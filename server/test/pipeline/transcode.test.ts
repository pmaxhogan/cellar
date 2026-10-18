import { TranscodeSchema, type Transcode } from "@cellar/shared";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTranscode } from "../../src/jobs/handlers/transcode.ts";
import {
  buildTranscodeArgs,
  codecFamily,
  containerFor,
  decideTranscode,
  parseClock,
  parseFfmpegProgress,
  parseFfprobe,
  parseRate,
  verifyTranscode,
  type NvencInfo,
  type ProbeInfo,
  type TranscodePlan,
} from "../../src/media/ffmpeg.ts";
import {
  activityKinds,
  addMediaFile,
  addVideo,
  CHANNEL_ID,
  createHarness,
  makeCtx,
  mediaRows,
  setEffective,
  VIDEO_ID,
  type Harness,
} from "./harness.ts";

const tc = (overrides: Partial<Transcode> = {}): Transcode => TranscodeSchema.parse(overrides);
const GPU: NvencInfo = { hevc: true, h264: true, nvdec: true };
const NO_GPU: NvencInfo = { hevc: false, h264: false, nvdec: false };

function src(overrides: Partial<ProbeInfo> = {}): ProbeInfo {
  return {
    hasVideo: true,
    hasAudio: true,
    vcodec: "vp9",
    acodec: "opus",
    width: 1920,
    height: 1080,
    fps: 30,
    bitrate: 1000,
    durationS: 100,
    sizeBytes: 1000,
    ...overrides,
  };
}

function plan(decision: ReturnType<typeof decideTranscode>): TranscodePlan {
  if (decision.action !== "transcode") {
    throw new Error(`expected a transcode, got ${decision.reason}`);
  }
  return decision.plan;
}

describe("decideTranscode", () => {
  it("skips by mode, missing video, AV1 and same-codec sources", () => {
    expect(decideTranscode(tc({ mode: "none" }), src(), GPU)).toMatchObject({ action: "skip" });
    expect(decideTranscode(tc(), src({ hasVideo: false }), GPU)).toMatchObject({ action: "skip" });
    expect(decideTranscode(tc(), src({ vcodec: "av1" }), GPU)).toEqual({
      action: "skip",
      reason: "the download is already AV1",
    });
    expect(decideTranscode(tc(), src({ vcodec: "hevc" }), GPU)).toMatchObject({ action: "skip" });
    expect(decideTranscode(tc({ mode: "always" }), src({ vcodec: "av1" }), GPU)).toMatchObject({
      action: "transcode",
    });
  });

  it("uses NVENC when available and falls back to SVT-AV1 otherwise", () => {
    expect(plan(decideTranscode(tc(), src(), GPU))).toMatchObject({
      encoder: "hevc_nvenc",
      family: "hevc",
      fallback: false,
      hwaccel: true,
      container: "mkv",
      nice: false,
    });
    expect(plan(decideTranscode(tc(), src(), { ...GPU, nvdec: false })).hwaccel).toBe(false);
    expect(plan(decideTranscode(tc({ codec: "h264_nvenc" }), src(), GPU)).encoder).toBe(
      "h264_nvenc",
    );
    expect(plan(decideTranscode(tc(), src(), NO_GPU))).toMatchObject({
      encoder: "libsvtav1",
      family: "av1",
      fallback: true,
      hwaccel: false,
      nice: true,
    });
    expect(plan(decideTranscode(tc({ codec: "h264_nvenc" }), src(), NO_GPU)).fallback).toBe(true);
    expect(plan(decideTranscode(tc({ codec: "av1_nvenc" }), src(), GPU)).encoder).toBe("libsvtav1");
    expect(
      plan(decideTranscode(tc({ codec: "av1_nvenc" }), src(), { ...GPU, av1: true })).encoder,
    ).toBe("av1_nvenc");
    expect(plan(decideTranscode(tc({ codec: "av1_svt" }), src(), GPU)).fallback).toBe(false);
  });

  it("follows the container rule", () => {
    expect(containerFor("opus")).toBe("mkv");
    expect(containerFor("vorbis")).toBe("mkv");
    expect(containerFor("aac")).toBe("mp4");
    expect(containerFor(null)).toBe("mp4");
    expect(plan(decideTranscode(tc(), src({ acodec: "aac" }), GPU)).container).toBe("mp4");
    expect(plan(decideTranscode(tc({ audio_codec: "aac" }), src(), GPU)).container).toBe("mp4");
    expect(
      plan(decideTranscode(tc({ audio_codec: "opus" }), src({ acodec: "aac" }), GPU)).container,
    ).toBe("mkv");
    expect(plan(decideTranscode(tc(), src({ hasAudio: false }), GPU))).toMatchObject({
      container: "mp4",
      outputAudio: null,
    });
  });
});

describe("buildTranscodeArgs", () => {
  it("builds the NVENC command", () => {
    const p = plan(decideTranscode(tc({ preset: "p6", quality: 30 }), src(), GPU));
    const args = buildTranscodeArgs(p, tc({ preset: "p6", quality: 30 }), "/in.webm", "/out.mkv");
    expect(args.slice(0, 5)).toEqual(["-y", "-hide_banner", "-nostats", "-progress", "pipe:1"]);
    expect(args.join(" ")).toContain("-hwaccel cuda -hwaccel_output_format cuda -i /in.webm");
    expect(args.join(" ")).toContain("-c:v hevc_nvenc -preset p6 -rc vbr -cq 30 -b:v 0");
    expect(args.join(" ")).toContain("-c:a copy");
    expect(args).not.toContain("-movflags");
    expect(args.at(-1)).toBe("/out.mkv");
  });

  it("adds faststart, hvc1, bitrate caps and audio re-encodes", () => {
    const settings = tc({
      audio_codec: "aac",
      audio_bitrate_kbps: 192,
      max_video_bitrate_kbps: 4000,
      preset: "slow",
    });
    const p = plan(decideTranscode(settings, src(), GPU));
    const args = buildTranscodeArgs(p, settings, "/in", "/out.mp4").join(" ");
    expect(args).toContain("-preset p5");
    expect(args).toContain("-maxrate 4000k -bufsize 8000k");
    expect(args).toContain("-tag:v hvc1");
    expect(args).toContain("-c:a aac -b:a 192k");
    expect(args).toContain("-movflags +faststart");
    const opus = tc({ audio_codec: "opus" });
    expect(
      buildTranscodeArgs(plan(decideTranscode(opus, src(), GPU)), opus, "/i", "/o").join(" "),
    ).toContain("-c:a libopus -b:a 128k");
    const aacDefault = tc({ audio_codec: "aac" });
    expect(
      buildTranscodeArgs(
        plan(decideTranscode(aacDefault, src(), GPU)),
        aacDefault,
        "/i",
        "/o",
      ).join(" "),
    ).toContain("-b:a 160k");
    const silent = buildTranscodeArgs(
      plan(decideTranscode(tc(), src({ hasAudio: false }), GPU)),
      tc(),
      "/i",
      "/o",
    );
    expect(silent).not.toContain("-c:a");
  });

  it("builds SVT-AV1 at the documented defaults on fallback, the rule's values when explicit", () => {
    const fallback = buildTranscodeArgs(
      plan(decideTranscode(tc(), src(), NO_GPU)),
      tc(),
      "/i",
      "/o",
    ).join(" ");
    expect(fallback).toContain("-c:v libsvtav1 -preset 8 -crf 35");
    expect(fallback).not.toContain("-hwaccel");
    const explicit = tc({ codec: "av1_svt", preset: "6", quality: 30 });
    expect(
      buildTranscodeArgs(plan(decideTranscode(explicit, src(), NO_GPU)), explicit, "/i", "/o").join(
        " ",
      ),
    ).toContain("-preset 6 -crf 30");
    const odd = tc({ codec: "av1_svt", preset: "p5", quality: 40 });
    expect(
      buildTranscodeArgs(plan(decideTranscode(odd, src(), NO_GPU)), odd, "/i", "/o").join(" "),
    ).toContain("-preset 8 -crf 40");
  });
});

describe("ffprobe and progress parsing", () => {
  it("parses streams, rates and durations", () => {
    const info = parseFfprobe(
      JSON.stringify({
        streams: [
          { codec_type: "video", codec_name: "mjpeg", disposition: { attached_pic: 1 } },
          {
            codec_type: "video",
            codec_name: "VP9",
            width: 1280,
            height: 720,
            avg_frame_rate: "30000/1001",
          },
          { codec_type: "audio", codec_name: "opus" },
        ],
        format: { duration: "12.5", bit_rate: "1000", size: "2000" },
      }),
    );
    expect(info).toEqual({
      hasVideo: true,
      hasAudio: true,
      vcodec: "vp9",
      acodec: "opus",
      width: 1280,
      height: 720,
      fps: 29.97,
      bitrate: 1000,
      durationS: 12.5,
      sizeBytes: 2000,
    });
    expect(parseFfprobe("{}")).toMatchObject({ hasVideo: false, hasAudio: false, durationS: null });
    expect(parseRate("0/0")).toBeNull();
    expect(parseRate("25")).toBe(25);
    expect(parseRate(24)).toBe(24);
    expect(parseRate("x/y")).toBeNull();
  });

  it("normalises codec families", () => {
    expect(codecFamily("av01.0.08M.08")).toBe("av1");
    expect(codecFamily("vp09.00.40.08")).toBe("vp9");
    expect(codecFamily("avc1.640028")).toBe("h264");
    expect(codecFamily("hvc1")).toBe("hevc");
    expect(codecFamily("mp4a.40.2")).toBe("aac");
    expect(codecFamily("opus")).toBe("opus");
    expect(codecFamily("none")).toBeNull();
    expect(codecFamily(null)).toBeNull();
  });

  it("turns -progress lines into percentages", () => {
    expect(parseFfmpegProgress("out_time_us=50000000", 100)).toBe(50);
    expect(parseFfmpegProgress("out_time_ms=25000000", 100)).toBe(25);
    expect(parseFfmpegProgress("out_time=00:01:15.000000", 100)).toBe(75);
    expect(parseFfmpegProgress("out_time_us=N/A", 100)).toBeNull();
    expect(parseFfmpegProgress("out_time_us=500000000", 100)).toBe(100);
    expect(parseFfmpegProgress("progress=end", null)).toBe(100);
    expect(parseFfmpegProgress("frame=10", 100)).toBeNull();
    expect(parseFfmpegProgress("out_time_us=1", null)).toBeNull();
    expect(parseFfmpegProgress("garbage", 100)).toBeNull();
    expect(parseClock("bad")).toBeNull();
  });

  it("verifies outputs", () => {
    expect(verifyTranscode(src(), src({ durationS: 100.9 }))).toEqual({ ok: true });
    expect(verifyTranscode(src(), src({ durationS: 102 }))).toMatchObject({ ok: false });
    expect(verifyTranscode(src(), src({ hasVideo: false }))).toMatchObject({ ok: false });
    expect(verifyTranscode(src(), src({ hasAudio: false }))).toMatchObject({ ok: false });
    expect(verifyTranscode(src({ durationS: null }), src())).toMatchObject({ ok: false });
  });
});

describe("transcode handler", () => {
  let h: Harness;
  const sourceRel = `${CHANNEL_ID}/${VIDEO_ID}/${VIDEO_ID}.webm`;

  beforeEach(() => {
    h = createHarness();
    addVideo(h.db);
    setEffective(h, VIDEO_ID);
    h.env.FAKE_FFMPEG_RECORD = join(h.root, "ffmpeg.argv");
  });

  afterEach(() => {
    h.close();
  });

  async function transcode(): Promise<ReturnType<typeof makeCtx>> {
    const test = makeCtx(h, { type: "transcode", videoId: VIDEO_ID });
    await runTranscode(h.deps, test.ctx);
    return test;
  }

  function ffmpegArgv(): string[][] {
    const path = join(h.root, "ffmpeg.argv");
    return existsSync(path)
      ? readFileSync(path, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[])
      : [];
  }

  it("skips an AV1 download without running ffmpeg", async () => {
    const { path } = addMediaFile(h, { rel: sourceRel, vcodec: "av1" });
    h.env.FAKE_FFPROBE_VCODEC = "av1";
    await transcode();
    expect(ffmpegArgv()).toEqual([]);
    expect(existsSync(path)).toBe(true);
    expect(mediaRows(h.db)[0]?.transcoded_from).toBeNull();
  });

  it("encodes HEVC on NVENC into mkv and deletes the original", async () => {
    const { path } = addMediaFile(h, { rel: sourceRel, size: 5000 });
    h.nvencInfo = GPU;
    h.env.FAKE_FFMPEG_NVENC = "1";
    h.env.FAKE_FFMPEG_BYTES = "3000";
    h.env.FAKE_FFPROBE_SCENARIO = JSON.stringify({
      vcodec: "vp9",
      byFile: { [`${VIDEO_ID}.transcode.mkv`]: { vcodec: "hevc" } },
    });
    const { progress } = await transcode();
    const argv = ffmpegArgv()[0] as string[];
    expect(argv).toContain("hevc_nvenc");
    expect(argv).toContain("cuda");
    const finalPath = join(h.loc1, CHANNEL_ID, VIDEO_ID, `${VIDEO_ID}.mkv`);
    expect(existsSync(finalPath)).toBe(true);
    expect(statSync(finalPath).size).toBe(3000);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(h.loc1, ".tmp", VIDEO_ID))).toBe(false);
    const row = mediaRows(h.db)[0];
    expect(row).toMatchObject({
      rel_path: `${CHANNEL_ID}/${VIDEO_ID}/${VIDEO_ID}.mkv`,
      size_bytes: 3000,
      vcodec: "hevc",
      transcoded_from: "vp9",
      version: 1,
    });
    expect(progress.some((entry) => entry.pct > 0 && entry.pct < 95)).toBe(true);
    expect(progress.at(-1)?.pct).toBe(100);
    const done = h.db.get<{ data_json: string }>(
      "SELECT data_json FROM activity WHERE kind = 'transcode.done'",
    );
    expect(JSON.parse(done?.data_json ?? "{}")).toMatchObject({
      beforeBytes: 5000,
      afterBytes: 3000,
    });
  });

  it("falls back to SVT-AV1 with a warning when NVENC is missing", async () => {
    addMediaFile(h, { rel: sourceRel });
    h.env.FAKE_FFPROBE_VCODEC = "vp9";
    await transcode();
    expect(ffmpegArgv()[0]).toContain("libsvtav1");
    expect(activityKinds(h.db)).toContain("transcode.fallback");
    expect(activityKinds(h.db)).toContain("transcode.done");
  });

  it("writes mp4 for AAC audio, replacing a same-named original", async () => {
    const rel = `${CHANNEL_ID}/${VIDEO_ID}/${VIDEO_ID}.mp4`;
    addMediaFile(h, { rel, vcodec: "h264", size: 4000 });
    h.nvencInfo = GPU;
    h.env.FAKE_FFMPEG_BYTES = "1500";
    h.env.FAKE_FFPROBE_SCENARIO = JSON.stringify({ vcodec: "h264", acodec: "aac" });
    await transcode();
    const argv = (ffmpegArgv()[0] as string[]).join(" ");
    expect(argv).toContain("-movflags +faststart");
    expect(argv).toContain("-tag:v hvc1");
    expect(statSync(join(h.loc1, ...rel.split("/"))).size).toBe(1500);
    expect(mediaRows(h.db)[0]).toMatchObject({ rel_path: rel, transcoded_from: "h264" });
  });

  it("keeps the original when verification fails", async () => {
    const { path } = addMediaFile(h, { rel: sourceRel });
    h.nvencInfo = GPU;
    h.env.FAKE_FFPROBE_SCENARIO = JSON.stringify({
      vcodec: "vp9",
      byFile: { [`${VIDEO_ID}.transcode.mkv`]: { duration: 100 } },
    });
    await transcode();
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(h.loc1, CHANNEL_ID, VIDEO_ID, `${VIDEO_ID}.mkv`))).toBe(false);
    expect(existsSync(join(h.loc1, ".tmp", VIDEO_ID))).toBe(false);
    expect(mediaRows(h.db)[0]?.transcoded_from).toBeNull();
    expect(activityKinds(h.db)).toContain("transcode.verify_failed");
  });

  it("keeps the original when the output loses its audio", async () => {
    const { path } = addMediaFile(h, { rel: sourceRel });
    h.nvencInfo = GPU;
    h.env.FAKE_FFPROBE_SCENARIO = JSON.stringify({
      vcodec: "vp9",
      byFile: { [`${VIDEO_ID}.transcode.mkv`]: { noAudio: true } },
    });
    await transcode();
    expect(existsSync(path)).toBe(true);
    expect(activityKinds(h.db)).toContain("transcode.verify_failed");
  });

  it("throws when ffmpeg fails and keeps the original", async () => {
    const { path } = addMediaFile(h, { rel: sourceRel });
    h.env.FAKE_FFPROBE_VCODEC = "vp9";
    h.env.FAKE_FFMPEG_FAIL = "1";
    await expect(transcode()).rejects.toThrow(/ffmpeg failed/);
    expect(existsSync(path)).toBe(true);
  });

  it("throws when the source cannot be probed", async () => {
    addMediaFile(h, { rel: sourceRel });
    h.env.FAKE_FFPROBE_FAIL = "1";
    await expect(transcode()).rejects.toThrow(/ffprobe/);
  });

  it("does nothing without media, for transcodes, when unevaluated or mode none", async () => {
    await transcode();
    const { id } = addMediaFile(h, { rel: sourceRel });
    h.db.run("UPDATE media SET transcoded_from = 'vp9' WHERE id = ?", id);
    await transcode();
    h.db.run("UPDATE media SET transcoded_from = NULL WHERE id = ?", id);
    setEffective(h, VIDEO_ID, {
      effective: { transcode: tc({ mode: "none" }) },
    });
    await transcode();
    h.effective.clear();
    await transcode();
    const bad = makeCtx(h, { type: "transcode", videoId: null });
    await runTranscode(h.deps, bad.ctx);
    expect(ffmpegArgv()).toEqual([]);
  });
});
