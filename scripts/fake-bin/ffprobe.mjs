#!/usr/bin/env node
// Fake ffprobe for cellar integration tests. Does not read the media, only stats it.
import { existsSync, statSync } from "node:fs";
import { extname } from "node:path";
import { baseName, loadConfig, recordArgv } from "./lib.mjs";

const SPEC = {
  vcodec: { env: "VCODEC", type: "str" },
  duration: { env: "DURATION", type: "num" },
  fail: { env: "FAIL", type: "bool" },
  requireFile: { env: "REQUIRE_FILE", type: "bool" },
};

const argv = process.argv.slice(2);
recordArgv(process.env.FAKE_FFPROBE_RECORD, argv);

const VIDEO_CODECS = {
  av1: { name: "av1", long: "Alliance for Open Media AV1", profile: "Main", tag: "av01", level: 8 },
  hevc: {
    name: "hevc",
    long: "H.265 / HEVC (High Efficiency Video Coding)",
    profile: "Main",
    tag: "hev1",
    level: 120,
  },
  h264: {
    name: "h264",
    long: "H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10",
    profile: "High",
    tag: "avc1",
    level: 40,
  },
  vp9: { name: "vp9", long: "Google VP9", profile: "Profile 0", tag: "[0][0][0][0]", level: -99 },
};

/** @param {string | undefined} name */
function videoCodec(name) {
  const n = (name ?? "av1").toLowerCase();
  if (n.startsWith("av01") || n === "av1") return VIDEO_CODECS.av1;
  if (n.startsWith("hevc") || n === "h265" || n.startsWith("hev1") || n.startsWith("hvc1")) {
    return VIDEO_CODECS.hevc;
  }
  if (n.startsWith("h264") || n.startsWith("avc")) return VIDEO_CODECS.h264;
  if (n.startsWith("vp9") || n.startsWith("vp09")) return VIDEO_CODECS.vp9;
  return { name: n, long: n, profile: "unknown", tag: "[0][0][0][0]", level: -99 };
}

/** @param {string} file */
function formatFor(file) {
  switch (extname(file).toLowerCase()) {
    case ".mp4":
    case ".m4a":
    case ".m4v":
    case ".mov":
      return { name: "mov,mp4,m4a,3gp,3g2,mj2", long: "QuickTime / MOV" };
    case ".opus":
    case ".ogg":
      return { name: "ogg", long: "Ogg" };
    default:
      return { name: "matroska,webm", long: "Matroska / WebM" };
  }
}

/** @param {number} n */
const fixed = (n, digits = 6) => n.toFixed(digits);

function banner() {
  process.stdout.write(
    [
      "ffprobe version 7.1-fake Copyright (c) 2007-2025 the FFmpeg developers",
      "built with the cellar fake-bin shim",
      "configuration: --enable-nvenc --enable-libsvtav1 (fake)",
      "libavutil      59. 39.100 / 59. 39.100",
      "",
    ].join("\n"),
  );
}

function main() {
  if (argv.includes("-version") || argv.includes("--version")) {
    banner();
    return 0;
  }

  // The file to probe is the last argument that is not an option or an option value.
  const valued = new Set([
    "-v",
    "-loglevel",
    "-print_format",
    "-of",
    "-select_streams",
    "-show_entries",
    "-i",
    "-f",
    "-count_frames",
  ]);
  let file = null;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (valued.has(token)) {
      if (token === "-i") file = argv[i + 1] ?? file;
      i += 1;
    } else if (!token.startsWith("-")) {
      file = token;
    }
  }
  if (file === null) {
    process.stderr.write("ffprobe: At least one input file must be specified\n");
    return 1;
  }

  const cfg = loadConfig("FFPROBE", SPEC);
  const override = cfg.byFile?.[baseName(file)] ?? {};
  const effective = { ...cfg, ...override };

  if (effective.fail) {
    process.stderr.write(`${file}: Invalid data found when processing input\n`);
    return 1;
  }
  const requireFile = effective.requireFile ?? true;
  if (requireFile && !existsSync(file)) {
    process.stderr.write(`${file}: No such file or directory\n`);
    return 1;
  }

  const duration = effective.duration ?? 212.5;
  const vc = videoCodec(effective.vcodec);
  const width = effective.width ?? 1920;
  const height = effective.height ?? 1080;
  const rate = effective.frameRate ?? "30/1";
  const acodec = effective.acodec ?? "opus";
  const size = existsSync(file) ? statSync(file).size : 0;
  const bitRate = duration > 0 ? Math.round((size * 8) / duration) : 0;
  const fmt = formatFor(file);

  const video = {
    index: 0,
    codec_name: vc.name,
    codec_long_name: vc.long,
    profile: vc.profile,
    codec_type: "video",
    codec_tag_string: vc.tag,
    codec_tag: "0x0000",
    width,
    height,
    coded_width: width,
    coded_height: height,
    has_b_frames: 0,
    sample_aspect_ratio: "1:1",
    display_aspect_ratio: "16:9",
    pix_fmt: "yuv420p",
    level: vc.level,
    color_range: "tv",
    field_order: "progressive",
    r_frame_rate: rate,
    avg_frame_rate: rate,
    time_base: "1/1000",
    start_pts: 0,
    start_time: fixed(0),
    extradata_size: 4,
    disposition: { default: 1, dub: 0, original: 0, comment: 0, lyrics: 0, karaoke: 0, forced: 0 },
    tags: { language: "eng", DURATION: durationTag(duration) },
  };
  const audio = {
    index: effective.noVideo ? 0 : 1,
    codec_name: acodec,
    codec_long_name:
      acodec === "opus" ? "Opus (Opus Interactive Audio Codec)" : "AAC (Advanced Audio Coding)",
    codec_type: "audio",
    codec_tag_string: "[0][0][0][0]",
    codec_tag: "0x0000",
    sample_fmt: "fltp",
    sample_rate: "48000",
    channels: 2,
    channel_layout: "stereo",
    bits_per_sample: 0,
    r_frame_rate: "0/0",
    avg_frame_rate: "0/0",
    time_base: "1/1000",
    start_pts: 0,
    start_time: fixed(0),
    extradata_size: 19,
    disposition: { default: 1, dub: 0, original: 0, comment: 0, lyrics: 0, karaoke: 0, forced: 0 },
    tags: { language: "eng", DURATION: durationTag(duration) },
  };

  let streams = [];
  if (!effective.noVideo) streams.push(video);
  if (!effective.noAudio) streams.push(audio);
  streams = streams.map((s, i) => ({ ...s, index: i }));

  const select = valueOf("-select_streams");
  if (select) {
    const kind = select.startsWith("v") ? "video" : select.startsWith("a") ? "audio" : null;
    const nth = /:(\d+)$/.exec(select);
    if (kind) streams = streams.filter((s) => s.codec_type === kind);
    if (nth) streams = streams.filter((_s, i) => i === Number(nth[1]));
  }

  const format = {
    filename: file,
    nb_streams: effective.noVideo || effective.noAudio ? 1 : 2,
    nb_programs: 0,
    format_name: fmt.name,
    format_long_name: fmt.long,
    start_time: fixed(0),
    duration: fixed(duration),
    size: String(size),
    bit_rate: String(bitRate),
    probe_score: 100,
    tags: { ENCODER: "Lavf61.7.100" },
  };

  const result = {};
  if (argv.includes("-show_streams")) result.streams = streams;
  if (argv.includes("-show_format")) result.format = format;
  process.stdout.write(`${JSON.stringify(result, null, 4)}\n`);
  return 0;
}

/** @param {string} name */
function valueOf(name) {
  const i = argv.lastIndexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** @param {number} seconds */
function durationTag(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds - h * 3600 - m * 60;
  const two = (v) => String(v).padStart(2, "0");
  return `${two(h)}:${two(m)}:${s.toFixed(9).padStart(12, "0")}`;
}

process.exitCode = main();
