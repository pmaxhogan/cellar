import { execFile } from "node:child_process";
import type { Logger } from "pino";
import { toolCommand, type Config, type ToolCommand, type ToolName } from "../config.ts";
import type { Db } from "../db/db.ts";
import { getSettings } from "../domain/settings.ts";

/**
 * The one place the server starts yt-dlp, ffmpeg and ffprobe. Always an argv
 * array through execFile, never a shell. The argv is never logged: it can
 * carry a cookie jar path and, later, a proxy URL.
 *
 * Deliberately small: the job runner (progress parsing, cancellation, log
 * files) builds on top of this.
 */

export interface RunToolRequest {
  tool: ToolName;
  args: readonly string[];
  timeoutMs: number;
  cwd?: string;
  /** Extra environment for the child, merged over the server's own. */
  env?: Readonly<Record<string, string>>;
}

export interface RunToolResult {
  /** Exit code; -1 when the process was killed (timeout or signal). */
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecDeps {
  config: Pick<Config, "toolOverrides" | "binDir" | "ytdlpPluginDirs">;
  log: Logger;
  /** When present, `tools.js_runtime` is read from the settings. */
  db?: Db;
}

/** The tool could not be started at all (missing binary, permissions, output too large). */
export class ToolRunError extends Error {
  override readonly name = "ToolRunError";
  readonly tool: ToolName;
  readonly reason: string;

  constructor(tool: ToolName, reason: string) {
    super(`${tool} could not be run (${reason}).`);
    this.tool = tool;
    this.reason = reason;
  }
}

/** -J on a long feed can be large; anything beyond this is a runaway. */
const MAX_BUFFER_BYTES = 256 * 1024 * 1024;
const HELP_PROBE_TIMEOUT_MS = 15_000;

function spawnCapture(
  tool: ToolName,
  cmd: ToolCommand,
  args: readonly string[],
  options: { timeoutMs: number; cwd?: string; env?: Readonly<Record<string, string>> },
): Promise<RunToolResult> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd.command,
      [...cmd.prefixArgs, ...args],
      {
        timeout: options.timeoutMs,
        maxBuffer: MAX_BUFFER_BYTES,
        windowsHide: true,
        encoding: "utf8",
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr, timedOut: false });
          return;
        }
        if (typeof error.code === "number") {
          resolve({ code: error.code, stdout, stderr, timedOut: false });
          return;
        }
        if (error.killed === true || error.signal != null) {
          resolve({ code: -1, stdout, stderr, timedOut: error.killed === true });
          return;
        }
        reject(new ToolRunError(tool, typeof error.code === "string" ? error.code : "unknown"));
      },
    );
  });
}

/** Per command line: does this yt-dlp build know --js-runtimes? */
const jsRuntimeProbe = new Map<string, boolean>();

/** Forget cached --help probes (after a tool update, and in tests). */
export function resetToolProbeCache(): void {
  jsRuntimeProbe.clear();
}

/** Whether the resolved yt-dlp advertises --js-runtimes. Probed once per command. */
export async function ytdlpSupportsJsRuntimes(deps: ExecDeps): Promise<boolean> {
  const cmd = toolCommand(deps.config, "yt-dlp");
  const key = JSON.stringify([cmd.command, ...cmd.prefixArgs]);
  const cached = jsRuntimeProbe.get(key);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const result = await spawnCapture("yt-dlp", cmd, ["--help"], {
      timeoutMs: HELP_PROBE_TIMEOUT_MS,
    });
    const supported = result.code === 0 && result.stdout.includes("--js-runtimes");
    jsRuntimeProbe.set(key, supported);
    return supported;
  } catch (error) {
    // Not cached: the binary may appear later (boot install, updater).
    deps.log.warn({ err: error }, "yt-dlp --help probe failed");
    return false;
  }
}

async function ytdlpBaseArgs(deps: ExecDeps): Promise<string[]> {
  const args: string[] = [];
  if (deps.config.ytdlpPluginDirs !== "") {
    args.push("--plugin-dirs", deps.config.ytdlpPluginDirs);
  }
  if (await ytdlpSupportsJsRuntimes(deps)) {
    const runtime = deps.db === undefined ? "node" : getSettings(deps.db)["tools.js_runtime"];
    args.push("--js-runtimes", runtime);
  }
  return args;
}

/**
 * Run a tool to completion and capture its output. A non-zero exit resolves
 * (the caller decides what it means); only a failure to start rejects, with a
 * ToolRunError. yt-dlp always gets the plugin directory and, when the build
 * supports it, the JS runtime flag ahead of the caller's arguments.
 */
export async function runTool(deps: ExecDeps, request: RunToolRequest): Promise<RunToolResult> {
  const cmd = toolCommand(deps.config, request.tool);
  const base = request.tool === "yt-dlp" ? await ytdlpBaseArgs(deps) : [];
  const startedAt = Date.now();
  const result = await spawnCapture(request.tool, cmd, [...base, ...request.args], {
    timeoutMs: request.timeoutMs,
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    ...(request.env === undefined ? {} : { env: request.env }),
  });
  deps.log.debug(
    {
      tool: request.tool,
      code: result.code,
      timedOut: result.timedOut,
      durationMs: Date.now() - startedAt,
    },
    "tool finished",
  );
  return result;
}
