import { THUMBNAIL_VARIANTS } from "@cellar/shared";
import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Config } from "../config.ts";
import type { Db } from "../db/db.ts";
import { fetchOf, nowOf, type ServiceDeps } from "./deps.ts";

/**
 * Thumbnail variants for the catalog: fetched on a video's first recheck and
 * whenever the API reports a different thumbnail URL, hashed (sha256) and
 * stored on change only under
 * `$DATA_DIR/meta/<channelId>/<videoId>/thumbnails/<variant>-<sha>.jpg`
 * (the same layout the download pipeline writes). `thumbnails.path` is
 * relative to the meta directory.
 */

export type ThumbnailVariant = (typeof THUMBNAIL_VARIANTS)[number];

export const THUMBNAIL_HOST = "https://i.ytimg.com/vi/";
export const THUMBNAIL_TIMEOUT_MS = 15_000;
/** Anything bigger is not a thumbnail. */
export const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;

/** videos.list `snippet.thumbnails` keys and the file variant each one is. */
export const API_THUMBNAIL_KEYS: Readonly<Record<string, ThumbnailVariant>> = {
  default: "default",
  medium: "mqdefault",
  high: "hqdefault",
  standard: "sddefault",
  maxres: "maxresdefault",
};

export type ApiThumbnails = Readonly<Record<string, { url?: string } | undefined>>;

/**
 * The URL to fetch for each wanted variant: the API's URL when the snippet
 * names that variant, else the conventional i.ytimg.com address (hq720 is
 * never in the snippet).
 */
export function thumbnailUrls(
  videoId: string,
  apiThumbnails: ApiThumbnails | undefined,
  variants: readonly ThumbnailVariant[],
): Map<ThumbnailVariant, string> {
  const fromApi = new Map<ThumbnailVariant, string>();
  for (const [key, variant] of Object.entries(API_THUMBNAIL_KEYS)) {
    const url = apiThumbnails?.[key]?.url;
    if (typeof url === "string" && url !== "") {
      fromApi.set(variant, url);
    }
  }
  const out = new Map<ThumbnailVariant, string>();
  for (const variant of variants) {
    out.set(
      variant,
      fromApi.get(variant) ?? `${THUMBNAIL_HOST}${encodeURIComponent(videoId)}/${variant}.jpg`,
    );
  }
  return out;
}

interface LatestRow {
  id: number;
  variant: string;
  url: string;
  sha256: string;
}

function latestByVariant(db: Db, videoId: string): Map<string, LatestRow> {
  const out = new Map<string, LatestRow>();
  for (const row of db.all<LatestRow>(
    `SELECT id, variant, url, sha256 FROM thumbnails
      WHERE video_id = ? ORDER BY first_seen_at DESC, id DESC`,
    videoId,
  )) {
    if (!out.has(row.variant)) {
      out.set(row.variant, row);
    }
  }
  return out;
}

/**
 * True on the first recheck (nothing stored) and when a variant the API names
 * has no stored row or its latest stored URL differs from the API's.
 */
export function thumbnailsNeedRefresh(
  db: Db,
  videoId: string,
  apiThumbnails: ApiThumbnails | undefined,
): boolean {
  const latest = latestByVariant(db, videoId);
  if (latest.size === 0) {
    return true;
  }
  for (const [key, variant] of Object.entries(API_THUMBNAIL_KEYS)) {
    const url = apiThumbnails?.[key]?.url;
    if (typeof url !== "string" || url === "") {
      continue;
    }
    if (latest.get(variant)?.url !== url) {
      return true;
    }
  }
  return false;
}

/** Relative path (always `/`-separated) of a stored thumbnail under the meta dir. */
export function thumbnailRelPath(
  channelId: string,
  videoId: string,
  variant: string,
  sha256: string,
): string {
  return `${channelId}/${videoId}/thumbnails/${variant}-${sha256}.jpg`;
}

export interface ThumbnailRefreshResult {
  /** New hashes written to disk and to the table. */
  stored: number;
  /** Fetched, same hash as the latest stored one. */
  unchanged: number;
  /** Not offered by YouTube (404). */
  missing: number;
  /** Fetch errors, timeouts, empty or oversized bodies. */
  failed: number;
}

export type ThumbnailDeps = Pick<ServiceDeps, "db" | "log" | "fetch" | "now"> & {
  config: Pick<Config, "metaDir">;
};

async function download(deps: ThumbnailDeps, url: string): Promise<Buffer | number | null> {
  try {
    const response = await fetchOf(deps)(url, {
      signal: AbortSignal.timeout(THUMBNAIL_TIMEOUT_MS),
    });
    if (!response.ok) {
      return response.status;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.length === 0 || bytes.length > MAX_THUMBNAIL_BYTES ? null : bytes;
  } catch (error) {
    deps.log.debug({ err: error }, "thumbnail fetch failed");
    return null;
  }
}

/**
 * Fetch every URL, hash it, and store the file plus a `thumbnails` row when
 * the hash differs from the latest stored one for that variant. A same-hash
 * fetch under a new URL only moves the latest row's URL forward, so the next
 * recheck does not see a "changed" URL again. Never throws for network
 * trouble; the counts say what happened.
 */
export async function refreshThumbnails(
  deps: ThumbnailDeps,
  input: { videoId: string; channelId: string; urls: ReadonlyMap<string, string> },
): Promise<ThumbnailRefreshResult> {
  const result: ThumbnailRefreshResult = { stored: 0, unchanged: 0, missing: 0, failed: 0 };
  for (const [variant, url] of input.urls) {
    const body = await download(deps, url);
    if (typeof body === "number") {
      if (body === 404) {
        result.missing += 1;
      } else {
        result.failed += 1;
      }
      continue;
    }
    if (body === null) {
      result.failed += 1;
      continue;
    }
    const sha256 = createHash("sha256").update(body).digest("hex");
    const latest = latestByVariant(deps.db, input.videoId).get(variant);
    if (latest?.sha256 === sha256) {
      if (latest.url !== url) {
        deps.db.run("UPDATE thumbnails SET url = ? WHERE id = ?", url, latest.id);
      }
      result.unchanged += 1;
      continue;
    }
    const relPath = thumbnailRelPath(input.channelId, input.videoId, variant, sha256);
    const absolute = join(deps.config.metaDir, ...relPath.split("/"));
    try {
      await mkdir(dirname(absolute), { recursive: true });
      const partial = `${absolute}.part`;
      await writeFile(partial, body);
      await rename(partial, absolute);
    } catch (error) {
      deps.log.warn({ err: error, videoId: input.videoId, variant }, "could not store thumbnail");
      result.failed += 1;
      continue;
    }
    deps.db.run(
      `INSERT INTO thumbnails (video_id, variant, url, sha256, path, first_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (video_id, variant, sha256) DO UPDATE SET url = excluded.url,
         first_seen_at = excluded.first_seen_at`,
      input.videoId,
      variant,
      url,
      sha256,
      relPath,
      nowOf(deps),
    );
    result.stored += 1;
  }
  return result;
}
