import { execFile } from "node:child_process";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
        reject(new ToolRunError(tool, String(error.code)));
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

/** PyInstaller onefile builds (yt-dlp_linux) unpack into `$TMPDIR/_MEIxxxxxx`. */
const ONEFILE_DIR = /^_MEI[A-Za-z0-9]+$/;
const ONEFILE_DIR_IN_MAPS = /\/(_MEI[A-Za-z0-9]+)(?=[/\s]|$)/gm;
/** A run unpacks in seconds; an unused directory this old was left by a killed run. */
export const ONEFILE_ORPHAN_AGE_MS = 10 * 60_000;

/**
 * The `_MEI*` directory names some live process has a file mapped from (a
 * running yt-dlp maps its unpacked libpython). Null when /proc cannot be
 * listed (not Linux), which means liveness is unknown. A pid whose maps cannot
 * be read is skipped: it exited, or it belongs to another user and so cannot
 * be using our private TMPDIR.
 */
export async function onefileDirsInUse(procRoot = "/proc"): Promise<Set<string> | null> {
  let pids: string[];
  try {
    pids = (await readdir(procRoot)).filter((name) => /^\d+$/.test(name));
  } catch {
    return null;
  }
  const inUse = new Set<string>();
  for (const pid of pids) {
    let maps: string;
    try {
      maps = await readFile(join(procRoot, pid, "maps"), "utf8");
    } catch {
      continue;
    }
    for (const match of maps.matchAll(ONEFILE_DIR_IN_MAPS)) {
      inUse.add(match[1] as string);
    }
  }
  return inUse;
}

export interface PruneOnefileOptions {
  /** Where yt-dlp unpacks: the child's TMPDIR. */
  dir?: string;
  now?: number;
  maxAgeMs?: number;
  procRoot?: string;
}

/**
 * Remove `_MEI*` directories a killed yt-dlp left in its TMPDIR. Each one is
 * about 45 MB and they fill the small exec tmpfs yt-dlp unpacks into, after
 * which every run fails. Only directories older than ONEFILE_ORPHAN_AGE_MS
 * that no live process maps are removed, so a long download (spawned here or
 * by the job runner) keeps its files; where /proc cannot tell, nothing is
 * removed. Never throws: returns the names it removed.
 */
export async function pruneOnefileTemp(
  log: Logger,
  options: PruneOnefileOptions = {},
): Promise<string[]> {
  const dir = options.dir ?? process.env.TMPDIR ?? tmpdir();
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? ONEFILE_ORPHAN_AGE_MS;
  const removed: string[] = [];
  try {
    const stale: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ONEFILE_DIR.test(entry.name)) {
        continue;
      }
      const info = await stat(join(dir, entry.name)).catch(() => null);
      if (info !== null && now - info.mtimeMs >= maxAgeMs) {
        stale.push(entry.name);
      }
    }
    if (stale.length === 0) {
      return removed;
    }
    const inUse = await onefileDirsInUse(options.procRoot);
    if (inUse === null) {
      log.debug({ dir, count: stale.length }, "cannot tell which onefile dirs are live; kept them");
      return removed;
    }
    for (const name of stale) {
      if (inUse.has(name)) {
        continue;
      }
      await rm(join(dir, name), { recursive: true, force: true });
      removed.push(name);
    }
  } catch (error) {
    log.warn({ err: error, dir }, "could not prune orphaned yt-dlp onefile dirs");
  }
  if (removed.length > 0) {
    log.info({ dir, count: removed.length }, "removed orphaned yt-dlp onefile dirs");
  }
  return removed;
}

/**
 * Run a tool to completion and capture its output. A non-zero exit resolves
 * (the caller decides what it means); only a failure to start rejects, with a
 * ToolRunError. yt-dlp always gets the plugin directory and, when the build
 * supports it, the JS runtime flag ahead of the caller's arguments. Before a
 * yt-dlp run, orphaned onefile directories are pruned from its TMPDIR.
 */
export async function runTool(deps: ExecDeps, request: RunToolRequest): Promise<RunToolResult> {
  const cmd = toolCommand(deps.config, request.tool);
  if (request.tool === "yt-dlp") {
    // The child unpacks into its own TMPDIR when the caller overrides it.
    const childTmp = request.env?.TMPDIR;
    await pruneOnefileTemp(deps.log, childTmp === undefined ? {} : { dir: childTmp });
  }
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
