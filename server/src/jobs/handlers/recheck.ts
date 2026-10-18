import { logActivity } from "../../domain/activity.ts";
import { nowOf } from "../../domain/deps.ts";
import {
  dueRecheckIds,
  emptyRecheckResult,
  enqueueRecheckAll,
  logRecheck,
  runRecheck,
  type RecheckDeps,
} from "../../domain/recheck.ts";
import { RECHECK_ALL_JOB } from "../../domain/ruleEval.ts";
import { RECHECK_BATCH_JOB, RECHECK_LEFTOVER_JOB, recheckKey } from "../../youtube/ingest.ts";
import type { JobContext, JobRegistry } from "../types.ts";

/**
 * Recheck jobs:
 *
 *   recheck_batch           { video_ids: string[] (<= 50) } | { due: true, limit }   io
 *   recheck_batch_leftover  same payloads, pri-0 videos                              leftover
 *   recheck_all             {} : queue every video in batches of 50                  maintenance
 */

export const DEFAULT_DUE_LIMIT = 200;
export const MAX_DUE_LIMIT = 1000;

export interface RecheckPayload {
  video_ids?: string[];
  due?: boolean;
  limit?: number;
}

function payloadOf(ctx: JobContext): RecheckPayload {
  const raw = ctx.job.payload;
  return (raw !== null && typeof raw === "object" ? raw : {}) as RecheckPayload;
}

/** The ids a recheck job covers: its explicit list, or the due videos of its class. */
export function recheckIdsFor(
  deps: Pick<RecheckDeps, "db" | "now">,
  payload: RecheckPayload,
  leftover: boolean,
): string[] {
  if (Array.isArray(payload.video_ids)) {
    return payload.video_ids.filter((id): id is string => typeof id === "string");
  }
  if (payload.due === true) {
    const limit =
      typeof payload.limit === "number" && Number.isInteger(payload.limit) && payload.limit > 0
        ? Math.min(payload.limit, MAX_DUE_LIMIT)
        : DEFAULT_DUE_LIMIT;
    return dueRecheckIds(deps.db, nowOf(deps), limit, { pri0: leftover });
  }
  return [];
}

function recheckHandler(deps: RecheckDeps, leftover: boolean) {
  return async (ctx: JobContext): Promise<void> => {
    const d: RecheckDeps = { ...deps, db: ctx.db, log: ctx.log };
    const ids = recheckIdsFor(d, payloadOf(ctx), leftover);
    if (ids.length === 0) {
      ctx.log.info("nothing to recheck");
      return;
    }
    const result = emptyRecheckResult();
    try {
      await runRecheck(d, ids, {
        recheckId: ctx.job.id,
        result,
        checkpoint: () => {
          ctx.checkpoint();
        },
      });
    } catch (error) {
      logRecheck(d, result, { jobId: ctx.job.id, leftover, error });
      throw error;
    }
    logRecheck(d, result, { jobId: ctx.job.id, leftover });
  };
}

export function registerRecheckHandlers(registry: JobRegistry, deps: RecheckDeps): void {
  if (!registry.has(RECHECK_BATCH_JOB)) {
    registry.register(RECHECK_BATCH_JOB, {
      class: "io",
      maxAttempts: 3,
      dedupeKey: recheckKey,
      handler: recheckHandler(deps, false),
    });
  }
  if (!registry.has(RECHECK_LEFTOVER_JOB)) {
    registry.register(RECHECK_LEFTOVER_JOB, {
      class: "leftover",
      maxAttempts: 3,
      dedupeKey: recheckKey,
      handler: recheckHandler(deps, true),
    });
  }
  if (!registry.has(RECHECK_ALL_JOB)) {
    registry.register(RECHECK_ALL_JOB, {
      class: "maintenance",
      maxAttempts: 1,
      handler: async (ctx) => {
        const d: RecheckDeps = { ...deps, db: ctx.db, log: ctx.log };
        const counts = enqueueRecheckAll(d);
        logActivity(d, {
          kind: "recheck.all",
          message:
            `Queued a recheck of ${String(counts.normal + counts.leftover)} videos ` +
            `(${String(counts.leftover)} on leftover budget).`,
          jobId: ctx.job.id,
          data: counts,
        });
        await Promise.resolve();
      },
    });
  }
}
