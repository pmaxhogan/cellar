#!/usr/bin/env node
// Fake ffmpeg for cellar integration tests: copies the input to the output, prints
// realistic banner and progress lines. No real encoding. See README.md.
import { appendFileSync, copyFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname } from "node:path";
import { formatClock, loadConfig, recordArgv, sleep, writeRandomFile } from "./lib.mjs";

const SPEC = {
  fail: { env: "FAIL", type: "bool" },
  bytes: { env: "BYTES", type: "int" },
  nvenc: { env: "NVENC", type: "str" },
  delayMs: { env: "DELAY_MS", type: "int" },
};

const argv = process.argv.slice(2);
recordArgv(process.env.FAKE_FFMPEG_RECORD, argv);

const COPYRIGHT = "Copyright (c) 2000-2025 the FFmpeg developers";

const BANNER = [
  `ffmpeg version 7.1-fake ${COPYRIGHT}`,
  "  built with the cellar fake-bin shim",
  "  configuration: --enable-nvenc --enable-libsvtav1 --enable-libx265 (fake)",
  "  libavutil      59. 39.100 / 59. 39.100",
  "  libavcodec     61. 19.100 / 61. 19.100",
  "  libavformat    61.  7.100 / 61.  7.100",
];

/** @param {string} name @param {string} desc @param {string} flags */
const codecLine = (flags, name, desc) => ` ${flags} ${name.padEnd(19)} ${desc}`;

const ENCODER_HEADER = [
  "Encoders:",
  " V..... = Video",
  " A..... = Audio",
  " S..... = Subtitle",
  " .F.... = Frame-level multithreading",
  " ..S... = Slice-level multithreading",
  " ...X.. = Codec is experimental",
  " ....B. = Supports draw_horiz_band",
  " .....D = Supports direct rendering method 1",
  " ------",
];

const DECODER_HEADER = ENCODER_HEADER.map((l) => l.replace("Encoders:", "Decoders:"));

/** @param {string | undefined} nvenc */
const nvencOn = (nvenc) => ["1", "true"].includes(String(nvenc).toLowerCase());

function listEncoders(nvenc) {
  const lines = [
    ...ENCODER_HEADER,
    codecLine(
      "V....D",
      "libx264",
      "libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)",
    ),
    codecLine("V....D", "libx265", "libx265 H.265 / HEVC (codec hevc)"),
    codecLine(
      "V....D",
      "libsvtav1",
      "SVT-AV1(Scalable Video Technology for AV1) encoder (codec av1)",
    ),
    codecLine("A....D", "libopus", "libopus Opus (codec opus)"),
    codecLine("A....D", "aac", "AAC (Advanced Audio Coding)"),
  ];
  if (nvencOn(nvenc)) {
    lines.push(codecLine("V....D", "h264_nvenc", "NVIDIA NVENC H.264 encoder (codec h264)"));
    lines.push(codecLine("V....D", "hevc_nvenc", "NVIDIA NVENC hevc encoder (codec hevc)"));
  }
  return lines;
}

function listDecoders(nvenc) {
  const lines = [
    ...DECODER_HEADER,
    codecLine("V....D", "libdav1d", "dav1d AV1 decoder by VideoLAN (codec av1)"),
    codecLine("V....D", "h264", "H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10"),
    codecLine("V....D", "hevc", "HEVC (High Efficiency Video Coding)"),
    codecLine("V....D", "vp9", "Google VP9"),
    codecLine("A....D", "opus", "Opus"),
    codecLine("A....D", "aac", "AAC (Advanced Audio Coding)"),
  ];
  if (nvencOn(nvenc)) {
    lines.push(codecLine("V....D", "h264_cuvid", "Nvidia CUVID H264 decoder (codec h264)"));
    lines.push(codecLine("V....D", "hevc_cuvid", "Nvidia CUVID HEVC decoder (codec hevc)"));
    lines.push(codecLine("V....D", "av1_cuvid", "Nvidia CUVID AV1 decoder (codec av1)"));
  }
  return lines;
}

/**
 * Parsed view of a transcode invocation. Only the options the shim cares about.
 * @param {string[]} args
 */
function parseTranscode(args) {
  /** @type {{ path: string, format: string | null }[]} */
  const inputs = [];
  let pendingFormat = null;
  let vcodec = null;
  let hwaccel = null;
  let overwrite = false;
  let never = false;
  let progress = null;
  let loglevel = null;
  let stats = null;
  let lastInputIndex = -1;
  for (let i = 0; i < args.length; i += 1) {
    const t = args[i];
    if (t === "-i") {
      inputs.push({ path: args[i + 1] ?? "", format: pendingFormat });
      pendingFormat = null;
      i += 1;
      lastInputIndex = i;
    } else if (t === "-f") {
      pendingFormat = args[i + 1] ?? null;
      i += 1;
    } else if (/^-(c|codec|vcodec)(:v(:\d+)?)?$/.test(t)) {
      vcodec = args[i + 1] ?? null;
      i += 1;
    } else if (t === "-hwaccel") {
      hwaccel = args[i + 1] ?? null;
      i += 1;
    } else if (t === "-y") {
      overwrite = true;
    } else if (t === "-n") {
      never = true;
    } else if (t === "-progress") {
      progress = args[i + 1] ?? null;
      i += 1;
    } else if (t === "-loglevel" || t === "-v") {
      loglevel = args[i + 1] ?? null;
      i += 1;
    } else if (t === "-nostats") {
      stats = false;
    } else if (t === "-stats") {
      stats = true;
    }
  }
  const lastArg = args[args.length - 1];
  const output =
    lastArg !== undefined &&
    args.length - 1 > lastInputIndex &&
    (lastArg === "-" || !lastArg.startsWith("-"))
      ? lastArg
      : null;
  return {
    inputs,
    outputFormat: pendingFormat,
    output,
    vcodec,
    hwaccel,
    overwrite,
    never,
    progress,
    loglevel,
    stats,
    hideBanner: args.includes("-hide_banner"),
  };
}

/** @param {string} path */
function containerName(path) {
  switch (extname(path).toLowerCase()) {
    case ".mp4":
    case ".m4a":
    case ".mov":
      return "mov,mp4,m4a,3gp,3g2,mj2";
    case ".webm":
    case ".mkv":
      return "matroska,webm";
    case ".opus":
    case ".ogg":
      return "ogg";
    default:
      return "matroska,webm";
  }
}

const err = (text) => process.stderr.write(text);

async function transcode() {
  const cfg = loadConfig("FFMPEG", SPEC);
  const t = parseTranscode(argv);
  const quiet = ["quiet", "panic", "fatal", "error"].includes(t.loglevel ?? "");
  const lines = (arr) => {
    if (!quiet) err(`${arr.join("\n")}\n`);
  };

  if (t.inputs.length === 0 || t.output === null) {
    if (t.inputs.length > 0) err("At least one output file must be specified\n");
    else err("ffmpeg: Argument parse error: no input file given\n");
    return 1;
  }

  const duration = Number(process.env.FAKE_FFPROBE_DURATION ?? 212.5);
  const effectiveDuration = cfg.duration ?? duration;

  if (!t.hideBanner) lines(BANNER);

  const first = t.inputs[0];
  const synthetic = first.format === "lavfi";
  for (const input of t.inputs) {
    if (input.format !== "lavfi" && !existsSync(input.path)) {
      err(`${input.path}: No such file or directory\n`);
      return 254;
    }
  }
  const discard =
    t.output === "-" || t.outputFormat === "null" || /^(NUL|\/dev\/null)$/.test(t.output);
  const outputDir = dirname(t.output);
  if (!discard && !existsSync(outputDir)) {
    err(`${t.output}: No such file or directory\n`);
    return 254;
  }
  if (!discard && existsSync(t.output) && (!t.overwrite || t.never)) {
    err(`File '${t.output}' already exists. Exiting.\n`);
    return 1;
  }

  lines([
    `Input #0, ${synthetic ? "lavfi" : containerName(first.path)}, from '${first.path}':`,
    `  Duration: ${formatClock(effectiveDuration)}, start: 0.000000, bitrate: 2468 kb/s`,
    "  Stream #0:0: Video: av1 (libdav1d), yuv420p(tv), 1920x1080, 30 fps, 30 tbr, 1k tbn",
    "  Stream #0:1: Audio: opus, 48000 Hz, stereo, fltp",
    `Output #0, ${t.outputFormat ?? containerName(t.output)}, to '${t.output}':`,
  ]);

  const wantsNvenc = /nvenc/.test(t.vcodec ?? "") || t.hwaccel === "cuda";
  if (wantsNvenc && cfg.nvenc !== undefined && !nvencOn(cfg.nvenc)) {
    err(
      "[hevc_nvenc @ 0x5581e0c0] OpenEncodeSessionEx failed: unsupported device (2): (no details)\n",
    );
    err(
      "[vost#0:0/hevc_nvenc @ 0x5581e0d0] Error while opening encoder for output stream #0:0 - maybe incorrect parameters such as bit_rate, rate, width or height\n",
    );
    err("Conversion failed!\n");
    return 1;
  }

  if (cfg.fail) {
    err(
      "[vost#0:0/libx265 @ 0x5581e0d0] Error while opening encoder for output stream #0:0 - maybe incorrect parameters such as bit_rate, rate, width or height\n",
    );
    err("Conversion failed!\n");
    if (cfg.leavePartial && !discard) writeFileSync(t.output, "");
    return 1;
  }

  const total = synthetic ? 1 : statSync(first.path).size;
  const outSize = cfg.bytes ?? total;
  const steps = 4;
  const showStats = (t.stats ?? true) && !quiet;
  const progressSink = (text) => {
    if (!t.progress) return;
    if (t.progress === "pipe:1" || t.progress === "-") process.stdout.write(text);
    else if (t.progress === "pipe:2") err(text);
    else appendFileSync(t.progress, text);
  };
  for (let step = 1; step <= steps; step += 1) {
    if (cfg.delayMs) await sleep(cfg.delayMs / steps);
    const time = (effectiveDuration * step) / steps;
    const frame = Math.round(time * 30);
    const size = Math.round((outSize * step) / steps);
    const bitrate = ((size * 8) / 1000 / Math.max(time, 0.001)).toFixed(1);
    if (showStats) {
      err(
        `frame=${String(frame).padStart(5)} fps= 60 q=28.0 size=${String(Math.round(size / 1024)).padStart(8)}KiB time=${formatClock(time)} bitrate=${bitrate.padStart(7)}kbits/s speed=2.00x    ${step === steps ? "\n" : "\r"}`,
      );
    }
    progressSink(
      [
        `frame=${frame}`,
        "fps=60.00",
        "stream_0_0_q=28.0",
        `bitrate=${bitrate}kbits/s`,
        `total_size=${size}`,
        `out_time_us=${Math.round(time * 1e6)}`,
        `out_time_ms=${Math.round(time * 1e6)}`,
        `out_time=${formatClock(time, 6)}`,
        "dup_frames=0",
        "drop_frames=0",
        "speed=2.00x",
        `progress=${step === steps ? "end" : "continue"}`,
        "",
      ].join("\n"),
    );
  }

  if (!discard) {
    if (cfg.bytes !== undefined || synthetic) writeRandomFile(t.output, cfg.bytes ?? 1024);
    else copyFileSync(first.path, t.output);
  }
  lines([
    `[out#0/${t.outputFormat ?? containerName(t.output).split(",")[0]} @ 0x5581e0e0] video:${Math.round(outSize / 1024)}KiB audio:0KiB subtitle:0KiB other streams:0KiB global headers:0KiB muxing overhead: 0.5%`,
  ]);
  return 0;
}

async function main() {
  if (argv.includes("-version")) {
    process.stdout.write(`${[...BANNER, ""].join("\n")}`);
    return 0;
  }
  if (argv.includes("-encoders")) {
    process.stdout.write(`${listEncoders(process.env.FAKE_FFMPEG_NVENC).join("\n")}\n`);
    return 0;
  }
  if (argv.includes("-decoders")) {
    process.stdout.write(`${listDecoders(process.env.FAKE_FFMPEG_NVENC).join("\n")}\n`);
    return 0;
  }
  if (argv.includes("-hwaccels")) {
    const lines = ["Hardware acceleration methods:"];
    if (nvencOn(process.env.FAKE_FFMPEG_NVENC)) lines.push("cuda");
    process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  }
  return transcode();
}

process.exitCode = await main();
