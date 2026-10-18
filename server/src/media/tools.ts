import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { chmod, copyFile, link, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  settingsRegistry,
  UPDATABLE_TOOLS,
  type ResolvedSettings,
  type ToolsResponse,
  type ToolUpdateOutcome,
  type ToolVersionsInfo,
  type UpdatableTool,
} from "@cellar/shared";
import type { Logger } from "pino";
import { z } from "zod";
import { toolCommand, type Config, type ToolCommand } from "../config.ts";
import type { Db } from "../db/db.ts";
import { getKv, setKv } from "../db/kv.ts";
import { DomainError } from "../domain/errors.ts";
import { APP_VERSION } from "../version.ts";

/**
 * External tools. The image bakes a baseline yt-dlp, ffmpeg and ffprobe into
 * BASELINE_BIN_DIR (/opt/cellar/bin); at boot they are copied into
 * $DATA_DIR/bin when absent, which is where the server runs them from and
 * where the tool updater drops newer builds. A copy that is already there is
 * never overwritten, so an update survives a restart.
 *
 * The updater (checkToolUpdates) downloads a newer release into
 * $DATA_DIR/bin/.staging, verifies its sha256 against the publisher's checksum
 * file, runs its version command from staging, and only then swaps it in: the
 * live binary is hard linked to `<tool>.prev` and the staged file is renamed
 * over the live path, so the live path never goes missing. rollbackTool swaps
 * `.prev` back.
 *
 * Nothing here is fatal: a missing or broken tool is logged and reported as a
 * null version in /api/status, and the server keeps serving.
 */

export const TOOL_BINARIES = ["yt-dlp", "ffmpeg", "ffprobe"] as const;
export type ToolName = (typeof TOOL_BINARIES)[number];
export const TOOL_VERSIONS_KEY = "tool_versions";
/** Each version probe gets this long before it is killed. */
export const PROBE_TIMEOUT_MS = 10_000;
/**
 * yt-dlp's onefile build unpacks about 90 MB into $TMPDIR before it answers
 * --version, which on a cold or slow disk takes far longer than 10 s.
 */
export const YTDLP_PROBE_TIMEOUT_MS = 60_000;

export const YTDLP_RELEASE_API = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
export const YTDLP_ASSET = "yt-dlp_linux";
export const YTDLP_SUMS_ASSET = "SHA2-256SUMS";
export const FFMPEG_RELEASE_API =
  "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/tags/latest";
export const FFMPEG_ASSET = "ffmpeg-master-latest-linux64-gpl.tar.xz";
export const FFMPEG_SUMS_ASSET = "checksums.sha256";
const FFMPEG_ARCHIVE_ROOT = "ffmpeg-master-latest-linux64-gpl";

/** Release metadata and checksum files are small; give them 30 s. */
const API_TIMEOUT_MS = 30_000;
/** The binaries are 30 to 80 MB; the download gets its own, longer budget. */
export const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/** Refuse anything absurdly large rather than fill /data. */
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const VERIFY_TIMEOUT_MS = 60_000;
const EXTRACT_TIMEOUT_MS = 5 * 60_000;

/** The two version strings /api/status reports. */
export interface ProbedVersions {
  ytdlp: string | null;
  ffmpeg: string | null;
}

// ---------------------------------------------------------------------------
// Running tools
// ---------------------------------------------------------------------------

/** Runs a binary with an argv array (never a shell) and resolves its stdout. */
export type ExecRunner = (
  file: string,
  args: readonly string[],
  timeoutMs?: number,
) => Promise<string>;

export const execRunner: ExecRunner = (file, args, timeoutMs = PROBE_TIMEOUT_MS) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });

export interface RunToolRequest {
  tool: ToolName;
  args: readonly string[];
  timeoutMs?: number;
}

/**
 * A finished run. `code` is the exit code, or null when the process was killed
 * (timeout). A spawn failure (binary missing) rejects instead.
 */
export interface RunToolResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run one of the managed tools by name. Agent A's media/exec.ts provides the real one. */
export type RunTool = (request: RunToolRequest) => Promise<RunToolResult>;

/** Run an explicit executable path (staged binaries, tar). */
export type RunFile = (
  file: string,
  args: readonly string[],
  timeoutMs?: number,
) => Promise<RunToolResult>;

function execCapture(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<RunToolResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
        ...(env === undefined ? {} : { env }),
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const { code, killed } = error as { code?: unknown; killed?: boolean };
        if (typeof code === "number") {
          resolve({ code, stdout, stderr });
          return;
        }
        if (killed === true) {
          resolve({ code: null, stdout, stderr });
          return;
        }
        reject(error);
      },
    );
  });
}

export const runFile: RunFile = (file, args, timeoutMs = PROBE_TIMEOUT_MS) =>
  execCapture(file, args, timeoutMs);

/** `yt-dlp` -> `CELLAR_TOOL_YT_DLP`. */
export function toolEnvKey(tool: string): string {
  return `CELLAR_TOOL_${tool.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/**
 * The argv prefix a tool runs as: the `CELLAR_TOOL_<TOOL>` override (a JSON
 * array such as `["node", "/repo/scripts/fake-bin/ffmpeg.mjs"]`), else
 * `<binDir>/<tool>` when it exists, else the bare name for a PATH lookup.
 */
export function resolveToolCommand(
  tool: string,
  binDir: string,
  env: NodeJS.ProcessEnv,
): [string, ...string[]] {
  const raw = env[toolEnvKey(tool)];
  if (raw !== undefined && raw.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((part) => typeof part === "string" && part !== "")
      ) {
        return parsed as [string, ...string[]];
      }
    } catch {
      // Fall through to the normal resolution.
    }
  }
  const local = join(binDir, tool);
  return existsSync(local) ? [local] : [tool];
}

/**
 * The built-in runTool: execFile with an argv array and a timeout. A stand in
 * for media/exec.ts so this module works on its own.
 */
export function createRunTool(options: { binDir: string; env?: NodeJS.ProcessEnv }): RunTool {
  return ({ tool, args, timeoutMs = PROBE_TIMEOUT_MS }) => {
    const env = options.env ?? process.env;
    const [command, ...prefix] = resolveToolCommand(tool, options.binDir, env);
    return execCapture(command, [...prefix, ...args], timeoutMs, options.env);
  };
}

// ---------------------------------------------------------------------------
// Baseline install and version probes
// ---------------------------------------------------------------------------

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

/** The token after "ffprobe version". */
export function parseFfprobeVersion(stdout: string): string | null {
  const match = /^ffprobe version (\S+)/m.exec(stdout);
  return match?.[1] ?? null;
}

/** The two tools whose versions are recorded. */
type VersionedTool = "yt-dlp" | "ffmpeg";

/** How to start a tool for a version probe; null when there is nothing to probe. */
export type ProbeCommandFor = (tool: VersionedTool) => ToolCommand | null;

const VERSION_PROBES: Record<
  VersionedTool,
  { args: readonly string[]; parse: (stdout: string) => string | null; timeoutMs: number }
> = {
  "yt-dlp": { args: ["--version"], parse: parseYtdlpVersion, timeoutMs: YTDLP_PROBE_TIMEOUT_MS },
  ffmpeg: { args: ["-version"], parse: parseFfmpegVersion, timeoutMs: PROBE_TIMEOUT_MS },
};

async function probe(
  run: ExecRunner,
  tool: VersionedTool,
  cmd: ToolCommand | null,
  log: Logger,
): Promise<string | null> {
  if (cmd === null) {
    return null;
  }
  const { args, parse, timeoutMs } = VERSION_PROBES[tool];
  try {
    return parse(await run(cmd.command, [...cmd.prefixArgs, ...args], timeoutMs));
  } catch (error) {
    // Only the error's name and code: the message of a failed spawn can embed
    // the full command line, and later waves pass more than --version.
    const { name, code } = error as { name?: unknown; code?: unknown };
    log.warn({ file: cmd.command, errName: name, errCode: code }, "tool version probe failed");
    return null;
  }
}

async function probeEach(
  commandFor: ProbeCommandFor,
  log: Logger,
  run: ExecRunner,
): Promise<ProbedVersions> {
  const [ytdlp, ffmpeg] = await Promise.all([
    probe(run, "yt-dlp", commandFor("yt-dlp"), log),
    probe(run, "ffmpeg", commandFor("ffmpeg"), log),
  ]);
  return { ytdlp, ffmpeg };
}

/**
 * Run each tool's version command the way the server runs the tool
 * (toolCommand: the CELLAR_TOOL_<TOOL> override, else $DATA_DIR/bin, else
 * PATH), so the recorded version is the one that actually answers.
 */
export function probeToolVersions(
  config: Pick<Config, "toolOverrides" | "binDir">,
  log: Logger,
  run: ExecRunner = execRunner,
): Promise<ProbedVersions> {
  return probeEach((tool) => toolCommand(config, tool), log, run);
}

// ---------------------------------------------------------------------------
// kv.tool_versions
// ---------------------------------------------------------------------------

export interface ToolState {
  current: string | null;
  previous: string | null;
  baseline: string | null;
  latest: string | null;
  checked_at: number | null;
  updated_at: number | null;
  last_error: string | null;
  rolled_back_from: string | null;
}

export interface FfmpegToolState extends ToolState {
  asset_updated_at: string | null;
  previous_asset_updated_at: string | null;
}

export interface ToolVersionsState {
  ytdlp: ToolState;
  ffmpeg: FfmpegToolState;
}

const nullableString = z.string().nullable().catch(null);
const nullableInt = z.number().int().nullable().catch(null);

const ToolStateSchema = z.object({
  current: nullableString.default(null),
  previous: nullableString.default(null),
  baseline: nullableString.default(null),
  latest: nullableString.default(null),
  checked_at: nullableInt.default(null),
  updated_at: nullableInt.default(null),
  last_error: nullableString.default(null),
  rolled_back_from: nullableString.default(null),
});

const FfmpegStateSchema = ToolStateSchema.extend({
  asset_updated_at: nullableString.default(null),
  previous_asset_updated_at: nullableString.default(null),
});

/**
 * Before the updater existed kv.tool_versions was `{ytdlp, ffmpeg, checkedAt}`
 * with plain version strings; such a row is read as the `current` versions.
 */
function normaliseEntry(value: unknown): unknown {
  if (typeof value === "string") {
    return { current: value };
  }
  return value !== null && typeof value === "object" ? value : {};
}

export function readToolState(db: Db): ToolVersionsState {
  const stored = getKv<Record<string, unknown> | null>(db, TOOL_VERSIONS_KEY);
  const source = stored !== null && typeof stored === "object" ? stored : {};
  return {
    ytdlp: ToolStateSchema.catch(ToolStateSchema.parse({})).parse(normaliseEntry(source.ytdlp)),
    ffmpeg: FfmpegStateSchema.catch(FfmpegStateSchema.parse({})).parse(
      normaliseEntry(source.ffmpeg),
    ),
  };
}

/** Read, change and write kv.tool_versions in one synchronous step. */
export function updateToolState(
  db: Db,
  change: (state: ToolVersionsState) => void,
): ToolVersionsState {
  const state = readToolState(db);
  change(state);
  setKv(db, TOOL_VERSIONS_KEY, state);
  return state;
}

/** Probe and persist the current versions, where /api/status reads them. */
export async function refreshToolVersions(
  db: Db,
  config: Pick<Config, "toolOverrides" | "binDir">,
  log: Logger,
  run: ExecRunner = execRunner,
): Promise<ProbedVersions> {
  const versions = await probeToolVersions(config, log, run);
  updateToolState(db, (state) => {
    state.ytdlp.current = versions.ytdlp;
    state.ffmpeg.current = versions.ffmpeg;
  });
  log.info(versions, "tool versions recorded");
  return versions;
}

/**
 * Probe the image's baseline copies and record them as `baseline`. A tool
 * the image does not carry (a dev checkout, an override-only test run) is
 * recorded as null rather than probed elsewhere, so `baseline` always means
 * the copy the image shipped.
 */
export async function recordBaselineVersions(
  db: Db,
  baselineBinDir: string,
  log: Logger,
  run: ExecRunner = execRunner,
): Promise<ProbedVersions> {
  const versions = await probeEach(
    (tool) => {
      const image = join(baselineBinDir, tool);
      return existsSync(image) ? { command: image, prefixArgs: [] } : null;
    },
    log,
    run,
  );
  updateToolState(db, (state) => {
    state.ytdlp.baseline = versions.ytdlp;
    state.ffmpeg.baseline = versions.ffmpeg;
  });
  return versions;
}

/** The last recorded versions; nulls when never probed or unreadable. */
export function readToolVersions(db: Db): ProbedVersions {
  const state = readToolState(db);
  return { ytdlp: state.ytdlp.current, ffmpeg: state.ffmpeg.current };
}

/** The value the installed build is compared against `latest` with. */
function installedKey(state: ToolVersionsState, tool: UpdatableTool): string | null {
  return tool === "ytdlp" ? state.ytdlp.current : state.ffmpeg.asset_updated_at;
}

export function toolVersionsInfo(state: ToolVersionsState, tool: UpdatableTool): ToolVersionsInfo {
  const entry = state[tool];
  const updateAvailable =
    entry.latest !== null &&
    entry.latest !== installedKey(state, tool) &&
    entry.latest !== entry.rolled_back_from;
  const info: ToolVersionsInfo = {
    current: entry.current,
    previous: entry.previous,
    baseline: entry.baseline,
    latest: entry.latest,
    checked_at: entry.checked_at,
    updated_at: entry.updated_at,
    update_available: updateAvailable,
    last_error: entry.last_error,
    rolled_back_from: entry.rolled_back_from,
  };
  if (tool === "ffmpeg") {
    info.asset_updated_at = state.ffmpeg.asset_updated_at;
  }
  return info;
}

/**
 * The PO token provider URL in effect. The registry default stands for "the
 * deployment's sidecar", so it is replaced by POT_PROVIDER_URL from the env;
 * an owner-set value wins, and an empty string disables the provider.
 */
export function resolvePotProviderUrl(
  settings: Pick<ResolvedSettings, "tools.pot_provider_url">,
  envDefault: string,
): string {
  const value = settings["tools.pot_provider_url"].trim();
  if (value === settingsRegistry["tools.pot_provider_url"].default) {
    return envDefault;
  }
  return value.replace(/\/+$/, "");
}

export function buildToolsResponse(
  db: Db,
  settings: ResolvedSettings,
  potProviderEnvDefault: string,
  outcomes?: ToolUpdateOutcome[],
): ToolsResponse {
  const state = readToolState(db);
  return {
    ytdlp: toolVersionsInfo(state, "ytdlp"),
    ffmpeg: toolVersionsInfo(state, "ffmpeg"),
    js_runtime: settings["tools.js_runtime"],
    pot_provider_url: resolvePotProviderUrl(settings, potProviderEnvDefault),
    auto_update: settings["tools.auto_update"],
    ...(outcomes === undefined ? {} : { outcomes }),
  };
}

// ---------------------------------------------------------------------------
// Updater
// ---------------------------------------------------------------------------

export interface ToolUpdateDeps {
  db: Db;
  log: Logger;
  config: Pick<Config, "binDir">;
  fetch: typeof fetch;
  runFile: RunFile;
  getSettings(): ResolvedSettings;
  now?: () => number;
  /** The tar used to unpack ffmpeg builds. Defaults to `tar` from PATH. */
  tarCommand?: string;
}

const ReleaseSchema = z.object({
  tag_name: z.string().min(1),
  assets: z.array(
    z.object({
      name: z.string(),
      browser_download_url: z.string(),
      updated_at: z.string().optional(),
    }),
  ),
});
type Release = z.infer<typeof ReleaseSchema>;
type ReleaseAsset = Release["assets"][number];

const TOOL_LABEL: Record<UpdatableTool, string> = { ytdlp: "yt-dlp", ffmpeg: "ffmpeg" };

/** Error text for logs and the API. Network errors keep their cause, which names the host. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message !== "" && !error.message.includes(cause.message)) {
    return `${error.message}: ${cause.message}`;
  }
  return error.message;
}

const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": `cellar/${APP_VERSION}`,
  "X-GitHub-Api-Version": "2022-11-28",
};

async function fetchOk(deps: ToolUpdateDeps, url: string, timeoutMs: number): Promise<Response> {
  const response = await deps.fetch(url, {
    headers: GITHUB_HEADERS,
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GET ${url} answered HTTP ${String(response.status)}`);
  }
  return response;
}

async function fetchRelease(deps: ToolUpdateDeps, url: string): Promise<Release> {
  const response = await fetchOk(deps, url, API_TIMEOUT_MS);
  const parsed = ReleaseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(`unexpected release metadata from ${url}`);
  }
  return parsed.data;
}

function findAsset(release: Release, name: string): ReleaseAsset {
  const asset = release.assets.find((candidate) => candidate.name === name);
  if (asset === undefined) {
    throw new Error(`release ${release.tag_name} has no ${name} asset`);
  }
  return asset;
}

/** The sha256 for `name` from a `sha256sum` style file (`<hex>  <name>`). */
export function parseChecksum(text: string, name: string): string {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
    if (match?.[2] === name) {
      return (match[1] as string).toLowerCase();
    }
  }
  throw new Error(`no checksum for ${name}`);
}

/** Stream a download to `target`, hashing as it goes. Returns the sha256 hex. */
async function download(deps: ToolUpdateDeps, url: string, target: string): Promise<string> {
  const response = await fetchOk(deps, url, DOWNLOAD_TIMEOUT_MS);
  if (response.body === null) {
    throw new Error(`GET ${url} returned no body`);
  }
  const hash = createHash("sha256");
  let size = 0;
  await pipeline(
    Readable.fromWeb(response.body),
    async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        size += chunk.length;
        if (size > MAX_DOWNLOAD_BYTES) {
          throw new Error(`download from ${url} exceeds ${String(MAX_DOWNLOAD_BYTES)} bytes`);
        }
        hash.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(target, { mode: 0o755 }),
  );
  return hash.digest("hex");
}

async function verifyStaged(
  deps: ToolUpdateDeps,
  file: string,
  args: readonly string[],
  parse: (stdout: string) => string | null,
  what: string,
): Promise<string> {
  const result = await deps.runFile(file, args, VERIFY_TIMEOUT_MS);
  const version = result.code === 0 ? parse(result.stdout) : null;
  if (version === null) {
    throw new Error(
      `the downloaded ${what} did not run (exit ${String(result.code)}); keeping the installed one`,
    );
  }
  return version;
}

async function linkOrCopy(from: string, to: string): Promise<void> {
  await rm(to, { force: true });
  try {
    await link(from, to);
  } catch {
    await copyFile(from, to);
  }
}

/**
 * Put staged files live. Every `.prev` is refreshed first (a hard link to the
 * live binary), then each staged file is renamed over its live path, which is
 * atomic on one filesystem: a process starting the tool sees either the old
 * or the new binary, never neither.
 */
async function swapIn(binDir: string, names: readonly string[], stagingDir: string): Promise<void> {
  for (const name of names) {
    const live = join(binDir, name);
    if (existsSync(live)) {
      await linkOrCopy(live, `${live}.prev`);
    }
  }
  for (const name of names) {
    await rename(join(stagingDir, name), join(binDir, name));
  }
}

const locks = new Map<string, Promise<void>>();

/** Serialise updates and rollbacks per bin dir, so a manual run and the daily tick never interleave. */
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = locks.get(key) ?? Promise.resolve();
  const run = prior.then(fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, settled);
  try {
    return await run;
  } finally {
    if (locks.get(key) === settled) {
      locks.delete(key);
    }
  }
}

export function stagingDirOf(binDir: string): string {
  return join(binDir, ".staging");
}

interface CheckContext {
  deps: ToolUpdateDeps;
  force: boolean;
  apply: boolean;
  now: number;
  staging: string;
}

/** Shared tail of both update paths: compare, gate, or carry on. */
function gate(
  ctx: CheckContext,
  tool: UpdatableTool,
  latest: string,
  installed: string | null,
  rolledBackFrom: string | null,
): ToolUpdateOutcome | null {
  const label = TOOL_LABEL[tool];
  if (!ctx.force && latest === installed) {
    return { tool, status: "up_to_date", detail: `${label} is up to date (${latest}).` };
  }
  if (!ctx.force && latest === rolledBackFrom) {
    return {
      tool,
      status: "skipped",
      detail: `${label} ${latest} was rolled back; force an update to reinstall it.`,
    };
  }
  if (!ctx.apply) {
    return {
      tool,
      status: "available",
      detail: `${label} ${latest} is available; auto-update is off, so nothing was installed.`,
    };
  }
  return null;
}

async function updateYtdlp(ctx: CheckContext): Promise<ToolUpdateOutcome> {
  const { deps } = ctx;
  const release = await fetchRelease(deps, YTDLP_RELEASE_API);
  const latest = release.tag_name;
  const before = updateToolState(deps.db, (state) => {
    state.ytdlp.latest = latest;
  }).ytdlp;
  const gated = gate(ctx, "ytdlp", latest, before.current, before.rolled_back_from);
  if (gated !== null) {
    return gated;
  }

  const binary = findAsset(release, YTDLP_ASSET);
  const sums = findAsset(release, YTDLP_SUMS_ASSET);
  const expected = parseChecksum(
    await (await fetchOk(deps, sums.browser_download_url, API_TIMEOUT_MS)).text(),
    YTDLP_ASSET,
  );
  await mkdir(ctx.staging, { recursive: true });
  const staged = join(ctx.staging, "yt-dlp");
  const actual = await download(deps, binary.browser_download_url, staged);
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${YTDLP_ASSET} ${latest}; the download was discarded`);
  }
  await chmod(staged, 0o755);
  const version = await verifyStaged(deps, staged, ["--version"], parseYtdlpVersion, "yt-dlp");

  await swapIn(deps.config.binDir, ["yt-dlp"], ctx.staging);
  updateToolState(deps.db, (state) => {
    state.ytdlp.previous = state.ytdlp.current;
    state.ytdlp.current = version;
    state.ytdlp.updated_at = ctx.now;
    state.ytdlp.rolled_back_from = null;
  });
  deps.log.info({ tool: "yt-dlp", from: before.current, to: version }, "tool updated");
  return {
    tool: "ytdlp",
    status: "updated",
    detail: `yt-dlp updated from ${before.current ?? "unknown"} to ${version}.`,
  };
}

async function updateFfmpeg(ctx: CheckContext): Promise<ToolUpdateOutcome> {
  const { deps } = ctx;
  const release = await fetchRelease(deps, FFMPEG_RELEASE_API);
  const archive = findAsset(release, FFMPEG_ASSET);
  const latest = archive.updated_at;
  if (latest === undefined) {
    throw new Error(`${FFMPEG_ASSET} has no updated_at in the release metadata`);
  }
  const before = updateToolState(deps.db, (state) => {
    state.ffmpeg.latest = latest;
  }).ffmpeg;
  const gated = gate(ctx, "ffmpeg", latest, before.asset_updated_at, before.rolled_back_from);
  if (gated !== null) {
    return gated;
  }

  const sums = findAsset(release, FFMPEG_SUMS_ASSET);
  const expected = parseChecksum(
    await (await fetchOk(deps, sums.browser_download_url, API_TIMEOUT_MS)).text(),
    FFMPEG_ASSET,
  );
  await mkdir(ctx.staging, { recursive: true });
  const archivePath = join(ctx.staging, FFMPEG_ASSET);
  const actual = await download(deps, archive.browser_download_url, archivePath);
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${FFMPEG_ASSET}; the download was discarded`);
  }

  const extract = await deps.runFile(
    deps.tarCommand ?? "tar",
    [
      "-xJf",
      archivePath,
      "--strip-components=2",
      "-C",
      ctx.staging,
      `${FFMPEG_ARCHIVE_ROOT}/bin/ffmpeg`,
      `${FFMPEG_ARCHIVE_ROOT}/bin/ffprobe`,
    ],
    EXTRACT_TIMEOUT_MS,
  );
  if (extract.code !== 0) {
    const reason = extract.stderr.trim().split(/\r?\n/)[0] ?? "";
    throw new Error(
      `could not unpack ${FFMPEG_ASSET} (tar exit ${String(extract.code)}) ${reason}`,
    );
  }
  const stagedFfmpeg = join(ctx.staging, "ffmpeg");
  const stagedFfprobe = join(ctx.staging, "ffprobe");
  await chmod(stagedFfmpeg, 0o755);
  await chmod(stagedFfprobe, 0o755);
  const version = await verifyStaged(
    deps,
    stagedFfmpeg,
    ["-version"],
    parseFfmpegVersion,
    "ffmpeg",
  );
  await verifyStaged(deps, stagedFfprobe, ["-version"], parseFfprobeVersion, "ffprobe");

  await swapIn(deps.config.binDir, ["ffmpeg", "ffprobe"], ctx.staging);
  updateToolState(deps.db, (state) => {
    state.ffmpeg.previous = state.ffmpeg.current;
    state.ffmpeg.previous_asset_updated_at = state.ffmpeg.asset_updated_at;
    state.ffmpeg.current = version;
    state.ffmpeg.asset_updated_at = latest;
    state.ffmpeg.updated_at = ctx.now;
    state.ffmpeg.rolled_back_from = null;
  });
  deps.log.info({ tool: "ffmpeg", from: before.current, to: version }, "tool updated");
  return {
    tool: "ffmpeg",
    status: "updated",
    detail: `ffmpeg and ffprobe updated from ${before.current ?? "unknown"} to ${version} (build ${latest}).`,
  };
}

async function checkOne(
  deps: ToolUpdateDeps,
  tool: UpdatableTool,
  force: boolean,
): Promise<ToolUpdateOutcome> {
  const now = (deps.now ?? Date.now)();
  const staging = stagingDirOf(deps.config.binDir);
  try {
    const apply = deps.getSettings()["tools.auto_update"];
    const ctx: CheckContext = { deps, force, apply, now, staging };
    const outcome = tool === "ytdlp" ? await updateYtdlp(ctx) : await updateFfmpeg(ctx);
    updateToolState(deps.db, (state) => {
      state[tool].checked_at = now;
      state[tool].last_error = null;
    });
    return outcome;
  } catch (error) {
    const message = describeError(error);
    deps.log.warn({ tool: TOOL_LABEL[tool], error: message }, "tool update check failed");
    updateToolState(deps.db, (state) => {
      state[tool].checked_at = now;
      state[tool].last_error = message;
    });
    return { tool, status: "failed", detail: message };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Check GitHub for newer yt-dlp and ffmpeg builds and, when
 * `tools.auto_update` is on, verify and swap them in. With the setting off it
 * only records what is available. `force` skips the "already installed" and
 * "rolled back" short circuits, not the setting. Never throws: every failure
 * is logged, recorded as `last_error` and returned as a `failed` outcome.
 */
export function checkToolUpdates(
  deps: ToolUpdateDeps,
  options: { force?: boolean; tool?: UpdatableTool } = {},
): Promise<ToolUpdateOutcome[]> {
  const tools = options.tool === undefined ? UPDATABLE_TOOLS : [options.tool];
  return withLock(deps.config.binDir, async () => {
    const outcomes: ToolUpdateOutcome[] = [];
    for (const tool of tools) {
      outcomes.push(await checkOne(deps, tool, options.force ?? false));
    }
    return outcomes;
  });
}

const ROLLBACK_FILES: Record<UpdatableTool, readonly string[]> = {
  ytdlp: ["yt-dlp"],
  ffmpeg: ["ffmpeg", "ffprobe"],
};

/**
 * Swap `<tool>.prev` and the live binary (ffmpeg and ffprobe as a pair). The
 * build rolled away from is remembered so the daily check does not reinstall
 * it; a forced update does. Rolling back twice returns to where it started.
 */
export function rollbackTool(deps: ToolUpdateDeps, tool: UpdatableTool): Promise<ToolVersionsInfo> {
  const binDir = deps.config.binDir;
  return withLock(binDir, async () => {
    const names = ROLLBACK_FILES[tool];
    for (const name of names) {
      if (!existsSync(join(binDir, `${name}.prev`))) {
        throw new DomainError(
          "precondition_failed",
          `There is no previous ${TOOL_LABEL[tool]} to roll back to.`,
        );
      }
    }
    const staging = stagingDirOf(binDir);
    try {
      await mkdir(staging, { recursive: true });
      for (const name of names) {
        const live = join(binDir, name);
        const swap = join(staging, `${name}.swap`);
        await linkOrCopy(live, swap);
        await rename(`${live}.prev`, live);
        await rename(swap, `${live}.prev`);
      }
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }

    const live = join(binDir, names[0] as string);
    const result = await deps
      .runFile(live, tool === "ytdlp" ? ["--version"] : ["-version"], VERIFY_TIMEOUT_MS)
      .catch(() => null);
    const parse = tool === "ytdlp" ? parseYtdlpVersion : parseFfmpegVersion;
    const probed = result?.code === 0 ? parse(result.stdout) : null;
    const now = (deps.now ?? Date.now)();

    const state = updateToolState(deps.db, (draft) => {
      const entry = draft[tool];
      const was = entry.current;
      entry.current = probed ?? entry.previous;
      entry.previous = was;
      entry.updated_at = now;
      if (tool === "ytdlp") {
        entry.rolled_back_from = was;
      } else {
        const asset = draft.ffmpeg.asset_updated_at;
        draft.ffmpeg.asset_updated_at = draft.ffmpeg.previous_asset_updated_at;
        draft.ffmpeg.previous_asset_updated_at = asset;
        entry.rolled_back_from = asset;
      }
    });
    deps.log.info(
      { tool: TOOL_LABEL[tool], to: state[tool].current, from: state[tool].previous },
      "tool rolled back",
    );
    return toolVersionsInfo(state, tool);
  });
}

/** Daily update check. The first run waits a few minutes so boot stays quiet. */
export function startToolUpdateSchedule(
  deps: ToolUpdateDeps,
  options: { initialDelayMs?: number; intervalMs?: number } = {},
): () => void {
  const tick = (): void => {
    void checkToolUpdates(deps).catch((error: unknown) => {
      deps.log.warn({ error: describeError(error) }, "tool update tick failed");
    });
  };
  const interval = setInterval(tick, options.intervalMs ?? 24 * 60 * 60_000);
  interval.unref();
  const first = setTimeout(tick, options.initialDelayMs ?? 5 * 60_000);
  first.unref();
  return () => {
    clearInterval(interval);
    clearTimeout(first);
  };
}
