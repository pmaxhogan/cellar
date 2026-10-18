import {
  isChannelId,
  isVideoId,
  type MediaRow,
  type VideoChangeRow,
  type VideoDetail,
  type VideoEffective,
  type VideoHistoryQuery,
  type VideoRow,
  type VideoSort,
  type VideoSourceRef,
  type VideoStatsPoint,
  type VideoStatsQuery,
  type VideoStatus,
  type VideosListQuery,
} from "@cellar/shared";
import type { SQLInputValue } from "node:sqlite";
import type { Db } from "../db/db.ts";
import { pagedQuery, parseJsonColumn, Where, type Paged } from "../db/paged.ts";
import { invalid, notFound } from "./errors.ts";
import { pickThumbnail } from "./videoFiles.ts";

/**
 * The video catalog: the Videos page list (filters, sorts, full text search),
 * the detail view, history and stats, and the one write path for metadata
 * observed on YouTube (applyVideoDiff), which keeps video_changes as THE
 * history store (ARCHITECTURE "Metadata history and rechecks").
 */

// ---------------------------------------------------------------------------
// Full text search
// ---------------------------------------------------------------------------

/** Bare FTS5 operators. Quoted they would only match the words, so they are dropped. */
const FTS_OPERATORS: ReadonlySet<string> = new Set(["AND", "OR", "NOT", "NEAR"]);

/**
 * Turn user input into a safe FTS5 query (spec 12): split on whitespace, drop
 * bare operators and terms without a letter or digit, strip double quotes,
 * quote every term and prefix-match the last one. Terms are ANDed. Returns
 * null when nothing searchable is left.
 */
export function buildFtsQuery(input: string): string | null {
  const terms = input
    .split(/\s+/u)
    .filter((term) => !FTS_OPERATORS.has(term))
    .map((term) => term.replaceAll('"', ""))
    .filter((term) => /[\p{L}\p{N}]/u.test(term));
  if (terms.length === 0) {
    return null;
  }
  return terms.map((term, index) => `"${term}"${index === terms.length - 1 ? "*" : ""}`).join(" ");
}

export interface SearchTerms {
  /** Channel ids typed or pasted into the box, matched against v.channel_id. */
  channelIds: string[];
  /** Everything else, for buildFtsQuery. */
  text: string;
}

/**
 * Pull whole channel ids (`UC` plus 22 characters) out of the search input.
 * They are not FTS columns (unicode61 would split an id on `-` and `_`), so
 * they become a `v.channel_id IN (...)` filter and the remaining words go to
 * full text search. Double quotes around an id are ignored.
 */
export function splitSearchTerms(input: string): SearchTerms {
  const channelIds: string[] = [];
  const rest: string[] = [];
  for (const term of input.split(/\s+/u)) {
    const bare = term.replaceAll('"', "");
    if (isChannelId(bare)) {
      if (!channelIds.includes(bare)) channelIds.push(bare);
    } else if (term !== "") {
      rest.push(term);
    }
  }
  return { channelIds, text: rest.join(" ") };
}

/** bm25 column weights: id (unindexed), title, description, channel title, tags. */
const BM25 = "bm25(videos_fts, 0.0, 10.0, 1.0, 4.0, 2.0)";

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

const CURRENT_AV = "m.video_id = v.id AND m.is_current = 1 AND m.kind IN ('video', 'audio')";
const DOWNLOADED_SQL = `EXISTS (SELECT 1 FROM media m WHERE ${CURRENT_AV})`;
const SIZE_SQL = `(SELECT COALESCE(SUM(m.size_bytes), 0) FROM media m WHERE ${CURRENT_AV})`;
const LOCATION_SQL = `COALESCE(
  (SELECT m.location_id FROM media m WHERE ${CURRENT_AV} AND m.location_id IS NOT NULL
    ORDER BY m.kind = 'video' DESC, m.id DESC LIMIT 1),
  ve.location_id)`;
const FIRST_SEEN_SQL = `COALESCE(
  (SELECT MIN(s.first_seen_at) FROM video_sources s WHERE s.video_id = v.id), v.created_at)`;
const SOURCES_SQL = `(SELECT json_group_array(json_object(
    'account_id', s.account_id, 'source', s.source, 'first_seen_at', s.first_seen_at))
  FROM video_sources s WHERE s.video_id = v.id)`;

const ROW_SELECT = `
  v.id, v.channel_id, c.title AS channel_title, v.title, v.upload_date, v.published_at,
  v.duration_s, v.type, v.privacy, v.gone_since, v.views, v.likes, v.comments, v.ryd_ratio,
  v.caption_available, v.max_height, v.has_av1, v.created_at, v.updated_at,
  ${SOURCES_SQL} AS sources_json,
  ${DOWNLOADED_SQL} AS downloaded,
  ${SIZE_SQL} AS media_size_bytes,
  ${LOCATION_SQL} AS location_id,
  ve.reclaim_priority, ve.include`;

const BASE_FROM = `videos v
  LEFT JOIN channels c ON c.id = v.channel_id
  LEFT JOIN video_effective ve ON ve.video_id = v.id`;
const FTS_FROM = `videos_fts
  JOIN videos v ON v.rowid = videos_fts.rowid
  LEFT JOIN channels c ON c.id = v.channel_id
  LEFT JOIN video_effective ve ON ve.video_id = v.id`;

const SORT_SQL: Record<VideoSort, string> = {
  upload_date: "v.upload_date",
  first_seen: FIRST_SEEN_SQL,
  title: "v.title COLLATE NOCASE",
  views: "v.views",
  likes: "v.likes",
  duration_s: "v.duration_s",
  size: SIZE_SQL,
  reclaim_priority: "ve.reclaim_priority",
  last_recheck: "v.last_recheck_at",
};

const STATUS_SQL: Record<VideoStatus, string> = {
  public: "(v.privacy = 'public' AND v.gone_since IS NULL)",
  unlisted: "(v.privacy = 'unlisted' AND v.gone_since IS NULL)",
  gone: "(v.privacy IN ('private', 'removed', 'unavailable') OR v.gone_since IS NOT NULL)",
  private: "(v.privacy = 'private')",
  removed: "(v.privacy = 'removed')",
};

const PRI_SQL: Record<NonNullable<VideosListQuery["pri"]>, string> = {
  "-1": "ve.reclaim_priority = -1",
  "0": "ve.reclaim_priority = 0",
  positive: "ve.reclaim_priority > 0",
};

interface VideoDbRow {
  id: string;
  channel_id: string | null;
  channel_title: string | null;
  title: string | null;
  upload_date: number | null;
  published_at: number | null;
  duration_s: number | null;
  type: string | null;
  privacy: string | null;
  gone_since: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  ryd_ratio: number | null;
  caption_available: number | null;
  max_height: number | null;
  has_av1: number | null;
  created_at: number;
  updated_at: number;
  /** json_group_array output: always a JSON array. */
  sources_json: string;
  downloaded: number;
  media_size_bytes: number;
  location_id: number | null;
  reclaim_priority: number | null;
  include: number | null;
}

function placeholders(count: number): string {
  return new Array<string>(count).fill("?").join(", ");
}

function bool(value: number | null): boolean | null {
  return value === null ? null : value !== 0;
}

function parseSources(json: string): VideoSourceRef[] {
  return (JSON.parse(json) as VideoSourceRef[]).sort(
    (a, b) => a.first_seen_at - b.first_seen_at || a.source.localeCompare(b.source),
  );
}

/** The content addressed URL of one stored thumbnail (safe to cache forever). */
export function thumbnailUrl(videoId: string, variant: string, sha256: string): string {
  return (
    `/api/videos/${encodeURIComponent(videoId)}/thumbnail/${encodeURIComponent(variant)}` +
    `?sha=${encodeURIComponent(sha256)}`
  );
}

/** Best stored thumbnail per video, as content addressed URLs. */
function bestThumbnails(db: Db, ids: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (ids.length === 0) {
    return out;
  }
  const rows = db.all<{ video_id: string; variant: string; sha256: string }>(
    `SELECT video_id, variant, sha256 FROM thumbnails
      WHERE video_id IN (${placeholders(ids.length)})
      ORDER BY first_seen_at DESC, id DESC`,
    ...ids,
  );
  const byVideo = new Map<string, { variant: string; sha256: string }[]>();
  for (const row of rows) {
    const list = byVideo.get(row.video_id) ?? [];
    list.push(row);
    byVideo.set(row.video_id, list);
  }
  for (const [videoId, list] of byVideo) {
    const best = pickThumbnail(list, "best") ?? list[0];
    if (best !== undefined) {
      out.set(videoId, thumbnailUrl(videoId, best.variant, best.sha256));
    }
  }
  return out;
}

function toVideoRow(row: VideoDbRow, thumbs: Map<string, string>): VideoRow {
  return {
    id: row.id,
    channel_id: row.channel_id,
    channel_title: row.channel_title,
    title: row.title,
    upload_date: row.upload_date,
    published_at: row.published_at,
    duration_s: row.duration_s,
    type: row.type,
    privacy: row.privacy,
    gone_since: row.gone_since,
    views: row.views,
    likes: row.likes,
    comments: row.comments,
    ryd_ratio: row.ryd_ratio,
    caption_available: bool(row.caption_available),
    max_height: row.max_height,
    has_av1: bool(row.has_av1),
    sources: parseSources(row.sources_json),
    downloaded: row.downloaded !== 0,
    media_size_bytes: row.media_size_bytes,
    location_id: row.location_id,
    reclaim_priority: row.reclaim_priority,
    include: bool(row.include),
    thumbnail_url: thumbs.get(row.id) ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function buildWhere(query: VideosListQuery, fts: string | null, channelIds: string[]): Where {
  const where = new Where();
  if (fts !== null) {
    where.add("videos_fts MATCH ?", fts);
  }
  if (channelIds.length > 0) {
    where.add(`v.channel_id IN (${placeholders(channelIds.length)})`, ...channelIds);
  }
  if (query.source !== undefined || query.account_id !== undefined) {
    const clauses = ["s.video_id = v.id"];
    const params: SQLInputValue[] = [];
    if (query.source !== undefined) {
      clauses.push(`s.source IN (${placeholders(query.source.length)})`);
      params.push(...query.source);
    }
    if (query.account_id !== undefined) {
      clauses.push("s.account_id = ?");
      params.push(query.account_id);
    }
    where.add(`EXISTS (SELECT 1 FROM video_sources s WHERE ${clauses.join(" AND ")})`, ...params);
  }
  where.maybe("v.channel_id = ?", query.channel_id);
  if (query.status !== undefined) {
    where.add(`(${query.status.map((status) => STATUS_SQL[status]).join(" OR ")})`);
  }
  if (query.downloaded !== undefined) {
    where.add(query.downloaded ? DOWNLOADED_SQL : `NOT ${DOWNLOADED_SQL}`);
  }
  where.maybe(`${LOCATION_SQL} = ?`, query.location_id);
  if (query.type !== undefined) {
    where.add(`v.type IN (${placeholders(query.type.length)})`, ...query.type);
  }
  where.maybe("v.upload_date >= ?", query.date_from);
  where.maybe("v.upload_date <= ?", query.date_to);
  where.maybe("v.duration_s >= ?", query.min_duration);
  where.maybe("v.duration_s <= ?", query.max_duration);
  if (query.pri !== undefined) {
    where.add(PRI_SQL[query.pri]);
  }
  return where;
}

/** The Videos page datatable. */
export function listVideos(db: Db, query: VideosListQuery): Paged<VideoRow> {
  const terms = splitSearchTerms(query.q ?? "");
  const fts = buildFtsQuery(terms.text);
  const where = buildWhere(query, fts, terms.channelIds);
  const dir = query.dir === "asc" ? "ASC" : "DESC";
  const orderBy =
    fts !== null && query.sort === undefined
      ? `${BM25} ASC, v.id ASC`
      : `${SORT_SQL[query.sort ?? "upload_date"]} ${dir} NULLS LAST, v.id ASC`;
  // buildFtsQuery only ever emits quoted terms, so MATCH cannot see a syntax error.
  const page = pagedQuery<VideoDbRow, VideoDbRow>(db, {
    select: ROW_SELECT,
    from: fts === null ? BASE_FROM : FTS_FROM,
    where,
    orderBy,
    page: query.page,
    perPage: query.perPage,
    map: (row) => row,
  });
  const thumbs = bestThumbnails(
    db,
    page.rows.map((row) => row.id),
  );
  return { ...page, rows: page.rows.map((row) => toVideoRow(row, thumbs)) };
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

interface VideoDetailDbRow extends VideoDbRow {
  description: string | null;
  tags_json: string | null;
  category_id: string | null;
  default_language: string | null;
  max_fps: number | null;
  has_vp9: number | null;
  has_h264: number | null;
  is_hdr: number | null;
  live_status: string | null;
  last_recheck_at: number | null;
  next_recheck_at: number | null;
  recheck_tier: string | null;
  consecutive_recheck_failures: number;
}

interface MediaDbRow extends Omit<MediaRow, "is_current"> {
  is_current: number;
}

function parseTags(json: string | null): string[] {
  const parsed = parseJsonColumn(json);
  return Array.isArray(parsed)
    ? parsed.filter((tag): tag is string => typeof tag === "string")
    : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function loadEffective(db: Db, id: string): VideoEffective | null {
  const row = db.get<{
    effective_json: string;
    provenance_json: string;
    matched_rule_ids: string;
    evaluated_at: number;
    next_eval_at: number | null;
  }>(
    `SELECT effective_json, provenance_json, matched_rule_ids, evaluated_at, next_eval_at
       FROM video_effective WHERE video_id = ?`,
    id,
  );
  if (row === undefined) {
    return null;
  }
  const matched = parseJsonColumn(row.matched_rule_ids);
  return {
    values: asRecord(parseJsonColumn(row.effective_json)) ?? {},
    provenance: asRecord(parseJsonColumn(row.provenance_json)) ?? {},
    matched_rule_ids: Array.isArray(matched)
      ? matched.filter((value): value is number => Number.isInteger(value))
      : [],
    evaluated_at: row.evaluated_at,
    next_eval_at: row.next_eval_at,
  };
}

/** True when the video is in the catalog. */
export function videoExists(db: Db, id: string): boolean {
  return db.get("SELECT 1 AS one FROM videos WHERE id = ?", id) !== undefined;
}

function requireVideo(db: Db, id: string): void {
  if (!videoExists(db, id)) {
    throw notFound("Video", id);
  }
}

/** One video with everything the detail page shows. */
export function getVideo(db: Db, id: string): VideoDetail {
  const row = db.get<VideoDetailDbRow>(
    `SELECT ${ROW_SELECT}, v.description, v.tags_json, v.category_id, v.default_language,
            v.max_fps, v.has_vp9, v.has_h264, v.is_hdr, v.live_status, v.last_recheck_at,
            v.next_recheck_at, v.recheck_tier, v.consecutive_recheck_failures
       FROM ${BASE_FROM} WHERE v.id = ?`,
    id,
  );
  if (row === undefined) {
    throw notFound("Video", id);
  }
  const thumbnailRows = db.all<{ variant: string; sha256: string; first_seen_at: number }>(
    `SELECT variant, sha256, first_seen_at FROM thumbnails
      WHERE video_id = ? ORDER BY first_seen_at DESC, id DESC`,
    id,
  );
  const best = pickThumbnail(thumbnailRows, "best") ?? thumbnailRows[0];
  const thumbs = new Map<string, string>();
  if (best !== undefined) {
    thumbs.set(id, thumbnailUrl(id, best.variant, best.sha256));
  }
  const media = db
    .all<MediaDbRow>(
      `SELECT id, kind, version, is_current, location_id, rel_path, size_bytes, vcodec, acodec,
              height, fps, bitrate, lang, downloaded_at, transcoded_from
         FROM media WHERE video_id = ?
        ORDER BY CASE kind WHEN 'video' THEN 0 WHEN 'audio' THEN 1 WHEN 'captions' THEN 2
                 ELSE 3 END, lang, version DESC, id DESC`,
      id,
    )
    .map((m): MediaRow => ({ ...m, is_current: m.is_current !== 0 }));
  const overrides = db.get<{ effects_json: string }>(
    "SELECT effects_json FROM rules WHERE kind = 'video' AND video_id = ?",
    id,
  );
  const shares = db.all<VideoDetail["share_links"][number]>(
    `SELECT token, expires_at, revoked_at, access_count, created_at FROM share_links
      WHERE video_id = ? ORDER BY created_at DESC, token`,
    id,
  );
  return {
    ...toVideoRow(row, thumbs),
    description: row.description,
    tags: parseTags(row.tags_json),
    category_id: row.category_id,
    default_language: row.default_language,
    formats: {
      max_height: row.max_height,
      max_fps: row.max_fps,
      has_av1: bool(row.has_av1),
      has_vp9: bool(row.has_vp9),
      has_h264: bool(row.has_h264),
      is_hdr: bool(row.is_hdr),
    },
    live_status: row.live_status,
    last_recheck_at: row.last_recheck_at,
    next_recheck_at: row.next_recheck_at,
    recheck_tier: row.recheck_tier,
    consecutive_recheck_failures: row.consecutive_recheck_failures,
    effective: loadEffective(db, id),
    overrides:
      overrides === undefined ? null : (asRecord(parseJsonColumn(overrides.effects_json)) ?? {}),
    media,
    captions: media.flatMap((m) =>
      m.kind === "captions" && m.is_current && m.lang !== null
        ? [{ lang: m.lang, media_id: m.id }]
        : [],
    ),
    thumbnails: thumbnailRows.map((t) => ({
      variant: t.variant,
      sha256: t.sha256,
      first_seen_at: t.first_seen_at,
      url: thumbnailUrl(id, t.variant, t.sha256),
    })),
    share_links: shares,
  };
}

// ---------------------------------------------------------------------------
// History and stats
// ---------------------------------------------------------------------------

/** The video_changes timeline, newest first. */
export function videoHistory(db: Db, id: string, query: VideoHistoryQuery): Paged<VideoChangeRow> {
  requireVideo(db, id);
  const where = new Where().add("video_id = ?", id).maybe("field = ?", query.field);
  return pagedQuery<
    {
      id: number;
      field: string;
      old_json: string | null;
      new_json: string | null;
      seen_at: number;
      recheck_id: number | null;
    },
    VideoChangeRow
  >(db, {
    select: "id, field, old_json, new_json, seen_at, recheck_id",
    from: "video_changes",
    where,
    orderBy: "seen_at DESC, id DESC",
    page: query.page,
    perPage: query.perPage,
    map: (row) => ({
      id: row.id,
      field: row.field,
      old: parseJsonColumn(row.old_json),
      new: parseJsonColumn(row.new_json),
      seen_at: row.seen_at,
      recheck_id: row.recheck_id,
    }),
  });
}

export const COUNTER_FIELDS = ["views", "likes", "comments", "ryd_dislikes"] as const;
export type CounterField = (typeof COUNTER_FIELDS)[number];

function counterValue(json: string | null): number | null {
  const value = parseJsonColumn(json);
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

/**
 * Rebuild counter points from video_changes: every change instant becomes a
 * point carrying each counter's value at that instant. A counter's value
 * before its first change is that change's old value.
 */
export function statsFromChanges(
  rows: readonly {
    field: string;
    old_json: string | null;
    new_json: string | null;
    seen_at: number;
  }[],
): VideoStatsPoint[] {
  const state: Record<CounterField, number | null> = {
    views: null,
    likes: null,
    comments: null,
    ryd_dislikes: null,
  };
  const seeded = new Set<string>();
  for (const row of rows) {
    if (!seeded.has(row.field)) {
      seeded.add(row.field);
      state[row.field as CounterField] = counterValue(row.old_json);
    }
  }
  const points = new Map<number, VideoStatsPoint>();
  for (const row of rows) {
    state[row.field as CounterField] = counterValue(row.new_json);
    points.set(row.seen_at, { at: row.seen_at, ...state });
  }
  return [...points.values()].sort((a, b) => a.at - b.at);
}

/** Counter time series for the stats chart, oldest first. */
export function videoStats(db: Db, id: string, query: VideoStatsQuery): VideoStatsPoint[] {
  requireVideo(db, id);
  const from = query.from ?? Number.MIN_SAFE_INTEGER;
  const to = query.to ?? Number.MAX_SAFE_INTEGER;
  const stored = db.all<VideoStatsPoint>(
    `SELECT at, views, likes, comments, ryd_dislikes FROM video_stats
      WHERE video_id = ? AND at >= ? AND at <= ? ORDER BY at`,
    id,
    from,
    to,
  );
  if (stored.length > 0) {
    return stored;
  }
  const hasAny = db.get("SELECT 1 AS one FROM video_stats WHERE video_id = ? LIMIT 1", id);
  if (hasAny !== undefined) {
    return [];
  }
  const changes = db.all<{
    field: string;
    old_json: string | null;
    new_json: string | null;
    seen_at: number;
  }>(
    `SELECT field, old_json, new_json, seen_at FROM video_changes
      WHERE video_id = ? AND field IN (${placeholders(COUNTER_FIELDS.length)})
      ORDER BY seen_at, id`,
    id,
    ...COUNTER_FIELDS,
  );
  return statsFromChanges(changes).filter((point) => point.at >= from && point.at <= to);
}

// ---------------------------------------------------------------------------
// Writes: skeleton rows and field level diffs
// ---------------------------------------------------------------------------

/**
 * Insert a skeleton row for `id` when it is not in the catalog yet. With
 * `channelId`, a row whose channel is still unknown gets it (the channel row
 * must exist). Returns true when the row was created.
 */
export function ensureVideo(
  db: Db,
  id: string,
  options: { channelId?: string; now?: number } = {},
): boolean {
  if (!isVideoId(id)) {
    throw invalid(`${id} is not a video id.`);
  }
  const now = options.now ?? Date.now();
  return db.tx(() => {
    const created =
      db.run(
        `INSERT INTO videos (id, channel_id, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
        id,
        options.channelId ?? null,
        now,
        now,
      ).changes > 0;
    if (!created && options.channelId !== undefined) {
      db.run(
        "UPDATE videos SET channel_id = ?, updated_at = ? WHERE id = ? AND channel_id IS NULL",
        options.channelId,
        now,
        id,
      );
    }
    return created;
  });
}

/** Fields whose changes are history (video_changes rows). */
export const TRACKED_FIELDS = [
  "title",
  "description",
  "duration_s",
  "privacy",
  "views",
  "likes",
  "comments",
  "ryd_dislikes",
  "tags_json",
  "category_id",
  "live_status",
  "type",
  "upload_date",
  "content_signature",
] as const;
export type TrackedField = (typeof TRACKED_FIELDS)[number];

/** Columns a patch may also set, without history. */
export const UNTRACKED_FIELDS = [
  "channel_id",
  "published_at",
  "ryd_ratio",
  "default_language",
  "caption_available",
  "max_height",
  "has_av1",
  "has_vp9",
  "has_h264",
  "max_fps",
  "is_hdr",
  "formats_json",
  "gone_since",
  "consecutive_recheck_failures",
  "last_recheck_at",
  "next_recheck_at",
  "recheck_tier",
] as const;
export type UntrackedField = (typeof UNTRACKED_FIELDS)[number];

const JSON_FIELDS: ReadonlySet<string> = new Set(["tags_json", "formats_json"]);
const BOOLEAN_KEYS = ["caption_available", "has_av1", "has_vp9", "has_h264", "is_hdr"] as const;
const BOOLEAN_FIELDS: ReadonlySet<string> = new Set(BOOLEAN_KEYS);
const COUNTER_SET: ReadonlySet<string> = new Set(COUNTER_FIELDS);
const PATCH_FIELDS: readonly string[] = [...TRACKED_FIELDS, ...UNTRACKED_FIELDS];

/** A column value as stored: text, a number, or null. Booleans are stored as 0/1. */
export type ColumnValue = string | number | null;

/**
 * Metadata observed for a video. A missing key means "not observed" and is
 * left alone; null means "observed empty". `*_json` fields carry JSON text.
 */
export type VideoPatch = Partial<
  Record<Exclude<TrackedField | UntrackedField, (typeof BOOLEAN_KEYS)[number]>, ColumnValue> &
    Record<(typeof BOOLEAN_KEYS)[number], boolean | number | null>
>;

/** The stored value of every patchable column. */
export type StoredVideo = Record<TrackedField | UntrackedField, ColumnValue>;

export interface FieldChange {
  field: TrackedField | UntrackedField;
  old: ColumnValue;
  new: ColumnValue;
  /** True when this change is (or would be) a video_changes row. */
  history: boolean;
}

/** Normalise one patch value to its column form. Throws invalid on a bad value. */
function normalise(field: string, value: unknown): ColumnValue {
  if (value === null) {
    return null;
  }
  if (BOOLEAN_FIELDS.has(field)) {
    if (typeof value === "boolean") {
      return value ? 1 : 0;
    }
    if (value === 0 || value === 1) {
      return value;
    }
    throw invalid(`${field} must be a boolean.`);
  }
  if (JSON_FIELDS.has(field)) {
    if (typeof value !== "string") {
      throw invalid(`${field} must be JSON text.`);
    }
    try {
      return JSON.stringify(JSON.parse(value) as unknown);
    } catch {
      throw invalid(`${field} must be JSON text.`);
    }
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw invalid(`${field} has an unsupported value.`);
}

/**
 * Pure field level diff of `patch` against `stored`. Only keys present in the
 * patch are compared. A tracked field change is history except when the
 * stored value is null (a first observation fills the field instead), but a
 * counter change is always history, so video_changes alone can rebuild the
 * counter series from its first point.
 */
export function diffVideo(stored: StoredVideo, patch: VideoPatch): FieldChange[] {
  const changes: FieldChange[] = [];
  const record = patch as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!PATCH_FIELDS.includes(key)) {
      throw invalid(`${key} is not a patchable video field.`);
    }
  }
  for (const field of PATCH_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, field) || record[field] === undefined) {
      continue;
    }
    const next = normalise(field, record[field]);
    const key = field as TrackedField | UntrackedField;
    const old = stored[key];
    if (old === next) {
      continue;
    }
    const tracked = (TRACKED_FIELDS as readonly string[]).includes(field);
    changes.push({
      field: key,
      old,
      new: next,
      history: tracked && (old !== null || COUNTER_SET.has(field)),
    });
  }
  return changes;
}

/** A history value as JSON: JSON columns keep their parsed form. */
function historyJson(field: string, value: ColumnValue): string | null {
  if (value === null) {
    return null;
  }
  return JSON_FIELDS.has(field) ? String(value) : JSON.stringify(value);
}

export interface DiffContext {
  /** jobs.id of the recheck_batch run that observed the values; null for ingestion. */
  recheckId?: number | null;
  /** When the values were observed (epoch ms). Also the stats point and updated_at. */
  seenAt: number;
}

export interface DiffResult {
  changes: FieldChange[];
  /** True when a video_stats point was written. */
  statsPoint: boolean;
}

/**
 * Apply observed metadata to a video in one transaction: update the changed
 * columns, write a video_changes row per history change, and when a counter
 * changed, upsert the video_stats point at seenAt with all four counters.
 * Deterministic: time comes from ctx, never the clock.
 */
export function applyVideoDiff(
  db: Db,
  id: string,
  patch: VideoPatch,
  ctx: DiffContext,
): DiffResult {
  return db.tx((): DiffResult => {
    const stored = db.get<StoredVideo>(
      `SELECT ${PATCH_FIELDS.join(", ")} FROM videos WHERE id = ?`,
      id,
    );
    if (stored === undefined) {
      throw notFound("Video", id);
    }
    const changes = diffVideo(stored, patch);
    if (changes.length === 0) {
      return { changes, statsPoint: false };
    }
    db.run(
      `UPDATE videos SET ${changes.map((c) => `${c.field} = ?`).join(", ")}, updated_at = ?
        WHERE id = ?`,
      ...changes.map((c) => c.new),
      ctx.seenAt,
      id,
    );
    for (const change of changes.filter((c) => c.history)) {
      db.run(
        `INSERT INTO video_changes (video_id, recheck_id, field, old_json, new_json, seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        ctx.recheckId ?? null,
        change.field,
        historyJson(change.field, change.old),
        historyJson(change.field, change.new),
        ctx.seenAt,
      );
    }
    const statsPoint = changes.some((c) => COUNTER_SET.has(c.field));
    if (statsPoint) {
      const merged = { ...stored };
      for (const change of changes) {
        merged[change.field] = change.new;
      }
      db.run(
        `INSERT INTO video_stats (video_id, at, views, likes, comments, ryd_dislikes)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (video_id, at) DO UPDATE SET views = excluded.views,
           likes = excluded.likes, comments = excluded.comments,
           ryd_dislikes = excluded.ryd_dislikes`,
        id,
        ctx.seenAt,
        merged.views,
        merged.likes,
        merged.comments,
        merged.ryd_dislikes,
      );
    }
    return { changes, statsPoint };
  });
}

/**
 * Ingestion's write path: create the row if needed, then apply the observed
 * fields as a diff (no recheck id unless given).
 */
export function upsertVideoFromApi(
  db: Db,
  id: string,
  fields: VideoPatch,
  ctx: Partial<DiffContext> = {},
): DiffResult {
  const seenAt = ctx.seenAt ?? Date.now();
  return db.tx(() => {
    const channelId = typeof fields.channel_id === "string" ? fields.channel_id : undefined;
    ensureVideo(db, id, { now: seenAt, ...(channelId === undefined ? {} : { channelId }) });
    return applyVideoDiff(db, id, fields, { recheckId: ctx.recheckId ?? null, seenAt });
  });
}
