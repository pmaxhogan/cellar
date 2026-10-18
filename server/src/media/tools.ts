import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import type { Config } from "../config.ts";
import type { Db } from "../db/db.ts";
import { getKv, setKv } from "../db/kv.ts";

/**
 * External tools. The image bakes a baseline yt-dlp, ffmpeg and ffprobe into
 * BASELINE_BIN_DIR (/opt/cellar/bin); at boot they are copied into
 * $DATA_DIR/bin when absent, which is where the server runs them from and
 * where the tool updater (a later wave) drops newer builds. A copy that is
 * already there is never overwritten, so an update survives a restart.
 *
 * Nothing here is fatal: a missing or broken tool is logged and reported as a
 * null version in /api/status, and the server keeps serving.
 */

export const TOOL_BINARIES = ["yt-dlp", "ffmpeg", "ffprobe"] as const;
export const TOOL_VERSIONS_KEY = "tool_versions";
/** Each version probe gets this long before it is killed. */
export const PROBE_TIMEOUT_MS = 10_000;

export interface ToolVersions {
  ytdlp: string | null;
  ffmpeg: string | null;
}

interface StoredToolVersions extends ToolVersions {
  checkedAt: number;
}

/** Runs a binary with an argv array (never a shell) and resolves its stdout. */
export type ExecRunner = (file: string, args: readonly string[]) => Promise<string>;

export const execRunner: ExecRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });

/**
 * Copy each baseline binary into binDir unless a copy already exists there.
 * Returns the names that were copied.
 */
export function installBaselineTools(
  config: Pick<Config, "binDir" | "baselineBinDir">,
  log: Logger,
): string[] {
  mkdirSync(config.binDir, { recursive: true });
  if (!existsSync(config.baselineBinDir)) {
    log.warn({ dir: config.baselineBinDir }, "no baseline tool directory; skipping tool install");
    return [];
  }
  const copied: string[] = [];
  for (const name of TOOL_BINARIES) {
    const source = join(config.baselineBinDir, name);
    const target = join(config.binDir, name);
    try {
      if (existsSync(target)) {
        continue;
      }
      if (!existsSync(source)) {
        log.warn({ tool: name }, "baseline tool missing from the image");
        continue;
      }
      copyFileSync(source, target);
      chmodSync(target, 0o755);
      copied.push(name);
    } catch (error) {
      log.warn({ tool: name, err: error }, "could not install baseline tool");
    }
  }
  if (copied.length > 0) {
    log.info({ tools: copied, dir: config.binDir }, "installed baseline tools");
  }
  return copied;
}

/** First line of `yt-dlp --version`, e.g. "2026.08.19". */
export function parseYtdlpVersion(stdout: string): string | null {
  const line = stdout.trim().split(/\r?\n/)[0]?.trim() ?? "";
  return line === "" ? null : line;
}

/** The token after "ffmpeg version", e.g. "N-121234-gabcdef" or "7.1". */
export function parseFfmpegVersion(stdout: string): string | null {
  const match = /^ffmpeg version (\S+)/m.exec(stdout);
  return match?.[1] ?? null;
}

async function probe(
  run: ExecRunner,
  file: string,
  args: readonly string[],
  parse: (stdout: string) => string | null,
  log: Logger,
): Promise<string | null> {
  try {
    return parse(await run(file, args));
  } catch (error) {
    // Only the error's name and code: the message of a failed spawn can embed
    // the full command line, and later waves pass more than --version.
    const { name, code } = error as { name?: unknown; code?: unknown };
    log.warn({ file, errName: name, errCode: code }, "tool version probe failed");
    return null;
  }
}

/** Run each tool's version command from binDir. */
export async function probeToolVersions(
  binDir: string,
  log: Logger,
  run: ExecRunner = execRunner,
): Promise<ToolVersions> {
  const [ytdlp, ffmpeg] = await Promise.all([
    probe(run, join(binDir, "yt-dlp"), ["--version"], parseYtdlpVersion, log),
    probe(run, join(binDir, "ffmpeg"), ["-version"], parseFfmpegVersion, log),
  ]);
  return { ytdlp, ffmpeg };
}

/** Probe and persist into kv.tool_versions, where /api/status reads them. */
export async function refreshToolVersions(
  db: Db,
  binDir: string,
  log: Logger,
  run: ExecRunner = execRunner,
): Promise<ToolVersions> {
  const versions = await probeToolVersions(binDir, log, run);
  const stored: StoredToolVersions = { ...versions, checkedAt: Date.now() };
  setKv(db, TOOL_VERSIONS_KEY, stored);
  log.info(versions, "tool versions recorded");
  return versions;
}

/** The last recorded versions; nulls when never probed or unreadable. */
export function readToolVersions(db: Db): ToolVersions {
  const stored = getKv<Partial<StoredToolVersions> | null>(db, TOOL_VERSIONS_KEY);
  const pick = (value: unknown): string | null => (typeof value === "string" ? value : null);
  if (stored === null || typeof stored !== "object") {
    return { ytdlp: null, ffmpeg: null };
  }
  return { ytdlp: pick(stored.ytdlp), ffmpeg: pick(stored.ffmpeg) };
}
