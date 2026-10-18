import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getKv } from "../src/db/kv.ts";
import { createConsoleLogger } from "../src/logging.ts";
import {
  execRunner,
  installBaselineTools,
  parseFfmpegVersion,
  parseYtdlpVersion,
  probeToolVersions,
  readToolVersions,
  refreshToolVersions,
  TOOL_VERSIONS_KEY,
  type ExecRunner,
  type ToolVersionsState,
} from "../src/media/tools.ts";
import { createTempDb, type TempDb } from "./helpers.ts";

const log = createConsoleLogger("silent");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cellar-tools-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("installBaselineTools", () => {
  it("copies each baseline binary that is not already installed", () => {
    const baselineBinDir = join(dir, "baseline");
    const binDir = join(dir, "data", "bin");
    mkdirSync(baselineBinDir);
    writeFileSync(join(baselineBinDir, "yt-dlp"), "baseline yt-dlp");
    writeFileSync(join(baselineBinDir, "ffmpeg"), "baseline ffmpeg");
    // ffprobe deliberately missing from the baseline.

    expect(installBaselineTools({ binDir, baselineBinDir }, log)).toEqual(["yt-dlp", "ffmpeg"]);
    expect(readFileSync(join(binDir, "yt-dlp"), "utf8")).toBe("baseline yt-dlp");
    expect(existsSync(join(binDir, "ffprobe"))).toBe(false);
  });

  it("never overwrites a copy that is already there, so updates survive restarts", () => {
    const baselineBinDir = join(dir, "baseline");
    const binDir = join(dir, "bin");
    mkdirSync(baselineBinDir);
    mkdirSync(binDir);
    writeFileSync(join(baselineBinDir, "yt-dlp"), "baseline");
    writeFileSync(join(binDir, "yt-dlp"), "updated");
    expect(installBaselineTools({ binDir, baselineBinDir }, log)).toEqual([]);
    expect(readFileSync(join(binDir, "yt-dlp"), "utf8")).toBe("updated");
  });

  it("skips quietly when the image has no baseline directory", () => {
    const binDir = join(dir, "bin");
    expect(installBaselineTools({ binDir, baselineBinDir: join(dir, "absent") }, log)).toEqual([]);
    expect(existsSync(binDir)).toBe(true);
  });

  it("logs and continues when a copy fails", () => {
    const baselineBinDir = join(dir, "baseline");
    const binDir = join(dir, "bin");
    // A directory where a file is expected makes copyFileSync throw.
    mkdirSync(join(baselineBinDir, "yt-dlp"), { recursive: true });
    writeFileSync(join(baselineBinDir, "ffmpeg"), "ok");
    expect(installBaselineTools({ binDir, baselineBinDir }, log)).toEqual(["ffmpeg"]);
  });
});

describe("version parsing", () => {
  it("reads yt-dlp's first line", () => {
    expect(parseYtdlpVersion("2026.08.19\n")).toBe("2026.08.19");
    expect(parseYtdlpVersion("  \n")).toBeNull();
  });

  it("reads the ffmpeg version token", () => {
    expect(
      parseFfmpegVersion("ffmpeg version N-121234-gabcdef-20261018 Copyright (c) 2000-2026\n"),
    ).toBe("N-121234-gabcdef-20261018");
    expect(parseFfmpegVersion("something else")).toBeNull();
  });
});

describe("probing", () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createTempDb();
  });

  afterEach(() => {
    temp.close();
  });

  it("runs each tool with an argv array and records the versions in kv", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const run: ExecRunner = async (file, args) => {
      calls.push({ file, args });
      return file.endsWith("yt-dlp") ? "2026.08.19\n" : "ffmpeg version 7.1 Copyright\n";
    };
    const versions = await refreshToolVersions(temp.db, "/data/bin", log, run);
    expect(versions).toEqual({ ytdlp: "2026.08.19", ffmpeg: "7.1" });
    expect(calls.map((call) => call.args)).toEqual([["--version"], ["-version"]]);
    expect(calls.map((call) => call.file.replaceAll("\\", "/"))).toEqual([
      "/data/bin/yt-dlp",
      "/data/bin/ffmpeg",
    ]);
    expect(readToolVersions(temp.db)).toEqual(versions);
    expect(getKv<ToolVersionsState>(temp.db, TOOL_VERSIONS_KEY)?.ytdlp.current).toBe("2026.08.19");
  });

  it("reports null for a tool that fails, never throwing", async () => {
    const run: ExecRunner = async (file) => {
      if (file.endsWith("ffmpeg")) {
        throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
      }
      return "2026.08.19";
    };
    expect(await probeToolVersions("/nowhere", log, run)).toEqual({
      ytdlp: "2026.08.19",
      ffmpeg: null,
    });
  });

  it("reads nulls before anything was probed", () => {
    expect(readToolVersions(temp.db)).toEqual({ ytdlp: null, ffmpeg: null });
  });

  it("uses execFile for real, and a missing binary is just a null", async () => {
    expect(await probeToolVersions(join(dir, "no-bin-here"), log)).toEqual({
      ytdlp: null,
      ffmpeg: null,
    });
    // The real runner resolves stdout for a binary that exists.
    await expect(execRunner(process.execPath, ["--version"])).resolves.toMatch(/^v\d+/);
  });
});
