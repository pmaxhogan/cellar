import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { getKv } from "../src/db/kv.ts";
import { createConsoleLogger } from "../src/logging.ts";
import {
  execRunner,
  installBaselineTools,
  parseFfmpegVersion,
  parseYtdlpVersion,
  PROBE_TIMEOUT_MS,
  probeToolVersions,
  readToolState,
  readToolVersions,
  recordBaselineVersions,
  refreshToolVersions,
  TOOL_VERSIONS_KEY,
  YTDLP_PROBE_TIMEOUT_MS,
  type ExecRunner,
  type ToolVersionsState,
} from "../src/media/tools.ts";
import { createTempDb, type TempDb } from "./helpers.ts";
import { fakeBinDir } from "./systemHelpers.ts";

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

  it("runs each tool from the bin dir with an argv array and records the versions", async () => {
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    writeFileSync(join(binDir, "yt-dlp"), "x");
    writeFileSync(join(binDir, "ffmpeg"), "x");
    const calls: Array<{ file: string; args: readonly string[]; timeoutMs?: number }> = [];
    const run: ExecRunner = async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs });
      return file.endsWith("yt-dlp") ? "2026.08.19\n" : "ffmpeg version 7.1 Copyright\n";
    };
    const versions = await refreshToolVersions(temp.db, { binDir, toolOverrides: {} }, log, run);
    expect(versions).toEqual({ ytdlp: "2026.08.19", ffmpeg: "7.1" });
    expect(calls).toEqual([
      { file: join(binDir, "yt-dlp"), args: ["--version"], timeoutMs: YTDLP_PROBE_TIMEOUT_MS },
      { file: join(binDir, "ffmpeg"), args: ["-version"], timeoutMs: PROBE_TIMEOUT_MS },
    ]);
    // The onefile yt-dlp unpacks itself first, so it gets a minute.
    expect(YTDLP_PROBE_TIMEOUT_MS).toBe(60_000);
    expect(readToolVersions(temp.db)).toEqual(versions);
    expect(getKv<ToolVersionsState>(temp.db, TOOL_VERSIONS_KEY)?.ytdlp.current).toBe("2026.08.19");
  });

  it("falls back to the bare name for a PATH lookup when the bin dir has no copy", async () => {
    const files: string[] = [];
    const run: ExecRunner = async (file) => {
      files.push(file);
      return file === "yt-dlp" ? "2026.08.19\n" : "ffmpeg version 7.1\n";
    };
    const config = { binDir: join(dir, "empty"), toolOverrides: {} };
    expect(await probeToolVersions(config, log, run)).toEqual({
      ytdlp: "2026.08.19",
      ffmpeg: "7.1",
    });
    expect(files).toEqual(["yt-dlp", "ffmpeg"]);
  });

  it("probes through a CELLAR_TOOL_* override, which is what the self-check runs", async () => {
    const config = loadConfig({
      INSECURE_ALLOW_PUBLIC_ACCESS: "1",
      DATA_DIR: dir,
      CELLAR_TOOL_YT_DLP: JSON.stringify([process.execPath, join(fakeBinDir, "yt-dlp.mjs")]),
      CELLAR_TOOL_FFMPEG: JSON.stringify([process.execPath, join(fakeBinDir, "ffmpeg.mjs")]),
    });
    // Nothing in $DATA_DIR/bin: before the fix both versions were null here.
    expect(existsSync(join(config.binDir, "yt-dlp"))).toBe(false);
    const versions = await refreshToolVersions(temp.db, config, log);
    expect(versions).toEqual({ ytdlp: "2026.08.19-fake", ffmpeg: "7.1-fake" });
    expect(readToolVersions(temp.db)).toEqual(versions);
  });

  it("reports null for a tool that fails, never throwing", async () => {
    const run: ExecRunner = async (file) => {
      if (file.endsWith("ffmpeg")) {
        throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
      }
      return "2026.08.19";
    };
    const config = { binDir: "/nowhere", toolOverrides: {} };
    expect(await probeToolVersions(config, log, run)).toEqual({
      ytdlp: "2026.08.19",
      ffmpeg: null,
    });
  });

  it("reads nulls before anything was probed", () => {
    expect(readToolVersions(temp.db)).toEqual({ ytdlp: null, ffmpeg: null });
  });

  it("uses execFile for real, and a missing binary is just a null", async () => {
    const config = {
      binDir: join(dir, "no-bin-here"),
      toolOverrides: { "yt-dlp": [join(dir, "no-yt-dlp")], ffmpeg: [join(dir, "no-ffmpeg")] },
    };
    expect(await probeToolVersions(config, log)).toEqual({ ytdlp: null, ffmpeg: null });
    // The real runner resolves stdout for a binary that exists.
    await expect(execRunner(process.execPath, ["--version"])).resolves.toMatch(/^v\d+/);
  });

  it("records the image copies as the baseline, and null for a tool the image lacks", async () => {
    const baseline = join(dir, "baseline");
    mkdirSync(baseline);
    writeFileSync(join(baseline, "ffmpeg"), "x");
    const files: string[] = [];
    const run: ExecRunner = async (file) => {
      files.push(file);
      return "ffmpeg version 6.1\n";
    };
    expect(await recordBaselineVersions(temp.db, baseline, log, run)).toEqual({
      ytdlp: null,
      ffmpeg: "6.1",
    });
    expect(files).toEqual([join(baseline, "ffmpeg")]);
    expect(readToolState(temp.db).ffmpeg.baseline).toBe("6.1");
    expect(readToolState(temp.db).ytdlp.baseline).toBeNull();
  });
});
