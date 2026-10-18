import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const binDir = fileURLToPath(new URL("../../scripts/fake-bin/", import.meta.url));
const fixturesDir = fileURLToPath(new URL("./fixtures/", import.meta.url));
const isWindows = process.platform === "win32";

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

type Tool = "yt-dlp" | "ffmpeg" | "ffprobe";

/** Environment without any FAKE_* variable leaking in from the developer's shell. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("FAKE_")) env[key] = value;
  }
  return { ...env, FAKE_BIN_NODE: process.execPath, ...extra };
}

function exec(file: string, args: string[], env: Record<string, string>): Promise<Result> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env: cleanEnv(env), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

/**
 * Spawn a shim with an argv array and no shell. On POSIX that is the sh launcher itself. On
 * Windows Node refuses to spawn a .cmd without a shell (EINVAL) and cmd.exe would mangle
 * format selectors such as `height<=720`, so the same Node script the launcher runs is used.
 */
function run(tool: Tool, args: string[], env: Record<string, string> = {}): Promise<Result> {
  if (isWindows) return exec(process.execPath, [join(binDir, `${tool}.mjs`), ...args], env);
  return exec(join(binDir, tool), args, env);
}

/** Run the platform launcher exactly as shipped (sh on POSIX, .cmd through cmd.exe on Windows). */
function launcher(tool: Tool, args: string[]): Promise<Result> {
  if (isWindows) {
    return exec("cmd.exe", ["/d", "/s", "/c", join(binDir, `${tool}.cmd`), ...args], {});
  }
  return exec(join(binDir, tool), args, {});
}

function lastJsonLine(stdout: string): Record<string, unknown> {
  const line = stdout
    .split(/\r?\n/)
    .filter((l) => l.startsWith("{"))
    .pop();
  if (!line) throw new Error(`no JSON line in stdout: ${stdout}`);
  return JSON.parse(line) as Record<string, unknown>;
}

let work: string;
let counter = 0;

/** A fresh directory per call so tests never share files. */
async function scratch(): Promise<string> {
  counter += 1;
  return mkdtemp(join(work, `t${counter}-`));
}

const COOKIE_SECRET = "SUPER_SECRET_COOKIE_VALUE_123";
const JAR = [
  "# Netscape HTTP Cookie File",
  `.youtube.com\tTRUE\t/\tTRUE\t1900000000\tSID\t${COOKIE_SECRET}`,
  "",
].join("\n");

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "cellar-fakebin-"));
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("launchers", () => {
  it.each(["yt-dlp", "ffmpeg", "ffprobe"] as const)("%s launcher starts Node", async (tool) => {
    const flag = tool === "yt-dlp" ? "--version" : "-version";
    const res = await launcher(tool, [flag]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("fake");
  });

  // A plain spawn("yt-dlp") resolves the sh launcher through PATH. On Windows libuv only
  // appends .exe, so a .cmd is never found that way (see the README).
  it.skipIf(isWindows)("is found through PATH when the directory is prepended", async () => {
    const env = { PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` };
    const res = await exec("yt-dlp", ["--version"], env);
    expect(res.stdout.trim()).toBe("2026.08.19-fake");
  });
});

describe("yt-dlp shim", () => {
  it("prints the fake version", async () => {
    const res = await run("yt-dlp", ["--version"]);
    expect(res).toMatchObject({ code: 0, stdout: "2026.08.19-fake\n" });
  });

  it("lists the flags the server probes for in --help", async () => {
    const res = await run("yt-dlp", ["--help"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/^\s+--js-runtimes /m);
    expect(res.stdout).toMatch(/^\s+--extractor-args /m);
  });

  it("emits a default flat playlist of three public ids", async () => {
    const res = await run("yt-dlp", [
      "-J",
      "--flat-playlist",
      "https://www.youtube.com/playlist?list=PLfake",
    ]);
    expect(res.code).toBe(0);
    const doc = JSON.parse(res.stdout) as { _type: string; entries: { id: string }[] };
    expect(doc._type).toBe("playlist");
    expect(doc.entries.map((e) => e.id)).toEqual(["dQw4w9WgXcQ", "jNQXAC9IVRw", "9bZkp7q19f0"]);
  });

  it("honours --playlist-end and --dump-single-json", async () => {
    const res = await run("yt-dlp", [
      "--dump-single-json",
      "--flat-playlist",
      "--playlist-end",
      "1",
      "https://www.youtube.com/feed/history",
    ]);
    const doc = JSON.parse(res.stdout) as { id: string; entries: unknown[] };
    expect(doc.id).toBe("history");
    expect(doc.entries).toHaveLength(1);
  });

  it("serves FAKE_YTDLP_PLAYLIST_FILE as the flat playlist", async () => {
    const res = await run("yt-dlp", ["-J", "--flat-playlist", ":ytwatchlater"], {
      FAKE_YTDLP_PLAYLIST_FILE: join(fixturesDir, "ytdlp", "history.flat.json"),
    });
    const doc = JSON.parse(res.stdout) as { entries: { title: string }[] };
    expect(doc.entries).toHaveLength(5);
    expect(doc.entries.map((e) => e.title)).toContain("[Private video]");
  });

  it("returns the full info dict for a single video url", async () => {
    const res = await run("yt-dlp", ["-J", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"]);
    const info = JSON.parse(res.stdout) as { id: string; formats: unknown[]; live_status: string };
    expect(info.id).toBe("dQw4w9WgXcQ");
    expect(info.formats.length).toBeGreaterThan(5);
    expect(info.live_status).toBe("not_live");
  });

  it("downloads: writes media and sidecars, prints progress and the info json", async () => {
    const dir = await scratch();
    const out = join(dir, ".tmp", "dQw4w9WgXcQ");
    const record = join(dir, "record.jsonl");
    const res = await run(
      "yt-dlp",
      [
        "-f",
        "bv*[vcodec^=av01][height<=720]+ba/b",
        "--proxy",
        "http://proxy.invalid:3128",
        "--sleep-requests",
        "1.5",
        "--extractor-args",
        "youtubepot-bgutilhttp:base_url=http://bgutil:4416",
        "--write-info-json",
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs",
        "en",
        "--write-thumbnail",
        "--no-overwrites",
        "--print-json",
        "-o",
        join(out, "%(id)s.%(ext)s"),
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      ],
      { FAKE_YTDLP_RECORD: record },
    );
    expect(res.code).toBe(0);
    const names = (await readdir(out)).sort();
    expect(names).toEqual([
      "dQw4w9WgXcQ.en.vtt",
      "dQw4w9WgXcQ.info.json",
      "dQw4w9WgXcQ.jpg",
      "dQw4w9WgXcQ.webm",
    ]);
    expect((await stat(join(out, "dQw4w9WgXcQ.webm"))).size).toBe(65536);
    expect(res.stdout).toMatch(/\[download\]\s+100% of/);
    const info = lastJsonLine(res.stdout) as {
      id: string;
      ext: string;
      vcodec: string;
      height: number;
    };
    expect(info).toMatchObject({ id: "dQw4w9WgXcQ", ext: "webm", height: 720 });
    expect(info.vcodec).toMatch(/^av01/);
    const onDisk = JSON.parse(await readFile(join(out, "dQw4w9WgXcQ.info.json"), "utf8")) as {
      id: string;
    };
    expect(onDisk.id).toBe("dQw4w9WgXcQ");
    expect(await readFile(join(out, "dQw4w9WgXcQ.en.vtt"), "utf8")).toMatch(/^WEBVTT/);

    const recorded = (await readFile(record, "utf8")).trim().split("\n");
    expect(recorded).toHaveLength(1);
    const argv = JSON.parse(recorded[0] ?? "[]") as string[];
    expect(argv).toContain("--proxy");
    expect(argv[argv.indexOf("--proxy") + 1]).toBe("http://proxy.invalid:3128");
    expect(argv[argv.indexOf("-f") + 1]).toBe("bv*[vcodec^=av01][height<=720]+ba/b");
    expect(argv).toContain("--extractor-args");
  });

  it("controls the container with FAKE_YTDLP_VCODEC and the size with FAKE_YTDLP_BYTES", async () => {
    for (const [vcodec, ext] of [
      ["av01", "webm"],
      ["vp09", "webm"],
      ["avc1", "mp4"],
    ] as const) {
      const dir = await scratch();
      const res = await run(
        "yt-dlp",
        ["--print-json", "-o", join(dir, "%(id)s.%(ext)s"), "jNQXAC9IVRw"],
        { FAKE_YTDLP_VCODEC: vcodec, FAKE_YTDLP_BYTES: "1000" },
      );
      expect(res.code).toBe(0);
      expect((await stat(join(dir, `jNQXAC9IVRw.${ext}`))).size).toBe(1000);
      expect(lastJsonLine(res.stdout).ext).toBe(ext);
    }
  });

  it("rewrites the cookie jar like yt-dlp's write-back and never prints it", async () => {
    const dir = await scratch();
    const jar = join(dir, "cookies.txt");
    await writeFile(jar, JAR);
    const res = await run("yt-dlp", [
      "--cookies",
      jar,
      "--print-json",
      "-o",
      join(dir, "%(id)s.%(ext)s"),
      "dQw4w9WgXcQ",
    ]);
    expect(res.code).toBe(0);
    const after = await readFile(jar, "utf8");
    expect(after).toContain(COOKIE_SECRET);
    expect(after).toMatch(/\tFAKE_ROTATED_1\t/);
    expect(after).toContain("\t1900086400\tSID\t");
    expect(res.stdout + res.stderr).not.toContain(COOKIE_SECRET);

    await run("yt-dlp", ["--cookies", jar, "-J", "--flat-playlist", ":ythistory"]);
    expect(await readFile(jar, "utf8")).toMatch(/\tFAKE_ROTATED_2\t/);
  });

  it("rejects a jar that is not Netscape format without echoing it", async () => {
    const dir = await scratch();
    const jar = join(dir, "bad.txt");
    await writeFile(jar, `{"sid":"${COOKIE_SECRET}"}`);
    const res = await run("yt-dlp", ["--cookies", jar, "-J", "--flat-playlist", ":ythistory"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("does not look like a Netscape format cookies file");
    expect(res.stdout + res.stderr).not.toContain(COOKIE_SECRET);
  });

  it("fails with the bot-wall error when FAKE_YTDLP_FAIL=1", async () => {
    const dir = await scratch();
    const res = await run("yt-dlp", ["-o", join(dir, "%(id)s.%(ext)s"), "dQw4w9WgXcQ"], {
      FAKE_YTDLP_FAIL: "1",
    });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain(
      "ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you're not a bot",
    );
    expect(await readdir(dir)).toEqual([]);
  });

  it("fails only the ids in FAKE_YTDLP_FAIL_IDS", async () => {
    const dir = await scratch();
    const res = await run(
      "yt-dlp",
      ["-o", join(dir, "%(id)s.%(ext)s"), "dQw4w9WgXcQ", "jNQXAC9IVRw"],
      { FAKE_YTDLP_FAIL_IDS: "dQw4w9WgXcQ,other" },
    );
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("dQw4w9WgXcQ: Sign in to confirm");
    expect(res.stderr).not.toContain("jNQXAC9IVRw");
    expect(await readdir(dir)).toEqual(["jNQXAC9IVRw.webm"]);
  });

  it("supports audio-only downloads", async () => {
    const dir = await scratch();
    await run("yt-dlp", ["-f", "ba", "-o", join(dir, "%(id)s.%(ext)s"), "jNQXAC9IVRw"]);
    await run("yt-dlp", ["-x", "-o", join(dir, "x-%(id)s.%(ext)s"), "jNQXAC9IVRw"]);
    expect((await readdir(dir)).sort()).toEqual(["jNQXAC9IVRw.webm", "x-jNQXAC9IVRw.opus"]);
  });

  it("scripts per-call outcomes with a scenario and a state file", async () => {
    const dir = await scratch();
    const env = {
      FAKE_YTDLP_SCENARIO: JSON.stringify({
        calls: [{ fail: true, failMessage: "HTTP Error 429: Too Many Requests" }, {}],
      }),
      FAKE_YTDLP_STATE: join(dir, "state"),
    };
    const args = ["-o", join(dir, "%(id)s.%(ext)s"), "dQw4w9WgXcQ"];
    const first = await run("yt-dlp", args, env);
    const second = await run("yt-dlp", args, env);
    expect(first.code).toBe(1);
    expect(first.stderr).toContain("HTTP Error 429");
    expect(second.code).toBe(0);
    expect(existsSync(join(dir, "dQw4w9WgXcQ.webm"))).toBe(true);
  });
});

describe("ffprobe shim", () => {
  it("prints the fake version", async () => {
    const res = await run("ffprobe", ["-version"]);
    expect(res.stdout).toMatch(/^ffprobe version 7\.1-fake/);
  });

  it("describes one av1 video stream and one opus audio stream by default", async () => {
    const dir = await scratch();
    const file = join(dir, "in.webm");
    await writeFile(file, Buffer.alloc(4096));
    const res = await run("ffprobe", [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      file,
    ]);
    expect(res.code).toBe(0);
    const doc = JSON.parse(res.stdout) as {
      streams: { codec_type: string; codec_name: string; width?: number; r_frame_rate: string }[];
      format: { duration: string; size: string };
    };
    expect(doc.streams).toHaveLength(2);
    expect(doc.streams[0]).toMatchObject({
      codec_type: "video",
      codec_name: "av1",
      width: 1920,
      r_frame_rate: "30/1",
    });
    expect(doc.streams[1]).toMatchObject({ codec_type: "audio", codec_name: "opus" });
    expect(Number(doc.format.duration)).toBe(212.5);
    expect(doc.format.size).toBe("4096");
  });

  it("honours FAKE_FFPROBE_VCODEC and FAKE_FFPROBE_DURATION", async () => {
    const dir = await scratch();
    const file = join(dir, "in.mp4");
    await writeFile(file, "x");
    const res = await run(
      "ffprobe",
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
      { FAKE_FFPROBE_VCODEC: "hevc", FAKE_FFPROBE_DURATION: "100.25" },
    );
    const doc = JSON.parse(res.stdout) as {
      streams: { codec_name: string }[];
      format: { duration: string; format_name: string };
    };
    expect(doc.streams[0]?.codec_name).toBe("hevc");
    expect(Number(doc.format.duration)).toBe(100.25);
    expect(doc.format.format_name).toContain("mp4");
  });

  it("fails for a missing file, and can skip that check", async () => {
    const missing = join(work, "does-not-exist.webm");
    const args = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", missing];
    const res = await run("ffprobe", args);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("No such file or directory");
    const lax = await run("ffprobe", args, { FAKE_FFPROBE_REQUIRE_FILE: "0" });
    expect(lax.code).toBe(0);
  });

  it("can drop streams or change one file's duration through the scenario", async () => {
    const dir = await scratch();
    const a = join(dir, "a.mkv");
    const b = join(dir, "b.mkv");
    await writeFile(a, "x");
    await writeFile(b, "x");
    const env = {
      FAKE_FFPROBE_SCENARIO: JSON.stringify({
        byFile: { "b.mkv": { duration: 50, noAudio: true } },
      }),
    };
    const args = (f: string) => [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      f,
    ];
    const first = JSON.parse((await run("ffprobe", args(a), env)).stdout) as {
      streams: unknown[];
      format: { duration: string };
    };
    const second = JSON.parse((await run("ffprobe", args(b), env)).stdout) as typeof first;
    expect(first.streams).toHaveLength(2);
    expect(Number(first.format.duration)).toBe(212.5);
    expect(second.streams).toHaveLength(1);
    expect(Number(second.format.duration)).toBe(50);
  });
});

describe("ffmpeg shim", () => {
  it("prints the fake version", async () => {
    const res = await run("ffmpeg", ["-version"]);
    expect(res.stdout).toMatch(/^ffmpeg version 7\.1-fake/);
  });

  it("advertises NVENC only when FAKE_FFMPEG_NVENC=1", async () => {
    const off = await run("ffmpeg", ["-hide_banner", "-encoders"]);
    expect(off.stdout).toContain("libsvtav1");
    expect(off.stdout).not.toContain("hevc_nvenc");
    const offHw = await run("ffmpeg", ["-hide_banner", "-hwaccels"]);
    expect(offHw.stdout).not.toMatch(/^cuda$/m);

    const on = await run("ffmpeg", ["-hide_banner", "-encoders"], { FAKE_FFMPEG_NVENC: "1" });
    expect(on.stdout).toContain("hevc_nvenc");
    expect(on.stdout).toContain("h264_nvenc");
    const onHw = await run("ffmpeg", ["-hide_banner", "-hwaccels"], { FAKE_FFMPEG_NVENC: "1" });
    expect(onHw.stdout).toMatch(/^cuda$/m);
  });

  it("transcodes by copying the input, with progress on stderr and argv recorded", async () => {
    const dir = await scratch();
    const input = join(dir, "in.webm");
    const output = join(dir, "out.mkv");
    const record = join(dir, "ffmpeg.jsonl");
    const payload = Buffer.from("not really a video, but bytes are bytes".repeat(50));
    await writeFile(input, payload);
    const args = [
      "-hide_banner",
      "-y",
      "-hwaccel",
      "cuda",
      "-i",
      input,
      "-c:v",
      "hevc_nvenc",
      "-c:a",
      "copy",
      output,
    ];
    const res = await run("ffmpeg", args, { FAKE_FFMPEG_RECORD: record, FAKE_FFMPEG_NVENC: "1" });
    expect(res.code).toBe(0);
    expect(await readFile(output)).toEqual(payload);
    expect(res.stderr).toMatch(/frame=\s*\d+ fps=.* time=\d\d:\d\d:\d\d\.\d\d/);
    expect(res.stderr).toContain("Duration: 00:03:32.50");
    expect(JSON.parse((await readFile(record, "utf8")).trim()) as string[]).toEqual(args);
  });

  it("writes FAKE_FFMPEG_BYTES bytes and emits -progress key/value blocks", async () => {
    const dir = await scratch();
    const input = join(dir, "in.mp4");
    const output = join(dir, "out.mp4");
    await writeFile(input, "x");
    const res = await run("ffmpeg", ["-y", "-progress", "pipe:1", "-i", input, output], {
      FAKE_FFMPEG_BYTES: "2048",
    });
    expect(res.code).toBe(0);
    expect((await stat(output)).size).toBe(2048);
    expect(res.stdout).toContain("progress=continue");
    expect(res.stdout.trimEnd().endsWith("progress=end")).toBe(true);
  });

  it("fails with an encoder error when FAKE_FFMPEG_FAIL=1", async () => {
    const dir = await scratch();
    const input = join(dir, "in.mp4");
    const output = join(dir, "out.mp4");
    await writeFile(input, "x");
    const res = await run("ffmpeg", ["-y", "-i", input, output], { FAKE_FFMPEG_FAIL: "1" });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("Error while opening encoder");
    expect(existsSync(output)).toBe(false);
  });

  it("refuses to overwrite without -y and reports a missing input", async () => {
    const dir = await scratch();
    const input = join(dir, "in.mp4");
    const output = join(dir, "out.mp4");
    await writeFile(input, "x");
    await writeFile(output, "old");
    const clash = await run("ffmpeg", ["-i", input, output]);
    expect(clash.code).toBe(1);
    expect(clash.stderr).toContain("already exists");
    expect(await readFile(output, "utf8")).toBe("old");
    const missing = await run("ffmpeg", ["-y", "-i", join(dir, "nope.mp4"), output]);
    expect(missing.code).toBe(254);
    expect(missing.stderr).toContain("No such file or directory");
  });

  it("fails an NVENC encode when FAKE_FFMPEG_NVENC=0 (no capable device)", async () => {
    const dir = await scratch();
    const input = join(dir, "in.mp4");
    await writeFile(input, "x");
    const res = await run(
      "ffmpeg",
      ["-y", "-i", input, "-c:v", "hevc_nvenc", join(dir, "out.mp4")],
      { FAKE_FFMPEG_NVENC: "0" },
    );
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("Error while opening encoder");
  });
});
