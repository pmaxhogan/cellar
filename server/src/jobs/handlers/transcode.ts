import { createWriteStream } from "node:fs";
import { mkdir, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  buildTranscodeArgs,
  decideTranscode,
  ffprobeArgs,
  parseFfmpegProgress,
  parseFfprobe,
  verifyTranscode,
  type NvencInfo,
  type ProbeInfo,
} from "../../media/ffmpeg.ts";
import { atomicRename, inflightDir, isVideoId, resolveRel, sha256File } from "../../media/paths.ts";
import { findLocation, type MediaRow } from "../../media/rows.ts";
import type { PipelineDeps } from "../pipelineDeps.ts";
import type { JobContext } from "../types.ts";

/**
 * The `transcode` job (transcode class, global concurrency 1). Decides from
 * the rule's `transcode` effect, the downloaded codec (ffprobe) and the GPU
 * (see media/ffmpeg.ts for the container rule and the fallback). The output
 * is written into the location's in-flight dir, verified with ffprobe
 * (streams present, duration within 1 s), then swapped in: the media row is
 * updated in place (same id and version, `transcoded_from` = the source
 * codec) and the ORIGINAL IS DELETED (spec 3.4). A failed verification keeps
 * the original, deletes the output and leaves a warning; it is not retried.
 */

export const TRANSCODE_JOB = "transcode";
export const TRANSCODE_TIMEOUT_MS = 24 * 60 * 60_000;
export const FFMPEG_LOG_FILE = "ffmpeg.log";
const NO_NVENC: NvencInfo = { hevc: false, h264: false, nvdec: false };

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

function currentVideoRow(deps: PipelineDeps, videoId: string): MediaRow | undefined {
  return deps.db.get<MediaRow>(
    `SELECT * FROM media WHERE video_id = ? AND kind = 'video' AND is_current = 1
      ORDER BY version DESC, id DESC LIMIT 1`,
    videoId,
  );
}

export async function runTranscode(deps: PipelineDeps, ctx: JobContext): Promise<void> {
  const videoId = ctx.job.videoId;
  if (videoId === null || !isVideoId(videoId)) {
    ctx.log.error({ videoId }, "transcode job without a valid video id");
    return;
  }
  const row = currentVideoRow(deps, videoId);
  if (row === undefined || row.location_id === null) {
    ctx.log.info("no current video media; nothing to transcode");
    return;
  }
  if (row.transcoded_from !== null) {
    ctx.log.info("the current media is already a transcode");
    return;
  }
  const location = findLocation(deps, row.location_id);
  if (location === undefined) {
    ctx.log.warn({ locationId: row.location_id }, "the media's location is unknown");
    return;
  }
  const resolved = deps.getEffective(videoId);
  if (resolved === null) {
    ctx.log.info("not evaluated; skipping the transcode");
    return;
  }
  const transcode = resolved.effective.transcode;
  if (transcode.mode === "none") {
    ctx.log.info("transcode mode is none");
    return;
  }

  const sourcePath = resolveRel(location.container_path, row.rel_path);
  const source = await probe(deps, sourcePath, ctx.signal);
  if (source === null) {
    throw new Error("ffprobe could not read the downloaded media");
  }
  const nvenc = transcode.codec === "av1_svt" ? NO_NVENC : await deps.nvenc();
  const decision = decideTranscode(transcode, source, nvenc);
  if (decision.action === "skip") {
    ctx.log.info({ reason: decision.reason }, "transcode skipped");
    return;
  }
  const plan = decision.plan;
  if (plan.fallback) {
    deps.logActivity({
      level: "warn",
      kind: "transcode.fallback",
      message: `${plan.requested} is not available on this machine; ${videoId} is encoded with software SVT-AV1 instead.`,
      videoId,
      jobId: ctx.job.id,
    });
  }

  const workDir = inflightDir(location.container_path, videoId);
  await mkdir(workDir, { recursive: true });
  const output = join(workDir, `${videoId}.transcode.${plan.container}`);
  await rm(output, { force: true });

  const logStream = createWriteStream(join(ctx.logDir, FFMPEG_LOG_FILE), { flags: "a" });
  const args = buildTranscodeArgs(plan, transcode, sourcePath, output);
  logStream.write(`[argv] ${JSON.stringify(args)}\n`);
  ctx.log.info({ encoder: plan.encoder, container: plan.container }, "running ffmpeg");
  let code: number | null;
  let stderrTail = "";
  try {
    const result = await deps.runTool({
      tool: "ffmpeg",
      args,
      timeoutMs: TRANSCODE_TIMEOUT_MS,
      signal: ctx.signal,
      ...(plan.nice ? { nice: 19 } : {}),
      onStdoutLine: (line) => {
        const pct = parseFfmpegProgress(line, source.durationS);
        if (pct !== null) {
          ctx.progress(pct * 0.95, "transcoding");
        }
      },
      onStderrLine: (line) => {
        logStream.write(`[err] ${line}\n`);
        if (line.trim() !== "") {
          stderrTail = line.trim();
        }
      },
    });
    code = result.code;
  } finally {
    await new Promise<void>((resolve) => {
      logStream.end(() => {
        resolve();
      });
    });
  }

  try {
    ctx.checkpoint();
    if (code !== 0) {
      throw new Error(`ffmpeg failed (exit ${String(code)}): ${stderrTail.slice(0, 300)}`);
    }
    const out = await probe(deps, output, ctx.signal);
    const verdict =
      out === null
        ? ({ ok: false, reason: "ffprobe could not read the output" } as const)
        : verifyTranscode(source, out);
    if (!verdict.ok || out === null) {
      deps.logActivity({
        level: "warn",
        kind: "transcode.verify_failed",
        message: `Transcode of ${videoId} failed verification (${verdict.ok ? "no probe" : verdict.reason}); kept the original.`,
        videoId,
        jobId: ctx.job.id,
      });
      return;
    }

    // The reaper or the mover may have touched the media while ffmpeg ran.
    const now = currentVideoRow(deps, videoId);
    if (now === undefined || now.id !== row.id || now.rel_path !== row.rel_path) {
      ctx.log.warn("the media changed during the transcode; discarding the output");
      return;
    }
    const slash = row.rel_path.lastIndexOf("/");
    const rel = `${slash === -1 ? "" : row.rel_path.slice(0, slash + 1)}${videoId}.${plan.container}`;
    const finalPath = resolveRel(location.container_path, rel);
    const sha256 = await sha256File(output);
    const { size } = await stat(output);
    await atomicRename(output, finalPath, deps.rename === undefined ? {} : { rename: deps.rename });
    if (finalPath !== sourcePath) {
      await unlink(sourcePath).catch((error: unknown) => {
        ctx.log.warn({ err: error }, "could not delete the original after the transcode");
      });
    }
    deps.db.run(
      `UPDATE media SET rel_path = ?, size_bytes = ?, sha256 = ?, vcodec = ?, acodec = ?,
                        height = ?, fps = ?, bitrate = ?, transcoded_from = ?
        WHERE id = ?`,
      rel,
      size,
      sha256,
      out.vcodec,
      out.acodec,
      out.height,
      out.fps,
      out.bitrate,
      source.vcodec ?? row.vcodec ?? "unknown",
      row.id,
    );
    deps.logActivity({
      kind: "transcode.done",
      message: `Transcoded ${videoId} from ${source.vcodec ?? "?"} to ${plan.family} (${plan.encoder}).`,
      videoId,
      jobId: ctx.job.id,
      data: {
        encoder: plan.encoder,
        container: plan.container,
        beforeBytes: Number(row.size_bytes),
        afterBytes: size,
      },
    });
    deps.events.publish("video.media", { videoId, kind: "video", version: row.version });
    ctx.progress(100, "done");
  } finally {
    await rm(output, { force: true }).catch(() => undefined);
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
