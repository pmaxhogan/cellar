import { resolveSettings } from "@cellar/shared";
import { describe, expect, it } from "vitest";
import {
  AUDIO_ONLY_FORMAT,
  buildCanaryArgs,
  buildDownloadArgs,
  classifyFailure,
  commonArgs,
  formatSelector,
  infoFilePaths,
  parsePrintedFile,
  parsePrintJson,
  parseProgress,
  redactArgv,
  redactUrl,
  subLangs,
  ytdlpToolOptions,
  type DownloadArgsInput,
} from "../../src/media/ytdlp.ts";
import { detectEdit } from "../../src/media/versions.ts";
import { effective } from "./harness.ts";

const settings = resolveSettings({});

function build(overrides: Partial<DownloadArgsInput> = {}): ReturnType<typeof buildDownloadArgs> {
  return buildDownloadArgs({
    effective: effective(),
    video: { id: "jNQXAC9IVRw" },
    outDir: "/media/.tmp/jNQXAC9IVRw/",
    settings,
    random: () => 0.5,
    ...overrides,
  });
}

function valueOf(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe("buildDownloadArgs", () => {
  it("builds the default argv with the URL last", () => {
    const { args, skipMedia, rejectedExtraArgs } = build();
    expect(skipMedia).toBe(false);
    expect(rejectedExtraArgs).toEqual([]);
    expect(args.slice(-2)).toEqual(["--", "https://www.youtube.com/watch?v=jNQXAC9IVRw"]);
    expect(valueOf(args, "-f")).toBe("bv*[vcodec^=av01]+ba/bv*+ba/b");
    expect(valueOf(args, "-o")).toBe("/media/.tmp/jNQXAC9IVRw/%(id)s.%(ext)s");
    for (const flag of [
      "--no-playlist",
      "--no-overwrites",
      "--newline",
      "--progress",
      "--print-json",
      "--write-info-json",
      "--write-all-thumbnails",
      "--write-subs",
      "--write-auto-subs",
    ]) {
      expect(args).toContain(flag);
    }
    expect(valueOf(args, "--progress-template")).toContain("cellar-progress");
    expect(valueOf(args, "--sub-langs")).toBe("all,-live_chat");
    expect(valueOf(args, "--sub-format")).toBe("vtt");
    expect(valueOf(args, "--convert-subs")).toBe("vtt");
    expect(valueOf(args, "--sleep-requests")).toBe("2");
    expect(args).not.toContain("--cookies");
    expect(args).not.toContain("--proxy");
    expect(args).not.toContain("--limit-rate");
    expect(args).not.toContain("--live-from-start");
    expect(args).not.toContain("--skip-download");
    expect(args).not.toContain("-x");
  });

  it("applies caps, policies and a format override", () => {
    expect(
      valueOf(
        build({ effective: effective({ format_policy: "prefer_h264", max_height: 720 }) }).args,
        "-f",
      ),
    ).toBe("bv*[vcodec^=avc1][height<=720]+ba/bv*[height<=720]+ba/b");
    expect(
      valueOf(build({ effective: effective({ ytdlp: { format_override: "18" } }) }).args, "-f"),
    ).toBe("18");
  });

  it("keeps the original audio for audio_only, with no -x", () => {
    const { args } = build({ effective: effective({ media_mode: "audio_only" }) });
    expect(valueOf(args, "-f")).toBe(AUDIO_ONLY_FORMAT);
    expect(args).not.toContain("-x");
    expect(args).not.toContain("--extract-audio");
  });

  it("skips media for captions_only and everything but metadata for metadata_only", () => {
    const captions = build({ effective: effective({ media_mode: "captions_only" }) });
    expect(captions.skipMedia).toBe(true);
    expect(captions.args).toContain("--skip-download");
    expect(captions.args).not.toContain("-f");
    expect(captions.args).toContain("--write-subs");
    const metadata = build({ effective: effective({ media_mode: "metadata_only" }) });
    expect(metadata.args).toContain("--skip-download");
    expect(metadata.args).not.toContain("--write-subs");
    expect(metadata.args).toContain("--write-info-json");
  });

  it("follows the captions effect", () => {
    const off = build({
      effective: effective({
        captions: { enabled: false, languages: "all", auto_generated: true },
      }),
    });
    expect(off.args).not.toContain("--write-subs");
    const manual = build({
      effective: effective({
        captions: { enabled: true, languages: ["en", "de"], auto_generated: false },
      }),
    });
    expect(manual.args).toContain("--write-subs");
    expect(manual.args).not.toContain("--write-auto-subs");
    expect(valueOf(manual.args, "--sub-langs")).toBe("en,de");
    expect(subLangs("all")).toBe("all,-live_chat");
  });

  it("adds cookies, proxy, rate, fragments, sleeps and live flags", () => {
    const { args } = build({
      cookiesPath: "/data/tmp/cookies-1.txt",
      proxyUrl: "http://user:pw@proxy:3128",
      effective: effective({
        live: "record_live",
        ytdlp: {
          rate_limit_bytes_per_s: 500000,
          concurrent_fragments: 4,
          sleep_requests_min: 2,
          sleep_requests_max: 4,
        },
      }),
    });
    expect(valueOf(args, "--cookies")).toBe("/data/tmp/cookies-1.txt");
    expect(valueOf(args, "--proxy")).toBe("http://user:pw@proxy:3128");
    expect(valueOf(args, "--limit-rate")).toBe("500000");
    expect(valueOf(args, "--concurrent-fragments")).toBe("4");
    expect(valueOf(args, "--sleep-requests")).toBe("3");
    expect(args).toContain("--live-from-start");
  });

  it("uses the global rate limit and omits a zero sleep", () => {
    const global = resolveSettings({
      "download.rate_limit_bytes_per_s": 1000,
      "download.sleep_requests_min_s": 0,
      "download.sleep_requests_max_s": 0,
    });
    const { args } = build({ settings: global });
    expect(valueOf(args, "--limit-rate")).toBe("1000");
    expect(args).not.toContain("--sleep-requests");
  });

  it("passes the PO token provider, plugin dirs and JS runtime", () => {
    const { args } = build({
      potProviderUrl: "http://bgutil:4416/",
      pluginDirs: ["/opt/cellar/yt-dlp-plugins", " "],
      jsRuntime: "node",
    });
    expect(valueOf(args, "--extractor-args")).toBe(
      "youtubepot-bgutilhttp:base_url=http://bgutil:4416",
    );
    expect(args.filter((arg) => arg === "--plugin-dirs")).toHaveLength(1);
    expect(valueOf(args, "--js-runtimes")).toBe("node");
    expect(commonArgs({ potProviderUrl: "", jsRuntime: null })).toEqual([]);
  });

  it("only passes allowlisted extra args", () => {
    const { args, rejectedExtraArgs } = build({
      effective: effective({
        ytdlp: { extra_args_allowlisted: ["--embed-chapters", "--exec=rm -rf /", "--retries=5"] },
      }),
    });
    expect(args).toContain("--embed-chapters");
    expect(args).toContain("--retries=5");
    expect(args.join(" ")).not.toContain("--exec");
    expect(rejectedExtraArgs).toEqual(["--exec=rm -rf /"]);
  });

  it("returns null selectors for media-less modes", () => {
    expect(formatSelector(effective({ media_mode: "metadata_only" }))).toBeNull();
  });
});

describe("canary and tool options", () => {
  it("builds the canary argv without cookies or sidecars", () => {
    const args = buildCanaryArgs({
      outDir: "/tmp/c",
      potProviderUrl: "http://p",
      jsRuntime: "node",
    });
    expect(valueOf(args, "-f")).toBe("worst");
    expect(args.at(-1)).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(args).not.toContain("--cookies");
    expect(args).not.toContain("--write-info-json");
  });

  it("seeds the provider URL from the environment while the setting is the default", () => {
    const config = { potProviderUrl: "http://sidecar:9000", ytdlpPluginDirs: "" };
    expect(ytdlpToolOptions(settings, config)).toEqual({
      potProviderUrl: "http://sidecar:9000",
      pluginDirs: [],
      jsRuntime: "node",
    });
    const custom = resolveSettings({ "tools.pot_provider_url": "", "tools.js_runtime": "deno" });
    expect(ytdlpToolOptions(custom, { ...config, ytdlpPluginDirs: "/p" })).toEqual({
      potProviderUrl: "",
      pluginDirs: ["/p"],
      jsRuntime: "deno",
    });
  });
});

describe("output parsing", () => {
  it("parses templated and native progress lines", () => {
    expect(parseProgress("cellar-progress  42.5% 17")).toEqual({ pct: 42.5, etaS: 17 });
    expect(parseProgress("cellar-progress 100.0% NA")).toEqual({ pct: 100, etaS: null });
    expect(parseProgress("[download]  25.0% of    1.00MiB at    2.00MiB/s ETA 00:03")).toEqual({
      pct: 25,
      etaS: null,
    });
    expect(parseProgress("[youtube] x: Downloading webpage")).toBeNull();
  });

  it("finds the last info JSON line and the printed file", () => {
    const stdout = [
      "[info] something",
      '{"not":"info"}',
      "{broken",
      '{"id":"jNQXAC9IVRw","ext":"webm"}',
      "cellar-file:/x/jNQXAC9IVRw.webm",
      "",
    ].join("\n");
    expect(parsePrintJson(stdout)).toEqual({ id: "jNQXAC9IVRw", ext: "webm" });
    expect(parsePrintJson("nothing here")).toBeNull();
    expect(parsePrintedFile(stdout)).toBe("/x/jNQXAC9IVRw.webm");
    expect(parsePrintedFile("cellar-file:NA")).toBeNull();
    expect(
      infoFilePaths({
        requested_downloads: [{ filepath: "/a" }, null],
        _filename: "/b",
        filepath: 3,
      }),
    ).toEqual(["/a", "/b"]);
    expect(infoFilePaths(null)).toEqual([]);
  });
});

describe("redaction", () => {
  it("masks proxy credentials but keeps the cookie path", () => {
    const argv = redactArgv([
      "--cookies",
      "/data/tmp/cookies.txt",
      "--proxy",
      "socks5://bob:hunter2@10.0.0.1:1080",
      "--extractor-args",
      "x:base_url=http://a:b@host",
    ]);
    expect(argv.join(" ")).not.toContain("hunter2");
    expect(argv.join(" ")).not.toContain("a:b@");
    expect(argv).toContain("/data/tmp/cookies.txt");
    expect(argv[3]).toBe("socks5://***@10.0.0.1:1080");
    expect(redactArgv(["--proxy", "http://plain:8080"])[1]).toBe("http://plain:8080");
    expect(redactArgv(["--proxy", "not a url"])[1]).toBe("[proxy]");
    expect(redactUrl("see https://u:p@h/x")).toBe("see https://***@h/x");
  });
});

describe("classifyFailure", () => {
  it.each([
    ["ERROR: [youtube] x: Sign in to confirm you're not a bot", "bot_wall", false, undefined],
    [
      "ERROR: [youtube] x: Private video. Sign in if you've been granted access",
      "unavailable",
      true,
      "private",
    ],
    [
      "ERROR: [youtube] x: This video has been removed by the uploader",
      "unavailable",
      true,
      "removed",
    ],
    ["ERROR: [youtube] x: Video unavailable", "unavailable", true, "unavailable"],
    [
      "ERROR: unable to download video data: HTTP Error 429: Too Many Requests",
      "rate_limited",
      false,
      undefined,
    ],
    ["ERROR: [youtube] x: Sign in to confirm your age", "auth", false, undefined],
    [
      "ERROR: Unable to download webpage: <urlopen error [Errno 111] Connection refused>",
      "network",
      false,
      undefined,
    ],
    ["ERROR: something odd", "unknown", false, undefined],
  ])("%s -> %s", (stderr, kind, permanent, privacy) => {
    const failure = classifyFailure(stderr);
    expect(failure.kind).toBe(kind);
    expect(failure.permanent).toBe(permanent);
    expect(failure.privacy).toBe(privacy);
    expect(failure.message).toBe(stderr);
  });

  it("falls back to the last line and masks credentials", () => {
    expect(classifyFailure("", "").message).toBe("yt-dlp failed without output");
    expect(classifyFailure("boom via http://u:p@proxy").message).toBe("boom via http://***@proxy");
  });
});

describe("detectEdit", () => {
  it("flags duration changes over 2 s and signature changes", () => {
    expect(detectEdit({ duration_s: 100 }, { duration_s: 102 })).toBe(false);
    expect(detectEdit({ duration_s: 100 }, { duration_s: 103 })).toBe(true);
    expect(detectEdit({ duration_s: null }, { duration_s: 300 })).toBe(false);
    expect(detectEdit({ content_signature: "a" }, { content_signature: "b" })).toBe(true);
    expect(detectEdit({ content_signature: "a" }, { content_signature: "a" })).toBe(false);
    expect(detectEdit({ content_signature: "" }, { content_signature: "b" })).toBe(false);
    expect(detectEdit({}, {})).toBe(false);
  });
});
