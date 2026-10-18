import { randomBytes } from "node:crypto";
import { mkdir, rm, stat, statfs, writeFile } from "node:fs/promises";
import { join, parse as parsePath, resolve } from "node:path";
import {
  CheckResultSchema,
  CheckTriggerSchema,
  defaultSettings,
  type CheckLevel,
  type CheckResult,
  type CheckRow,
  type CheckTrigger,
  type ResolvedSettings,
} from "@cellar/shared";
import type { Logger } from "pino";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { z } from "zod";
import type { Config } from "../config.ts";
import { readPragma, type Db } from "../db/db.ts";
import { getKv } from "../db/kv.ts";
import { migrations } from "../db/migrations.ts";
import {
  describeError,
  parseFfmpegVersion,
  parseFfprobeVersion,
  parseYtdlpVersion,
  readToolState,
  resolvePotProviderUrl,
  toolVersionsInfo,
  type RunTool,
  type RunToolResult,
  type ToolName,
} from "../media/tools.ts";

/**
 * The self-check (ARCHITECTURE "Self-check", spec 3.11). Every check runs in
 * its own try/catch under a 15 s budget, all of them concurrently, so a run
 * takes about as long as its slowest check. A run is stored in `checks` and a
 * run with any `fail` raises a `selfcheck_failed` notification.
 *
 * Details are shown in the UI, so they never carry a credential: proxies are
 * named by label only and any URL in an error message is redacted.
 */

export const CHECK_TIMEOUT_MS = 15_000;
const GB = 1024 ** 3;
const DATA_WARN_BYTES = 10 * GB;
const DATA_FAIL_BYTES = GB;
const SKEW_WARN_MS = 30_000;
const SKEW_FAIL_MS = 5 * 60_000;
const NETWORK_TIMEOUT_MS = 10_000;
export const NVENC_CACHE_MS = 10 * 60_000;
export const YOUTUBE_FAVICON_URL = "https://youtube.com/favicon.ico";
export const CLOCK_REFERENCE_URL = "https://www.google.com";
export const VAPID_KV_KEY = "vapid";

export interface LocationInfo {
  id: number;
  label: string;
  container_path: string;
  quota_bytes: number;
  enabled: boolean;
  /** Bytes cellar has placed there, when known. Drives the quota headroom check. */
  used_bytes?: number;
}

export interface CredentialCheck {
  ok: boolean;
  detail: string;
}

export interface DiskSpace {
  free: number;
  total: number;
}

/** What the self-check needs from the rest of the server. Wired in domain/systemDeps.ts. */
export interface SelfCheckDeps {
  db: Db;
  log: Logger;
  config: Pick<Config, "dataDir" | "tmpDir" | "potProviderUrl">;
  runTool: RunTool;
  fetch: typeof fetch;
  listLocations(): LocationInfo[];
  accounts: {
    list(): { id: number; label: string }[];
    checkApi(id: number): Promise<CredentialCheck>;
    checkCookies(id: number): Promise<CredentialCheck>;
  };
  proxies: { listDecrypted(): { id: number; label: string; url: string }[] };
  getSettings(): ResolvedSettings;
  notify(type: string, title: string, body: string): void | Promise<void>;
  now?: () => number;
  /** Test seam: free and total bytes of the filesystem holding `path`. */
  statfs?: (path: string) => Promise<DiskSpace>;
  /** Test seam: whether `path` sits on a different filesystem than the root. */
  isSeparateMount?: (path: string) => Promise<boolean>;
  /** Test seam: GET `url` through the proxy, resolving the HTTP status. */
  proxyFetch?: (url: string, proxyUrl: string, signal: AbortSignal) => Promise<number>;
  /** Test seam for the per-check budget. */
  checkTimeoutMs?: number;
}

interface Outcome {
  level: CheckLevel;
  detail: string;
  value?: string | number;
}

interface CheckSpec {
  key: string;
  label: string;
  run(): Promise<Outcome>;
}

const ok = (detail: string, value?: string | number): Outcome => ({ level: "ok", detail, value });
const warn = (detail: string, value?: string | number): Outcome => ({
  level: "warn",
  detail,
  value,
});
const fail = (detail: string, value?: string | number): Outcome => ({
  level: "fail",
  detail,
  value,
});
const skip = (detail: string): Outcome => ({ level: "skip", detail });

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit] as string}`;
}

/** Strip a proxy URL, its credentials, and any `user:pass@` from an error message. */
export function redactProxy(message: string, proxyUrl: string): string {
  let out = message.split(proxyUrl).join("[proxy]");
  try {
    const parsed = new URL(proxyUrl);
    for (const secret of [parsed.username, parsed.password]) {
      if (secret !== "") {
        out = out.split(secret).join("[redacted]");
        out = out.split(decodeURIComponent(secret)).join("[redacted]");
      }
    }
  } catch {
    // Not a URL; the generic pattern below still applies.
  }
  return out.replace(/\/\/[^\s/@]+@/g, "//[redacted]@");
}

async function defaultStatfs(path: string): Promise<DiskSpace> {
  const stats = await statfs(path);
  return {
    free: Number(stats.bavail) * Number(stats.bsize),
    total: Number(stats.blocks) * Number(stats.bsize),
  };
}

async function defaultIsSeparateMount(path: string): Promise<boolean> {
  const absolute = resolve(path);
  const [target, root] = await Promise.all([stat(absolute), stat(parsePath(absolute).root)]);
  return target.dev !== root.dev;
}

async function defaultProxyFetch(
  url: string,
  proxyUrl: string,
  signal: AbortSignal,
): Promise<number> {
  const agent = new ProxyAgent(proxyUrl);
  try {
    const response = await undiciFetch(url, { dispatcher: agent, signal });
    await response.arrayBuffer();
    return response.status;
  } finally {
    await agent.close();
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${String(Math.round(ms / 1000))} s`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

async function runSpec(spec: CheckSpec, timeoutMs: number): Promise<CheckResult> {
  const started = performance.now();
  let outcome: Outcome;
  try {
    outcome = await withTimeout(spec.run(), timeoutMs);
  } catch (error) {
    outcome = fail(describeError(error));
  }
  const result: CheckResult = {
    key: spec.key,
    label: spec.label,
    level: outcome.level,
    detail: outcome.detail,
    took_ms: Math.max(0, Math.round(performance.now() - started)),
  };
  if (outcome.value !== undefined) {
    result.value = outcome.value;
  }
  return result;
}

async function probeWritable(dir: string): Promise<void> {
  const probe = join(dir, `.cellar-selfcheck-${randomBytes(6).toString("hex")}`);
  await writeFile(probe, "cellar self-check\n");
  await rm(probe, { force: true });
}

/** Run a tool, mapping a spawn failure (binary missing) to null. */
async function tryRun(
  deps: Pick<SelfCheckDeps, "runTool">,
  tool: ToolName,
  args: readonly string[],
  timeoutMs = 10_000,
): Promise<RunToolResult | null> {
  try {
    return await deps.runTool({ tool, args, timeoutMs });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GPU probe (shared by the self-check and the transcode/rule UI)
// ---------------------------------------------------------------------------

export interface GpuProbe {
  ffmpegMissing: boolean;
  hevcListed: boolean;
  h264Listed: boolean;
  hevcEncodes: boolean;
  h264Encodes: boolean;
  nvdec: boolean;
}

export interface NvencAvailability {
  hevc: boolean;
  h264: boolean;
  nvdec: boolean;
}

async function encodeWorks(deps: Pick<SelfCheckDeps, "runTool">, codec: string): Promise<boolean> {
  const result = await tryRun(deps, "ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=256x256:rate=10",
    "-frames:v",
    "10",
    "-c:v",
    codec,
    "-f",
    "null",
    "-",
  ]);
  return result?.code === 0;
}

export async function probeGpu(deps: Pick<SelfCheckDeps, "runTool">): Promise<GpuProbe> {
  const encoders = await tryRun(deps, "ffmpeg", ["-hide_banner", "-encoders"]);
  if (encoders === null) {
    return {
      ffmpegMissing: true,
      hevcListed: false,
      h264Listed: false,
      hevcEncodes: false,
      h264Encodes: false,
      nvdec: false,
    };
  }
  const listing = encoders.code === 0 ? encoders.stdout : "";
  const hevcListed = /\bhevc_nvenc\b/.test(listing);
  const h264Listed = /\bh264_nvenc\b/.test(listing);
  // One test encode at a time: consumer GPUs cap concurrent NVENC sessions.
  const hevcEncodes = hevcListed && (await encodeWorks(deps, "hevc_nvenc"));
  const h264Encodes = h264Listed && (await encodeWorks(deps, "h264_nvenc"));
  const hwaccels = await tryRun(deps, "ffmpeg", ["-hide_banner", "-hwaccels"]);
  const nvdec =
    hwaccels?.code === 0 && hwaccels.stdout.split(/\r?\n/).some((line) => line.trim() === "cuda");
  return { ffmpegMissing: false, hevcListed, h264Listed, hevcEncodes, h264Encodes, nvdec };
}

let nvencCache: { at: number; value: NvencAvailability } | null = null;

function availabilityOf(probe: GpuProbe): NvencAvailability {
  return {
    hevc: probe.hevcListed && probe.hevcEncodes,
    h264: probe.h264Listed && probe.h264Encodes,
    nvdec: probe.nvdec,
  };
}

/**
 * Whether NVENC (and NVDEC) actually work here: listed by ffmpeg AND a short
 * test encode succeeds. Cached for 10 minutes; a self-check refreshes it.
 */
export async function nvencAvailable(
  deps: Pick<SelfCheckDeps, "runTool" | "now">,
  options: { force?: boolean } = {},
): Promise<NvencAvailability> {
  const now = (deps.now ?? Date.now)();
  if (options.force !== true && nvencCache !== null && now - nvencCache.at < NVENC_CACHE_MS) {
    return nvencCache.value;
  }
  const value = availabilityOf(await probeGpu(deps));
  nvencCache = { at: now, value };
  return value;
}

/** Tests only. */
export function resetNvencCache(): void {
  nvencCache = null;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function dataChecks(deps: SelfCheckDeps, space: (path: string) => Promise<DiskSpace>): CheckSpec[] {
  const dir = deps.config.dataDir;
  return [
    {
      key: "data.writable",
      label: "Data directory writable",
      async run() {
        await probeWritable(dir);
        return ok(`${dir} is writable.`);
      },
    },
    {
      key: "data.free_space",
      label: "Data directory free space",
      async run() {
        const { free, total } = await space(dir);
        const detail = `${formatBytes(free)} free of ${formatBytes(total)}.`;
        if (free < DATA_FAIL_BYTES) {
          return fail(`Only ${detail} Under 1 GB the database and logs can fill the disk.`, free);
        }
        if (free < DATA_WARN_BYTES) {
          return warn(`Only ${detail}`, free);
        }
        return ok(detail, free);
      },
    },
  ];
}

function locationChecks(
  deps: SelfCheckDeps,
  location: LocationInfo,
  settings: ResolvedSettings,
  space: (path: string) => Promise<DiskSpace>,
  separateMount: (path: string) => Promise<boolean>,
): CheckSpec[] {
  const prefix = `location.${String(location.id)}`;
  const name = `Location "${location.label}"`;
  const path = location.container_path;
  const keys = ["mounted", "writable", "free", "quota_headroom"] as const;
  const labels = {
    mounted: `${name} mounted`,
    writable: `${name} writable`,
    free: `${name} free space`,
    quota_headroom: `${name} quota headroom`,
  };
  if (!location.enabled) {
    return keys.map((key) => ({
      key: `${prefix}.${key}`,
      label: labels[key],
      run: () => Promise.resolve(skip("Location is disabled.")),
    }));
  }

  // One existence probe shared by the four checks.
  let present: Promise<boolean> | undefined;
  const exists = (): Promise<boolean> => {
    present ??= stat(path).then(
      (stats) => stats.isDirectory(),
      () => false,
    );
    return present;
  };
  const missing = (): Outcome => skip(`${path} is not available.`);
  const minFree = settings["reaper.min_free_gb"] * GB;

  return [
    {
      key: `${prefix}.mounted`,
      label: labels.mounted,
      async run() {
        if (!(await exists())) {
          return fail(`${path} does not exist or is not a directory. Is the volume mounted?`);
        }
        if (!(await separateMount(path))) {
          return warn(
            `${path} is on the container's root filesystem, not a mounted volume; media written there is lost when the container is replaced.`,
          );
        }
        return ok(`${path} is a mounted volume.`);
      },
    },
    {
      key: `${prefix}.writable`,
      label: labels.writable,
      async run() {
        if (!(await exists())) {
          return missing();
        }
        await probeWritable(path);
        return ok(`${path} is writable.`);
      },
    },
    {
      key: `${prefix}.free`,
      label: labels.free,
      async run() {
        if (!(await exists())) {
          return missing();
        }
        const { free, total } = await space(path);
        const detail = `${formatBytes(free)} free of ${formatBytes(total)}.`;
        if (free < GB) {
          return fail(`Only ${detail}`, free);
        }
        if (free < minFree) {
          return warn(
            `Only ${detail} Below the ${String(settings["reaper.min_free_gb"])} GB minimum, so the reaper will free space.`,
            free,
          );
        }
        return ok(detail, free);
      },
    },
    {
      key: `${prefix}.quota_headroom`,
      label: labels.quota_headroom,
      run() {
        if (location.quota_bytes === 0) {
          return Promise.resolve(ok("No quota set."));
        }
        if (location.used_bytes === undefined) {
          return Promise.resolve(skip("Usage is not known yet."));
        }
        const headroom = location.quota_bytes - location.used_bytes;
        const pct = (location.used_bytes / location.quota_bytes) * 100;
        const detail = `${formatBytes(location.used_bytes)} of ${formatBytes(location.quota_bytes)} used (${pct.toFixed(1)}%).`;
        if (headroom <= 0) {
          return Promise.resolve(fail(`Over quota: ${detail}`, headroom));
        }
        if (pct >= settings["reaper.high_water_pct"]) {
          return Promise.resolve(
            warn(
              `${detail} At or above the ${String(settings["reaper.high_water_pct"])}% reaping threshold.`,
              headroom,
            ),
          );
        }
        return Promise.resolve(ok(detail, headroom));
      },
    },
  ];
}

function dbChecks(db: Db): CheckSpec[] {
  return [
    {
      key: "db.integrity",
      label: "Database integrity",
      run() {
        const rows = db.all<Record<string, unknown>>("PRAGMA integrity_check");
        const messages = rows.map((row) => String(Object.values(row)[0]));
        if (messages.length === 1 && messages[0] === "ok") {
          return Promise.resolve(ok("PRAGMA integrity_check reports ok."));
        }
        return Promise.resolve(fail(`integrity_check: ${messages.slice(0, 3).join("; ")}`));
      },
    },
    {
      key: "db.wal",
      label: "Database WAL mode",
      run() {
        const mode = String(readPragma(db, "journal_mode") ?? "unknown").toLowerCase();
        return Promise.resolve(
          mode === "wal"
            ? ok("journal_mode is wal.", mode)
            : warn(`journal_mode is ${mode}, expected wal.`, mode),
        );
      },
    },
    {
      key: "db.migrations",
      label: "Database migrations",
      run() {
        const row = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM migrations");
        const applied = Number(row?.n ?? 0);
        const expected = migrations.length;
        if (applied < expected) {
          return Promise.resolve(
            fail(`${String(applied)} of ${String(expected)} migrations applied.`, applied),
          );
        }
        return Promise.resolve(ok(`${String(applied)} migrations applied.`, applied));
      },
    },
  ];
}

function versionCheck(
  deps: SelfCheckDeps,
  key: string,
  label: string,
  tool: ToolName,
  args: readonly string[],
  parse: (stdout: string) => string | null,
): CheckSpec {
  return {
    key,
    label,
    async run() {
      const result = await tryRun(deps, tool, args);
      if (result === null) {
        return fail(`${tool} was not found.`);
      }
      const version = result.code === 0 ? parse(result.stdout) : null;
      if (version === null) {
        return fail(`${tool} ${args.join(" ")} failed (exit ${String(result.code)}).`);
      }
      return ok(`${tool} ${version}`, version);
    },
  };
}

const ProbeOutputSchema = z.object({
  streams: z.array(z.object({ codec_type: z.string().optional() })).default([]),
  format: z.object({ duration: z.union([z.string(), z.number()]).optional() }).default({}),
});

function dryRunCheck(deps: SelfCheckDeps): CheckSpec {
  return {
    key: "tools.ffprobe_dry_run",
    label: "ffmpeg/ffprobe dry run",
    async run() {
      await mkdir(deps.config.tmpDir, { recursive: true });
      const clip = join(deps.config.tmpDir, `selfcheck-${randomBytes(6).toString("hex")}.mp4`);
      try {
        const encode = await tryRun(
          deps,
          "ffmpeg",
          [
            "-hide_banner",
            "-nostats",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=1:size=64x64:rate=10",
            "-f",
            "lavfi",
            "-i",
            "sine=duration=1",
            "-c:v",
            "libx264",
            "-t",
            "1",
            "-y",
            clip,
          ],
          12_000,
        );
        if (encode === null) {
          return skip("ffmpeg is missing, so no test clip can be made.");
        }
        if (encode.code !== 0) {
          return fail(`ffmpeg could not make the test clip (exit ${String(encode.code)}).`);
        }
        const probed = await tryRun(deps, "ffprobe", [
          "-v",
          "error",
          "-print_format",
          "json",
          "-show_format",
          "-show_streams",
          clip,
        ]);
        if (probed === null) {
          return fail("ffprobe was not found.");
        }
        if (probed.code !== 0) {
          return fail(`ffprobe could not read the test clip (exit ${String(probed.code)}).`);
        }
        let parsed: z.infer<typeof ProbeOutputSchema>;
        try {
          parsed = ProbeOutputSchema.parse(JSON.parse(probed.stdout));
        } catch {
          return fail("ffprobe printed something that is not its JSON report.");
        }
        const types = new Set(parsed.streams.map((stream) => stream.codec_type));
        const duration = Number(parsed.format.duration);
        if (!types.has("video") || !types.has("audio")) {
          return fail("The test clip is missing its video or audio stream.");
        }
        if (!Number.isFinite(duration) || Math.abs(duration - 1) > 1) {
          return fail(`The test clip should last 1 s, ffprobe says ${String(duration)} s.`);
        }
        return ok(`1 s test clip encoded and probed (${duration.toFixed(2)} s).`, duration);
      } finally {
        await rm(clip, { force: true });
      }
    },
  };
}

function gpuChecks(deps: SelfCheckDeps): CheckSpec[] {
  let shared: Promise<GpuProbe> | undefined;
  const gpu = (): Promise<GpuProbe> => {
    shared ??= probeGpu(deps).then((probe) => {
      nvencCache = { at: (deps.now ?? Date.now)(), value: availabilityOf(probe) };
      return probe;
    });
    return shared;
  };
  return [
    {
      key: "gpu.nvenc",
      label: "NVENC encoder",
      async run() {
        const probe = await gpu();
        if (probe.ffmpegMissing) {
          return skip("ffmpeg is missing.");
        }
        if (!probe.hevcListed && !probe.h264Listed) {
          return warn("ffmpeg lists no NVENC encoder; transcodes use the CPU.");
        }
        const working = [
          probe.hevcEncodes ? "hevc_nvenc" : null,
          probe.h264Encodes ? "h264_nvenc" : null,
        ].filter((name): name is string => name !== null);
        if (working.length === 0) {
          return warn(
            "NVENC is listed but a test encode failed; is the GPU passed through to the container?",
          );
        }
        return ok(`Test encode succeeded with ${working.join(", ")}.`, working.join(","));
      },
    },
    {
      key: "gpu.nvdec",
      label: "NVDEC (CUDA hwaccel)",
      async run() {
        const probe = await gpu();
        if (probe.ffmpegMissing) {
          return skip("ffmpeg is missing.");
        }
        return probe.nvdec
          ? ok("ffmpeg lists the cuda hwaccel.")
          : warn("ffmpeg lists no cuda hwaccel; decoding uses the CPU.");
      },
    },
  ];
}

type NetworkChecks = Record<"pot" | "favicon" | "clock" | "vapid" | "updates", CheckSpec>;

function networkChecks(deps: SelfCheckDeps, settings: ResolvedSettings): NetworkChecks {
  const now = deps.now ?? Date.now;
  return {
    pot: {
      key: "pot.sidecar",
      label: "PO token provider",
      async run() {
        const base = resolvePotProviderUrl(settings, deps.config.potProviderUrl);
        if (base === "") {
          return skip("The PO token provider is disabled in settings.");
        }
        let response: Response;
        try {
          response = await deps.fetch(`${base}/ping`, {
            signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
          });
        } catch (error) {
          return fail(`The PO token provider is unreachable: ${describeError(error)}`);
        }
        if (!response.ok) {
          await response.body?.cancel();
          return fail(`The PO token provider answered HTTP ${String(response.status)}.`);
        }
        const body: unknown = await response.json().catch(() => null);
        const version = (body as { version?: unknown } | null)?.version;
        if (typeof version !== "string" && typeof version !== "number") {
          return fail("The PO token provider's /ping did not report a version.");
        }
        return ok(`bgutil provider ${String(version)} is up.`, String(version));
      },
    },
    favicon: {
      key: "youtube.favicon",
      label: "YouTube reachable",
      async run() {
        let response: Response;
        try {
          response = await deps.fetch(YOUTUBE_FAVICON_URL, {
            signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
          });
        } catch (error) {
          return fail(`youtube.com is unreachable: ${describeError(error)}`);
        }
        await response.body?.cancel();
        return response.status === 200
          ? ok("youtube.com/favicon.ico answered 200.")
          : fail(`youtube.com/favicon.ico answered HTTP ${String(response.status)}.`);
      },
    },
    clock: {
      key: "clock.skew",
      label: "Clock skew",
      async run() {
        const sent = now();
        let response: Response;
        try {
          response = await deps.fetch(CLOCK_REFERENCE_URL, {
            method: "HEAD",
            signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
          });
        } catch (error) {
          return warn(`Could not reach www.google.com to compare clocks: ${describeError(error)}`);
        }
        const received = now();
        await response.body?.cancel();
        const header = response.headers.get("date");
        const remote = header === null ? Number.NaN : Date.parse(header);
        if (Number.isNaN(remote)) {
          return warn("www.google.com sent no usable Date header.");
        }
        // The Date header has one second resolution: compare against its midpoint.
        const skew = Math.round((sent + received) / 2 - (remote + 500));
        const seconds = (Math.abs(skew) / 1000).toFixed(1);
        const direction = skew >= 0 ? "ahead of" : "behind";
        const detail = `The local clock is ${seconds} s ${direction} Google's.`;
        if (Math.abs(skew) > SKEW_FAIL_MS) {
          return fail(`${detail} OAuth and signed URLs break beyond a few minutes.`, skew);
        }
        if (Math.abs(skew) > SKEW_WARN_MS) {
          return warn(detail, skew);
        }
        return ok(detail, skew);
      },
    },
    vapid: {
      key: "push.vapid",
      label: "Web push keys",
      run() {
        const keys = getKv<unknown>(deps.db, VAPID_KV_KEY);
        return Promise.resolve(
          keys === undefined || keys === null
            ? warn("No VAPID keys yet; web push stays off until they are generated.")
            : ok("VAPID keys are present."),
        );
      },
    },
    updates: {
      key: "tools.updates",
      label: "Tool updates",
      run() {
        const state = readToolState(deps.db);
        const tools = [
          { name: "yt-dlp", info: toolVersionsInfo(state, "ytdlp") },
          { name: "ffmpeg", info: toolVersionsInfo(state, "ffmpeg") },
        ];
        if (tools.every((tool) => tool.info.checked_at === null)) {
          return Promise.resolve(skip("No update check has run yet."));
        }
        const problems: string[] = [];
        for (const { name, info } of tools) {
          if (info.last_error !== null) {
            problems.push(`${name} update check failed: ${info.last_error}`);
          } else if (info.update_available) {
            problems.push(
              `${name} ${info.latest ?? "?"} is available (installed ${info.current ?? "unknown"})`,
            );
          }
        }
        return Promise.resolve(
          problems.length === 0
            ? ok("yt-dlp and ffmpeg are up to date.")
            : warn(`${problems.join("; ")}.`),
        );
      },
    },
  };
}

function accountChecks(deps: SelfCheckDeps, account: { id: number; label: string }): CheckSpec[] {
  const id = String(account.id);
  const credential = async (check: Promise<CredentialCheck>): Promise<Outcome> => {
    const result = await check;
    return result.ok ? ok(result.detail) : fail(result.detail);
  };
  return [
    {
      key: `account.${id}.api`,
      label: `Account "${account.label}" API token`,
      run: () => credential(deps.accounts.checkApi(account.id)),
    },
    {
      key: `account.${id}.cookies`,
      label: `Account "${account.label}" cookies`,
      run: () => credential(deps.accounts.checkCookies(account.id)),
    },
  ];
}

function proxyCheck(
  deps: SelfCheckDeps,
  proxy: { id: number; label: string; url: string },
): CheckSpec {
  const viaProxy = deps.proxyFetch ?? defaultProxyFetch;
  return {
    key: `proxy.${String(proxy.id)}`,
    label: `Proxy "${proxy.label}"`,
    async run() {
      let status: number;
      try {
        status = await viaProxy(
          YOUTUBE_FAVICON_URL,
          proxy.url,
          AbortSignal.timeout(NETWORK_TIMEOUT_MS),
        );
      } catch (error) {
        return fail(
          `Unreachable through this proxy: ${redactProxy(describeError(error), proxy.url)}`,
        );
      }
      return status === 200
        ? ok("youtube.com/favicon.ico answered 200 through this proxy.")
        : fail(`youtube.com/favicon.ico answered HTTP ${String(status)} through this proxy.`);
    },
  };
}

/** A list the deps could not produce becomes one failing result instead of a crash. */
function listOrFail<T>(
  what: string,
  key: string,
  produce: () => T[],
  log: Logger,
): { items: T[]; failure: CheckSpec | null } {
  try {
    return { items: produce(), failure: null };
  } catch (error) {
    const message = describeError(error);
    log.warn({ list: what, error: message }, "self-check could not list");
    return {
      items: [],
      failure: {
        key,
        label: `List ${what}`,
        run: () => Promise.resolve(fail(`Could not list ${what}: ${message}`)),
      },
    };
  }
}

function buildSpecs(deps: SelfCheckDeps): CheckSpec[] {
  let settings: ResolvedSettings;
  try {
    settings = deps.getSettings();
  } catch (error) {
    deps.log.warn({ error: describeError(error) }, "self-check is using default settings");
    settings = defaultSettings();
  }
  const space = deps.statfs ?? defaultStatfs;
  const separateMount = deps.isSeparateMount ?? defaultIsSeparateMount;
  const locations = listOrFail("locations", "locations", () => deps.listLocations(), deps.log);
  const accounts = listOrFail("accounts", "accounts", () => deps.accounts.list(), deps.log);
  const proxies = listOrFail("proxies", "proxies", () => deps.proxies.listDecrypted(), deps.log);

  const specs: CheckSpec[] = [...dataChecks(deps, space)];
  for (const location of locations.items) {
    specs.push(...locationChecks(deps, location, settings, space, separateMount));
  }
  specs.push(
    ...dbChecks(deps.db),
    versionCheck(deps, "tools.ytdlp", "yt-dlp", "yt-dlp", ["--version"], parseYtdlpVersion),
    versionCheck(deps, "tools.ffmpeg", "ffmpeg", "ffmpeg", ["-version"], parseFfmpegVersion),
    versionCheck(deps, "tools.ffprobe", "ffprobe", "ffprobe", ["-version"], parseFfprobeVersion),
    dryRunCheck(deps),
    ...gpuChecks(deps),
  );
  const { pot, favicon, clock, vapid, updates } = networkChecks(deps, settings);
  specs.push(pot, favicon);
  for (const account of accounts.items) {
    specs.push(...accountChecks(deps, account));
  }
  specs.push(vapid, clock);
  for (const proxy of proxies.items) {
    specs.push(proxyCheck(deps, proxy));
  }
  specs.push(updates);
  for (const failure of [locations.failure, accounts.failure, proxies.failure]) {
    if (failure !== null) {
      specs.push(failure);
    }
  }
  return specs;
}

// ---------------------------------------------------------------------------
// Runs and history
// ---------------------------------------------------------------------------

interface CheckDbRow {
  id: number;
  run_at: number;
  trigger: string;
  results_json: string;
  ok: number;
}

function toCheckRow(row: CheckDbRow): CheckRow {
  let results: CheckResult[];
  try {
    const parsed = z.array(CheckResultSchema).safeParse(JSON.parse(row.results_json));
    results = parsed.success ? parsed.data : [];
  } catch {
    results = [];
  }
  const trigger = CheckTriggerSchema.safeParse(row.trigger);
  return {
    id: Number(row.id),
    run_at: Number(row.run_at),
    trigger: trigger.success ? trigger.data : "manual",
    ok: Number(row.ok) === 1,
    results,
  };
}

/** Run every check, store the run, and notify when anything failed. */
export async function runSelfCheck(deps: SelfCheckDeps, trigger: CheckTrigger): Promise<CheckRow> {
  const now = deps.now ?? Date.now;
  const runAt = now();
  const timeoutMs = deps.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
  const results = await Promise.all(buildSpecs(deps).map((spec) => runSpec(spec, timeoutMs)));
  const failed = results.filter((result) => result.level === "fail");
  const passed = failed.length === 0;
  const { lastInsertRowid } = deps.db.run(
    "INSERT INTO checks (run_at, trigger, results_json, ok) VALUES (?, ?, ?, ?)",
    runAt,
    trigger,
    JSON.stringify(results),
    passed ? 1 : 0,
  );
  const warned = results.filter((result) => result.level === "warn").length;
  deps.log.info(
    { trigger, checks: results.length, failed: failed.length, warned },
    "self-check finished",
  );
  if (!passed) {
    const title = `Self-check: ${String(failed.length)} check${failed.length === 1 ? "" : "s"} failed`;
    const body = failed.map((result) => `${result.label}: ${result.detail}`).join("\n");
    try {
      await deps.notify("selfcheck_failed", title, body);
    } catch (error) {
      deps.log.warn({ error: describeError(error) }, "could not send the self-check notification");
    }
  }
  return { id: lastInsertRowid, run_at: runAt, trigger, ok: passed, results };
}

const SELECT_CHECKS = "SELECT id, run_at, trigger, results_json, ok FROM checks";

export function lastCheck(db: Db): CheckRow | null {
  const row = db.get<CheckDbRow>(`${SELECT_CHECKS} ORDER BY run_at DESC, id DESC LIMIT 1`);
  return row === undefined ? null : toCheckRow(row);
}

export function listChecks(db: Db, limit: number): CheckRow[] {
  return db
    .all<CheckDbRow>(`${SELECT_CHECKS} ORDER BY run_at DESC, id DESC LIMIT ?`, limit)
    .map(toCheckRow);
}

/**
 * Boot run plus the periodic run every `selfcheck.interval_hours`, re-read
 * before each run so a settings change applies from the next one. Timers are
 * unref'ed; nothing escapes a tick.
 */
export function startSelfCheckSchedule(
  deps: SelfCheckDeps,
  options: { boot?: boolean; intervalMs?: number } = {},
): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const run = (trigger: CheckTrigger): Promise<void> =>
    runSelfCheck(deps, trigger).then(
      () => undefined,
      (error: unknown) => {
        deps.log.warn({ error: describeError(error), trigger }, "self-check run failed");
      },
    );
  const intervalMs = (): number => {
    if (options.intervalMs !== undefined) {
      return options.intervalMs;
    }
    try {
      return deps.getSettings()["selfcheck.interval_hours"] * 60 * 60_000;
    } catch {
      return 24 * 60 * 60_000;
    }
  };
  const schedule = (): void => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      void run("schedule").finally(schedule);
    }, intervalMs());
    timer.unref();
  };
  if (options.boot ?? true) {
    void run("boot");
  }
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
