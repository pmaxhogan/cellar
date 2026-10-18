import {
  SHARE_DESCRIPTION_MAX,
  SHARE_TOKEN_RE,
  type ShareCreateRequest,
  type ShareFilter,
  type ShareLinkRow,
  type SharePublicData,
  type ShareRevokeBulkRequest,
  type ShareSort,
  type ShareStatus,
  type SharesListQuery,
} from "@cellar/shared";
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { Db } from "../db/db.ts";
import { pagedQuery, parseJsonColumn, Where, type Paged } from "../db/paged.ts";
import type { EventBus } from "../events.ts";
import { logActivity } from "./activity.ts";
import { conflict, invalid, isUniqueViolation, notFound } from "./errors.ts";
import { contentTypeFor, currentMedia, resolveMediaPath, thumbnailPath } from "./videoFiles.ts";

/**
 * Public share links (ARCHITECTURE "Share links and the public surface").
 *
 * A token is 16 CSPRNG bytes in base64url (22 characters), stored in
 * plaintext by the owner's decision. A link is valid iff it exists, is not
 * revoked, and has no expiry or one in the future. The admin side lists,
 * creates, revokes and deletes links; the public side (public/share.ts) asks
 * only resolveActiveShare, recordShareAccess and the payload builders below,
 * which pick every field explicitly so nothing private can ride along.
 */

export interface ShareCtx {
  db: Db;
  /** PUBLIC_ORIGIN without a trailing slash. */
  publicOrigin: string;
  events?: EventBus | undefined;
  now?: () => number;
}

/** 16 random bytes as base64url: always 22 characters from [A-Za-z0-9_-]. */
export function generateShareToken(random: (size: number) => Buffer = randomBytes): string {
  return random(16).toString("base64url");
}

export function isShareToken(value: unknown): value is string {
  return typeof value === "string" && SHARE_TOKEN_RE.test(value);
}

/** Revoked wins over expired; an expiry exactly at `now` has expired. */
export function shareStatus(
  link: { expires_at: number | null; revoked_at: number | null },
  now: number,
): ShareStatus {
  if (link.revoked_at !== null) {
    return "revoked";
  }
  return link.expires_at !== null && link.expires_at <= now ? "expired" : "active";
}

export function shareUrl(publicOrigin: string, token: string): string {
  return `${publicOrigin}/s/${token}`;
}

// ---------------------------------------------------------------------------
// Admin: list, read, create, revoke, delete
// ---------------------------------------------------------------------------

interface ShareDbRow {
  token: string;
  video_id: string;
  title: string | null;
  channel_title: string | null;
  expires_at: number | null;
  revoked_at: number | null;
  access_count: number;
  last_access_at: number | null;
  created_at: number;
}

const SHARE_SELECT = `s.token, s.video_id, v.title, c.title AS channel_title, s.expires_at,
  s.revoked_at, s.access_count, s.last_access_at, s.created_at`;
const SHARE_FROM = `share_links s
  JOIN videos v ON v.id = s.video_id
  LEFT JOIN channels c ON c.id = v.channel_id`;

const SORT_SQL: Record<ShareSort, (dir: "ASC" | "DESC") => string> = {
  created_at: (dir) => `s.created_at ${dir}`,
  // NULL means never, which is later than any date: last ascending, first descending.
  expires_at: (dir) => `(s.expires_at IS NULL) ${dir}, s.expires_at ${dir}`,
  access_count: (dir) => `s.access_count ${dir}`,
  // NULL means never opened, which sorts as the oldest.
  last_access_at: (dir) => `s.last_access_at ${dir}`,
};

/** `%`, `_` and the escape character itself are literal in a LIKE pattern. */
export function likeContains(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function filterWhere(filter: ShareFilter, now: number): Where {
  const where = new Where();
  const q = filter.q?.trim();
  if (q !== undefined && q !== "") {
    const pattern = likeContains(q);
    where.add("(v.title LIKE ? ESCAPE '\\' OR s.token LIKE ? ESCAPE '\\')", pattern, pattern);
  }
  where.maybe("s.video_id = ?", filter.video_id);
  if (filter.status === "revoked") {
    where.add("s.revoked_at IS NOT NULL");
  } else if (filter.status === "expired") {
    where.add("s.revoked_at IS NULL AND s.expires_at IS NOT NULL AND s.expires_at <= ?", now);
  } else if (filter.status === "active") {
    where.add("s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?)", now);
  }
  return where;
}

function toRow(ctx: ShareCtx, row: ShareDbRow, now: number): ShareLinkRow {
  return {
    ...row,
    url: shareUrl(ctx.publicOrigin, row.token),
    status: shareStatus(row, now),
  };
}

function clock(ctx: ShareCtx): number {
  return (ctx.now ?? Date.now)();
}

/** The Share links page datatable. */
export function listShares(ctx: ShareCtx, query: SharesListQuery): Paged<ShareLinkRow> {
  const now = clock(ctx);
  const dir = query.dir === "asc" ? "ASC" : "DESC";
  return pagedQuery<ShareDbRow, ShareLinkRow>(ctx.db, {
    select: SHARE_SELECT,
    from: SHARE_FROM,
    where: filterWhere(query, now),
    orderBy: `${SORT_SQL[query.sort](dir)}, s.token ASC`,
    page: query.page,
    perPage: query.perPage,
    map: (row) => toRow(ctx, row, now),
  });
}

/** One link by token, or not_found. */
export function getShare(ctx: ShareCtx, token: string): ShareLinkRow {
  const row = ctx.db.get<ShareDbRow>(
    `SELECT ${SHARE_SELECT} FROM ${SHARE_FROM} WHERE s.token = ?`,
    token,
  );
  if (row === undefined) {
    throw notFound("Share link", token);
  }
  return toRow(ctx, row, clock(ctx));
}

/** The first characters of a token: enough to tell links apart in the activity log. */
function tokenHint(token: string): string {
  return token.slice(0, 6);
}

/**
 * Create a link. The video must be in the catalog (not_found otherwise) and an
 * expiry must lie in the future (invalid otherwise).
 */
export function createShare(
  ctx: ShareCtx,
  input: ShareCreateRequest,
  random?: (size: number) => Buffer,
): ShareLinkRow {
  const now = clock(ctx);
  if (ctx.db.get("SELECT 1 AS one FROM videos WHERE id = ?", input.video_id) === undefined) {
    throw notFound("Video", input.video_id);
  }
  if (input.expires_at !== null && input.expires_at <= now) {
    throw invalid("The expiry must be in the future.");
  }
  const insert = (): string => {
    for (let attempt = 0; ; attempt += 1) {
      const candidate = generateShareToken(random);
      try {
        ctx.db.run(
          `INSERT INTO share_links (token, video_id, expires_at, created_at) VALUES (?, ?, ?, ?)`,
          candidate,
          input.video_id,
          input.expires_at,
          now,
        );
        return candidate;
      } catch (error) {
        // 2^128 tokens make a collision a broken RNG, not bad luck: retry twice, then fail.
        if (!isUniqueViolation(error) || attempt >= 2) {
          throw error;
        }
      }
    }
  };
  const token = insert();
  logActivity(
    { db: ctx.db, events: ctx.events, now: () => now },
    {
      kind: "share.created",
      message:
        input.expires_at === null
          ? "Share link created (never expires)"
          : `Share link created (expires ${new Date(input.expires_at).toISOString()})`,
      videoId: input.video_id,
      data: { token_hint: tokenHint(token), expires_at: input.expires_at },
    },
  );
  return getShare(ctx, token);
}

/** Revoke one link. Idempotent: an already revoked link keeps its revoked_at. */
export function revokeShare(ctx: ShareCtx, token: string): ShareLinkRow {
  const now = clock(ctx);
  const before = getShare(ctx, token);
  if (before.revoked_at !== null) {
    return before;
  }
  ctx.db.run(
    "UPDATE share_links SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL",
    now,
    token,
  );
  logActivity(
    { db: ctx.db, events: ctx.events, now: () => now },
    {
      kind: "share.revoked",
      message: "Share link revoked",
      videoId: before.video_id,
      data: { token_hint: tokenHint(token) },
    },
  );
  return getShare(ctx, token);
}

/** Revoke by token list or by filter. Returns how many links were newly revoked. */
export function revokeShares(ctx: ShareCtx, request: ShareRevokeBulkRequest): number {
  const now = clock(ctx);
  const count = ctx.db.tx(() => {
    if ("tokens" in request) {
      let changed = 0;
      const tokens = [...new Set(request.tokens)];
      for (let index = 0; index < tokens.length; index += 500) {
        const chunk = tokens.slice(index, index + 500);
        changed += ctx.db.run(
          `UPDATE share_links SET revoked_at = ?
            WHERE revoked_at IS NULL AND token IN (${chunk.map(() => "?").join(", ")})`,
          now,
          ...chunk,
        ).changes;
      }
      return changed;
    }
    const where = filterWhere(request.all_matching, now);
    return ctx.db.run(
      `UPDATE share_links SET revoked_at = ?
        WHERE revoked_at IS NULL
          AND token IN (SELECT s.token FROM ${SHARE_FROM} ${where.sql})`,
      now,
      ...where.params,
    ).changes;
  });
  if (count > 0) {
    logActivity(
      { db: ctx.db, events: ctx.events, now: () => now },
      {
        kind: "share.revoked",
        message: `${String(count)} share link${count === 1 ? "" : "s"} revoked`,
        data: { count, mode: "tokens" in request ? "selected" : "all_matching" },
      },
    );
  }
  return count;
}

/** Hard delete. Only a revoked link may be deleted (conflict otherwise). */
export function deleteShare(ctx: ShareCtx, token: string): void {
  const link = getShare(ctx, token);
  if (link.revoked_at === null) {
    throw conflict("Revoke the link before deleting it.");
  }
  ctx.db.run("DELETE FROM share_links WHERE token = ?", token);
}

// ---------------------------------------------------------------------------
// Public side
// ---------------------------------------------------------------------------

export interface ActiveShare {
  token: string;
  video_id: string;
}

/** The link behind `token` when it is valid right now; null for every other case. */
export function resolveActiveShare(db: Db, token: unknown, now: number): ActiveShare | null {
  if (!isShareToken(token)) {
    return null;
  }
  return (
    db.get<ActiveShare>(
      `SELECT token, video_id FROM share_links
        WHERE token = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
      token,
      now,
    ) ?? null
  );
}

/** One page view: bump the counter and the last access time atomically. */
export function recordShareAccess(db: Db, token: string, now: number): void {
  db.run(
    `UPDATE share_links SET access_count = access_count + 1, last_access_at = ?
      WHERE token = ?`,
    now,
    token,
  );
}

let displayNames: Intl.DisplayNames | null | undefined;

/** An English name for a caption language code; the code itself when unknown. */
export function captionLabel(lang: string): string {
  if (displayNames === undefined) {
    try {
      displayNames = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });
    } catch {
      displayNames = null;
    }
  }
  try {
    const name = displayNames?.of(lang.replace(/_/g, "-"));
    return name === undefined || name === "" ? lang : name;
  } catch {
    return lang;
  }
}

interface PublicVideoRow {
  id: string;
  title: string | null;
  channel_title: string | null;
  upload_date: number | null;
  duration_s: number | null;
  description: string | null;
  views: number | null;
  likes: number | null;
}

function publicVideo(db: Db, videoId: string): PublicVideoRow {
  const row = db.get<PublicVideoRow>(
    `SELECT v.id, v.title, c.title AS channel_title, v.upload_date, v.duration_s,
            v.description, v.views, v.likes
       FROM videos v LEFT JOIN channels c ON c.id = v.channel_id WHERE v.id = ?`,
    videoId,
  );
  if (row === undefined) {
    throw notFound("Video", videoId);
  }
  return row;
}

/** Current caption languages of a video, sorted. */
export function captionLangs(db: Db, videoId: string): string[] {
  return db
    .all<{ lang: string }>(
      `SELECT DISTINCT lang FROM media
        WHERE video_id = ? AND kind = 'captions' AND is_current = 1 AND lang IS NOT NULL
        ORDER BY lang`,
      videoId,
    )
    .map((row) => row.lang);
}

/** The payload the public page renders, injected into share.html and served at /meta. */
export function sharePublicData(db: Db, metaDir: string, share: ActiveShare): SharePublicData {
  const video = publicVideo(db, share.video_id);
  const base = `/s/${share.token}`;
  const videoMedia = currentMedia(db, video.id, "video");
  const audioMedia = currentMedia(db, video.id, "audio");
  const played = videoMedia ?? audioMedia;
  const langs = captionLangs(db, video.id);
  const captions: Record<string, string> = {};
  for (const lang of langs) {
    captions[lang] = `${base}/captions/${encodeURIComponent(lang)}`;
  }
  return {
    token: share.token,
    video: {
      id: video.id,
      title: video.title,
      channel_title: video.channel_title,
      upload_date: video.upload_date,
      duration_s: video.duration_s,
      description:
        video.description === null ? null : video.description.slice(0, SHARE_DESCRIPTION_MAX),
      views: video.views,
      likes: video.likes,
    },
    media:
      played === undefined
        ? null
        : {
            kind: played.kind === "video" ? "video" : "audio",
            mime: contentTypeFor(played.rel_path),
            size_bytes: played.size_bytes,
            height: played.height,
            has_audio_only: audioMedia !== undefined,
          },
    captions: langs.map((lang) => ({ lang, label: captionLabel(lang) })),
    thumbnail: thumbnailPath(db, metaDir, video.id, "best") !== undefined,
    downloads: {
      ...(videoMedia === undefined ? {} : { video: `${base}/video` }),
      ...(audioMedia === undefined ? {} : { audio: `${base}/audio` }),
      captions,
      metadata: `${base}/metadata.json`,
    },
  };
}

/**
 * Top level info.json keys a share may expose. An allowlist, not a denylist:
 * yt-dlp also writes container paths (_filename, filepath), request headers,
 * signed format URLs that embed the server's address, and playlist fields
 * that name the owner's lists (Watch Later, Liked), none of which may leave.
 */
export const PUBLIC_INFO_KEYS: readonly string[] = [
  "id",
  "title",
  "fulltitle",
  "description",
  "uploader",
  "uploader_id",
  "uploader_url",
  "channel",
  "channel_id",
  "channel_url",
  "channel_follower_count",
  "channel_is_verified",
  "upload_date",
  "timestamp",
  "release_date",
  "release_timestamp",
  "modified_date",
  "duration",
  "duration_string",
  "view_count",
  "like_count",
  "comment_count",
  "average_rating",
  "categories",
  "tags",
  "age_limit",
  "live_status",
  "is_live",
  "was_live",
  "availability",
  "webpage_url",
  "chapters",
  "heatmap",
  "thumbnail",
  "thumbnails",
  "language",
  "license",
  "location",
  "creators",
  "artists",
  "track",
  "album",
  "width",
  "height",
  "fps",
  "resolution",
  "aspect_ratio",
  "dynamic_range",
  "vcodec",
  "acodec",
  "ext",
  "format_id",
  "format_note",
  "extractor",
  "extractor_key",
  "display_id",
];

/** Largest stored info.json a share will parse; a bigger one falls back to the row. */
export const MAX_PUBLIC_INFO_BYTES = 32 * 1024 * 1024;

/** Keep only the allowlisted keys of a parsed info.json; null when it is not an object. */
export function pickPublicInfo(info: unknown): Record<string, unknown> | null {
  if (typeof info !== "object" || info === null || Array.isArray(info)) {
    return null;
  }
  const record = info as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of PUBLIC_INFO_KEYS) {
    if (Object.prototype.hasOwnProperty.call(record, key) && record[key] !== undefined) {
      out[key] = record[key];
    }
  }
  return out;
}

function storedInfo(db: Db, metaDir: string, videoId: string): Record<string, unknown> | null {
  const info = currentMedia(db, videoId, "info");
  if (info === undefined) {
    return null;
  }
  try {
    const path = resolveMediaPath(db, metaDir, info);
    if (statSync(path).size > MAX_PUBLIC_INFO_BYTES) {
      return null;
    }
    return pickPublicInfo(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return null;
  }
}

function parseTags(json: string | null): string[] {
  const parsed = parseJsonColumn(json);
  return Array.isArray(parsed)
    ? parsed.filter((tag): tag is string => typeof tag === "string")
    : [];
}

/**
 * The downloadable metadata of a shared video: the stored info.json reduced to
 * PUBLIC_INFO_KEYS, else an explicit subset of the catalog row. Both carry
 * `share: true`. Never the detail row itself, which names sources, rules,
 * locations, file paths and every other link to the video.
 */
export function sharePublicMetadata(
  db: Db,
  metaDir: string,
  videoId: string,
): Record<string, unknown> {
  const stored = storedInfo(db, metaDir, videoId);
  if (stored !== null) {
    return { ...stored, share: true };
  }
  const row = db.get<{
    id: string;
    title: string | null;
    description: string | null;
    channel_id: string | null;
    channel_title: string | null;
    upload_date: number | null;
    published_at: number | null;
    duration_s: number | null;
    type: string | null;
    live_status: string | null;
    category_id: string | null;
    default_language: string | null;
    tags_json: string | null;
    views: number | null;
    likes: number | null;
    comments: number | null;
  }>(
    `SELECT v.id, v.title, v.description, v.channel_id, c.title AS channel_title,
            v.upload_date, v.published_at, v.duration_s, v.type, v.live_status, v.category_id,
            v.default_language, v.tags_json, v.views, v.likes, v.comments
       FROM videos v LEFT JOIN channels c ON c.id = v.channel_id WHERE v.id = ?`,
    videoId,
  );
  if (row === undefined) {
    throw notFound("Video", videoId);
  }
  const { tags_json: tagsJson, ...rest } = row;
  return { ...rest, tags: parseTags(tagsJson), share: true };
}
