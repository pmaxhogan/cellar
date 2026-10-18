import { mkdir, unlink } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { Db } from "../db/db.ts";
import { atomicRename, listFiles, resolveRel, sha256File, thumbnailRel } from "./paths.ts";

/**
 * Thumbnail sidecars (open call 8). `--write-all-thumbnails` makes yt-dlp
 * write `<id>.<thumbnail id>.<ext>` per thumbnail (YouTube's ids are numeric,
 * the fake shim uses variant names) and sometimes a bare `<id>.<ext>`. Each
 * file is mapped back to a YouTube variant (`maxresdefault`, `hq720`, ...)
 * through the info dict's `thumbnails` list, filtered by the
 * `thumbnails.variants` setting, hashed, and stored on change only as
 * `<metaDir>/<channel>/<id>/thumbnails/<variant>-<sha>.<ext>` with a
 * `thumbnails` row. The extension is kept (YouTube also serves WebP), so a
 * file is never mislabelled as JPEG.
 */

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".webp", ".png"]);
const VARIANT_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface ThumbnailFile {
  path: string;
  /** The segment between `<id>.` and the extension; null for the bare `<id>.<ext>`. */
  segment: string | null;
  ext: string;
}

export async function findThumbnailFiles(dir: string, videoId: string): Promise<ThumbnailFile[]> {
  const out: ThumbnailFile[] = [];
  const prefix = `${videoId}.`;
  for (const path of await listFiles(dir)) {
    const name = basename(path);
    const ext = extname(name).toLowerCase();
    if (!name.startsWith(prefix) || !IMAGE_EXTS.has(ext)) {
      continue;
    }
    const middle = name.slice(prefix.length, name.length - ext.length);
    out.push({ path, segment: middle === "" ? null : middle, ext: ext.slice(1) });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

interface InfoThumbnail {
  id?: unknown;
  url?: unknown;
}

/** `https://i.ytimg.com/vi/ID/hq720.jpg?sqp=...` -> `hq720`. */
export function variantFromUrl(url: string): string | null {
  try {
    const last = new URL(url).pathname.split("/").pop() ?? "";
    const stem = last.replace(/\.[A-Za-z0-9]+$/, "");
    return VARIANT_RE.test(stem) ? stem : null;
  } catch {
    return null;
  }
}

/** Map a written file to its variant and source URL. */
export function resolveThumbnail(
  file: ThumbnailFile,
  info: Record<string, unknown> | null,
  videoId: string,
): { variant: string; url: string } | null {
  const thumbs = Array.isArray(info?.thumbnails) ? (info.thumbnails as InfoThumbnail[]) : [];
  let url: string | null;
  if (file.segment === null) {
    url = typeof info?.thumbnail === "string" ? info.thumbnail : null;
  } else {
    const match = thumbs.find(
      (thumb) =>
        (typeof thumb.id === "string" && thumb.id === file.segment) ||
        (typeof thumb.url === "string" && variantFromUrl(thumb.url) === file.segment),
    );
    url = typeof match?.url === "string" ? match.url : null;
  }
  const variant = (url === null ? null : variantFromUrl(url)) ?? file.segment;
  if (variant === null || !VARIANT_RE.test(variant)) {
    return null;
  }
  return { variant, url: url ?? `https://i.ytimg.com/vi/${videoId}/${variant}.jpg` };
}

export interface StoredThumbnail {
  variant: string;
  sha256: string;
  relPath: string;
  /** False when this exact image was already stored. */
  isNew: boolean;
}

/**
 * Hash, dedupe and store every wanted thumbnail file. Files that are not
 * kept are deleted from the in-flight dir.
 */
export async function storeThumbnails(input: {
  db: Db;
  files: readonly ThumbnailFile[];
  info: Record<string, unknown> | null;
  metaDir: string;
  channelId: string | null;
  videoId: string;
  variants: readonly string[];
  now: number;
}): Promise<StoredThumbnail[]> {
  const wanted = new Set(input.variants);
  const seen = new Set<string>();
  const out: StoredThumbnail[] = [];
  for (const file of input.files) {
    const resolved = resolveThumbnail(file, input.info, input.videoId);
    if (resolved === null || !wanted.has(resolved.variant)) {
      await unlink(file.path).catch(() => undefined);
      continue;
    }
    const sha256 = await sha256File(file.path);
    const key = `${resolved.variant}:${sha256}`;
    const exists =
      seen.has(key) ||
      input.db.get(
        "SELECT 1 AS one FROM thumbnails WHERE video_id = ? AND variant = ? AND sha256 = ?",
        input.videoId,
        resolved.variant,
        sha256,
      ) !== undefined;
    const rel = thumbnailRel(input.channelId, input.videoId, resolved.variant, sha256, file.ext);
    if (exists) {
      await unlink(file.path).catch(() => undefined);
      if (!seen.has(key)) {
        out.push({ variant: resolved.variant, sha256, relPath: rel, isNew: false });
      }
      seen.add(key);
      continue;
    }
    seen.add(key);
    const target = resolveRel(input.metaDir, rel);
    await mkdir(resolveRel(input.metaDir, rel.slice(0, rel.lastIndexOf("/"))), {
      recursive: true,
    });
    await atomicRename(file.path, target);
    input.db.run(
      `INSERT OR IGNORE INTO thumbnails (video_id, variant, url, sha256, path, first_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.videoId,
      resolved.variant,
      resolved.url,
      sha256,
      rel,
      input.now,
    );
    out.push({ variant: resolved.variant, sha256, relPath: rel, isNew: true });
  }
  return out;
}
