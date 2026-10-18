import type { Transcode } from "@cellar/shared";

/**
 * ffprobe parsing and ffmpeg transcode planning. Pure functions; the
 * transcode handler does the IO. docs/ARCHITECTURE.md "Transcode".
 *
 * Container rule (open call 1, decided): the original audio is kept
 * (`audio_codec: copy`, the default). The container follows the OUTPUT audio
 * codec: Opus or Vorbis audio goes into `.mkv` (MP4 support for Opus is
 * patchy across players), anything else into `.mp4` with
 * `-movflags +faststart` so it streams before it is fully fetched. HEVC in
 * MP4 is tagged `hvc1`, which Apple players require. A rule that re-encodes
 * the audio to AAC therefore always gets an MP4.
 *
 * NVENC rate control: `-rc vbr -cq <q> -b:v 0`. Without `-b:v 0` the encoder
 * keeps its 2 Mb/s default bitrate as a ceiling and CQ never applies. A rule's
 * `max_video_bitrate_kbps` becomes `-maxrate`/`-bufsize`.
 *
 * Fallback: hevc_nvenc / h264_nvenc need a working NVENC encoder (the
 * self-check probe), av1_nvenc needs an AV1-capable GPU (the GTX 1650 SUPER
 * has none). Without them the job encodes software SVT-AV1 at the documented
 * defaults (preset 8, CRF 35), because a CQ chosen for NVENC means something
 * else as an SVT CRF, under nice 19.
 */

export interface ProbeInfo {
  hasVideo: boolean;
  hasAudio: boolean;
  /** ffprobe codec_name of the first video stream (av1, hevc, h264, vp9, ...). */
  vcodec: string | null;
  acodec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  /** Container bitrate in bits/s. */
  bitrate: number | null;
  durationS: number | null;
  sizeBytes: number | null;
}

export function ffprobeArgs(file: string): string[] {
  return ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file];
}

function num(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

/** `30000/1001` -> 29.97; `0/0` -> null. */
export function parseRate(rate: unknown): number | null {
  if (typeof rate !== "string") {
    return num(rate);
  }
  const [a, b] = rate.split("/");
  const top = Number(a);
  const bottom = b === undefined ? 1 : Number(b);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0 || top === 0) {
    return null;
  }
  return Math.round((top / bottom) * 1000) / 1000;
}

interface ProbeStream {
  codec_type?: unknown;
  codec_name?: unknown;
  width?: unknown;
  height?: unknown;
  r_frame_rate?: unknown;
  avg_frame_rate?: unknown;
  duration?: unknown;
  disposition?: { attached_pic?: unknown };
}

/** Parse `ffprobe -print_format json -show_format -show_streams` output. Throws on garbage. */
export function parseFfprobe(stdout: string): ProbeInfo {
  const parsed = JSON.parse(stdout) as {
    streams?: ProbeStream[];
    format?: { duration?: unknown; bit_rate?: unknown; size?: unknown };
  };
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  // Cover art in a container is a "video" stream with attached_pic set; it is not video.
  const video = streams.find(
    (stream) => stream.codec_type === "video" && num(stream.disposition?.attached_pic) !== 1,
  );
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const format = parsed.format ?? {};
  return {
    hasVideo: video !== undefined,
    hasAudio: audio !== undefined,
    vcodec: typeof video?.codec_name === "string" ? video.codec_name.toLowerCase() : null,
    acodec: typeof audio?.codec_name === "string" ? audio.codec_name.toLowerCase() : null,
    width: num(video?.width),
    height: num(video?.height),
    fps:
      video === undefined
        ? null
        : (parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate)),
    bitrate: num(format.bit_rate),
    durationS: num(format.duration) ?? num(video?.duration) ?? num(audio?.duration),
    sizeBytes: num(format.size),
  };
}

/** Normalise a yt-dlp or ffprobe codec name to a family (`av01.0.08M.08` -> `av1`). */
export function codecFamily(codec: string | null | undefined): string | null {
  if (codec === null || codec === undefined || codec === "" || codec === "none") {
    return null;
  }
  const lower = codec.toLowerCase();
  if (lower.startsWith("av01") || lower === "av1") return "av1";
  if (lower.startsWith("vp09") || lower === "vp9") return "vp9";
  if (lower.startsWith("avc1") || lower === "h264") return "h264";
  if (lower.startsWith("hev1") || lower.startsWith("hvc1") || lower === "hevc") return "hevc";
  if (lower.startsWith("mp4a") || lower === "aac") return "aac";
  return lower;
}

export interface NvencInfo {
  hevc: boolean;
  h264: boolean;
  nvdec: boolean;
  /** AV1 NVENC (Ada and newer). Absent means no. */
  av1?: boolean;
}

export type Encoder = "hevc_nvenc" | "h264_nvenc" | "av1_nvenc" | "libsvtav1";

export interface TranscodePlan {
  encoder: Encoder;
  /** Codec family of the output video. */
  family: "hevc" | "h264" | "av1";
  /** True when the requested codec was unavailable and SVT-AV1 runs instead. */
  fallback: boolean;
  requested: Transcode["codec"];
  hwaccel: boolean;
  container: "mkv" | "mp4";
  /** Audio codec family of the output, null without audio. */
  outputAudio: string | null;
  /** Run under nice 19 (software encodes). */
  nice: boolean;
  /** Output frame size when the source is larger than `max_height`, else null. */
  scale: { width: number; height: number } | null;
  /** Keep every Nth frame to meet `max_fps`, else null. */
  framestep: number | null;
}

export type TranscodeDecision =
  { action: "skip"; reason: string } | { action: "transcode"; plan: TranscodePlan };

export const SVT_DEFAULT_PRESET = "8";
export const SVT_DEFAULT_CRF = 35;
export const NVENC_DEFAULT_PRESET = "p5";
export const DEFAULT_AAC_KBPS = 160;
export const DEFAULT_OPUS_KBPS = 128;

const FAMILY_OF_CODEC: Record<Transcode["codec"], TranscodePlan["family"]> = {
  hevc_nvenc: "hevc",
  h264_nvenc: "h264",
  av1_nvenc: "av1",
  av1_svt: "av1",
};

/** Opus and Vorbis go into Matroska; everything else (and no audio) into MP4. */
export function containerFor(outputAudio: string | null): "mkv" | "mp4" {
  return outputAudio === "opus" || outputAudio === "vorbis" ? "mkv" : "mp4";
}

function outputAudioOf(transcode: Transcode, source: ProbeInfo): string | null {
  if (!source.hasAudio) {
    return null;
  }
  switch (transcode.audio_codec) {
    case "copy":
      return codecFamily(source.acodec);
    case "aac":
      return "aac";
    case "opus":
      return "opus";
  }
}

/** Round down to an even number (4:2:0 encoders need even dimensions), at least 2. */
function even(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

/**
 * The frame size that brings the shorter side down to `maxShort`, keeping the
 * aspect ratio, or null when the source already fits or its size is unknown.
 */
export function scaledSize(
  width: number | null,
  height: number | null,
  maxShort: number | undefined,
): { width: number; height: number } | null {
  if (maxShort === undefined || width === null || height === null || width <= 0 || height <= 0) {
    return null;
  }
  const short = Math.min(width, height);
  if (short <= maxShort) {
    return null;
  }
  const factor = maxShort / short;
  return width <= height
    ? { width: even(maxShort), height: even(height * factor) }
    : { width: even(width * factor), height: even(maxShort) };
}

/**
 * The smallest whole-frame step that brings `fps` to at most `maxFps`, or null
 * when no step is needed. Dropping whole frames keeps motion even: 60 -> 30,
 * 59.94 -> 29.97, 50 -> 25, 48 -> 24, 120 -> 30.
 */
export function frameStep(fps: number | null, maxFps: number | undefined): number | null {
  if (maxFps === undefined || fps === null || !(fps > 0)) {
    return null;
  }
  // A small tolerance so 30.0001 reported for a 30 fps stream needs no step.
  const step = Math.ceil(fps / maxFps - 0.01);
  return step > 1 ? step : null;
}

/** Decide whether and how to transcode, from the rule's settings, the probe and the GPU. */
export function decideTranscode(
  transcode: Transcode,
  source: ProbeInfo,
  nvenc: NvencInfo,
): TranscodeDecision {
  if (transcode.mode === "none") {
    return { action: "skip", reason: "transcode mode is none" };
  }
  if (!source.hasVideo) {
    return { action: "skip", reason: "the media has no video stream" };
  }
  const sourceFamily = codecFamily(source.vcodec);
  const target = FAMILY_OF_CODEC[transcode.codec];
  if (transcode.mode === "if_not_av1") {
    if (sourceFamily === "av1") {
      return { action: "skip", reason: "the download is already AV1" };
    }
    if (sourceFamily === target) {
      return { action: "skip", reason: `the download is already ${target.toUpperCase()}` };
    }
  }

  let encoder: Encoder;
  let fallback = false;
  switch (transcode.codec) {
    case "hevc_nvenc":
      encoder = nvenc.hevc ? "hevc_nvenc" : "libsvtav1";
      break;
    case "h264_nvenc":
      encoder = nvenc.h264 ? "h264_nvenc" : "libsvtav1";
      break;
    case "av1_nvenc":
      encoder = nvenc.av1 === true ? "av1_nvenc" : "libsvtav1";
      break;
    case "av1_svt":
      encoder = "libsvtav1";
      break;
  }
  if (encoder === "libsvtav1" && transcode.codec !== "av1_svt") {
    fallback = true;
  }
  const family = encoder === "libsvtav1" ? "av1" : target;
  const outputAudio = outputAudioOf(transcode, source);
  const scale = scaledSize(source.width, source.height, transcode.max_height);
  // Turing NVDEC has no AV1: ffmpeg would fall back to software decode and hand
  // scale_cuda system-memory frames, so a scaled AV1 source decodes on the CPU.
  const hwaccel =
    encoder !== "libsvtav1" && nvenc.nvdec && !(scale !== null && sourceFamily === "av1");
  return {
    action: "transcode",
    plan: {
      encoder,
      family,
      fallback,
      requested: transcode.codec,
      hwaccel,
      container: containerFor(outputAudio),
      outputAudio,
      nice: encoder === "libsvtav1",
      scale,
      framestep: frameStep(source.fps, transcode.max_fps),
    },
  };
}

function videoArgs(plan: TranscodePlan, transcode: Transcode): string[] {
  const args = ["-c:v", plan.encoder];
  if (plan.encoder === "libsvtav1") {
    const explicit = !plan.fallback;
    const preset =
      explicit && /^\d{1,2}$/.test(transcode.preset) && Number(transcode.preset) <= 13
        ? transcode.preset
        : SVT_DEFAULT_PRESET;
    const crf = explicit ? transcode.quality : SVT_DEFAULT_CRF;
    args.push("-preset", preset, "-crf", String(crf));
  } else {
    const preset = /^p[1-7]$/.test(transcode.preset) ? transcode.preset : NVENC_DEFAULT_PRESET;
    args.push("-preset", preset, "-rc", "vbr", "-cq", String(transcode.quality), "-b:v", "0");
  }
  if (transcode.max_video_bitrate_kbps !== undefined) {
    const kbps = transcode.max_video_bitrate_kbps;
    args.push("-maxrate", `${String(kbps)}k`, "-bufsize", `${String(kbps * 2)}k`);
  }
  if (plan.family === "hevc" && plan.container === "mp4") {
    args.push("-tag:v", "hvc1");
  }
  return args;
}

function audioArgs(plan: TranscodePlan, transcode: Transcode): string[] {
  if (plan.outputAudio === null) {
    return [];
  }
  switch (transcode.audio_codec) {
    case "copy":
      return ["-c:a", "copy"];
    case "aac":
      return [
        "-c:a",
        "aac",
        "-b:a",
        `${String(transcode.audio_bitrate_kbps ?? DEFAULT_AAC_KBPS)}k`,
      ];
    case "opus":
      return [
        "-c:a",
        "libopus",
        "-b:a",
        `${String(transcode.audio_bitrate_kbps ?? DEFAULT_OPUS_KBPS)}k`,
      ];
  }
}

/**
 * The `-vf` chain for a plan, or null. Frames stay on the GPU under CUDA
 * decode, so scaling uses `scale_cuda` there; `framestep` only drops frames
 * and works on either.
 */
export function videoFilters(plan: TranscodePlan): string | null {
  const filters: string[] = [];
  if (plan.framestep !== null) {
    filters.push(`framestep=${String(plan.framestep)}`);
  }
  if (plan.scale !== null) {
    const size = `${String(plan.scale.width)}:${String(plan.scale.height)}`;
    filters.push(plan.hwaccel ? `scale_cuda=${size}` : `scale=${size}`);
  }
  return filters.length === 0 ? null : filters.join(",");
}

/** The ffmpeg argv (without the tool itself). Progress goes to stdout as key=value blocks. */
export function buildTranscodeArgs(
  plan: TranscodePlan,
  transcode: Transcode,
  input: string,
  output: string,
): string[] {
  const args = ["-y", "-hide_banner", "-nostats", "-progress", "pipe:1"];
  if (plan.hwaccel) {
    args.push("-hwaccel", "cuda", "-hwaccel_output_format", "cuda");
  }
  args.push("-i", input, "-map", "0:v:0", "-map", "0:a?", "-map_metadata", "0", "-sn", "-dn");
  const filters = videoFilters(plan);
  if (filters !== null) {
    args.push("-vf", filters);
  }
  args.push(...videoArgs(plan, transcode), ...audioArgs(plan, transcode));
  if (plan.container === "mp4") {
    args.push("-movflags", "+faststart");
  }
  args.push(output);
  return args;
}

/** `HH:MM:SS.ffffff` -> seconds. */
export function parseClock(text: string): number | null {
  const match = /^(-?\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(text.trim());
  if (match === null) {
    return null;
  }
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/**
 * One `-progress` line -> percent of `durationS`, or null when the line
 * carries no time. `out_time_ms` is microseconds too (an old ffmpeg quirk).
 */
export function parseFfmpegProgress(line: string, durationS: number | null): number | null {
  const [key, raw] = line.trim().split("=", 2) as [string, string | undefined];
  if (raw === undefined) {
    return null;
  }
  if (key === "progress" && raw === "end") {
    return 100;
  }
  if (durationS === null || durationS <= 0) {
    return null;
  }
  let seconds: number | null = null;
  if (key === "out_time_us" || key === "out_time_ms") {
    const micros = Number(raw);
    seconds = Number.isFinite(micros) ? micros / 1e6 : null;
  } else if (key === "out_time") {
    seconds = parseClock(raw);
  }
  if (seconds === null || seconds < 0) {
    return null;
  }
  return Math.min(100, (seconds / durationS) * 100);
}

export const DURATION_TOLERANCE_S = 1;

/** Verify a transcode output against its source. */
export function verifyTranscode(
  source: ProbeInfo,
  output: ProbeInfo,
): { ok: true } | { ok: false; reason: string } {
  if (!output.hasVideo) {
    return { ok: false, reason: "the output has no video stream" };
  }
  if (source.hasAudio && !output.hasAudio) {
    return { ok: false, reason: "the output lost the audio stream" };
  }
  if (source.durationS === null || output.durationS === null) {
    return { ok: false, reason: "the duration could not be read" };
  }
  const diff = Math.abs(source.durationS - output.durationS);
  if (diff > DURATION_TOLERANCE_S) {
    return {
      ok: false,
      reason: `the output is ${diff.toFixed(2)} s off the source duration`,
    };
  }
  return { ok: true };
}
