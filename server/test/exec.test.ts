import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, loadConfig, toolCommand } from "../src/config.ts";
import { updateSettings } from "../src/domain/settings.ts";
import { createConsoleLogger } from "../src/logging.ts";
import {
  resetToolProbeCache,
  runTool,
  ToolRunError,
  ytdlpSupportsJsRuntimes,
  type ExecDeps,
} from "../src/media/exec.ts";
import { createTempDb, type TempDb } from "./helpers.ts";
import { FAKE_YTDLP_ENV } from "./wave1aHelpers.ts";

const log = createConsoleLogger("silent");
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cellar-exec-"));
  resetToolProbeCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function config(env: Record<string, string> = {}) {
  return loadConfig({ INSECURE_ALLOW_PUBLIC_ACCESS: "1", DATA_DIR: dir, ...env });
}

function recordedArgv(path: string): string[][] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
}

describe("toolCommand", () => {
  it("uses the JSON array override with prefix args", () => {
    const cfg = config({ CELLAR_TOOL_YT_DLP: JSON.stringify(["node", "shim.mjs", "--x"]) });
    expect(toolCommand(cfg, "yt-dlp")).toEqual({
      command: "node",
      prefixArgs: ["shim.mjs", "--x"],
    });
  });

  it("prefers $DATA_DIR/bin/<tool> when it exists at call time, else PATH", () => {
    const cfg = config();
    expect(toolCommand(cfg, "ffmpeg")).toEqual({ command: "ffmpeg", prefixArgs: [] });
    mkdirSync(cfg.binDir, { recursive: true });
    writeFileSync(join(cfg.binDir, "ffmpeg"), "");
    expect(toolCommand(cfg, "ffmpeg")).toEqual({
      command: join(cfg.binDir, "ffmpeg"),
      prefixArgs: [],
    });
  });

  it("rejects an override that is not a JSON array of strings, without echoing it", () => {
    expect(() => config({ CELLAR_TOOL_FFPROBE: "not json secret" })).toThrow(ConfigError);
    expect(() => config({ CELLAR_TOOL_FFPROBE: "not json secret" })).not.toThrow(/secret/);
    expect(() => config({ CELLAR_TOOL_FFMPEG: "[]" })).toThrow(/at least the command/);
    expect(() => config({ CELLAR_TOOL_FFMPEG: "[1]" })).toThrow(ConfigError);
  });

  it("defaults the plugin dir and allows disabling it", () => {
    expect(config().ytdlpPluginDirs).toBe("/opt/cellar/yt-dlp-plugins");
    expect(config({ CELLAR_YTDLP_PLUGIN_DIRS: " " }).ytdlpPluginDirs).toBe("");
  });
});

describe("runTool", () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createTempDb();
  });

  afterEach(() => {
    temp.close();
  });

  it("runs yt-dlp with the plugin dir and the js runtime ahead of the caller's argv", async () => {
    const record = join(dir, "argv.jsonl");
    vi.stubEnv("FAKE_YTDLP_RECORD", record);
    const deps: ExecDeps = { config: config({ CELLAR_TOOL_YT_DLP: FAKE_YTDLP_ENV }), log };
    const result = await runTool(deps, {
      tool: "yt-dlp",
      args: ["https://www.youtube.com/feed/history", "--flat-playlist", "-J"],
      timeoutMs: 30_000,
    });
    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(JSON.parse(result.stdout)).toMatchObject({ id: "history" });
    const calls = recordedArgv(record);
    expect(calls.at(-1)).toEqual([
      "--plugin-dirs",
      "/opt/cellar/yt-dlp-plugins",
      "--js-runtimes",
      "node",
      "https://www.youtube.com/feed/history",
      "--flat-playlist",
      "-J",
    ]);
  });

  it("reads the js runtime from settings and caches the --help probe", async () => {
    const record = join(dir, "argv.jsonl");
    vi.stubEnv("FAKE_YTDLP_RECORD", record);
    updateSettings(temp.db, { "tools.js_runtime": "deno" });
    const deps: ExecDeps = {
      config: config({ CELLAR_TOOL_YT_DLP: FAKE_YTDLP_ENV, CELLAR_YTDLP_PLUGIN_DIRS: "" }),
      log,
      db: temp.db,
    };
    await runTool(deps, { tool: "yt-dlp", args: ["--version"], timeoutMs: 30_000 });
    await runTool(deps, { tool: "yt-dlp", args: ["--version"], timeoutMs: 30_000 });
    const calls = recordedArgv(record);
    expect(calls.filter((argv) => argv.includes("--help"))).toHaveLength(1);
    expect(calls.at(-1)).toEqual(["--js-runtimes", "deno", "--version"]);
  });

  it("omits --js-runtimes when the build does not advertise it", async () => {
    const script = join(dir, "old-ytdlp.mjs");
    writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    const deps: ExecDeps = {
      config: config({
        CELLAR_TOOL_YT_DLP: JSON.stringify([process.execPath, script]),
        CELLAR_YTDLP_PLUGIN_DIRS: "",
      }),
      log,
    };
    expect(await ytdlpSupportsJsRuntimes(deps)).toBe(false);
    const result = await runTool(deps, { tool: "yt-dlp", args: ["a"], timeoutMs: 30_000 });
    expect(JSON.parse(result.stdout)).toEqual(["a"]);
  });

  it("passes extra env and cwd, and resolves non-zero exits", async () => {
    const deps: ExecDeps = { config: config({ CELLAR_TOOL_YT_DLP: FAKE_YTDLP_ENV }), log };
    const result = await runTool(deps, {
      tool: "yt-dlp",
      args: ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "-J"],
      timeoutMs: 30_000,
      cwd: dir,
      env: { FAKE_YTDLP_FAIL: "1" },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Sign in to confirm/);
  });

  it("does not add yt-dlp flags to other tools", async () => {
    const deps: ExecDeps = {
      config: config({
        CELLAR_TOOL_FFPROBE: JSON.stringify([
          process.execPath,
          "-e",
          "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
          "--",
        ]),
      }),
      log,
    };
    const result = await runTool(deps, { tool: "ffprobe", args: ["-version"], timeoutMs: 30_000 });
    expect(JSON.parse(result.stdout)).toEqual(["-version"]);
  });

  it("kills a run that exceeds its timeout", async () => {
    const deps: ExecDeps = {
      config: config({
        CELLAR_TOOL_FFMPEG: JSON.stringify([process.execPath, "-e", "setTimeout(() => {}, 20000)"]),
      }),
      log,
    };
    const result = await runTool(deps, { tool: "ffmpeg", args: [], timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(result.code).toBe(-1);
  });

  it("rejects with ToolRunError when the binary cannot start", async () => {
    const deps: ExecDeps = {
      config: config({
        CELLAR_TOOL_FFMPEG: JSON.stringify([join(dir, "does-not-exist")]),
        CELLAR_TOOL_YT_DLP: JSON.stringify([join(dir, "does-not-exist")]),
      }),
      log,
    };
    await expect(runTool(deps, { tool: "ffmpeg", args: [], timeoutMs: 5000 })).rejects.toThrow(
      ToolRunError,
    );
    // The probe failure is not cached and does not hide the real failure.
    await expect(runTool(deps, { tool: "yt-dlp", args: [], timeoutMs: 5000 })).rejects.toThrow(
      /yt-dlp could not be run/,
    );
  });
});
