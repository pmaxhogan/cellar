import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { getKv, setKv } from "../db/kv.ts";
import type { PipelineDeps } from "../jobs/pipelineDeps.ts";
import { buildCanaryArgs, classifyFailure, ytdlpToolOptions } from "../media/ytdlp.ts";

/**
 * The canary (docs/ARCHITECTURE.md "Canary"). A known-good video is
 * downloaded at the lowest quality into a temp dir, without cookies or a
 * proxy, and discarded; the YouTube favicon is fetched alongside. Together
 * they tell "these videos fail" from "yt-dlp or YouTube is broken" from "the
 * network is down":
 *
 *   canary ok                     -> the failures are video specific; nothing to do
 *   canary fails, favicon ok      -> notify `youtube_broken`
 *   canary fails, favicon fails   -> network outage: activity only
 *
 * At most `canary.max_per_hour` runs per rolling hour (`kv.canary_last`).
 */

export const CANARY_JOB = "canary";
export const CANARY_KV_KEY = "canary_last";
export const FAVICON_URL = "https://youtube.com/favicon.ico";
export const CANARY_TIMEOUT_MS = 10 * 60_000;
export const FAVICON_TIMEOUT_MS = 15_000;
const HOUR_MS = 60 * 60_000;

export type CanaryVerdict = "ok" | "youtube_broken" | "network_outage";

export interface CanaryOutcome {
  canaryOk: boolean;
  faviconOk: boolean;
  verdict: CanaryVerdict;
  detail: string;
}

type CanaryDeps = Pick<
  PipelineDeps,
  | "db"
  | "log"
  | "config"
  | "now"
  | "runTool"
  | "getSettings"
  | "notify"
  | "logActivity"
  | "enqueue"
  | "fetch"
>;

/** Canary run times within the last hour. */
export function recentCanaryRuns(deps: Pick<CanaryDeps, "db" | "now">): number[] {
  const stored = getKv<{ runs?: unknown }>(deps.db, CANARY_KV_KEY);
  const now = deps.now();
  const runs = Array.isArray(stored?.runs) ? stored.runs : [];
  return runs.filter(
    (at): at is number => typeof at === "number" && at <= now && now - at < HOUR_MS,
  );
}

export function canaryBudgetOk(deps: Pick<CanaryDeps, "db" | "now" | "getSettings">): boolean {
  return recentCanaryRuns(deps).length < deps.getSettings()["canary.max_per_hour"];
}

function recordRun(deps: Pick<CanaryDeps, "db" | "now">): void {
  const now = deps.now();
  setKv(deps.db, CANARY_KV_KEY, { runs: [...recentCanaryRuns(deps), now] }, now);
}

/** Queue a canary unless one is queued or the hourly budget is spent. */
export function maybeEnqueueCanary(
  deps: Pick<CanaryDeps, "db" | "now" | "getSettings" | "enqueue" | "log">,
  reason: string,
): boolean {
  if (!canaryBudgetOk(deps)) {
    deps.log.info({ reason }, "canary budget spent for this hour; not queuing one");
    return false;
  }
  const { deduped } = deps.enqueue({ type: CANARY_JOB, dedupe: true, payload: { reason } });
  return !deduped;
}

async function fetchFavicon(deps: Pick<CanaryDeps, "fetch">): Promise<boolean> {
  const doFetch = deps.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
  try {
    const response = await doFetch(FAVICON_URL, {
      signal: AbortSignal.timeout(FAVICON_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}

/** Run the canary and act on the verdict. */
export async function runCanary(
  deps: CanaryDeps,
  options: { signal?: AbortSignal; jobId?: number } = {},
): Promise<CanaryOutcome> {
  recordRun(deps);
  const dir = join(deps.config.tmpDir, `canary-${String(deps.now())}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let canaryOk = false;
  let detail: string;
  try {
    const tools = ytdlpToolOptions(deps.getSettings(), deps.config);
    const result = await deps.runTool({
      tool: "yt-dlp",
      args: buildCanaryArgs({ outDir: dir, ...tools }),
      timeoutMs: CANARY_TIMEOUT_MS,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    canaryOk = result.code === 0;
    detail = canaryOk
      ? "The canary video downloaded."
      : classifyFailure(result.stderr, result.stdout).message;
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  const faviconOk = await fetchFavicon(deps);

  let verdict: CanaryVerdict;
  const jobId = options.jobId ?? null;
  if (canaryOk) {
    verdict = "ok";
    deps.logActivity({
      kind: "canary.ok",
      message: "Canary download worked; recent download failures are specific to those videos.",
      jobId,
    });
  } else if (faviconOk) {
    verdict = "youtube_broken";
    deps.logActivity({
      level: "error",
      kind: "canary.failed",
      message: `Canary download failed while YouTube is reachable: ${detail}`,
      jobId,
    });
    await deps.notify({
      type: "youtube_broken",
      title: "Downloads from YouTube are broken",
      body: `The known-good canary video failed to download while youtube.com answers: ${detail}`,
      data: { detail },
    });
  } else {
    verdict = "network_outage";
    deps.logActivity({
      level: "warn",
      kind: "canary.network",
      message: "Canary download and the YouTube favicon both failed: the network looks down.",
      data: { detail },
      jobId,
    });
  }
  deps.log.info({ canaryOk, faviconOk, verdict }, "canary finished");
  return { canaryOk, faviconOk, verdict, detail };
}
