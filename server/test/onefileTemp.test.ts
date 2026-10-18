import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.ts";
import { createConsoleLogger } from "../src/logging.ts";
import {
  ONEFILE_ORPHAN_AGE_MS,
  onefileDirsInUse,
  pruneOnefileTemp,
  resetToolProbeCache,
  runTool,
} from "../src/media/exec.ts";
import { FAKE_YTDLP_ENV } from "./wave1aHelpers.ts";

const log = createConsoleLogger("silent");
const NOW = Date.now();
const OLD = (NOW - ONEFILE_ORPHAN_AGE_MS - 60_000) / 1000;

let root: string;
let tmp: string;
let proc: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cellar-onefile-"));
  tmp = join(root, "tmp");
  proc = join(root, "proc");
  mkdirSync(tmp);
  mkdirSync(proc);
  resetToolProbeCache();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A `_MEI*` dir (or file) in the fake TMPDIR, aged as asked. */
function meiDir(name: string, old: boolean): string {
  const path = join(tmp, name);
  mkdirSync(path);
  writeFileSync(join(path, "libpython3.13.so.1.0"), "x");
  if (old) utimesSync(path, OLD, OLD);
  return path;
}

/** A fake /proc/<pid>/maps. */
function procMaps(pid: string, lines: string[]): void {
  mkdirSync(join(proc, pid));
  writeFileSync(join(proc, pid, "maps"), `${lines.join("\n")}\n`);
}

const mapLine = (path: string): string =>
  `7f3a1c000000-7f3a1c400000 r-xp 00000000 00:2c 1234 ${path}`;

describe("pruneOnefileTemp", () => {
  it("removes only old, unused _MEI directories", async () => {
    const orphan = meiDir("_MEIab12Cd", true);
    const fresh = meiDir("_MEIfresh1", false);
    const live = meiDir("_MEIlive99", true);
    const other = join(tmp, "not-a-mei");
    mkdirSync(other);
    utimesSync(other, OLD, OLD);
    writeFileSync(join(tmp, "_MEIfile00"), "a file, not a dir");
    utimesSync(join(tmp, "_MEIfile00"), OLD, OLD);
    // A running yt-dlp maps its unpacked libpython; the path may differ from
    // TMPDIR (a mount namespace) and carry " (deleted)".
    procMaps("4242", [
      mapLine("/usr/lib/x86_64-linux-gnu/libc.so.6"),
      mapLine("/run/ytdlp/_MEIlive99/libpython3.13.so.1.0 (deleted)"),
    ]);
    procMaps("1", [mapLine("/usr/bin/node")]);
    mkdirSync(join(proc, "self"));

    const removed = await pruneOnefileTemp(log, { dir: tmp, now: NOW, procRoot: proc });
    expect(removed).toEqual(["_MEIab12Cd"]);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(join(tmp, "_MEIfile00"))).toBe(true);
  });

  it("keeps everything when /proc cannot say which directories are live", async () => {
    const orphan = meiDir("_MEIab12Cd", true);
    const removed = await pruneOnefileTemp(log, {
      dir: tmp,
      now: NOW,
      procRoot: join(root, "no-proc"),
    });
    expect(removed).toEqual([]);
    expect(existsSync(orphan)).toBe(true);
  });

  it("skips a pid whose maps cannot be read, and an empty or missing TMPDIR", async () => {
    mkdirSync(join(proc, "77"));
    const orphan = meiDir("_MEIab12Cd", true);
    expect(await onefileDirsInUse(proc)).toEqual(new Set());
    expect(await pruneOnefileTemp(log, { dir: tmp, now: NOW, procRoot: proc })).toEqual([
      "_MEIab12Cd",
    ]);
    expect(existsSync(orphan)).toBe(false);
    expect(await pruneOnefileTemp(log, { dir: tmp, now: NOW, procRoot: proc })).toEqual([]);
    const warn = vi.fn();
    const spy = { ...log, warn } as unknown as typeof log;
    expect(await pruneOnefileTemp(spy, { dir: join(root, "absent"), procRoot: proc })).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("reads every _MEI name from a maps file", async () => {
    procMaps("10", [
      mapLine("/tmp/_MEIone111/a.so"),
      mapLine("/tmp/_MEItwo222/lib-dynload/b.so"),
      mapLine("/tmp/_MEIthree3"),
      mapLine("/tmp/not_MEI/x.so"),
    ]);
    expect(await onefileDirsInUse(proc)).toEqual(
      new Set(["_MEIone111", "_MEItwo222", "_MEIthree3"]),
    );
  });

  it("defaults to TMPDIR, then the OS temp dir", async () => {
    meiDir("_MEIab12Cd", true);
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    try {
      expect(await pruneOnefileTemp(log, { now: NOW, procRoot: proc })).toEqual(["_MEIab12Cd"]);
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  });
});

describe("runTool prunes before yt-dlp", () => {
  it("prunes the child's TMPDIR before starting yt-dlp, and never for ffmpeg", async () => {
    const orphan = meiDir("_MEIab12Cd", true);
    const config = loadConfig({
      INSECURE_ALLOW_PUBLIC_ACCESS: "1",
      DATA_DIR: join(root, "data"),
      CELLAR_TOOL_YT_DLP: FAKE_YTDLP_ENV,
      CELLAR_TOOL_FFMPEG: JSON.stringify([process.execPath, "-e", "process.exit(0)"]),
    });
    const deps = { config, log };

    await runTool(deps, {
      tool: "ffmpeg",
      args: [],
      timeoutMs: 30_000,
      env: { TMPDIR: tmp },
    });
    expect(existsSync(orphan)).toBe(true);

    const result = await runTool(deps, {
      tool: "yt-dlp",
      args: ["--version"],
      timeoutMs: 30_000,
      env: { TMPDIR: tmp },
    });
    expect(result.code).toBe(0);
    // Only Linux has the /proc that proves the directory is unused.
    expect(existsSync(orphan)).toBe(process.platform !== "linux");
  });
});
