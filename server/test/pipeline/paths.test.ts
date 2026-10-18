import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  atomicRename,
  captionRel,
  channelBucket,
  childOf,
  fsyncDir,
  fsyncFile,
  inflightDir,
  infoJsonRel,
  isInside,
  listFiles,
  mediaRel,
  metaVideoDir,
  PathEscapeError,
  relPath,
  removeEmptyParents,
  resolveRel,
  safeJoin,
  sha256File,
  thumbnailRel,
  versionRel,
} from "../../src/media/paths.ts";
import {
  buildToolArgv,
  createSpawnTool,
  LineSplitter,
  niceAvailable,
  resetNiceProbe,
} from "../../src/media/spawn.ts";
import { baseEnv, fakeBinDir } from "./harness.ts";

const ID = "jNQXAC9IVRw";
const CH = "UCabcdefghijklmnopqrstuv";
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cellar-paths-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("layout", () => {
  it("builds the documented relative paths", () => {
    expect(mediaRel(CH, ID, "WEBM")).toBe(`${CH}/${ID}/${ID}.webm`);
    expect(versionRel(CH, ID, 2, "mp4")).toBe(`${CH}/${ID}/versions/v2/${ID}.mp4`);
    expect(infoJsonRel(null, ID)).toBe(`_unknown/${ID}/info.json`);
    expect(captionRel(CH, ID, "en-US")).toBe(`${CH}/${ID}/en-US.vtt`);
    expect(thumbnailRel(CH, ID, "hq720", "a".repeat(64), "jpg")).toBe(
      `${CH}/${ID}/thumbnails/hq720-${"a".repeat(64)}.jpg`,
    );
    expect(inflightDir("/m", ID)).toBe(resolve("/m", ".tmp", ID));
    expect(metaVideoDir("/d/meta", CH, ID)).toBe(resolve("/d/meta", CH, ID));
    expect(channelBucket("../evil")).toBe("_unknown");
    expect(channelBucket(undefined)).toBe("_unknown");
  });

  it("refuses ids, extensions and paths that escape", () => {
    expect(() => mediaRel(CH, "../../etc/pw", "mp4")).toThrow(PathEscapeError);
    expect(() => mediaRel(CH, ID, "mp4/../x")).toThrow(PathEscapeError);
    expect(() => versionRel(CH, ID, 0, "mp4")).toThrow(PathEscapeError);
    expect(() => captionRel(CH, ID, "../x")).toThrow(PathEscapeError);
    expect(() => thumbnailRel(CH, ID, "x", "nothex", "jpg")).toThrow(PathEscapeError);
    expect(() => safeJoin("/root", "..", "etc")).toThrow(PathEscapeError);
    expect(() => safeJoin("/root")).toThrow(PathEscapeError);
    expect(() => resolveRel("/root", "a/../../b")).toThrow(PathEscapeError);
    expect(() => relPath("/root", "/elsewhere/x")).toThrow(PathEscapeError);
    expect(() => childOf(dir, "../x")).toThrow(PathEscapeError);
    expect(relPath("/root", join("/root", "a", "b"))).toBe("a/b");
    expect(isInside("/root", "/root")).toBe(true);
    expect(isInside("/root", "/rootx/a")).toBe(false);
  });
});

describe("durable file operations", () => {
  it("fsyncs, hashes and renames atomically", async () => {
    const from = join(dir, "a.bin");
    const to = join(dir, "sub", "b.bin");
    writeFileSync(from, "hello");
    mkdirSync(join(dir, "sub"));
    await fsyncFile(from);
    await fsyncDir(dir);
    expect(await sha256File(from)).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    await atomicRename(from, to);
    expect(readFileSync(to, "utf8")).toBe("hello");
    expect(existsSync(from)).toBe(false);
  });

  it("falls back to copy, verify and unlink across filesystems", async () => {
    const from = join(dir, "a.bin");
    const to = join(dir, "b.bin");
    writeFileSync(from, "cross");
    const exdev = (): Promise<void> =>
      Promise.reject(Object.assign(new Error("x"), { code: "EXDEV" }));
    await atomicRename(from, to, { rename: exdev });
    expect(readFileSync(to, "utf8")).toBe("cross");
    expect(existsSync(from)).toBe(false);
    expect(existsSync(`${to}.partial-${String(process.pid)}`)).toBe(false);
  });

  it("rethrows other rename errors", async () => {
    const from = join(dir, "a.bin");
    writeFileSync(from, "x");
    const eperm = (): Promise<void> =>
      Promise.reject(Object.assign(new Error("nope"), { code: "EPERM" }));
    await expect(atomicRename(from, join(dir, "b"), { rename: eperm })).rejects.toThrow("nope");
    const exdev = (): Promise<void> =>
      Promise.reject(Object.assign(new Error("x"), { code: "EXDEV" }));
    await expect(
      atomicRename(from, join(dir, "missing", "b"), { rename: exdev }),
    ).rejects.toThrow();
    expect(existsSync(from)).toBe(true);
  });

  it("removes empty parents up to the stop dir", async () => {
    const deep = join(dir, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(dir, "a", "keep.txt"), "x");
    await removeEmptyParents(deep, dir);
    expect(existsSync(join(dir, "a", "b"))).toBe(false);
    expect(existsSync(join(dir, "a"))).toBe(true);
    await removeEmptyParents(join(dir, "gone", "x"), dir);
    await removeEmptyParents(dir, dir);
    expect(existsSync(dir)).toBe(true);
    expect(await listFiles(join(dir, "a"))).toEqual([join(dir, "a", "keep.txt")]);
    expect(await listFiles(join(dir, "nope"))).toEqual([]);
  });
});

describe("spawn", () => {
  it("splits lines on LF, CRLF and CR", () => {
    const lines: string[] = [];
    const splitter = new LineSplitter((line) => lines.push(line));
    splitter.push("a\r\nb\rc");
    splitter.push("\r");
    splitter.push("\nd\n");
    splitter.push("tail\r");
    splitter.end();
    expect(lines).toEqual(["a", "b", "c", "d", "tail"]);
  });

  it("prefixes nice only when it is available", () => {
    const env = { CELLAR_TOOL_FFMPEG: JSON.stringify(["/x/ffmpeg"]) };
    expect(
      buildToolArgv(
        { tool: "ffmpeg", args: ["-i"], nice: 19 },
        { binDir: dir, env, hasNice: () => true },
      ),
    ).toEqual(["nice", "-n", "19", "/x/ffmpeg", "-i"]);
    expect(
      buildToolArgv(
        { tool: "ffmpeg", args: [], nice: 19 },
        { binDir: dir, env, hasNice: () => false },
      ),
    ).toEqual(["/x/ffmpeg"]);
    expect(buildToolArgv({ tool: "ffprobe", args: [] }, { binDir: dir, env: {} })).toEqual([
      "ffprobe",
    ]);
    resetNiceProbe();
    expect(typeof niceAvailable()).toBe("boolean");
  });

  it("streams lines, captures output and reports exit codes", async () => {
    const run = createSpawnTool({ binDir: dir, env: baseEnv() });
    const out: string[] = [];
    const result = await run({
      tool: "ffmpeg",
      args: ["-version"],
      onStdoutLine: (line) => out.push(line),
    });
    expect(result.code).toBe(0);
    expect(out[0]).toContain("ffmpeg version");
    const failed = await run({ tool: "ffprobe", args: ["-v", "error", join(dir, "missing.mkv")] });
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("No such file");
  });

  it("kills on abort and on timeout", async () => {
    const env = { ...baseEnv(), FAKE_FFMPEG_DELAY_MS: "10000" };
    const run = createSpawnTool({ binDir: dir, env, killGraceMs: 200 });
    const input = join(dir, "in.mkv");
    writeFileSync(input, "x");
    const controller = new AbortController();
    const pending = run({
      tool: "ffmpeg",
      args: ["-y", "-i", input, join(dir, "out.mkv")],
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 200);
    expect(await pending).toMatchObject({ code: null, aborted: true });
    const timed = await run({
      tool: "ffmpeg",
      args: ["-y", "-i", input, join(dir, "o2.mkv")],
      timeoutMs: 200,
    });
    expect(timed).toMatchObject({ code: null, timedOut: true });
    const already = new AbortController();
    already.abort();
    expect(await run({ tool: "ffmpeg", args: [], signal: already.signal })).toMatchObject({
      aborted: true,
    });
  });

  it("rejects when the binary cannot start and caps captured output", async () => {
    const env = { ...baseEnv(), CELLAR_TOOL_YT_DLP: JSON.stringify([join(dir, "nope")]) };
    await expect(
      createSpawnTool({ binDir: dir, env })({ tool: "yt-dlp", args: [] }),
    ).rejects.toThrow();
    const capped = createSpawnTool({ binDir: dir, env: baseEnv(), maxCaptureBytes: 10 });
    const result = await capped({ tool: "yt-dlp", args: ["--help"] });
    expect(result.stdout.length).toBe(10);
    expect(fakeBinDir).toContain("fake-bin");
  });
});
