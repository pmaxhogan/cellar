import { addDuration, summariseFormats, type EffectiveSettings } from "@cellar/shared";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { getKv, setKv } from "../../db/kv.ts";
import { maybeEnqueueCanary } from "../../domain/canary.ts";
import { maybeEnqueueReap } from "../../domain/reaper.ts";
import { installCaptions, findCaptionFiles } from "../../media/captions.ts";
import { codecFamily, ffprobeArgs, parseFfprobe, type ProbeInfo } from "../../media/ffmpeg.ts";
import {
  atomicRename,
  channelBucket,
  infoJsonRel,
  inflightDir,
  isInside,
  isVideoId,
  listFiles,
  mediaRel,
  resolveRel,
  sha256File,
} from "../../media/paths.ts";
import {
  currentAvMedia,
  isLocationPaused,
  nextVersion,
  resolveLocation,
  type MediaRow,
} from "../../media/rows.ts";
import { findThumbnailFiles, storeThumbnails } from "../../media/thumbnails.ts";
import {
  buildDownloadArgs,
  classifyFailure,
  infoFilePaths,
  parseProgress,
  parsePrintJson,
  parsePrintedFile,
  redactArgv,
  redactUrl,
  ytdlpToolOptions,
  type YtdlpFailure,
} from "../../media/ytdlp.ts";
import type { SpawnToolResult } from "../../media/spawn.ts";
import type { PipelineDeps, PipelineLocation } from "../pipelineDeps.ts";
import type { JobContext } from "../types.ts";
import { TRANSCODE_JOB } from "./transcode.ts";

/**
 * The `download` job (download class, deduped per video). Payload:
 * `{ reason?: "version" | "redownload" }`.
 *
 * Order of checks: include, reclaim priority 0, existing media, delay after
 * upload, live status, the rate-limit cooldown, the target location (missing,
 * disabled or paused by the reaper). Then an account and a proxy are picked,
 * yt-dlp writes into `<location>/.tmp/<id>/` (or `$DATA_DIR/tmp/meta-dl/<id>/`
 * for captions_only / metadata_only, which need no location), the sidecars
 * move to `/data/meta`, the media file is renamed into place, and the rows
 * are written. Version re-downloads (`reason: "version"`, a YouTube-side
 * edit) first move the old current media to `versions/v<N>/`.
 *
 * Deferrals (delay_after_upload, upcoming/live with vod_only, a rate-limit
 * cooldown) queue a fresh `download` row with a later run_after and finish
 * this one: the running row itself would satisfy `dedupe`, so the new row is
 * inserted without it after checking no other active row exists.
 *
 * Failures are classified from stderr. A private/removed/unavailable video is
 * recorded in videos.privacy and the job ends without a retry (and without
 * counting toward the consecutive-failure alarm or the class breaker). A
 * rate limit (429) sets a cooldown that defers every download. Everything
 * else is rethrown so the queue applies its backoff; the consecutive-failure
 * counter may trip a canary.
 */

export const DOWNLOAD_JOB = "download";
export const LIVE_RECHECK_MS = 15 * 60_000;
export const COOLDOWN_KV_KEY = "download.cooldown";
export const COOLDOWN_BASE_MS = 30 * 60_000;
export const COOLDOWN_MAX_MS = 4 * 60 * 60_000;
export const DOWNLOAD_TIMEOUT_MS = 6 * 60 * 60_000;
export const LIVE_TIMEOUT_MS = 24 * 60 * 60_000;
export const ACCOUNT_RR_PREFIX = "download_rr:";
export const PROXY_FAILURE_NOTIFY_THRESHOLD = 3;
export const YTDLP_LOG_FILE = "yt-dlp.log";

export type DownloadReason = "version" | "redownload";

export interface DownloadPayload {
  reason?: DownloadReason;
}

export function downloadPayload(payload: unknown): DownloadPayload {
  const reason = (payload as { reason?: unknown } | null)?.reason;
  return reason === "version" || reason === "redownload" ? { reason } : {};
}

interface VideoRow {
  id: string;
  channel_id: string | null;
  upload_date: number | null;
  published_at: number | null;
  live_status: string | null;
}

// ---------------------------------------------------------------------------
// Account selection
// ---------------------------------------------------------------------------

function policyKey(policy: EffectiveSettings["download_accounts"]): string {
  return Array.isArray(policy) ? [...policy].sort((a, b) => a - b).join(",") : policy;
}

/** Accounts allowed by the policy that have cookies, in id order. */
export function accountCandidates(
  deps: Pick<PipelineDeps, "sourcingAccountIds" | "accountsWithCookies">,
  videoId: string,
  policy: EffectiveSettings["download_accounts"],
): number[] {
  const withCookies = new Set(deps.accountsWithCookies());
  let wanted: number[];
  if (policy === "any") {
    wanted = [...withCookies];
  } else if (policy === "sourcing") {
    wanted = deps.sourcingAccountIds(videoId);
  } else {
    wanted = [...policy];
  }
  return [...new Set(wanted)].filter((id) => withCookies.has(id)).sort((a, b) => a - b);
}

/**
 * Round-robin over the candidates (the cursor persists in kv per policy). A
 * preferred account (the one the job was queued for) wins when it is still a
 * candidate. Null when no candidate has cookies.
 */
export function pickDownloadAccount(
  deps: Pick<PipelineDeps, "db" | "now" | "sourcingAccountIds" | "accountsWithCookies">,
  videoId: string,
  policy: EffectiveSettings["download_accounts"],
  preferred: number | null = null,
): number | null {
  const candidates = accountCandidates(deps, videoId, policy);
  if (candidates.length === 0) {
    return null;
  }
  if (preferred !== null && candidates.includes(preferred)) {
    return preferred;
  }
  const key = `${ACCOUNT_RR_PREFIX}${policyKey(policy)}`;
  const last = getKv<number>(deps.db, key) ?? 0;
  const next = candidates.find((id) => id > last) ?? (candidates[0] as number);
  setKv(deps.db, key, next, deps.now());
  return next;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function activeLiveStatus(status: unknown): "upcoming" | "live" | null {
  if (typeof status !== "string") {
    return null;
  }
  const normalised = status.toLowerCase();
  if (normalised === "is_upcoming" || normalised === "upcoming") return "upcoming";
  if (normalised === "is_live" || normalised === "live") return "live";
  return null;
}

/** Queue a later attempt of this download and let the current job finish. */
function defer(
  deps: PipelineDeps,
  ctx: JobContext,
  videoId: string,
  runAfter: number,
  why: string,
): void {
  const other = deps.db.get<{ id: number }>(
    `SELECT id FROM jobs WHERE type = ? AND video_id = ? AND status IN ('queued', 'running')
       AND id != ? LIMIT 1`,
    DOWNLOAD_JOB,
    videoId,
    ctx.job.id,
  );
  if (other === undefined) {
    deps.enqueue({
      type: DOWNLOAD_JOB,
      videoId,
      accountId: ctx.job.accountId,
      payload: ctx.job.payload ?? {},
      priority: ctx.job.priority,
      runAfter,
    });
  }
  deps.logActivity({
    kind: "download.deferred",
    message: `Download of ${videoId} deferred: ${why}.`,
    videoId,
    jobId: ctx.job.id,
    data: { runAfter },
  });
  ctx.log.info({ runAfter, why }, "download deferred");
}

function skip(
  deps: PipelineDeps,
  ctx: JobContext,
  videoId: string,
  why: string,
  level: "info" | "warn" = "info",
): void {
  deps.logActivity({
    level,
    kind: "download.skipped",
    message: `Not downloading ${videoId}: ${why}.`,
    videoId,
    jobId: ctx.job.id,
  });
  ctx.log.info({ why }, "download skipped");
}

const SIDECAR_EXTS = new Set([
  ".json",
  ".vtt",
  ".srt",
  ".jpg",
  ".jpeg",
  ".webp",
  ".png",
  ".part",
  ".ytdl",
  ".temp",
  ".tmp",
]);

/** The media file yt-dlp produced, from its printed paths or by scanning the dir. */
async function findMediaFile(
  workDir: string,
  videoId: string,
  stdout: string,
  info: Record<string, unknown> | null,
): Promise<string | null> {
  const printed = parsePrintedFile(stdout);
  for (const candidate of [...(printed === null ? [] : [printed]), ...infoFilePaths(info)]) {
    if (isInside(workDir, candidate) && existsSync(candidate)) {
      return candidate;
    }
  }
  const prefix = `${videoId}.`;
  const scanned = (await listFiles(workDir)).filter((path) => {
    const name = basename(path);
    return (
      name.startsWith(prefix) &&
      !SIDECAR_EXTS.has(extname(name).toLowerCase()) &&
      !/\.f\d+\.[A-Za-z0-9]+$/.test(name)
    );
  });
  return scanned[0] ?? null;
}

async function probe(
  deps: PipelineDeps,
  file: string,
  signal: AbortSignal,
): Promise<ProbeInfo | null> {
  try {
    const result = await deps.runTool({
      tool: "ffprobe",
      args: ffprobeArgs(file),
      timeoutMs: 60_000,
      signal,
    });
    return result.code === 0 ? parseFfprobe(result.stdout) : null;
  } catch {
    return null;
  }
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compactFormats(formats: unknown): unknown[] {
  if (!Array.isArray(formats)) {
    return [];
  }
  return formats
    .filter(
      (format): format is Record<string, unknown> => typeof format === "object" && format !== null,
    )
    .map((format) => ({
      format_id: format.format_id ?? null,
      ext: format.ext ?? null,
      vcodec: format.vcodec ?? null,
      acodec: format.acodec ?? null,
      height: format.height ?? null,
      fps: format.fps ?? null,
      tbr: format.tbr ?? null,
      dynamic_range: format.dynamic_range ?? null,
    }));
}

function bool(value: boolean): number {
  return value ? 1 : 0;
}

/** Log lines go to <logDir>/yt-dlp.log with URL credentials and the proxy masked. */
function lineLogger(
  stream: WriteStream,
  proxyUrl: string | null,
): (tag: string, line: string) => void {
  return (tag, line) => {
    const masked = proxyUrl === null ? line : line.split(proxyUrl).join("[proxy]");
    stream.write(`${tag} ${redactUrl(masked)}\n`);
  };
}

async function closeStream(stream: WriteStream): Promise<void> {
  await new Promise<void>((resolve) => {
    stream.end(() => {
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

export async function runDownload(deps: PipelineDeps, ctx: JobContext): Promise<void> {
  const videoId = ctx.job.videoId;
  if (videoId === null || !isVideoId(videoId)) {
    ctx.log.error({ videoId }, "download job without a valid video id");
    return;
  }
  const { reason } = downloadPayload(ctx.job.payload);
  const now = deps.now();
  const video = deps.db.get<VideoRow>(
    "SELECT id, channel_id, upload_date, published_at, live_status FROM videos WHERE id = ?",
    videoId,
  );
  if (video === undefined) {
    skip(deps, ctx, videoId, "the video is not in the catalog", "warn");
    return;
  }
  const resolved = deps.getEffective(videoId);
  if (resolved === null) {
    skip(deps, ctx, videoId, "it has not been evaluated against the rules yet", "warn");
    return;
  }
  const effective = resolved.effective;
  if (!resolved.include) {
    skip(deps, ctx, videoId, "a rule excludes it");
    return;
  }
  if (resolved.reclaim_priority === 0) {
    skip(deps, ctx, videoId, "its reclaim priority is 0");
    return;
  }

  const skipMedia =
    effective.media_mode === "captions_only" || effective.media_mode === "metadata_only";
  const current = currentAvMedia(deps.db, videoId);
  if (reason === undefined) {
    const hasInfo =
      deps.db.get("SELECT 1 AS one FROM media WHERE video_id = ? AND kind = 'info'", videoId) !==
      undefined;
    if (current.length > 0 || (skipMedia && hasInfo)) {
      ctx.log.info("media already present; nothing to download");
      return;
    }
  }

  if (effective.delay_after_upload !== null) {
    const uploaded = video.published_at ?? video.upload_date;
    if (uploaded !== null) {
      const due = addDuration(uploaded, effective.delay_after_upload);
      if (now < due) {
        defer(deps, ctx, videoId, due, "waiting for the delay after upload");
        return;
      }
    }
  }
  const live = activeLiveStatus(video.live_status);
  if (live === "upcoming" || (live === "live" && effective.live === "vod_only")) {
    defer(deps, ctx, videoId, now + LIVE_RECHECK_MS, `the video is ${live}; waiting for the VOD`);
    return;
  }
  const cooldown = getKv<{ until?: unknown }>(deps.db, COOLDOWN_KV_KEY);
  if (typeof cooldown?.until === "number" && cooldown.until > now) {
    defer(deps, ctx, videoId, cooldown.until, "YouTube rate limited downloads");
    return;
  }

  let location: PipelineLocation | undefined;
  if (!skipMedia) {
    location = resolveLocation(deps, resolved.location_id);
    if (location === undefined || !location.enabled) {
      skip(deps, ctx, videoId, "its storage location is missing or disabled", "warn");
      return;
    }
    if (isLocationPaused(deps.db, location.id)) {
      skip(
        deps,
        ctx,
        videoId,
        `location ${String(location.id)} is full and paused until the reaper frees space`,
        "warn",
      );
      return;
    }
  }

  const accountId = pickDownloadAccount(
    deps,
    videoId,
    effective.download_accounts,
    ctx.job.accountId,
  );
  if (accountId === null) {
    ctx.log.warn("no account with cookies for this video; downloading without cookies");
  }
  const proxy = deps.pickProxy(effective.proxy);
  const settings = deps.getSettings();
  const tools = ytdlpToolOptions(settings, deps.config);

  const workDir =
    location === undefined
      ? join(deps.config.tmpDir, "meta-dl", videoId)
      : inflightDir(location.container_path, videoId);
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  const logStream = createWriteStream(join(ctx.logDir, YTDLP_LOG_FILE), { flags: "a" });
  const writeLine = lineLogger(logStream, proxy?.url ?? null);
  let result: SpawnToolResult;
  try {
    const run = async (cookiesPath: string | null): Promise<SpawnToolResult> => {
      const built = buildDownloadArgs({
        effective,
        video: { id: videoId },
        outDir: workDir,
        cookiesPath,
        proxyUrl: proxy?.url ?? null,
        settings,
        ...tools,
      });
      if (built.rejectedExtraArgs.length > 0) {
        deps.logActivity({
          level: "warn",
          kind: "download.args_rejected",
          message: `Ignored yt-dlp arguments that are not allowlisted: ${built.rejectedExtraArgs.join(" ")}`,
          videoId,
          jobId: ctx.job.id,
        });
      }
      ctx.log.info(
        { argv: redactArgv(built.args), accountId, proxyId: proxy?.id ?? null },
        "running yt-dlp",
      );
      writeLine("[argv]", JSON.stringify(redactArgv(built.args)));
      return deps.runTool({
        tool: "yt-dlp",
        args: built.args,
        timeoutMs: effective.live === "record_live" ? LIVE_TIMEOUT_MS : DOWNLOAD_TIMEOUT_MS,
        signal: ctx.signal,
        onStdoutLine: (line) => {
          const progress = parseProgress(line);
          if (progress !== null) {
            ctx.progress(progress.pct * 0.9, "downloading");
          } else if (!line.startsWith("{")) {
            writeLine("[out]", line);
          }
        },
        onStderrLine: (line) => {
          writeLine("[err]", line);
        },
      });
    };
    result =
      accountId === null
        ? await run(null)
        : await deps.withCookiesFile(accountId, (path) => run(path));
    writeLine("[exit]", String(result.code));
  } catch (error) {
    await closeStream(logStream);
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  await closeStream(logStream);

  try {
    ctx.checkpoint();
    if (result.code !== 0) {
      await handleFailure(deps, ctx, videoId, result, proxy);
      return;
    }
    if (proxy !== null) {
      deps.markProxyOk(proxy.id);
    }
    await finishDownload(deps, ctx, {
      videoId,
      video,
      reason,
      location,
      workDir,
      stdout: result.stdout,
      effective,
      accountId,
      current,
    });
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function handleFailure(
  deps: PipelineDeps,
  ctx: JobContext,
  videoId: string,
  result: SpawnToolResult,
  proxy: { id: number; url: string } | null,
): Promise<void> {
  const failure: YtdlpFailure = result.timedOut
    ? { kind: "network", message: "yt-dlp timed out", permanent: false }
    : classifyFailure(result.stderr, result.stdout);
  const now = deps.now();
  ctx.log.warn({ kind: failure.kind, message: failure.message }, "yt-dlp failed");

  if (proxy !== null && failure.kind === "network") {
    const count = deps.markProxyFailure(proxy.id);
    if (typeof count === "number" && count >= PROXY_FAILURE_NOTIFY_THRESHOLD) {
      await deps.notify({
        type: "proxy_failing",
        title: "A proxy is failing",
        body: `Proxy ${String(proxy.id)} failed ${String(count)} times in a row; it is skipped for 10 minutes.`,
        data: { proxyId: proxy.id },
        rateKey: `proxy_failing:${String(proxy.id)}`,
      });
    }
  }

  if (failure.permanent) {
    deps.db.run(
      "UPDATE videos SET privacy = ?, updated_at = ? WHERE id = ?",
      failure.privacy ?? "unavailable",
      now,
      videoId,
    );
    deps.logActivity({
      level: "error",
      kind: "download.unavailable",
      message: `${videoId} cannot be downloaded (${failure.privacy ?? "unavailable"}): ${failure.message}`,
      videoId,
      jobId: ctx.job.id,
      data: { privacy: failure.privacy ?? "unavailable" },
    });
    return;
  }

  if (failure.kind === "rate_limited") {
    const previous = getKv<{ until?: unknown; ms?: unknown }>(deps.db, COOLDOWN_KV_KEY);
    const lastMs = typeof previous?.ms === "number" ? previous.ms : 0;
    const recent = typeof previous?.until === "number" && now - previous.until < COOLDOWN_MAX_MS;
    const ms = recent
      ? Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_BASE_MS, lastMs * 2))
      : COOLDOWN_BASE_MS;
    setKv(deps.db, COOLDOWN_KV_KEY, { until: now + ms, ms }, now);
    deps.logActivity({
      level: "warn",
      kind: "download.rate_limited",
      message: `YouTube rate limited downloads; pausing them for ${String(Math.round(ms / 60_000))} min.`,
      videoId,
      jobId: ctx.job.id,
    });
  }

  const tripped = await deps.recordDownloadFailure(videoId);
  if (tripped !== null) {
    maybeEnqueueCanary(deps, "consecutive download failures");
  }
  throw new Error(`yt-dlp failed (${failure.kind}): ${failure.message}`);
}

interface FinishInput {
  videoId: string;
  video: VideoRow;
  reason: DownloadReason | undefined;
  location: PipelineLocation | undefined;
  workDir: string;
  stdout: string;
  effective: EffectiveSettings;
  accountId: number | null;
  current: MediaRow[];
}

async function readInfo(workDir: string, videoId: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(workDir, `${videoId}.info.json`), "utf8"),
    );
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function finishDownload(
  deps: PipelineDeps,
  ctx: JobContext,
  input: FinishInput,
): Promise<void> {
  const { videoId, location, workDir } = input;
  const now = deps.now();
  const info = parsePrintJson(input.stdout) ?? (await readInfo(workDir, videoId));
  const infoChannel = typeof info?.channel_id === "string" ? info.channel_id : null;
  const channel = channelBucket(input.video.channel_id ?? infoChannel);
  const metaDir = deps.config.metaDir;
  const settings = deps.getSettings();
  ctx.progress(92, "storing");

  // Media first: if it is missing, nothing else is worth keeping.
  let media:
    | {
        path: string;
        ext: string;
        probe: ProbeInfo | null;
        sha256: string;
        size: number;
      }
    | undefined;
  if (location !== undefined) {
    const file = await findMediaFile(workDir, videoId, input.stdout, info);
    if (file === null) {
      throw new Error("yt-dlp reported success but wrote no media file");
    }
    const ext = extname(file).slice(1).toLowerCase();
    const probeInfo = await probe(deps, file, ctx.signal);
    if (probeInfo === null) {
      ctx.log.warn("ffprobe could not read the download; using yt-dlp's format info");
    }
    media = {
      path: file,
      ext,
      probe: probeInfo,
      sha256: await sha256File(file),
      size: (await stat(file)).size,
    };
  }

  // Sidecars into /data/meta.
  const infoPath = join(workDir, `${videoId}.info.json`);
  let infoRow: { rel: string; size: number; sha256: string } | null = null;
  if (existsSync(infoPath)) {
    const rel = infoJsonRel(channel, videoId);
    const target = resolveRel(metaDir, rel);
    await mkdir(dirname(target), { recursive: true });
    const sha256 = await sha256File(infoPath);
    const { size } = await stat(infoPath);
    await atomicRename(infoPath, target, deps.rename === undefined ? {} : { rename: deps.rename });
    infoRow = { rel, size, sha256 };
  }
  const captions = await installCaptions(
    await findCaptionFiles(workDir, videoId),
    metaDir,
    channel,
    videoId,
  );
  const thumbnails = await storeThumbnails({
    db: deps.db,
    files: await findThumbnailFiles(workDir, videoId),
    info,
    metaDir,
    channelId: channel,
    videoId,
    variants: settings["thumbnails.variants"],
    now,
  });

  // Version handling and the rename into place.
  let version = nextVersion(deps.db, videoId);
  const replaced: MediaRow[] = [];
  let mediaRow: { kind: "video" | "audio"; rel: string } | null = null;
  if (location !== undefined && media !== undefined) {
    if (input.reason === "version") {
      for (const row of input.current) {
        await keepAsVersion(deps, row);
      }
    } else if (input.reason === "redownload" && input.current.length > 0) {
      replaced.push(...input.current);
      version = Math.max(...input.current.map((row) => Number(row.version)));
    }
    const rel = mediaRel(channel, videoId, media.ext);
    const target = resolveRel(location.container_path, rel);
    await mkdir(dirname(target), { recursive: true });
    await atomicRename(
      media.path,
      target,
      deps.rename === undefined ? {} : { rename: deps.rename },
    );
    const kind: "video" | "audio" =
      media.probe !== null
        ? media.probe.hasVideo
          ? "video"
          : "audio"
        : input.effective.media_mode === "audio_only"
          ? "audio"
          : "video";
    mediaRow = { kind, rel };
    for (const row of replaced) {
      if (row.location_id === location.id && row.rel_path === rel) {
        continue;
      }
      const old = resolveLocation(deps, row.location_id);
      if (old !== undefined) {
        await unlink(resolveRel(old.container_path, row.rel_path)).catch(() => undefined);
      }
    }
  }

  const probeInfo = media?.probe ?? null;
  const tbr = numberOf(info?.tbr);
  deps.db.tx(() => {
    for (const row of replaced) {
      deps.db.run("DELETE FROM media WHERE id = ?", row.id);
    }
    if (mediaRow !== null && media !== undefined && location !== undefined) {
      deps.db.run(
        `INSERT INTO media (video_id, kind, version, is_current, location_id, rel_path, size_bytes,
                            sha256, vcodec, acodec, height, fps, bitrate, downloaded_at, created_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        videoId,
        mediaRow.kind,
        version,
        location.id,
        mediaRow.rel,
        media.size,
        media.sha256,
        mediaRow.kind === "audio"
          ? null
          : (probeInfo?.vcodec ??
              codecFamily(typeof info?.vcodec === "string" ? info.vcodec : null)),
        probeInfo?.acodec ?? codecFamily(typeof info?.acodec === "string" ? info.acodec : null),
        probeInfo?.height ?? numberOf(info?.height),
        probeInfo?.fps ?? numberOf(info?.fps),
        probeInfo?.bitrate ?? (tbr === null ? null : Math.round(tbr * 1000)),
        now,
        now,
      );
    }
    for (const caption of captions) {
      deps.db.run(
        "DELETE FROM media WHERE video_id = ? AND kind = 'captions' AND lang = ?",
        videoId,
        caption.lang,
      );
      deps.db.run(
        `INSERT INTO media (video_id, kind, version, is_current, location_id, rel_path, size_bytes,
                            sha256, lang, downloaded_at, created_at)
         VALUES (?, 'captions', ?, 1, NULL, ?, ?, ?, ?, ?, ?)`,
        videoId,
        version,
        caption.relPath,
        caption.sizeBytes,
        caption.sha256,
        caption.lang,
        now,
        now,
      );
    }
    if (infoRow !== null) {
      deps.db.run("DELETE FROM media WHERE video_id = ? AND kind = 'info'", videoId);
      deps.db.run(
        `INSERT INTO media (video_id, kind, version, is_current, location_id, rel_path, size_bytes,
                            sha256, downloaded_at, created_at)
         VALUES (?, 'info', ?, 1, NULL, ?, ?, ?, ?, ?)`,
        videoId,
        version,
        infoRow.rel,
        infoRow.size,
        infoRow.sha256,
        now,
        now,
      );
    }
    if (Array.isArray(info?.formats) && info.formats.length > 0) {
      const summary = summariseFormats(info.formats);
      deps.db.run(
        `UPDATE videos SET max_height = ?, max_fps = ?, has_av1 = ?, has_vp9 = ?, has_h264 = ?,
                           is_hdr = ?, formats_json = ?, updated_at = ?
          WHERE id = ?`,
        summary.max_height,
        summary.max_fps,
        bool(summary.has_av1),
        bool(summary.has_vp9),
        bool(summary.has_h264),
        bool(summary.is_hdr),
        JSON.stringify(compactFormats(info.formats)),
        now,
        videoId,
      );
    }
  });

  deps.recordDownloadSuccess();
  deps.logActivity({
    kind: "download.done",
    message:
      mediaRow === null
        ? `Stored the metadata of ${videoId}.`
        : `Downloaded ${videoId}${input.reason === "version" ? ` (version ${String(version)})` : ""}.`,
    videoId,
    jobId: ctx.job.id,
    data: {
      kind: mediaRow?.kind ?? null,
      version,
      locationId: location?.id ?? null,
      bytes: media?.size ?? 0,
      captions: captions.map((caption) => caption.lang),
      thumbnails: thumbnails.filter((thumb) => thumb.isNew).length,
      accountId: input.accountId,
    },
  });
  deps.events.publish("video.media", {
    videoId,
    kind: mediaRow?.kind ?? null,
    version,
    locationId: location?.id ?? null,
  });

  if (mediaRow?.kind === "video" && input.effective.transcode.mode !== "none") {
    deps.enqueue({ type: TRANSCODE_JOB, videoId, dedupe: true });
  }
  if (location !== undefined) {
    maybeEnqueueReap(deps, location.id);
  }
  ctx.progress(100, "done");
}

/** Move a current media file to versions/v<N>/ and mark its row not current. */
async function keepAsVersion(deps: PipelineDeps, row: MediaRow): Promise<void> {
  const location = row.location_id === null ? undefined : resolveLocation(deps, row.location_id);
  if (location === undefined) {
    deps.db.run("UPDATE media SET is_current = 0 WHERE id = ?", row.id);
    return;
  }
  const source = resolveRel(location.container_path, row.rel_path);
  const slash = row.rel_path.lastIndexOf("/");
  const dir = slash === -1 ? "" : row.rel_path.slice(0, slash + 1);
  const rel = `${dir}versions/v${String(row.version)}/${row.rel_path.slice(slash + 1)}`;
  const target = resolveRel(location.container_path, rel);
  if (existsSync(source)) {
    await mkdir(dirname(target), { recursive: true });
    await atomicRename(source, target, deps.rename === undefined ? {} : { rename: deps.rename });
  }
  deps.db.run("UPDATE media SET is_current = 0, rel_path = ? WHERE id = ?", rel, row.id);
}
