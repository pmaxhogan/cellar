import { createReadStream } from "node:fs";
import { copyFile, open, readdir, rename as fsRename, rmdir, stat, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * The on-disk layout (spec 3.3, docs/ARCHITECTURE.md "Storage layout on disk").
 *
 * Media locations hold ONLY video/audio files:
 *
 *   <location>/<channelId>/<videoId>/<videoId>.<ext>
 *   <location>/<channelId>/<videoId>/versions/v<N>/<videoId>.<ext>
 *   <location>/.tmp/<videoId>/                                 in-flight work
 *
 * Everything that survives a media delete lives under $DATA_DIR/meta:
 *
 *   <metaDir>/<channelId>/<videoId>/info.json
 *   <metaDir>/<channelId>/<videoId>/<lang>.vtt
 *   <metaDir>/<channelId>/<videoId>/thumbnails/<variant>-<sha>.<ext>
 *
 * `media.rel_path` is relative to the location root for video/audio rows and
 * relative to metaDir for captions/info rows (their location_id is NULL).
 * `thumbnails.path` is relative to metaDir.
 *
 * Every helper that turns ids into paths validates the ids and refuses a
 * result that escapes its root, so a hostile id or a tampered rel_path can
 * never point outside the tree it belongs to.
 */

/** Bucket for videos whose channel is unknown. */
export const UNKNOWN_CHANNEL = "_unknown";
export const TMP_DIR_NAME = ".tmp";
export const VERSIONS_DIR_NAME = "versions";
export const THUMBNAILS_DIR_NAME = "thumbnails";

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const EXT_RE = /^[A-Za-z0-9]{1,10}$/;
const LANG_RE = /^[A-Za-z0-9_-]{1,32}$/;
const VARIANT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

export class PathEscapeError extends Error {
  override readonly name = "PathEscapeError";
}

export function isVideoId(value: string): boolean {
  return VIDEO_ID_RE.test(value);
}

function requireVideoId(videoId: string): string {
  if (!VIDEO_ID_RE.test(videoId)) {
    throw new PathEscapeError(`Not a video id: ${JSON.stringify(videoId)}`);
  }
  return videoId;
}

function requireExt(ext: string): string {
  if (!EXT_RE.test(ext)) {
    throw new PathEscapeError(`Not a file extension: ${JSON.stringify(ext)}`);
  }
  return ext.toLowerCase();
}

/** The channel directory name: the channel id when it is well formed, else `_unknown`. */
export function channelBucket(channelId: string | null | undefined): string {
  return channelId !== null && channelId !== undefined && CHANNEL_ID_RE.test(channelId)
    ? channelId
    : UNKNOWN_CHANNEL;
}

/** True when `child` is `root` itself or lies below it. Both are resolved first. */
export function isInside(root: string, child: string): boolean {
  const base = resolve(root);
  const target = resolve(child);
  if (target === base) {
    return true;
  }
  const rel = relative(base, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Join `parts` under `root` and refuse a result that is not strictly below
 * the root. Returns the absolute path.
 */
export function safeJoin(root: string, ...parts: string[]): string {
  const base = resolve(root);
  const target = resolve(base, ...parts);
  if (target === base || !isInside(base, target)) {
    throw new PathEscapeError(`Path escapes its root: ${parts.join("/")}`);
  }
  return target;
}

/** The relative path from `root` to `path`, with forward slashes (what the DB stores). */
export function relPath(root: string, path: string): string {
  if (!isInside(root, path)) {
    throw new PathEscapeError("Path is not inside its root.");
  }
  return relative(resolve(root), resolve(path)).split(sep).join("/");
}

/** Resolve a stored rel_path against its root, refusing anything that escapes it. */
export function resolveRel(root: string, rel: string): string {
  return safeJoin(root, ...rel.split("/"));
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** `<channel>/<videoId>`: the per-video directory, relative to a location or metaDir. */
export function videoDirRel(channelId: string | null | undefined, videoId: string): string {
  return `${channelBucket(channelId)}/${requireVideoId(videoId)}`;
}

/** Current media: `<channel>/<id>/<id>.<ext>` relative to the location root. */
export function mediaRel(
  channelId: string | null | undefined,
  videoId: string,
  ext: string,
): string {
  return `${videoDirRel(channelId, videoId)}/${videoId}.${requireExt(ext)}`;
}

/** A kept version: `<channel>/<id>/versions/v<N>/<id>.<ext>` relative to the location root. */
export function versionRel(
  channelId: string | null | undefined,
  videoId: string,
  version: number,
  ext: string,
): string {
  if (!Number.isInteger(version) || version < 1) {
    throw new PathEscapeError(`Not a version number: ${String(version)}`);
  }
  return `${videoDirRel(channelId, videoId)}/${VERSIONS_DIR_NAME}/v${String(version)}/${videoId}.${requireExt(ext)}`;
}

/** `<location>/.tmp/<videoId>/`: where downloads and transcodes work. */
export function inflightDir(locationRoot: string, videoId: string): string {
  return safeJoin(locationRoot, TMP_DIR_NAME, requireVideoId(videoId));
}

/** `<metaDir>/<channel>/<id>/`. */
export function metaVideoDir(
  metaDir: string,
  channelId: string | null | undefined,
  videoId: string,
): string {
  return safeJoin(metaDir, ...videoDirRel(channelId, videoId).split("/"));
}

export function infoJsonRel(channelId: string | null | undefined, videoId: string): string {
  return `${videoDirRel(channelId, videoId)}/info.json`;
}

export function captionRel(
  channelId: string | null | undefined,
  videoId: string,
  lang: string,
): string {
  if (!LANG_RE.test(lang)) {
    throw new PathEscapeError(`Not a caption language: ${JSON.stringify(lang)}`);
  }
  return `${videoDirRel(channelId, videoId)}/${lang}.vtt`;
}

export function thumbnailRel(
  channelId: string | null | undefined,
  videoId: string,
  variant: string,
  sha256: string,
  ext: string,
): string {
  if (!VARIANT_RE.test(variant) || !SHA_RE.test(sha256)) {
    throw new PathEscapeError("Not a thumbnail variant or hash.");
  }
  return `${videoDirRel(channelId, videoId)}/${THUMBNAILS_DIR_NAME}/${variant}-${sha256}.${requireExt(ext)}`;
}

// ---------------------------------------------------------------------------
// Durable file operations
// ---------------------------------------------------------------------------

/** Error codes a directory fsync raises where directories cannot be opened (Windows). */
const DIR_FSYNC_UNSUPPORTED = new Set(["EISDIR", "EPERM", "EACCES", "EINVAL", "ENOTSUP"]);

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** fsync a regular file's data and metadata. */
export async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * fsync a directory so a rename or create inside it is durable. Windows
 * cannot open a directory for this; there the call is a no-op.
 */
export async function fsyncDir(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (DIR_FSYNC_UNSUPPORTED.has(codeOf(error) ?? "")) {
      return;
    }
    throw error;
  }
  try {
    await handle.sync();
  } catch (error) {
    if (!DIR_FSYNC_UNSUPPORTED.has(codeOf(error) ?? "")) {
      throw error;
    }
  } finally {
    await handle.close();
  }
}

/** sha256 of a file, streamed. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => {
      resolvePromise();
    });
  });
  return hash.digest("hex");
}

export interface RenameSeams {
  /** Test seam: the rename primitive (throw EXDEV to exercise the copy path). */
  rename?: (from: string, to: string) => Promise<void>;
}

/**
 * Move `from` to `to` durably. Same filesystem: fsync the file, rename, fsync
 * the target directory. Across filesystems (EXDEV): copy, fsync the copy,
 * verify its size, rename it into place, then unlink the source. The target
 * directory must exist. An existing target is replaced.
 */
export async function atomicRename(
  from: string,
  to: string,
  seams: RenameSeams = {},
): Promise<void> {
  const doRename = seams.rename ?? fsRename;
  await fsyncFile(from);
  try {
    await doRename(from, to);
    await fsyncDir(dirname(to));
    return;
  } catch (error) {
    if (codeOf(error) !== "EXDEV") {
      throw error;
    }
  }
  const staging = `${to}.partial-${String(process.pid)}`;
  try {
    await copyFile(from, staging);
    await fsyncFile(staging);
    const [source, copy] = await Promise.all([stat(from), stat(staging)]);
    if (source.size !== copy.size) {
      throw new Error(
        `Copy of ${from} is ${String(copy.size)} bytes, expected ${String(source.size)}.`,
      );
    }
    await fsRename(staging, to);
  } catch (error) {
    await unlink(staging).catch(() => undefined);
    throw error;
  }
  await fsyncDir(dirname(to));
  await unlink(from);
  await fsyncDir(dirname(from));
}

/**
 * Remove `path` and each parent while it is an empty directory, stopping
 * before `stopAt` (which is never removed). Missing directories are skipped.
 */
export async function removeEmptyParents(path: string, stopAt: string): Promise<void> {
  const stop = resolve(stopAt);
  let current = resolve(path);
  while (current !== stop && isInside(stop, current)) {
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch (error) {
      if (codeOf(error) === "ENOENT") {
        current = dirname(current);
        continue;
      }
      return;
    }
    if (entries.length > 0) {
      return;
    }
    try {
      await rmdir(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}

/** Absolute path of a file named `name` directly inside `dir` (refuses separators). */
export function childOf(dir: string, name: string): string {
  return safeJoin(dir, name);
}

/** Files (not directories) directly inside `dir`; empty when it does not exist. */
export async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => join(dir, entry.name));
  } catch (error) {
    if (codeOf(error) === "ENOENT") {
      return [];
    }
    throw error;
  }
}
