import { CANARY_JOB } from "../domain/canary.ts";
import {
  MOVE_JOB,
  MOVE_SCAN_INTERVAL_MS,
  MOVE_SCAN_SCHEDULE,
  scheduleMovesForChangedLocations,
} from "../domain/mover.ts";
import { REAP_JOB, REAP_NOW_ACTION } from "../domain/reaper.ts";
import { runCanaryJob } from "./handlers/canary.ts";
import {
  DOWNLOAD_SCAN_INTERVAL_MS,
  DOWNLOAD_SCAN_JOB,
  runDownloadScan,
} from "./handlers/downloadScan.ts";
import {
  DOWNLOAD_JOB,
  pickDownloadAccount,
  runDownload,
  type DownloadReason,
} from "./handlers/download.ts";
import { runMove } from "./handlers/move.ts";
import { reapLocationOf, runReap } from "./handlers/reap.ts";
import { runTranscode, TRANSCODE_JOB } from "./handlers/transcode.ts";
import type { PipelineDeps } from "./pipelineDeps.ts";
import type { EnqueueResult } from "./queue.ts";
import { jobRegistry, type HandlerRegistration } from "./types.ts";

/**
 * Wires the media pipeline into the scheduler: the download, transcode, move,
 * reap and canary handlers, the `action:reap-now` manual action, and the
 * hourly reap plus the 10-minute move scan.
 */

export const REAP_HOURLY_SCHEDULE = "reap_hourly";
export const REAP_INTERVAL_MS = 60 * 60_000;

export { CANARY_JOB, DOWNLOAD_JOB, MOVE_JOB, REAP_JOB, REAP_NOW_ACTION, TRANSCODE_JOB };

export function bootPipeline(deps: PipelineDeps): void {
  const registry = deps.registry ?? jobRegistry;
  const register = (type: string, registration: HandlerRegistration): void => {
    if (!registry.has(type)) {
      registry.register(type, registration);
    }
  };
  register(DOWNLOAD_JOB, {
    class: "download",
    maxAttempts: 5,
    handler: (ctx) => runDownload(deps, ctx),
  });
  register(TRANSCODE_JOB, {
    class: "transcode",
    maxAttempts: 2,
    handler: (ctx) => runTranscode(deps, ctx),
  });
  register(MOVE_JOB, {
    class: "maintenance",
    maxAttempts: 3,
    handler: (ctx) => runMove(deps, ctx),
  });
  register(REAP_JOB, {
    class: "maintenance",
    maxAttempts: 1,
    handler: (ctx) => runReap(deps, ctx),
    dedupeKey: (payload) => String(reapLocationOf(payload) ?? "all"),
  });
  register(REAP_NOW_ACTION, {
    class: "maintenance",
    maxAttempts: 1,
    handler: (ctx) => runReap(deps, ctx),
  });
  register(CANARY_JOB, {
    class: "maintenance",
    maxAttempts: 1,
    handler: (ctx) => runCanaryJob(deps, ctx),
    dedupeKey: () => CANARY_JOB,
  });

  register(DOWNLOAD_SCAN_JOB, {
    class: "maintenance",
    maxAttempts: 1,
    handler: (ctx) => {
      runDownloadScan(deps, ctx);
      return Promise.resolve();
    },
    dedupeKey: () => DOWNLOAD_SCAN_JOB,
  });

  deps.every(REAP_HOURLY_SCHEDULE, REAP_INTERVAL_MS, () =>
    deps.enqueue({ type: REAP_JOB, payload: {}, dedupe: true }),
  );
  // Queue downloads for everything the rules keep that is not on disk yet.
  deps.every(DOWNLOAD_SCAN_JOB, DOWNLOAD_SCAN_INTERVAL_MS, () =>
    deps.enqueue({ type: DOWNLOAD_SCAN_JOB, payload: {}, dedupe: true }),
  );
  deps.every(MOVE_SCAN_SCHEDULE, MOVE_SCAN_INTERVAL_MS, () => {
    const queued = scheduleMovesForChangedLocations(deps);
    if (queued > 0) {
      deps.log.info({ queued }, "queued moves for videos whose location changed");
    }
  });
}

/**
 * Queue a download of one video (deduped per video). The download account
 * is chosen now when the effective settings allow one, so the scheduler's
 * per-account gap applies to the job; the handler re-checks it at run time.
 */
export function enqueueDownload(
  deps: PipelineDeps,
  videoId: string,
  options: { reason?: DownloadReason; priority?: number; runAfter?: number } = {},
): EnqueueResult {
  const resolved = deps.getEffective(videoId);
  const accountId =
    resolved === null
      ? null
      : pickDownloadAccount(deps, videoId, resolved.effective.download_accounts);
  return deps.enqueue({
    type: DOWNLOAD_JOB,
    videoId,
    accountId,
    dedupe: true,
    payload: options.reason === undefined ? {} : { reason: options.reason },
    ...(options.priority === undefined ? {} : { priority: options.priority }),
    ...(options.runAfter === undefined ? {} : { runAfter: options.runAfter }),
  });
}
