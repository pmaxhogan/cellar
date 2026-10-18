import { describe, expect, it } from "vitest";
import { buildYtDlpFormat, summariseFormats, type YtDlpFormatInput } from "../src/formats.ts";

function video(overrides: Partial<YtDlpFormatInput>): YtDlpFormatInput {
  return { format_policy: "prefer_av1", media_mode: "video", ...overrides };
}

describe("buildYtDlpFormat", () => {
  const cases: [string, Partial<YtDlpFormatInput>, string | null][] = [
    ["av1, no caps", {}, "bv*[vcodec^=av01]+ba/bv*+ba/b"],
    [
      "av1 with height (the spec example)",
      { max_height: 1080 },
      "bv*[vcodec^=av01][height<=1080]+ba/bv*[height<=1080]+ba/b",
    ],
    [
      "av1 with height and fps",
      { max_height: 2160, max_fps: 30 },
      "bv*[vcodec^=av01][height<=2160][fps<=30]+ba/bv*[height<=2160][fps<=30]+ba/b",
    ],
    ["av1 with fps only", { max_fps: 60 }, "bv*[vcodec^=av01][fps<=60]+ba/bv*[fps<=60]+ba/b"],
    [
      "vp9 covers both vcodec spellings",
      { format_policy: "prefer_vp9", max_height: 1440 },
      "bv*[vcodec^=vp09][height<=1440]+ba/bv*[vcodec^=vp9][height<=1440]+ba/bv*[height<=1440]+ba/b",
    ],
    [
      "h264",
      { format_policy: "prefer_h264", max_height: 720 },
      "bv*[vcodec^=avc1][height<=720]+ba/bv*[height<=720]+ba/b",
    ],
    ["best, no caps", { format_policy: "best" }, "bv*+ba/b"],
    [
      "best with caps",
      { format_policy: "best", max_height: 480, max_fps: 30 },
      "bv*[height<=480][fps<=30]+ba/b",
    ],
    ["null caps are ignored", { max_height: null, max_fps: null }, "bv*[vcodec^=av01]+ba/bv*+ba/b"],
    [
      "non-positive caps are ignored",
      { max_height: 0, max_fps: -1 },
      "bv*[vcodec^=av01]+ba/bv*+ba/b",
    ],
    [
      "fractional caps are floored",
      { max_height: 1080.7, max_fps: 29.97 },
      "bv*[vcodec^=av01][height<=1080][fps<=29]+ba/bv*[height<=1080][fps<=29]+ba/b",
    ],
    ["audio only ignores policy and caps", { media_mode: "audio_only", max_height: 720 }, "ba/b"],
    ["captions only downloads no media", { media_mode: "captions_only" }, null],
    ["metadata only downloads no media", { media_mode: "metadata_only" }, null],
  ];

  it.each(cases)("%s", (_name, overrides, expected) => {
    expect(buildYtDlpFormat(video(overrides))).toBe(expected);
  });
});

describe("summariseFormats", () => {
  const EMPTY = {
    max_height: null,
    max_fps: null,
    has_av1: false,
    has_vp9: false,
    has_h264: false,
    is_hdr: false,
  };

  it("summarises a typical YouTube format list", () => {
    const formats = [
      { format_id: "sb0", vcodec: "none", acodec: "none", height: 45, ext: "mhtml" },
      { format_id: "251", vcodec: "none", acodec: "opus", abr: 130 },
      { format_id: "160", vcodec: "avc1.4d400c", height: 144, fps: 30, dynamic_range: "SDR" },
      { format_id: "137", vcodec: "avc1.640028", height: 1080, fps: 30, dynamic_range: "SDR" },
      { format_id: "248", vcodec: "vp9", height: 1080, fps: 30, dynamic_range: "SDR" },
      { format_id: "399", vcodec: "av01.0.08M.08", height: 1080, fps: 30, dynamic_range: "SDR" },
      { format_id: "18", vcodec: "avc1.42001E", acodec: "mp4a.40.2", height: 360, fps: 30 },
    ];
    expect(summariseFormats(formats)).toEqual({
      max_height: 1080,
      max_fps: 30,
      has_av1: true,
      has_vp9: true,
      has_h264: true,
      is_hdr: false,
    });
  });

  it("detects HDR, high frame rates and vp09 spellings", () => {
    const formats = [
      { vcodec: "vp09.02.51.10.01.09.16.09.00", height: 2160, fps: 60, dynamic_range: "HDR10" },
      { vcodec: "av01.0.13M.10.0.110.09.16.09.0", height: 2160, fps: 60, dynamic_range: "hlg" },
    ];
    expect(summariseFormats(formats)).toEqual({
      max_height: 2160,
      max_fps: 60,
      has_av1: true,
      has_vp9: true,
      has_h264: false,
      is_hdr: true,
    });
  });

  it("ignores audio-only, storyboard and malformed entries", () => {
    const formats = [
      null,
      "137",
      [1, 2],
      { vcodec: "none", height: 4320, fps: 60, dynamic_range: "HDR10" },
      { acodec: "opus", height: 999 },
      { vcodec: "avc1", height: "1080", fps: Number.NaN },
    ];
    expect(summariseFormats(formats)).toEqual({ ...EMPTY, has_h264: true });
  });

  it("returns an empty summary for non-array input", () => {
    expect(summariseFormats(undefined)).toEqual(EMPTY);
    expect(summariseFormats({ formats: [] })).toEqual(EMPTY);
    expect(summariseFormats([])).toEqual(EMPTY);
  });

  it("treats a missing dynamic_range as SDR", () => {
    expect(summariseFormats([{ vcodec: "avc1", height: 720, fps: 25 }]).is_hdr).toBe(false);
  });
});
