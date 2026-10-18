import { isVideoId } from "@cellar/shared";
import type { Db } from "../db/db.ts";
import { getKv, INSTALLED_AT_KEY, setKv } from "../db/kv.ts";
import { logActivity } from "../domain/activity.ts";
import { nowOf, type ServiceDeps } from "../domain/deps.ts";
import { DomainError, notFound } from "../domain/errors.ts";
import { scheduleEvalPass } from "../domain/ruleEval.ts";
import { getSettings } from "../domain/settings.ts";
import { ensureVideo } from "../domain/videos.ts";
import type { EventBus } from "../events.ts";
import type { EnqueueInput, EnqueueResult } from "../jobs/queue.ts";
import { API_UNIT_COSTS, YoutubeApiError, youtubeApi, type ApiParams } from "./api.ts";
import { fetchHistory, fetchWatchLater, type FeedEntry } from "./feeds.ts";
import { QuotaExhausted } from "./quota.ts";

/**
 * Ingestion: turn feed listings and API pages into catalog rows. Every source
 * sighting is a `video_sources` row (one per video, account and source); new
 * videos are created as metadata-only skeletons, queued for a recheck, and
 * every touched video gets a (debounced) rule evaluation.
 */

// ---------------------------------------------------------------------------
// Job types
// ---------------------------------------------------------------------------

export const INGEST_HISTORY_JOB = "ingest_history";
export const INGEST_WATCH_LATER_JOB = "ingest_watch_later";
export const INGEST_LIKED_JOB = "ingest_liked";
export const INGEST_SUBSCRIPTIONS_JOB = "ingest_subscriptions";
export const INGEST_CHANNEL_UPLOADS_JOB = "ingest_channel_uploads";
/** A manual channel's full catalog walk, leftover budget class. */
export const INGEST_CHANNEL_BACKFILL_JOB = "ingest_channel_backfill";
export const RECHECK_BATCH_JOB = "recheck_batch";
/** Same handler as recheck_batch, in the leftover class (pri-0 videos). */
export const RECHECK_LEFTOVER_JOB = "recheck_batch_leftover";
export const ACTION_INGEST_NOW = "action:ingest-now";

/** videos.list takes at most 50 ids per call (1 unit). */
export const RECHECK_BATCH_SIZE = 50;
/** Priority of the recheck queued for videos ingestion just discovered. */
export const RECHECK_NEW_PRIORITY = 5;
export const PLAYLIST_PAGE_SIZE = 50;
/** Hard caps so a runaway walk cannot spend the day's budget. */
export const MAX_LIKED_PAGES = 200;
export const MAX_SUBSCRIPTION_PAGES = 100;
export const MAX_BACKFILL_GUARD_PAGES = 40;
export const MAX_DEEP_BACKFILL_PAGES = 400;
/** The default subscriptions backfill guard window before installed_at. */
export const BACKFILL_GUARD_MS = 7 * 24 * 60 * 60_000;
export const CHANNEL_BACKFILL_KV_PREFIX = "channel_backfill:";

export type VideoSourceKind = "history" | "watch_later" | "liked" | "subscription" | "channel";
export type SourceOrigin = "live_feed" | "api" | "takeout";

/** What ingestion needs: the service deps plus a way to queue follow-up jobs. */
export interface IngestDeps extends ServiceDeps {
  events?: EventBus | undefined;
  enqueue(input: EnqueueInput): EnqueueResult;
}

export interface IngestRunOptions {
  /** Called between pages; throws to abort (job cancel/shutdown). */
  checkpoint?: () => void;
}

// ---------------------------------------------------------------------------
// Catalog write helpers
// ---------------------------------------------------------------------------

export interface ChannelInput {
  id: string;
  title?: string | null;
  thumbnailUrl?: string | null;
  uploadsPlaylistId?: string | null;
}

const CHANNEL_ID_RE = /^UC[\w-]{22}$/;

export function isChannelId(value: unknown): value is string {
  return typeof value === "string" && CHANNEL_ID_RE.test(value);
}

/**
 * Insert the channel or refresh its metadata. A given title or thumbnail
 * replaces the stored one (channels get renamed); null keeps what is there.
 * Returns true when the row was created.
 */
export function ensureChannel(db: Db, input: ChannelInput, now: number): boolean {
  const existed = db.get("SELECT 1 AS one FROM channels WHERE id = ?", input.id) !== undefined;
  db.run(
    `INSERT INTO channels (id, title, uploads_playlist_id, thumbnail_url, first_seen_at,
                           created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       title = COALESCE(excluded.title, channels.title),
       uploads_playlist_id = COALESCE(channels.uploads_playlist_id, excluded.uploads_playlist_id),
       thumbnail_url = COALESCE(excluded.thumbnail_url, channels.thumbnail_url),
       updated_at = CASE
         WHEN excluded.title IS NOT channels.title AND excluded.title IS NOT NULL
           OR excluded.thumbnail_url IS NOT channels.thumbnail_url
             AND excluded.thumbnail_url IS NOT NULL
         THEN excluded.updated_at ELSE channels.updated_at END`,
    input.id,
    input.title ?? null,
    input.uploadsPlaylistId ?? null,
    input.thumbnailUrl ?? null,
    now,
    now,
    now,
  );
  return !existed;
}

export interface SourceInput {
  videoId: string;
  accountId: number | null;
  source: VideoSourceKind;
  /** Real watch/like/add time when known; null keeps the stored value. */
  sourceTs?: number | null;
  origin: SourceOrigin;
}

/**
 * Record one sighting of a video in a source. A new row gets first_seen_at =
 * last_seen_at = now; an existing one only moves last_seen_at forward (and
 * takes a newer source_ts). SELECT-then-write in one transaction, because the
 * unique index is on `COALESCE(account_id, 0)` and an expression conflict
 * target is not portable across SQLite builds. Returns true when created.
 */
export function upsertVideoSource(db: Db, input: SourceInput, now: number): boolean {
  return db.tx(() => {
    const existing = db.get<{ id: number }>(
      `SELECT id FROM video_sources
        WHERE video_id = ? AND account_id IS ? AND source = ?`,
      input.videoId,
      input.accountId,
      input.source,
    );
    if (existing !== undefined) {
      db.run(
        `UPDATE video_sources SET last_seen_at = MAX(last_seen_at, ?),
                source_ts = COALESCE(?, source_ts)
          WHERE id = ?`,
        now,
        input.sourceTs ?? null,
        existing.id,
      );
      return false;
    }
    db.run(
      `INSERT INTO video_sources (video_id, account_id, source, first_seen_at, last_seen_at,
                                  source_ts, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.videoId,
      input.accountId,
      input.source,
      now,
      now,
      input.sourceTs ?? null,
      input.origin,
    );
    return true;
  });
}

/** Whether the video already has a row in this source for this account. */
export function hasVideoSource(
  db: Db,
  videoId: string,
  accountId: number | null,
  source: VideoSourceKind,
): boolean {
  return (
    db.get(
      "SELECT 1 AS one FROM video_sources WHERE video_id = ? AND account_id IS ? AND source = ?",
      videoId,
      accountId,
      source,
    ) !== undefined
  );
}

const FILL_FIELDS = ["title", "duration_s", "privacy", "type", "upload_date"] as const;
type FillField = (typeof FILL_FIELDS)[number];
export type FillPatch = Partial<Record<FillField, string | number | null>>;

/**
 * Fill columns that are still empty from what a feed or playlist page shows.
 * Never overwrites a value (rechecks own changes and their history), so a
 * feed can never write a spurious video_changes row.
 */
export function fillVideo(db: Db, id: string, patch: FillPatch, now: number): void {
  const keys = FILL_FIELDS.filter(
    (key) => patch[key] !== undefined && patch[key] !== null,
  ) as FillField[];
  if (keys.length === 0) {
    return;
  }
  const sets = keys.map((key) => `${key} = COALESCE(${key}, ?)`).join(", ");
  db.run(
    `UPDATE videos SET ${sets}, updated_at = ? WHERE id = ?`,
    ...keys.map((key) => patch[key] as string | number),
    now,
    id,
  );
}

export interface SightingInput {
  videoId: string;
  channelId: string | null;
  channelTitle?: string | null;
  fill: FillPatch;
  sources: readonly Omit<SourceInput, "videoId">[];
}

export interface SightingResult {
  createdVideo: boolean;
  newSources: number;
}

/** Channel row first (videos.channel_id is a foreign key), then video, fill and sources. */
export function recordSighting(db: Db, input: SightingInput, now: number): SightingResult {
  return db.tx(() => {
    const channelId = isChannelId(input.channelId) ? input.channelId : null;
    if (channelId !== null) {
      ensureChannel(db, { id: channelId, title: input.channelTitle ?? null }, now);
    }
    const createdVideo = ensureVideo(db, input.videoId, {
      now,
      ...(channelId === null ? {} : { channelId }),
    });
    fillVideo(db, input.videoId, input.fill, now);
    let newSources = 0;
    for (const source of input.sources) {
      if (upsertVideoSource(db, { ...source, videoId: input.videoId }, now)) {
        newSources += 1;
      }
    }
    return { createdVideo, newSources };
  });
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/** Accounts holding a Google grant that is not known broken or paused, by id. */
export function apiAccountIds(db: Db): number[] {
  return db
    .all<{ id: number }>(
      `SELECT a.id FROM accounts a
        WHERE a.status NOT IN ('auth_lost', 'disabled')
          AND EXISTS (SELECT 1 FROM account_secrets s
                       WHERE s.account_id = a.id AND s.kind = 'oauth_refresh')
        ORDER BY a.id`,
    )
    .map((row) => Number(row.id));
}

/** Accounts with a cookie jar that is not known invalid, and not paused, by id. */
export function cookieAccountIds(db: Db): number[] {
  return db
    .all<{ id: number }>(
      `SELECT a.id FROM accounts a
        WHERE a.status NOT IN ('cookies_invalid', 'disabled')
          AND EXISTS (SELECT 1 FROM account_secrets s
                       WHERE s.account_id = a.id AND s.kind = 'cookies')
        ORDER BY a.id`,
    )
    .map((row) => Number(row.id));
}

const RR_KV_PREFIX = "rr:";

/**
 * Round-robin over the API accounts, restricted to `preferred` when any of
 * them qualifies. The last pick per `key` persists in kv. Null when no
 * account has API access.
 */
export function pickApiAccount(
  db: Db,
  preferred: readonly number[],
  key: string,
  now: number,
): number | null {
  const eligible = apiAccountIds(db);
  if (eligible.length === 0) {
    return null;
  }
  const wanted = new Set(preferred);
  const preferredPool = eligible.filter((id) => wanted.has(id));
  const pool = preferredPool.length > 0 ? preferredPool : eligible;
  const last = getKv<number>(db, RR_KV_PREFIX + key) ?? 0;
  const next = pool.find((id) => id > last) ?? (pool[0] as number);
  setKv(db, RR_KV_PREFIX + key, next, now);
  return next;
}

function requireApiAccount(db: Db, preferred: readonly number[], key: string, now: number): number {
  const accountId = pickApiAccount(db, preferred, key, now);
  if (accountId === null) {
    throw new DomainError("no_account", "No linked account has working YouTube API access.");
  }
  return accountId;
}

// ---------------------------------------------------------------------------
// Results and follow-up
// ---------------------------------------------------------------------------

export type IngestFeed =
  "history" | "watch_later" | "liked" | "subscriptions" | "channel_uploads" | "channel_backfill";

export interface IngestResult {
  feed: IngestFeed;
  accountId: number | null;
  channelId: string | null;
  /** Entries or items looked at. */
  seen: number;
  newVideos: number;
  newSources: number;
  /** API pages or yt-dlp runs. */
  pages: number;
  /** API units charged. */
  units: number;
  /** Scrape requests charged. */
  scrapes: number;
  /** Videos whose facts changed (eval pass targets). */
  touched: string[];
  /** Newly created videos to recheck right away. */
  recheckIds: string[];
  /** subscriptions: channels newly subscribed and channels no longer returned. */
  newChannels: string[];
  missingChannels: string[];
  /** Feed specific detail for the activity row. */
  notes: Record<string, unknown>;
}

export function emptyResult(
  feed: IngestFeed,
  accountId: number | null,
  channelId: string | null = null,
): IngestResult {
  return {
    feed,
    accountId,
    channelId,
    seen: 0,
    newVideos: 0,
    newSources: 0,
    pages: 0,
    units: 0,
    scrapes: 0,
    touched: [],
    recheckIds: [],
    newChannels: [],
    missingChannels: [],
    notes: {},
  };
}

function note(result: IngestResult, sighting: SightingResult, videoId: string): void {
  if (sighting.createdVideo) {
    result.newVideos += 1;
  }
  result.newSources += sighting.newSources;
  result.touched.push(videoId);
}

const FEED_LABELS: Record<IngestFeed, string> = {
  history: "Watch history",
  watch_later: "Watch Later",
  liked: "Liked videos",
  subscriptions: "Subscriptions",
  channel_uploads: "Channel uploads",
  channel_backfill: "Channel backfill",
};

/**
 * After a run (also a partial one that failed midway): queue the recheck of
 * new videos, ask for a debounced evaluation of every touched video, and log
 * one activity row with the counts.
 */
export function finishIngest(
  deps: IngestDeps,
  result: IngestResult,
  options: { jobId?: number | null; error?: unknown } = {},
): void {
  if (result.recheckIds.length > 0) {
    enqueueRecheck(deps, result.recheckIds, { priority: RECHECK_NEW_PRIORITY });
  }
  const touched = [...new Set(result.touched)];
  if (touched.length > 0) {
    scheduleEvalPass(deps, `ingest:${result.feed}`, { videoIds: touched });
  }
  const failed = options.error !== undefined;
  const errorText =
    options.error instanceof Error ? options.error.message : failed ? String(options.error) : null;
  const scope =
    result.channelId !== null
      ? ` for channel ${result.channelId}`
      : result.accountId !== null
        ? ` for account ${String(result.accountId)}`
        : "";
  const counts =
    `${String(result.newVideos)} new videos, ${String(result.newSources)} new sources, ` +
    `${String(result.pages)} pages, ${String(result.units)} API units`;
  logActivity(deps, {
    level: failed ? "warn" : "info",
    kind: `ingest.${result.feed}`,
    message: failed
      ? `${FEED_LABELS[result.feed]}${scope} stopped early (${counts}): ${errorText ?? ""}`
      : `${FEED_LABELS[result.feed]}${scope}: ${counts}.`,
    jobId: options.jobId ?? null,
    data: {
      accountId: result.accountId,
      channelId: result.channelId,
      seen: result.seen,
      newVideos: result.newVideos,
      newSources: result.newSources,
      pages: result.pages,
      units: result.units,
      scrapes: result.scrapes,
      ...(result.newChannels.length > 0 ? { newChannels: result.newChannels } : {}),
      ...(result.missingChannels.length > 0 ? { missingChannels: result.missingChannels } : {}),
      ...result.notes,
      ...(failed ? { error: errorText } : {}),
    },
  });
}

/** Dedupe identity of a recheck job: "due" or the sorted id list. */
export function recheckKey(payload: unknown): string {
  const p = (payload ?? {}) as { video_ids?: unknown; due?: unknown };
  if (Array.isArray(p.video_ids)) {
    return `ids:${p.video_ids.map(String).sort().join(",")}`;
  }
  return p.due === true ? "due" : "none";
}

interface QueuedRecheck {
  id: number;
  ids: string[];
}

/**
 * Queue rechecks for `ids` in batches of 50. Ids join a queued explicit batch
 * of the same type that still has room before a new job is created, so many
 * small ingests still cost one API unit per 50 videos.
 */
export function enqueueRecheck(
  deps: Pick<IngestDeps, "db" | "enqueue">,
  ids: readonly string[],
  options: { priority?: number; leftover?: boolean } = {},
): number[] {
  const type = options.leftover === true ? RECHECK_LEFTOVER_JOB : RECHECK_BATCH_JOB;
  const wanted = [...new Set(ids.filter((id) => isVideoId(id)))];
  if (wanted.length === 0) {
    return [];
  }
  return deps.db.tx(() => {
    const queued: QueuedRecheck[] = deps.db
      .all<{ id: number; payload_json: string }>(
        `SELECT id, payload_json FROM jobs WHERE type = ? AND status = 'queued' ORDER BY id`,
        type,
      )
      .flatMap((row) => {
        try {
          const payload = JSON.parse(row.payload_json) as { video_ids?: unknown };
          return Array.isArray(payload.video_ids)
            ? [{ id: row.id, ids: payload.video_ids.map(String) }]
            : [];
        } catch {
          return [];
        }
      });
    const already = new Set(queued.flatMap((job) => job.ids));
    let pending = wanted.filter((id) => !already.has(id));
    const jobIds: number[] = [];
    for (const job of queued) {
      if (pending.length === 0) {
        break;
      }
      const room = RECHECK_BATCH_SIZE - job.ids.length;
      if (room <= 0) {
        continue;
      }
      const added = pending.slice(0, room);
      pending = pending.slice(room);
      deps.db.run(
        `UPDATE jobs SET payload_json = ?, priority = MAX(priority, ?)
          WHERE id = ? AND status = 'queued'`,
        JSON.stringify({ video_ids: [...job.ids, ...added] }),
        options.priority ?? 0,
        job.id,
      );
      jobIds.push(job.id);
    }
    for (let at = 0; at < pending.length; at += RECHECK_BATCH_SIZE) {
      const chunk = pending.slice(at, at + RECHECK_BATCH_SIZE);
      jobIds.push(
        deps.enqueue({
          type,
          payload: { video_ids: chunk },
          priority: options.priority ?? 0,
          dedupe: true,
        }).id,
      );
    }
    return jobIds;
  });
}

// ---------------------------------------------------------------------------
// Metered API access
// ---------------------------------------------------------------------------

interface MeteredApi {
  get<T>(path: string, params: ApiParams): Promise<T>;
}

/** youtubeApi that adds the units it charged to `result.units`. */
function meteredApi(deps: ServiceDeps, accountId: number, result: IngestResult): MeteredApi {
  const api = youtubeApi(deps, accountId);
  return {
    async get<T>(path: string, params: ApiParams): Promise<T> {
      const units = API_UNIT_COSTS[path] ?? 1;
      try {
        const body = await api.get<T>(path, params, units);
        result.units += units;
        return body;
      } catch (error) {
        // Charged before the call unless the budget itself refused it.
        if (!(error instanceof QuotaExhausted)) {
          result.units += units;
        }
        throw error;
      }
    },
  };
}

function epochOf(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// ---------------------------------------------------------------------------
// Cookie feeds: history and Watch Later
// ---------------------------------------------------------------------------

function feedFill(entry: FeedEntry): FillPatch {
  return {
    title: entry.title,
    duration_s: entry.durationS,
    privacy: entry.privacy,
    ...(entry.isShort === true ? { type: "short" } : {}),
  };
}

function applyFeed(
  deps: IngestDeps,
  accountId: number,
  source: "history" | "watch_later",
  entries: readonly FeedEntry[],
  result: IngestResult,
  now: number,
): void {
  for (const entry of entries) {
    const sighting = recordSighting(
      deps.db,
      {
        videoId: entry.id,
        channelId: entry.channelId,
        channelTitle: entry.channelTitle,
        fill: feedFill(entry),
        sources: [{ accountId, source, origin: "live_feed" }],
      },
      now,
    );
    note(result, sighting, entry.id);
    if (sighting.createdVideo) {
      result.recheckIds.push(entry.id);
    }
  }
  result.seen += entries.length;
}

/** `ingest_history`: the adaptive-depth history feed of one account. */
export async function ingestHistory(
  deps: IngestDeps,
  accountId: number,
  result: IngestResult = emptyResult("history", accountId),
  options: IngestRunOptions & { max?: number } = {},
): Promise<IngestResult> {
  const run = await fetchHistory(deps, accountId, {
    isKnown: (id) => hasVideoSource(deps.db, id, accountId, "history"),
    ...(options.max === undefined ? {} : { max: options.max }),
    ...(options.checkpoint === undefined ? {} : { checkpoint: options.checkpoint }),
  });
  result.pages += run.runs;
  result.scrapes += run.runs;
  result.notes["depth"] = run.depth;
  applyFeed(deps, accountId, "history", run.entries, result, nowOf(deps));
  return result;
}

/**
 * `ingest_watch_later`: the whole list. An entry that left the list keeps its
 * row; its last_seen_at just stops moving (rules may use it).
 */
export async function ingestWatchLater(
  deps: IngestDeps,
  accountId: number,
  result: IngestResult = emptyResult("watch_later", accountId),
  options: IngestRunOptions = {},
): Promise<IngestResult> {
  const run = await fetchWatchLater(deps, accountId, {
    ...(options.checkpoint === undefined ? {} : { checkpoint: options.checkpoint }),
  });
  result.pages += run.runs;
  result.scrapes += run.runs;
  const now = nowOf(deps);
  applyFeed(deps, accountId, "watch_later", run.entries, result, now);
  const stale = deps.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM video_sources
      WHERE account_id = ? AND source = 'watch_later' AND last_seen_at < ?`,
    accountId,
    now,
  );
  result.notes["notInList"] = Number(stale?.n ?? 0);
  return result;
}

// ---------------------------------------------------------------------------
// API playlists: liked videos, channel uploads
// ---------------------------------------------------------------------------

interface PlaylistItem {
  snippet?: {
    publishedAt?: string;
    title?: string;
    videoOwnerChannelId?: string;
    videoOwnerChannelTitle?: string;
    resourceId?: { videoId?: string };
  };
  contentDetails?: { videoId?: string; videoPublishedAt?: string };
}

interface PlaylistPage {
  items?: PlaylistItem[];
  nextPageToken?: string;
}

export interface ParsedPlaylistItem {
  videoId: string;
  title: string | null;
  privacy: "private" | "removed" | null;
  channelId: string | null;
  channelTitle: string | null;
  /** When the item was added to the playlist (the like time for LL). */
  addedAt: number | null;
  /** The video's own publish time. */
  publishedAt: number | null;
}

/** Normalise one playlistItems.list item; null when it carries no video id. */
export function parsePlaylistItem(item: PlaylistItem): ParsedPlaylistItem | null {
  const videoId = item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId;
  if (typeof videoId !== "string" || !isVideoId(videoId)) {
    return null;
  }
  const rawTitle = typeof item.snippet?.title === "string" ? item.snippet.title : null;
  const privacy =
    rawTitle === "Private video" ? "private" : rawTitle === "Deleted video" ? "removed" : null;
  const channelId = item.snippet?.videoOwnerChannelId;
  return {
    videoId,
    title: privacy === null ? rawTitle : null,
    privacy,
    channelId: isChannelId(channelId) ? channelId : null,
    channelTitle: item.snippet?.videoOwnerChannelTitle ?? null,
    addedAt: epochOf(item.snippet?.publishedAt),
    publishedAt: epochOf(item.contentDetails?.videoPublishedAt),
  };
}

function itemFill(item: ParsedPlaylistItem): FillPatch {
  return { title: item.title, privacy: item.privacy, upload_date: item.publishedAt };
}

/**
 * `ingest_liked`: playlistItems.list on `LL`, 50 per page, newest first,
 * until a page is all known (or the list ends). source_ts is the like time.
 */
export async function ingestLiked(
  deps: IngestDeps,
  accountId: number,
  result: IngestResult = emptyResult("liked", accountId),
  options: IngestRunOptions = {},
): Promise<IngestResult> {
  const api = meteredApi(deps, accountId, result);
  let pageToken: string | undefined;
  do {
    options.checkpoint?.();
    const page = await api.get<PlaylistPage>("playlistItems", {
      part: "snippet,contentDetails",
      playlistId: "LL",
      maxResults: PLAYLIST_PAGE_SIZE,
      pageToken,
    });
    result.pages += 1;
    const items = (page.items ?? []).flatMap((raw) => {
      const parsed = parsePlaylistItem(raw);
      return parsed === null ? [] : [parsed];
    });
    const allKnown = items.every((item) =>
      hasVideoSource(deps.db, item.videoId, accountId, "liked"),
    );
    const now = nowOf(deps);
    for (const item of items) {
      const sighting = recordSighting(
        deps.db,
        {
          videoId: item.videoId,
          channelId: item.channelId,
          channelTitle: item.channelTitle,
          fill: itemFill(item),
          sources: [{ accountId, source: "liked", sourceTs: item.addedAt, origin: "api" }],
        },
        now,
      );
      note(result, sighting, item.videoId);
      if (sighting.createdVideo) {
        result.recheckIds.push(item.videoId);
      }
    }
    result.seen += items.length;
    if (allKnown) {
      break;
    }
    pageToken = page.nextPageToken;
  } while (pageToken !== undefined && result.pages < MAX_LIKED_PAGES);
  return result;
}

interface ChannelRowLite {
  id: string;
  uploads_playlist_id: string | null;
  last_checked_at: number | null;
}

interface ChannelSourceLite {
  account_id: number | null;
  kind: "subscription" | "manual";
}

function channelSources(db: Db, channelId: string): ChannelSourceLite[] {
  return db.all<ChannelSourceLite>(
    "SELECT account_id, kind FROM channel_sources WHERE channel_id = ? ORDER BY id",
    channelId,
  );
}

/** The video_sources rows an upload of this channel gets, one per channel source. */
function uploadSources(
  sources: readonly ChannelSourceLite[],
  kinds: readonly ("subscription" | "manual")[],
): Omit<SourceInput, "videoId">[] {
  const out: Omit<SourceInput, "videoId">[] = [];
  for (const row of sources) {
    if (!kinds.includes(row.kind)) {
      continue;
    }
    out.push(
      row.kind === "subscription"
        ? { accountId: row.account_id, source: "subscription", origin: "api" }
        : { accountId: null, source: "channel", origin: "api" },
    );
  }
  return out;
}

function uploadsPlaylistOf(channel: ChannelRowLite): string {
  return channel.uploads_playlist_id ?? `UU${channel.id.slice(2)}`;
}

function isKnownUpload(db: Db, videoId: string): boolean {
  return (
    db.get(
      `SELECT 1 AS one FROM video_sources
        WHERE video_id = ? AND source IN ('subscription', 'channel')`,
      videoId,
    ) !== undefined
  );
}

function loadChannel(db: Db, channelId: string): ChannelRowLite {
  const channel = db.get<ChannelRowLite>(
    "SELECT id, uploads_playlist_id, last_checked_at FROM channels WHERE id = ?",
    channelId,
  );
  if (channel === undefined) {
    throw notFound("Channel", channelId);
  }
  return channel;
}

/** The guard cutoff: uploads older than installed_at - 7 days are backfill. */
export function backfillCutoff(db: Db, now: number): number {
  return (getKv<number>(db, INSTALLED_AT_KEY) ?? now) - BACKFILL_GUARD_MS;
}

function isPlaylistMissing(error: unknown): boolean {
  return (
    error instanceof YoutubeApiError &&
    error.status === 404 &&
    (error.reason === "playlistNotFound" || error.reason === "notFound")
  );
}

/**
 * `ingest_channel_uploads`: the channel's `UU` playlist, newest first.
 *
 * - A channel polled before stops at the first upload it already has as a
 *   subscription/channel source, and reads at most `ingest.channel_newest_n`.
 * - A brand-new channel source (never polled: `last_checked_at` NULL) pages
 *   until a whole page is older than installed_at - 7 days, still creating
 *   the metadata-only records of that page so the guard rule marks them pri 0.
 *   Only uploads newer than the cutoff are queued for an immediate recheck;
 *   the rest wait for the leftover-budget due rechecks.
 */
export async function ingestChannelUploads(
  deps: IngestDeps,
  channelId: string,
  result: IngestResult = emptyResult("channel_uploads", null, channelId),
  options: IngestRunOptions & { accountId?: number } = {},
): Promise<IngestResult> {
  const channel = loadChannel(deps.db, channelId);
  const sources = channelSources(deps.db, channelId);
  const targets = uploadSources(sources, ["subscription", "manual"]);
  if (targets.length === 0) {
    result.notes["skipped"] = "not tracked";
    return result;
  }
  const now = nowOf(deps);
  const accountId =
    options.accountId ??
    requireApiAccount(
      deps.db,
      sources.flatMap((row) => (row.account_id === null ? [] : [row.account_id])),
      "uploads",
      now,
    );
  result.accountId = accountId;
  const api = meteredApi(deps, accountId, result);
  const brandNew = channel.last_checked_at === null;
  const cutoff = backfillCutoff(deps.db, now);
  const newestN = getSettings(deps.db)["ingest.channel_newest_n"];
  result.notes["brandNew"] = brandNew;

  let considered = 0;
  let pageToken: string | undefined;
  let done = false;
  while (!done) {
    options.checkpoint?.();
    let page: PlaylistPage;
    try {
      page = await api.get<PlaylistPage>("playlistItems", {
        part: "snippet,contentDetails",
        playlistId: uploadsPlaylistOf(channel),
        maxResults: brandNew
          ? PLAYLIST_PAGE_SIZE
          : Math.min(PLAYLIST_PAGE_SIZE, Math.max(1, newestN - considered)),
        pageToken,
      });
    } catch (error) {
      if (isPlaylistMissing(error)) {
        result.notes["noUploads"] = true;
        break;
      }
      throw error;
    }
    result.pages += 1;
    let pageHasRecent = false;
    const stamp = nowOf(deps);
    for (const raw of page.items ?? []) {
      const item = parsePlaylistItem(raw);
      if (item === null) {
        continue;
      }
      if (!brandNew && (considered >= newestN || isKnownUpload(deps.db, item.videoId))) {
        done = true;
        break;
      }
      considered += 1;
      result.seen += 1;
      const recent = item.publishedAt === null || item.publishedAt >= cutoff;
      pageHasRecent ||= recent;
      const sighting = recordSighting(
        deps.db,
        {
          videoId: item.videoId,
          channelId: channel.id,
          fill: itemFill(item),
          sources: targets,
        },
        stamp,
      );
      note(result, sighting, item.videoId);
      if (sighting.createdVideo && recent) {
        result.recheckIds.push(item.videoId);
      }
    }
    pageToken = page.nextPageToken;
    if (
      pageToken === undefined ||
      (brandNew && (!pageHasRecent || result.pages >= MAX_BACKFILL_GUARD_PAGES)) ||
      (!brandNew && considered >= newestN)
    ) {
      done = true;
    }
  }
  deps.db.run(
    `UPDATE channels SET last_checked_at = ?,
            uploads_playlist_id = COALESCE(uploads_playlist_id, ?), updated_at = ?
      WHERE id = ?`,
    nowOf(deps),
    uploadsPlaylistOf(channel),
    nowOf(deps),
    channel.id,
  );
  return result;
}

export interface BackfillState {
  done: boolean;
  pageToken: string | null;
  pages: number;
}

export function backfillState(db: Db, channelId: string): BackfillState {
  const stored = getKv<Partial<BackfillState>>(db, CHANNEL_BACKFILL_KV_PREFIX + channelId);
  return {
    done: stored?.done === true,
    pageToken: typeof stored?.pageToken === "string" ? stored.pageToken : null,
    pages: typeof stored?.pages === "number" ? stored.pages : 0,
  };
}

/** Manual channels whose full catalog walk has not finished. */
export function channelsNeedingBackfill(db: Db): string[] {
  return db
    .all<{ channel_id: string }>(
      "SELECT DISTINCT channel_id FROM channel_sources WHERE kind = 'manual' ORDER BY channel_id",
    )
    .map((row) => row.channel_id)
    .filter((id) => !backfillState(db, id).done);
}

/**
 * `ingest_channel_backfill` (leftover class): walk a manual channel's whole
 * uploads playlist, resuming from the stored page token, while
 * `budgetOk()` allows. Creates metadata-only records with a `channel` source;
 * no immediate rechecks (the due pass rechecks them on leftover budget).
 */
export async function ingestChannelBackfill(
  deps: IngestDeps,
  channelId: string,
  result: IngestResult = emptyResult("channel_backfill", null, channelId),
  options: IngestRunOptions & { budgetOk?: () => boolean; accountId?: number } = {},
): Promise<IngestResult> {
  const channel = loadChannel(deps.db, channelId);
  const targets = uploadSources(channelSources(deps.db, channelId), ["manual"]);
  const state = backfillState(deps.db, channelId);
  if (targets.length === 0 || state.done) {
    result.notes["skipped"] = targets.length === 0 ? "not a manual channel" : "caught up";
    return result;
  }
  const accountId = options.accountId ?? requireApiAccount(deps.db, [], "backfill", nowOf(deps));
  result.accountId = accountId;
  const api = meteredApi(deps, accountId, result);
  let pageToken = state.pageToken ?? undefined;
  let pages = state.pages;
  for (let run = 0; run < MAX_DEEP_BACKFILL_PAGES; run += 1) {
    if (options.budgetOk?.() === false) {
      result.notes["paused"] = "leftover budget spent";
      break;
    }
    options.checkpoint?.();
    let page: PlaylistPage;
    try {
      page = await api.get<PlaylistPage>("playlistItems", {
        part: "snippet,contentDetails",
        playlistId: uploadsPlaylistOf(channel),
        maxResults: PLAYLIST_PAGE_SIZE,
        pageToken,
      });
    } catch (error) {
      if (!isPlaylistMissing(error)) {
        throw error;
      }
      page = {};
    }
    result.pages += 1;
    pages += 1;
    const now = nowOf(deps);
    for (const raw of page.items ?? []) {
      const item = parsePlaylistItem(raw);
      if (item === null) {
        continue;
      }
      result.seen += 1;
      const sighting = recordSighting(
        deps.db,
        { videoId: item.videoId, channelId: channel.id, fill: itemFill(item), sources: targets },
        now,
      );
      note(result, sighting, item.videoId);
    }
    pageToken = page.nextPageToken;
    const done = pageToken === undefined;
    setKv(
      deps.db,
      CHANNEL_BACKFILL_KV_PREFIX + channelId,
      { done, pageToken: pageToken ?? null, pages },
      now,
    );
    if (done) {
      result.notes["caughtUp"] = true;
      break;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

interface SubscriptionItem {
  snippet?: {
    publishedAt?: string;
    title?: string;
    resourceId?: { channelId?: string };
    thumbnails?: Record<string, { url?: string } | undefined>;
  };
}

interface SubscriptionPage {
  items?: SubscriptionItem[];
  nextPageToken?: string;
}

function thumbnailOf(
  thumbs: Record<string, { url?: string } | undefined> | undefined,
): string | null {
  for (const size of ["default", "medium", "high"]) {
    const url = thumbs?.[size]?.url;
    if (typeof url === "string") {
      return url;
    }
  }
  return null;
}

/**
 * `ingest_subscriptions`: the full `subscriptions.list mine=true` walk ->
 * channels and `channel_sources(subscription)` with subscribed_at. A channel
 * no longer returned keeps its row (the table has no last-seen column); the
 * run reports it in the activity row instead.
 */
export async function ingestSubscriptions(
  deps: IngestDeps,
  accountId: number,
  result: IngestResult = emptyResult("subscriptions", accountId),
  options: IngestRunOptions = {},
): Promise<IngestResult> {
  const api = meteredApi(deps, accountId, result);
  const seen = new Set<string>();
  let pageToken: string | undefined;
  do {
    options.checkpoint?.();
    const page = await api.get<SubscriptionPage>("subscriptions", {
      part: "snippet",
      mine: true,
      maxResults: PLAYLIST_PAGE_SIZE,
      pageToken,
    });
    result.pages += 1;
    const now = nowOf(deps);
    for (const item of page.items ?? []) {
      const channelId = item.snippet?.resourceId?.channelId;
      if (!isChannelId(channelId) || seen.has(channelId)) {
        continue;
      }
      seen.add(channelId);
      result.seen += 1;
      const subscribedAt = epochOf(item.snippet?.publishedAt);
      deps.db.tx(() => {
        ensureChannel(
          deps.db,
          {
            id: channelId,
            title: item.snippet?.title ?? null,
            thumbnailUrl: thumbnailOf(item.snippet?.thumbnails),
          },
          now,
        );
        const created =
          deps.db.run(
            `INSERT OR IGNORE INTO channel_sources (channel_id, account_id, kind, subscribed_at,
                                                    created_at)
             VALUES (?, ?, 'subscription', ?, ?)`,
            channelId,
            accountId,
            subscribedAt,
            now,
          ).changes > 0;
        if (created) {
          result.newChannels.push(channelId);
        } else if (subscribedAt !== null) {
          deps.db.run(
            `UPDATE channel_sources SET subscribed_at = ?
              WHERE channel_id = ? AND account_id = ? AND kind = 'subscription'
                AND subscribed_at IS NOT ?`,
            subscribedAt,
            channelId,
            accountId,
            subscribedAt,
          );
        }
      });
    }
    pageToken = page.nextPageToken;
  } while (pageToken !== undefined && result.pages < MAX_SUBSCRIPTION_PAGES);

  const complete = pageToken === undefined;
  if (complete) {
    result.missingChannels = deps.db
      .all<{ channel_id: string }>(
        `SELECT channel_id FROM channel_sources
          WHERE account_id = ? AND kind = 'subscription' ORDER BY channel_id`,
        accountId,
      )
      .map((row) => row.channel_id)
      .filter((id) => !seen.has(id));
  }
  if (result.missingChannels.length > 0) {
    logActivity(deps, {
      level: "info",
      kind: "ingest.subscriptions_missing",
      message:
        `${String(result.missingChannels.length)} subscribed channels of account ` +
        `${String(accountId)} are no longer returned by YouTube; their rows are kept.`,
      data: { accountId, channels: result.missingChannels },
    });
  }
  return result;
}
