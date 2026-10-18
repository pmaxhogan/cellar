import {
  classifyTakeoutFile,
  parsePlaylistCsv,
  parseSubscriptionsCsv,
  parseWatchHistoryJson,
  TAKEOUT_ACTIVITY_KIND,
  TAKEOUT_JOB_TYPE,
  TakeoutFileKindSchema,
  TakeoutParseError,
  type TakeoutChannelRow,
  type TakeoutCounts,
  type TakeoutErrorCode,
  type TakeoutFileKind,
  type TakeoutJobResponse,
  type TakeoutParseResult,
  type TakeoutPreviewFile,
  type TakeoutSkippedFile,
  type TakeoutVideoRow,
} from "@cellar/shared";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Logger } from "pino";
import yauzl from "yauzl";
import { z } from "zod";
import type { Db } from "../db/db.ts";
import { parseJsonColumn } from "../db/paged.ts";
import type { EventBus } from "../events.ts";
import type { EnqueueInput, EnqueueResult } from "../jobs/queue.ts";
import type { JobRegistry } from "../jobs/types.ts";
import { logActivity } from "./activity.ts";
import { notFound } from "./errors.ts";
import { scheduleEvalPass } from "./ruleEval.ts";
import { ensureVideo } from "./videos.ts";

/**
 * The Google Takeout importer (spec 3.1, ARCHITECTURE "Google Takeout
 * importer"). Two halves:
 *
 *   staging  - the upload route streams every file to $DATA_DIR/tmp/takeout-<id>/,
 *              unpacks archives there, classifies and dry-parses each file for the
 *              preview, then queues one `takeout_import` job.
 *   import   - the job re-parses the staged files and upserts sources in batched
 *              transactions, then queues rechecks for unknown videos and an eval
 *              pass, logs a `takeout.imported` activity row and deletes the dir.
 *
 * Archive entries never choose where anything is written: zip entries are
 * written under generated names, and a tar is extracted by the system tar
 * (which refuses `..` and absolute members) into its own subdirectory, after
 * which only regular files whose real path stays inside that subdirectory are
 * read. Unsafe member names are reported as skipped.
 */

export const TAKEOUT_JOB = TAKEOUT_JOB_TYPE;
/** The recheck job type and its batch size (videos.list takes 50 ids per call). */
export const RECHECK_BATCH_JOB = "recheck_batch";
export const RECHECK_CHUNK = 50;
/** Source rows per transaction. */
export const IMPORT_BATCH = 500;
/** Above this many touched videos a full eval pass is cheaper than a giant id list. */
export const TARGETED_EVAL_LIMIT = 5000;
/** The upload response lists at most this many skipped files. */
export const MAX_SKIPPED_LISTED = 200;
/** Takeout staging directories are named `takeout-<id>` under the tmp dir. */
export const STAGING_PREFIX = "takeout-";

const TAR_TIMEOUT_MS = 10 * 60_000;
const TAR_LIST_MAX_BUFFER = 64 * 1024 * 1024;

/** A 4xx the route sends as-is: `toApiError` passes `statusCode` and `code` through. */
export class TakeoutUploadError extends Error {
  override readonly name = "TakeoutUploadError";
  readonly statusCode: number;
  readonly code: TakeoutErrorCode;

  constructor(code: TakeoutErrorCode, message: string, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export const HTML_HISTORY_MESSAGE =
  "Your watch history was exported as HTML, which cellar cannot import. In Google Takeout, " +
  "open 'Multiple formats', set history to JSON, and export again.";

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

/** One file the job will import, as stored in the job payload. */
export interface StagedFile {
  /** Relative to the staging dir, `/` separated. */
  path: string;
  /** The name shown to the owner: the upload's name or the path inside the archive. */
  name: string;
  kind: TakeoutFileKind;
}

export interface TakeoutPayload {
  dir: string;
  files: StagedFile[];
  account_id: number;
}

const PayloadSchema = z.object({
  dir: z.string().min(1),
  files: z.array(
    z.object({ path: z.string().min(1), name: z.string(), kind: TakeoutFileKindSchema }),
  ),
  account_id: z.number().int().positive(),
});

/** A file saved from the multipart stream. */
export interface SavedUpload {
  /** Relative to the staging dir. */
  path: string;
  /** The client's file name (base name only). */
  name: string;
}

/** Files the owner may upload, by name. */
export function uploadKind(name: string): "tar" | "zip" | "json" | "csv" | "html" | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".tgz") || lower.endsWith(".tar.gz")) {
    return "tar";
  }
  if (lower.endsWith(".zip")) {
    return "zip";
  }
  if (lower.endsWith(".json")) {
    return "json";
  }
  if (lower.endsWith(".csv")) {
    return "csv";
  }
  if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    return "html";
  }
  return null;
}

/** The client's file name reduced to a base name, or a fallback. */
export function displayName(filename: string | undefined, index: number): string {
  const base = (filename ?? "").split(/[\\/]/).pop()?.trim() ?? "";
  return base === "" ? `upload-${index + 1}` : base;
}

/** An on-disk name that cannot escape or collide: `<index>-<ascii-safe name>`. */
export function storedName(name: string, index: number): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
  return `${String(index).padStart(3, "0")}-${safe.slice(-80)}`;
}

/** Counts bytes across every file of one request and fails past the cap. */
export class ByteBudget {
  readonly limit: number;
  used = 0;

  constructor(limit: number) {
    this.limit = limit;
  }

  meter(): Transform {
    return new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        this.used += chunk.length;
        if (this.used > this.limit) {
          callback(tooLarge(this.limit));
          return;
        }
        callback(null, chunk);
      },
    });
  }
}

export function tooLarge(limit: number): TakeoutUploadError {
  const gib = limit / 1024 ** 3;
  const size = gib >= 1 ? `${String(Math.round(gib * 10) / 10)} GB` : `${String(limit)} bytes`;
  return new TakeoutUploadError("upload_too_large", `The upload is larger than ${size}.`, 413);
}

/** Make a fresh staging dir under `tmpDir`. */
export async function createStagingDir(tmpDir: string, id: string): Promise<string> {
  const dir = join(tmpDir, `${STAGING_PREFIX}${id}`);
  await mkdir(join(dir, "upload"), { recursive: true, mode: 0o700 });
  return dir;
}

/** Stream one multipart file into `<dir>/upload/`, metered against the request budget. */
export async function saveUpload(
  dir: string,
  index: number,
  filename: string | undefined,
  stream: Readable,
  budget: ByteBudget,
): Promise<SavedUpload> {
  const name = displayName(filename, index);
  const path = `upload/${storedName(name, index)}`;
  await pipeline(stream, budget.meter(), createWriteStream(join(dir, path), { mode: 0o600 }));
  return { path, name };
}

/** True for a member name that would land outside the extraction dir. */
export function isUnsafeMemberName(name: string): boolean {
  const normalized = name.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || isAbsolute(name)) {
    return true;
  }
  return normalized.split("/").some((segment) => segment === "..");
}

export interface TarRunner {
  /** Resolves with the exit code and output; never rejects for a non-zero exit. */
  (args: readonly string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** The system tar through execFile, argv only. Paths are relative to `cwd`. */
export function systemTar(command = "tar"): TarRunner {
  return (args, cwd) =>
    new Promise((resolvePromise, reject) => {
      execFile(
        command,
        [...args],
        {
          cwd,
          timeout: TAR_TIMEOUT_MS,
          maxBuffer: TAR_LIST_MAX_BUFFER,
          windowsHide: true,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          if (error === null) {
            resolvePromise({ code: 0, stdout, stderr });
            return;
          }
          if (typeof error.code === "number") {
            resolvePromise({ code: error.code, stdout, stderr });
            return;
          }
          reject(error);
        },
      );
    });
}

interface Unpacked {
  /** Extracted regular files: path relative to the staging dir, name inside the archive. */
  files: { path: string; name: string }[];
  skipped: TakeoutSkippedFile[];
}

/** Regular files under `root`, recursively; symlinks and anything else are skipped. */
async function walkRegularFiles(
  root: string,
  realRoot: string,
  prefix: string,
  out: Unpacked,
  archive: string,
): Promise<void> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const full = join(root, rel);
    const stat = await lstat(full);
    if (stat.isDirectory()) {
      await walkRegularFiles(root, realRoot, rel, out, archive);
      continue;
    }
    if (!stat.isFile()) {
      out.skipped.push({ name: `${archive}: ${rel}`, reason: "not-a-regular-file" });
      continue;
    }
    const real = await realpath(full);
    if (!real.startsWith(realRoot + sep)) {
      out.skipped.push({ name: `${archive}: ${rel}`, reason: "unsafe-path" });
      continue;
    }
    out.files.push({ path: rel, name: rel });
  }
}

/** A Takeout archive never has members outside its root; one that does is refused whole. */
export function unsafeArchive(archive: string, member: string): TakeoutUploadError {
  return new TakeoutUploadError(
    "unsafe_archive",
    `${archive} contains a path outside the archive (${member}), so nothing in it was imported.`,
  );
}

/**
 * Unpack a `.tgz` with the system tar into `<dir>/<outRel>/`. Member names
 * are listed first and an archive with an absolute or `..` member is refused
 * before anything is extracted.
 */
export async function unpackTar(
  dir: string,
  uploadRel: string,
  outRel: string,
  archive: string,
  tar: TarRunner,
): Promise<Unpacked> {
  const out: Unpacked = { files: [], skipped: [] };
  const listed = await tar(["-tzf", uploadRel], dir);
  if (listed.code !== 0) {
    throw new TakeoutUploadError(
      "archive_unreadable",
      `${archive} is not a readable .tgz archive.`,
    );
  }
  const unsafe = listed.stdout
    .split(/\r?\n/)
    .find((line) => line !== "" && isUnsafeMemberName(line));
  if (unsafe !== undefined) {
    throw unsafeArchive(archive, unsafe);
  }
  await mkdir(join(dir, outRel), { recursive: true, mode: 0o700 });
  const extracted = await tar(["-xzf", uploadRel, "-C", outRel], dir);
  if (extracted.code !== 0) {
    throw new TakeoutUploadError(
      "archive_unreadable",
      `${archive} could not be unpacked completely.`,
    );
  }
  const root = join(dir, outRel);
  const inner: Unpacked = { files: [], skipped: [] };
  await walkRegularFiles(root, await realpath(root), "", inner, archive);
  out.skipped.push(...inner.skipped);
  for (const file of inner.files) {
    out.files.push({ path: `${outRel}/${file.path}`, name: file.name });
  }
  return out;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** Zip entry names: the UTF-8 flag or Info-ZIP unicode field, else UTF-8 when valid, else CP437. */
function zipEntryName(entry: yauzl.Entry): string {
  const raw = entry.fileNameRaw;
  const flagged =
    (entry.generalPurposeBitFlag & 0x800) !== 0 ||
    entry.extraFields.some((field) => field.id === 0x7075);
  if (!flagged) {
    try {
      return UTF8.decode(raw).replace(/\\/g, "/");
    } catch {
      // Not UTF-8: fall through to the zip default.
    }
  }
  return yauzl.getFileNameLowLevel(entry.generalPurposeBitFlag, raw, entry.extraFields, false);
}

/** True for archive members the importer may want (or must detect, like HTML history). */
function wanted(name: string): boolean {
  return classifyTakeoutFile(name) !== null || /(^|\/)watch-history\.html?$/i.test(name);
}

/** The next central directory entry of a lazyEntries zip, or null at the end. */
function nextEntry(zip: yauzl.ZipFile): Promise<yauzl.Entry | null> {
  return new Promise((resolvePromise, reject) => {
    const cleanup = (): void => {
      zip.off("entry", onEntry);
      zip.off("end", onEnd);
      zip.off("error", onError);
    };
    const onEntry = (entry: yauzl.Entry): void => {
      cleanup();
      resolvePromise(entry);
    };
    const onEnd = (): void => {
      cleanup();
      resolvePromise(null);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    zip.on("entry", onEntry);
    zip.on("end", onEnd);
    zip.on("error", onError);
    zip.readEntry();
  });
}

/**
 * Unpack the wanted entries of a `.zip` into `<dir>/<outRel>/` under generated
 * names, streaming each entry (yauzl reads the central directory, never the
 * whole archive). Unused entries are listed as skipped.
 */
export async function unpackZip(
  dir: string,
  uploadRel: string,
  outRel: string,
  archive: string,
): Promise<Unpacked> {
  const out: Unpacked = { files: [], skipped: [] };
  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.openPromise(join(dir, uploadRel), {
      lazyEntries: true,
      decodeStrings: false,
      validateEntrySizes: true,
    });
  } catch {
    throw new TakeoutUploadError(
      "archive_unreadable",
      `${archive} is not a readable .zip archive.`,
    );
  }
  await mkdir(join(dir, outRel), { recursive: true, mode: 0o700 });
  try {
    let index = 0;
    for (let entry = await nextEntry(zip); entry !== null; entry = await nextEntry(zip)) {
      const name = zipEntryName(entry);
      if (name.endsWith("/")) {
        continue;
      }
      if (isUnsafeMemberName(name)) {
        throw unsafeArchive(archive, name);
      }
      if (!wanted(name)) {
        out.skipped.push({ name, reason: "not-used" });
        continue;
      }
      const path = `${outRel}/${String(index).padStart(5, "0")}.dat`;
      index += 1;
      const stream = await zip.openReadStreamPromise(entry);
      await pipeline(stream, createWriteStream(join(dir, path), { mode: 0o600 }));
      out.files.push({ path, name });
    }
  } catch (error) {
    if (error instanceof TakeoutUploadError) {
      throw error;
    }
    throw new TakeoutUploadError("archive_unreadable", `${archive} could not be unpacked.`);
  } finally {
    zip.close();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Classify and dry parse
// ---------------------------------------------------------------------------

export type ParsedFile =
  | {
      kind: "history" | "watch_later" | "liked" | `playlist:${string}`;
      video: true;
      result: TakeoutParseResult<TakeoutVideoRow>;
    }
  | { kind: "subscription"; video: false; result: TakeoutParseResult<TakeoutChannelRow> };

function looksLikeHtml(text: string): boolean {
  return /^\s*</.test(text.replace(/^\u{FEFF}/u, ""));
}

/** Parse one staged file by kind. Throws TakeoutParseError for a wrong file. */
export function parseStaged(kind: TakeoutFileKind, text: string): ParsedFile {
  if (kind === "subscription") {
    return { kind, video: false, result: parseSubscriptionsCsv(text) };
  }
  if (kind === "history") {
    return { kind, video: true, result: parseWatchHistoryJson(text) };
  }
  return { kind, video: true, result: parsePlaylistCsv(text) };
}

export interface StagePlan {
  files: StagedFile[];
  preview: TakeoutPreviewFile[];
  skipped: TakeoutSkippedFile[];
}

/**
 * Turn the saved uploads into the job's file list: unpack archives, classify
 * every file, dry-parse the importable ones for the preview counts. Throws
 * `history_is_html` when the history came as HTML and no JSON history is
 * present, and `no_takeout_files` when nothing is importable.
 */
export async function planStaging(
  dir: string,
  uploads: readonly SavedUpload[],
  tar: TarRunner,
): Promise<StagePlan> {
  const candidates: { path: string; name: string }[] = [];
  const skipped: TakeoutSkippedFile[] = [];
  let htmlHistory = false;

  for (const [index, upload] of uploads.entries()) {
    const kind = uploadKind(upload.name);
    if (kind === "tar" || kind === "zip") {
      const outRel = `x${String(index).padStart(3, "0")}`;
      const unpacked =
        kind === "tar"
          ? await unpackTar(dir, upload.path, outRel, upload.name, tar)
          : await unpackZip(dir, upload.path, outRel, upload.name);
      skipped.push(...unpacked.skipped);
      candidates.push(...unpacked.files);
    } else if (kind === null) {
      skipped.push({ name: upload.name, reason: "unsupported-file-type" });
    } else {
      candidates.push({ path: upload.path, name: upload.name });
    }
  }

  const files: StagedFile[] = [];
  const preview: TakeoutPreviewFile[] = [];
  for (const candidate of candidates) {
    const kind = classifyTakeoutFile(candidate.name);
    if (kind === null) {
      if (/(^|\/)watch-history\.html?$/i.test(candidate.name)) {
        htmlHistory = true;
        skipped.push({ name: candidate.name, reason: "history-is-html" });
      } else {
        skipped.push({ name: candidate.name, reason: "not-used" });
      }
      continue;
    }
    const text = await readFile(join(dir, candidate.path), "utf8");
    if (kind === "history" && looksLikeHtml(text)) {
      htmlHistory = true;
      skipped.push({ name: candidate.name, reason: "history-is-html" });
      continue;
    }
    try {
      const parsed = parseStaged(kind, text);
      files.push({ path: candidate.path, name: candidate.name, kind });
      preview.push({
        name: candidate.name,
        kind,
        rows: parsed.result.rows.length,
        skipped_rows: { ...parsed.result.skipped },
      });
    } catch (error) {
      if (!(error instanceof TakeoutParseError)) {
        throw error;
      }
      skipped.push({ name: candidate.name, reason: `unreadable: ${error.message}` });
    }
  }

  if (htmlHistory && !files.some((file) => file.kind === "history")) {
    throw new TakeoutUploadError("history_is_html", HTML_HISTORY_MESSAGE);
  }
  if (files.length === 0) {
    throw new TakeoutUploadError(
      "no_takeout_files",
      "Nothing in the upload is a Takeout file cellar can import: expected watch-history.json, " +
        "playlist CSVs or subscriptions.csv (or a Takeout .tgz / .zip containing them).",
    );
  }
  return { files, preview, skipped };
}

/** Remove a staging dir. Refuses anything that is not a `takeout-*` dir directly under tmpDir. */
export async function removeStagingDir(tmpDir: string, dir: string): Promise<void> {
  if (!isStagingDir(tmpDir, dir)) {
    return;
  }
  await rm(dir, { recursive: true, force: true });
}

export function isStagingDir(tmpDir: string, dir: string): boolean {
  const rel = relative(resolve(tmpDir), resolve(dir));
  return (
    rel !== "" &&
    !rel.startsWith("..") &&
    !isAbsolute(rel) &&
    !rel.includes(sep) &&
    !rel.includes("/") &&
    basename(rel).startsWith(STAGING_PREFIX)
  );
}

// ---------------------------------------------------------------------------
// Import (the takeout_import job)
// ---------------------------------------------------------------------------

export interface TakeoutImportDeps {
  db: Db;
  log: Logger;
  events?: EventBus | undefined;
  now?: () => number;
  tmpDir: string;
  enqueue(input: EnqueueInput): EnqueueResult;
  registry: Pick<JobRegistry, "has">;
}

export interface ImportHooks {
  jobId: number;
  progress?: (pct: number, message?: string) => void;
  checkpoint?: () => void;
}

type VideoSource = "history" | "watch_later" | "liked";

interface SourceItem {
  source: VideoSource;
  videoId: string;
  /** Earliest and latest known timestamps; null when the export carried none. */
  first: number | null;
  last: number | null;
}

export function parsePayload(payload: unknown): TakeoutPayload {
  const parsed = PayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("takeout_import payload is malformed");
  }
  return parsed.data;
}

function addSkips(target: Record<string, number>, skips: Partial<Record<string, number>>): void {
  for (const [reason, count] of Object.entries(skips)) {
    target[reason] = (target[reason] ?? 0) + (count ?? 0);
  }
}

function mergeTs(map: Map<string, SourceItem>, source: VideoSource, row: TakeoutVideoRow): void {
  const key = row.videoId;
  const item = map.get(key) ?? { source, videoId: row.videoId, first: null, last: null };
  if (row.ts !== null) {
    item.first = item.first === null ? row.ts : Math.min(item.first, row.ts);
    item.last = item.last === null ? row.ts : Math.max(item.last, row.ts);
  }
  map.set(key, item);
}

/**
 * history keeps the earliest real watch as source_ts; playlists take the
 * export's add time. first_seen_at only ever moves earlier, last_seen_at only
 * later; origin records how a row first arrived and is left alone.
 */
const UPSERT_SOURCE = `
  INSERT INTO video_sources (video_id, account_id, source, first_seen_at, last_seen_at,
                             source_ts, origin)
  VALUES (?, ?, ?, ?, ?, ?, 'takeout')
  ON CONFLICT (video_id, COALESCE(account_id, 0), source) DO UPDATE SET
    first_seen_at = MIN(video_sources.first_seen_at, excluded.first_seen_at),
    last_seen_at = MAX(video_sources.last_seen_at, excluded.last_seen_at),
    source_ts = CASE
      WHEN excluded.source = 'history'
        THEN COALESCE(MIN(video_sources.source_ts, excluded.source_ts),
                      video_sources.source_ts, excluded.source_ts)
      ELSE COALESCE(excluded.source_ts, video_sources.source_ts)
    END`;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** Run one takeout_import job. Idempotent: a second run creates nothing new. */
export async function importTakeout(
  deps: TakeoutImportDeps,
  rawPayload: unknown,
  hooks: ImportHooks,
): Promise<TakeoutCounts> {
  const now = deps.now ?? Date.now;
  const started = now();
  const payload = parsePayload(rawPayload);
  if (!isStagingDir(deps.tmpDir, payload.dir)) {
    throw new Error("takeout_import payload names a directory outside the staging area");
  }
  const accountId = payload.account_id;
  if (deps.db.get("SELECT id FROM accounts WHERE id = ?", accountId) === undefined) {
    throw notFound("Account", accountId);
  }

  const counts: TakeoutCounts = {
    account_id: accountId,
    history: 0,
    history_videos: 0,
    watch_later: 0,
    liked: 0,
    subscriptions: 0,
    playlists_ignored: 0,
    playlist_videos_ignored: 0,
    new_videos: 0,
    new_sources: 0,
    skipped: {},
    recheck_jobs: null,
    duration_ms: 0,
  };
  const bySource: Record<VideoSource, Map<string, SourceItem>> = {
    history: new Map(),
    watch_later: new Map(),
    liked: new Map(),
  };
  const channels = new Map<string, string>();

  for (const file of payload.files) {
    const full = resolve(payload.dir, file.path);
    if (!full.startsWith(resolve(payload.dir) + sep)) {
      counts.skipped["unsafe-path"] = (counts.skipped["unsafe-path"] ?? 0) + 1;
      continue;
    }
    let parsed: ParsedFile;
    try {
      parsed = parseStaged(file.kind, await readFile(full, "utf8"));
    } catch (error) {
      deps.log.warn({ err: error, file: file.name }, "takeout file unreadable");
      counts.skipped["unreadable-file"] = (counts.skipped["unreadable-file"] ?? 0) + 1;
      continue;
    }
    addSkips(counts.skipped, parsed.result.skipped);
    if (!parsed.video) {
      for (const row of parsed.result.rows) {
        channels.set(row.channelId, row.title);
      }
      counts.subscriptions += parsed.result.rows.length;
      continue;
    }
    const rows = parsed.result.rows;
    if (parsed.kind === "history" || parsed.kind === "watch_later" || parsed.kind === "liked") {
      counts[parsed.kind] += rows.length;
      for (const row of rows) {
        mergeTs(bySource[parsed.kind], parsed.kind, row);
      }
    } else {
      counts.playlists_ignored += 1;
      counts.playlist_videos_ignored += rows.length;
    }
  }
  counts.history_videos = bySource.history.size;
  hooks.checkpoint?.();

  const items = [
    ...bySource.history.values(),
    ...bySource.watch_later.values(),
    ...bySource.liked.values(),
  ];
  const subs = [...channels.entries()];
  const total = Math.max(1, items.length + subs.length);
  let done = 0;
  const newIds: string[] = [];
  const touched = new Set<string>();

  for (const batch of chunks(items, IMPORT_BATCH)) {
    const at = now();
    deps.db.tx(() => {
      for (const item of batch) {
        if (ensureVideo(deps.db, item.videoId, { now: at })) {
          newIds.push(item.videoId);
        }
        touched.add(item.videoId);
        const existed =
          deps.db.get(
            `SELECT id FROM video_sources
              WHERE video_id = ? AND COALESCE(account_id, 0) = ? AND source = ?`,
            item.videoId,
            accountId,
            item.source,
          ) !== undefined;
        deps.db.run(
          UPSERT_SOURCE,
          item.videoId,
          accountId,
          item.source,
          item.first ?? at,
          item.last ?? at,
          item.source === "history" ? item.first : item.last,
        );
        if (!existed) {
          counts.new_sources += 1;
        }
      }
    });
    done += batch.length;
    hooks.progress?.(
      Math.floor((done / total) * 90),
      `Imported ${String(done)} of ${String(total)}`,
    );
    hooks.checkpoint?.();
  }

  for (const batch of chunks(subs, IMPORT_BATCH)) {
    const at = now();
    deps.db.tx(() => {
      for (const [channelId, title] of batch) {
        deps.db.run(
          `INSERT INTO channels (id, title, first_seen_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET title = COALESCE(channels.title, excluded.title)`,
          channelId,
          title === "" ? null : title,
          at,
          at,
          at,
        );
        counts.new_sources += deps.db.run(
          `INSERT OR IGNORE INTO channel_sources (channel_id, account_id, kind, subscribed_at,
                                                  created_at)
           VALUES (?, ?, 'subscription', NULL, ?)`,
          channelId,
          accountId,
          at,
        ).changes;
      }
    });
    done += batch.length;
    hooks.progress?.(
      Math.floor((done / total) * 90),
      `Imported ${String(done)} of ${String(total)}`,
    );
    hooks.checkpoint?.();
  }
  counts.new_videos = newIds.length;

  if (deps.registry.has(RECHECK_BATCH_JOB)) {
    counts.recheck_jobs = 0;
    for (const ids of chunks(newIds, RECHECK_CHUNK)) {
      deps.enqueue({ type: RECHECK_BATCH_JOB, payload: { videoIds: ids, reason: "takeout" } });
      counts.recheck_jobs += 1;
    }
  } else if (newIds.length > 0) {
    deps.log.info({ videos: newIds.length }, "no recheck_batch handler; new videos wait for one");
  }

  if (touched.size > TARGETED_EVAL_LIMIT) {
    scheduleEvalPass({ db: deps.db, enqueue: deps.enqueue, now }, "takeout");
  } else if (touched.size > 0) {
    scheduleEvalPass({ db: deps.db, enqueue: deps.enqueue, now }, "takeout", {
      videoIds: [...touched],
    });
  }

  counts.duration_ms = Math.max(0, now() - started);
  logActivity(
    { db: deps.db, events: deps.events, now },
    {
      kind: TAKEOUT_ACTIVITY_KIND,
      message: summarize(counts),
      jobId: hooks.jobId,
      data: counts,
    },
  );
  hooks.progress?.(100, "Import finished");
  await removeStagingDir(deps.tmpDir, payload.dir);
  return counts;
}

/** The Activity row's message. */
export function summarize(counts: TakeoutCounts): string {
  const parts = [
    `${String(counts.history)} history entries`,
    `${String(counts.watch_later)} Watch later`,
    `${String(counts.liked)} liked`,
    `${String(counts.subscriptions)} subscriptions`,
  ];
  if (counts.playlists_ignored > 0) {
    parts.push(`${String(counts.playlists_ignored)} other playlists not imported`);
  }
  return `Takeout imported: ${parts.join(", ")}; ${String(counts.new_videos)} new videos.`;
}

// ---------------------------------------------------------------------------
// Status (GET /api/takeout/:jobId)
// ---------------------------------------------------------------------------

interface JobStatusRow {
  id: number;
  type: string;
  status: TakeoutJobResponse["status"];
  payload_json: string;
  error: string | null;
  created_at: number;
  finished_at: number | null;
}

export function takeoutStatus(db: Db, jobId: number): TakeoutJobResponse {
  const job = db.get<JobStatusRow>(
    `SELECT id, type, status, payload_json, error, created_at, finished_at
       FROM jobs WHERE id = ?`,
    jobId,
  );
  if (job?.type !== TAKEOUT_JOB) {
    throw notFound("Takeout import", jobId);
  }
  const payload = PayloadSchema.safeParse(parseJsonColumn(job.payload_json));
  const activity = db.get<{ data_json: string | null }>(
    `SELECT data_json FROM activity WHERE kind = ? AND job_id = ? ORDER BY id DESC LIMIT 1`,
    TAKEOUT_ACTIVITY_KIND,
    jobId,
  );
  const counts = activity === undefined ? null : parseJsonColumn(activity.data_json);
  return {
    job_id: job.id,
    status: job.status,
    error: job.error,
    created_at: job.created_at,
    finished_at: job.finished_at,
    files: payload.success
      ? payload.data.files.map((file) => ({ name: file.name, kind: file.kind }))
      : [],
    counts: counts === null ? null : (counts as TakeoutCounts),
  };
}
