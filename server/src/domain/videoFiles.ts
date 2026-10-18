import { createReadStream, realpathSync, statSync, type ReadStream, type Stats } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Db } from "../db/db.ts";
import { DomainError, notFound } from "./errors.ts";

/**
 * Files behind the catalog: media rows, captions, info.json and thumbnails.
 *
 * Every path read from the database is resolved under its root (the
 * location's container_path, or $DATA_DIR/meta for rows without a location)
 * and refused when it would land outside it, lexically and, when the file
 * exists, after symlinks are resolved. A refused path reads as "not found" so
 * nothing about the layout on disk reaches a client.
 */

/** Media type by extension. Anything else is served as application/octet-stream. */
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".mkv": "video/x-matroska",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".opus": "audio/ogg",
  ".ogg": "audio/ogg",
  ".vtt": "text/vtt; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".json": "application/json; charset=utf-8",
};

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** Thumbnail preference, best first. `hq720` (1280x720) ranks just below maxres. */
export const THUMBNAIL_FALLBACK = [
  "maxresdefault",
  "hq720",
  "sddefault",
  "hqdefault",
  "mqdefault",
  "default",
] as const;

/** The pseudo variant that means "the best stored one". */
export const BEST_THUMBNAIL = "best";

function fileMissing(): DomainError {
  return new DomainError("not_found", "The file is not available.");
}

/**
 * Join `rel` under `root` and return the absolute path, or null when the
 * result would not be strictly inside `root`. A relative `rel` must use `/`
 * separators and contain no `..` segment or backslash; an absolute `rel` is
 * accepted only with `allowAbsolute` and only when it already lies under
 * `root`. Purely lexical: see realPathWithin for symlinks.
 */
export function resolveUnder(
  root: string,
  rel: string,
  options: { allowAbsolute?: boolean } = {},
): string | null {
  if (rel === "" || rel.includes("\0")) {
    return null;
  }
  const base = resolve(root);
  let target: string;
  if (isAbsolute(rel) || rel.startsWith("/")) {
    if (options.allowAbsolute !== true) {
      return null;
    }
    target = resolve(rel);
  } else {
    if (rel.includes("\\") || rel.split("/").some((segment) => segment === "..")) {
      return null;
    }
    target = resolve(base, rel);
  }
  return isStrictlyInside(base, target) ? target : null;
}

function isStrictlyInside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * The symlink check: true when `target` does not exist (the caller's open
 * fails later) or its real path is inside the real path of `root`.
 */
export function realPathWithin(root: string, target: string): boolean {
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    return true;
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return false;
  }
  return isStrictlyInside(realRoot, real);
}

export interface MediaLocationRef {
  location_id: number | null;
  rel_path: string;
}

/** The root a media row lives under: its location's container path, or the meta dir. */
export function mediaRoot(db: Db, metaDir: string, locationId: number | null): string {
  if (locationId === null) {
    return metaDir;
  }
  const row = db.get<{ container_path: string }>(
    "SELECT container_path FROM locations WHERE id = ?",
    locationId,
  );
  if (row === undefined) {
    throw fileMissing();
  }
  return row.container_path;
}

/**
 * Absolute path of a media row's file. Throws not_found when the location is
 * gone or the stored rel_path would escape its root.
 */
export function resolveMediaPath(db: Db, metaDir: string, media: MediaLocationRef): string {
  const root = mediaRoot(db, metaDir, media.location_id);
  const path = resolveUnder(root, media.rel_path);
  if (path === null || !realPathWithin(root, path)) {
    throw fileMissing();
  }
  return path;
}

export interface RangeSpan {
  start: number;
  /** Inclusive. */
  end: number;
}

/**
 * Parse a Range header against a file of `size` bytes (RFC 9110 14.1.2).
 * Returns the span, "unsatisfiable" (answer 416), or null when the header is
 * absent, malformed or asks for several ranges (answer 200 with the whole
 * file, which the RFC allows).
 */
export function parseRange(
  header: string | undefined,
  size: number,
): RangeSpan | "unsatisfiable" | null {
  if (header === undefined) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) {
    return null;
  }
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") {
    return null;
  }
  if (first === "") {
    const suffix = Number(last);
    if (suffix === 0 || size === 0) {
      return "unsatisfiable";
    }
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  const end = last === "" ? Number.MAX_SAFE_INTEGER : Number(last);
  if (end < start) {
    return null;
  }
  if (start >= size) {
    return "unsatisfiable";
  }
  return { start, end: Math.min(end, size - 1) };
}

export interface RangeResult {
  status: 200 | 206 | 416;
  headers: Record<string, string>;
  /** Null for a 416 and for HEAD. */
  stream: ReadStream | null;
}

function statFile(path: string): Stats {
  let stats: Stats;
  try {
    stats = statSync(path);
  } catch {
    throw fileMissing();
  }
  if (!stats.isFile()) {
    throw fileMissing();
  }
  return stats;
}

/**
 * Open `path` for an HTTP answer honouring `rangeHeader`. Throws not_found
 * when the file is missing. With `head` no stream is opened.
 */
export function openRangeStream(
  path: string,
  rangeHeader: string | undefined,
  options: { head?: boolean } = {},
): RangeResult {
  const stats = statFile(path);
  const size = stats.size;
  const headers: Record<string, string> = {
    "content-type": contentTypeFor(path),
    "accept-ranges": "bytes",
    "last-modified": stats.mtime.toUTCString(),
  };
  const span = parseRange(rangeHeader, size);
  if (span === "unsatisfiable") {
    return {
      status: 416,
      headers: { ...headers, "content-range": `bytes */${String(size)}` },
      stream: null,
    };
  }
  if (span === null) {
    return {
      status: 200,
      headers: { ...headers, "content-length": String(size) },
      stream: options.head === true ? null : createReadStream(path),
    };
  }
  return {
    status: 206,
    headers: {
      ...headers,
      "content-length": String(span.end - span.start + 1),
      "content-range": `bytes ${String(span.start)}-${String(span.end)}/${String(size)}`,
    },
    stream:
      options.head === true ? null : createReadStream(path, { start: span.start, end: span.end }),
  };
}

export interface ThumbnailRecord {
  variant: string;
  sha256: string;
  path: string;
  first_seen_at: number;
}

/**
 * The thumbnail to serve for `variant` from rows ordered newest first: the
 * newest row of that variant, else the newest of the next best variant in
 * THUMBNAIL_FALLBACK. `best` walks the fallback list from the top.
 */
export function pickThumbnail<T extends { variant: string }>(
  rows: readonly T[],
  variant: string,
): T | undefined {
  const order =
    variant === BEST_THUMBNAIL
      ? [...THUMBNAIL_FALLBACK]
      : [variant, ...THUMBNAIL_FALLBACK.filter((candidate) => candidate !== variant)];
  for (const candidate of order) {
    const hit = rows.find((row) => row.variant === candidate);
    if (hit !== undefined) {
      return hit;
    }
  }
  return undefined;
}

export interface ResolvedThumbnail {
  variant: string;
  sha256: string;
  path: string;
}

/**
 * Absolute path of the thumbnail to serve, or undefined when none is stored.
 * With `sha256` the exact stored image of that variant is served (no
 * fallback). thumbnails.path may be relative to the meta dir or absolute under
 * it; anything else is refused as missing.
 */
export function thumbnailPath(
  db: Db,
  metaDir: string,
  videoId: string,
  variant: string,
  sha256?: string,
): ResolvedThumbnail | undefined {
  const rows = db.all<ThumbnailRecord>(
    `SELECT variant, sha256, path, first_seen_at FROM thumbnails
      WHERE video_id = ? ORDER BY first_seen_at DESC, id DESC`,
    videoId,
  );
  const row =
    sha256 === undefined
      ? pickThumbnail(rows, variant)
      : rows.find((candidate) => candidate.variant === variant && candidate.sha256 === sha256);
  if (row === undefined) {
    return undefined;
  }
  const path = resolveUnder(metaDir, row.path, { allowAbsolute: true });
  if (path === null || !realPathWithin(metaDir, path)) {
    return undefined;
  }
  return { variant: row.variant, sha256: row.sha256, path };
}

export interface MediaRecord {
  id: number;
  video_id: string;
  kind: "video" | "audio" | "captions" | "info";
  version: number;
  is_current: number;
  location_id: number | null;
  rel_path: string;
  size_bytes: number;
  height: number | null;
  lang: string | null;
}

const MEDIA_RECORD_COLUMNS =
  "id, video_id, kind, version, is_current, location_id, rel_path, size_bytes, height, lang";

/** One media row of a video, or not_found. */
export function getMediaRecord(db: Db, videoId: string, mediaId: number): MediaRecord {
  const row = db.get<MediaRecord>(
    `SELECT ${MEDIA_RECORD_COLUMNS} FROM media WHERE id = ? AND video_id = ?`,
    mediaId,
    videoId,
  );
  if (row === undefined) {
    throw notFound("Media", mediaId);
  }
  return row;
}

/** The current media row of `kind` (newest version first), optionally for one language. */
export function currentMedia(
  db: Db,
  videoId: string,
  kind: MediaRecord["kind"],
  lang?: string,
): MediaRecord | undefined {
  return lang === undefined
    ? db.get<MediaRecord>(
        `SELECT ${MEDIA_RECORD_COLUMNS} FROM media
          WHERE video_id = ? AND kind = ? AND is_current = 1
          ORDER BY version DESC, id DESC LIMIT 1`,
        videoId,
        kind,
      )
    : db.get<MediaRecord>(
        `SELECT ${MEDIA_RECORD_COLUMNS} FROM media
          WHERE video_id = ? AND kind = ? AND is_current = 1 AND lang = ?
          ORDER BY version DESC, id DESC LIMIT 1`,
        videoId,
        kind,
        lang,
      );
}

/** Every current media row of the given kinds for a set of videos, newest version first. */
export function currentMediaFor(
  db: Db,
  videoIds: readonly string[],
  kinds: readonly MediaRecord["kind"][],
): MediaRecord[] {
  if (videoIds.length === 0 || kinds.length === 0) {
    return [];
  }
  const out: MediaRecord[] = [];
  // Chunked so a 10k id request stays under sqlite's bound parameter limit.
  for (let index = 0; index < videoIds.length; index += 500) {
    const chunk = videoIds.slice(index, index + 500);
    out.push(
      ...db.all<MediaRecord>(
        `SELECT ${MEDIA_RECORD_COLUMNS} FROM media
          WHERE is_current = 1
            AND video_id IN (${chunk.map(() => "?").join(", ")})
            AND kind IN (${kinds.map(() => "?").join(", ")})
          ORDER BY video_id, kind, version DESC, id DESC`,
        ...chunk,
        ...kinds,
      ),
    );
  }
  return out;
}
