/**
 * yt-dlp format selection and format-list summaries. Pure logic, no IO.
 *
 * The input types are local string unions on purpose: the rule effects
 * registry owns the canonical `format_policy` / `media_mode` schemas, and this
 * module must not collide with its exports.
 */

export type YtDlpFormatPolicy = "prefer_av1" | "prefer_vp9" | "prefer_h264" | "best";
export type YtDlpMediaMode = "video" | "audio_only" | "captions_only" | "metadata_only";

export interface YtDlpFormatInput {
  format_policy: YtDlpFormatPolicy;
  /** Cap on video height; null or undefined means no cap. */
  max_height?: number | null;
  /** Cap on frame rate; null or undefined means no cap. */
  max_fps?: number | null;
  media_mode: YtDlpMediaMode;
}

/** vcodec prefixes, as yt-dlp's `[vcodec^=...]` filter sees them. */
const CODEC_PREFIXES: Record<Exclude<YtDlpFormatPolicy, "best">, readonly string[]> = {
  prefer_av1: ["av01"],
  // YouTube reports VP9 as both `vp09.00.xx.08` and plain `vp9`.
  prefer_vp9: ["vp09", "vp9"],
  prefer_h264: ["avc1"],
};

function capFilter(field: "height" | "fps", value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) {
    return "";
  }
  return `[${field}<=${Math.floor(value)}]`;
}

/**
 * Build the yt-dlp `-f` selector for a video's effective settings, following
 * spec 4.7: the preferred codec within the caps, then any codec within the caps,
 * then yt-dlp's best single file as the last resort. Returns null for modes that
 * download no media (`captions_only`, `metadata_only`).
 *
 * prefer_av1, max_height 1080 -> `bv*[vcodec^=av01][height<=1080]+ba/bv*[height<=1080]+ba/b`
 */
export function buildYtDlpFormat(input: YtDlpFormatInput): string | null {
  switch (input.media_mode) {
    case "captions_only":
    case "metadata_only":
      return null;
    case "audio_only":
      return "ba/b";
    case "video":
      break;
  }

  const caps = capFilter("height", input.max_height) + capFilter("fps", input.max_fps);
  const anyCodec = `bv*${caps}+ba`;
  if (input.format_policy === "best") {
    return `${anyCodec}/b`;
  }
  const preferred = CODEC_PREFIXES[input.format_policy].map(
    (prefix) => `bv*[vcodec^=${prefix}]${caps}+ba`,
  );
  return [...preferred, anyCodec, "b"].join("/");
}

/** What the rule engine needs to know about the formats YouTube offers. */
export interface FormatsSummary {
  max_height: number | null;
  max_fps: number | null;
  has_av1: boolean;
  has_vp9: boolean;
  has_h264: boolean;
  is_hdr: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function maxOf(current: number | null, next: number | null): number | null {
  if (next === null) {
    return current;
  }
  return current === null ? next : Math.max(current, next);
}

/**
 * Summarise a yt-dlp `formats` array (from `-J` / info.json). Audio-only
 * formats and storyboards (`vcodec: "none"`) are ignored. Tolerates any input
 * shape: anything that is not an array of objects yields an empty summary.
 */
export function summariseFormats(formats: unknown): FormatsSummary {
  const summary: FormatsSummary = {
    max_height: null,
    max_fps: null,
    has_av1: false,
    has_vp9: false,
    has_h264: false,
    is_hdr: false,
  };
  if (!Array.isArray(formats)) {
    return summary;
  }

  for (const entry of formats) {
    const format = asRecord(entry);
    if (format === null) {
      continue;
    }
    const vcodec = typeof format.vcodec === "string" ? format.vcodec.toLowerCase() : "";
    if (vcodec === "" || vcodec === "none") {
      continue;
    }

    summary.max_height = maxOf(summary.max_height, positiveNumber(format.height));
    summary.max_fps = maxOf(summary.max_fps, positiveNumber(format.fps));

    if (vcodec.startsWith("av01")) {
      summary.has_av1 = true;
    } else if (vcodec.startsWith("vp09") || vcodec.startsWith("vp9")) {
      summary.has_vp9 = true;
    } else if (vcodec.startsWith("avc1") || vcodec.startsWith("h264")) {
      summary.has_h264 = true;
    }

    const range = typeof format.dynamic_range === "string" ? format.dynamic_range.trim() : "";
    if (range !== "" && range.toUpperCase() !== "SDR") {
      summary.is_hdr = true;
    }
  }
  return summary;
}
