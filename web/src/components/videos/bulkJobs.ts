import type { VideoJobResponse } from "@cellar/shared";
import { normalizeError } from "../../api/client.ts";

/**
 * Per-video job triggers (recheck, download now) fanned out over a selection.
 * There is no bulk endpoint, so the requests go through a small pool; the first
 * 501 stops the run, because every other id would answer the same.
 */

export type BulkJobKind = "recheck" | "download";

export interface BulkJobOutcome {
  queued: number;
  deduped: number;
  failed: number;
  /** True when the server has no handler for the job type (501). */
  unavailable: boolean;
  firstError: string | null;
}

export const BULK_JOB_CONCURRENCY = 4;

export async function runBulkJobs(
  ids: readonly string[],
  enqueue: (id: string) => Promise<VideoJobResponse>,
  concurrency = BULK_JOB_CONCURRENCY,
): Promise<BulkJobOutcome> {
  const outcome: BulkJobOutcome = {
    queued: 0,
    deduped: 0,
    failed: 0,
    unavailable: false,
    firstError: null,
  };
  let next = 0;

  async function worker(): Promise<void> {
    while (!outcome.unavailable && next < ids.length) {
      const id = ids[next]!;
      next += 1;
      try {
        const result = await enqueue(id);
        outcome.queued += 1;
        if (result.deduped) outcome.deduped += 1;
      } catch (cause) {
        const error = normalizeError(cause);
        if (error.status === 501) {
          outcome.unavailable = true;
          return;
        }
        outcome.failed += 1;
        outcome.firstError ??= error.message;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, ids.length)) }, () => worker()),
  );
  return outcome;
}
