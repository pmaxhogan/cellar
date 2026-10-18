import {
  dueVideoIds,
  EVAL_PASS_JOB,
  RECHECK_ALL_JOB,
  runEvalPass,
  type EvalPassPayload,
  type RulesDeps,
} from "../../domain/ruleEval.ts";
import type { Scheduler } from "../scheduler.ts";
import type { JobContext, JobRegistry } from "../types.ts";
import { registerPri0Sweep } from "./pri0Sweep.ts";

/**
 * Job handlers and schedules of the rules subsystem:
 *
 *   eval_pass          full / due-only / targeted evaluation (maintenance)
 *   pri0_sweep         delete media of pri-0 videos (maintenance)
 *   action:eval-now    POST /api/actions/eval-now: a full pass now
 *   action:refresh-all POST /api/actions/refresh-all: recheck_all (when that
 *                      handler exists), then a full pass
 *
 * Schedules: `eval_pass_hourly` every eval.interval_minutes (read once at
 * boot) and `eval_pass_due`, a 60 s tick that queues a due-only pass when a
 * video's next_eval_at has passed or a video was never evaluated.
 */

export const ACTION_EVAL_NOW = "action:eval-now";
export const ACTION_REFRESH_ALL = "action:refresh-all";
export const EVAL_HOURLY_SCHEDULE = "eval_pass_hourly";
export const EVAL_DUE_SCHEDULE = "eval_pass_due";
export const EVAL_DUE_TICK_MS = 60_000;

/** Dedupe identity of an eval_pass payload: "full", "due" or the sorted id list. */
export function evalPassKey(payload: unknown): string {
  const p = (payload ?? {}) as EvalPassPayload;
  if (Array.isArray(p.videoIds)) {
    return `ids:${[...p.videoIds].map(String).sort().join(",")}`;
  }
  return p.dueOnly === true ? "due" : "full";
}

function payloadOf(ctx: JobContext): EvalPassPayload {
  const raw = ctx.job.payload;
  return (raw !== null && typeof raw === "object" ? raw : {}) as EvalPassPayload;
}

async function runFromJob(deps: RulesDeps, ctx: JobContext, fallbackReason: string): Promise<void> {
  const payload = payloadOf(ctx);
  const videoIds = Array.isArray(payload.videoIds)
    ? payload.videoIds.filter((id): id is string => typeof id === "string")
    : undefined;
  const result = await runEvalPass(
    { ...deps, db: ctx.db, log: ctx.log },
    {
      reason: typeof payload.reason === "string" ? payload.reason : fallbackReason,
      ...(videoIds === undefined ? {} : { videoIds }),
      ...(payload.dueOnly === true ? { dueOnly: true } : {}),
      checkpoint: () => {
        ctx.checkpoint();
      },
      progress: (pct, message) => {
        ctx.progress(pct, message);
      },
    },
  );
  ctx.log.info({ evaluated: result.evaluated, changed: result.changed }, "eval pass job done");
}

export function registerRuleHandlers(registry: JobRegistry, deps: RulesDeps): void {
  registry.register(EVAL_PASS_JOB, {
    class: "maintenance",
    maxAttempts: 2,
    dedupeKey: evalPassKey,
    handler: (ctx) => runFromJob(deps, ctx, "queued"),
  });
  registerPri0Sweep(registry, deps);
  registry.register(ACTION_EVAL_NOW, {
    class: "maintenance",
    maxAttempts: 1,
    handler: async (ctx) => {
      await runEvalPass(
        { ...deps, db: ctx.db, log: ctx.log },
        {
          reason: "manual",
          checkpoint: () => {
            ctx.checkpoint();
          },
          progress: (pct, message) => {
            ctx.progress(pct, message);
          },
        },
      );
    },
  });
  registry.register(ACTION_REFRESH_ALL, {
    class: "maintenance",
    maxAttempts: 1,
    handler: async (ctx) => {
      if (deps.registry.has(RECHECK_ALL_JOB)) {
        deps.enqueue({ type: RECHECK_ALL_JOB, payload: {}, dedupe: true });
      } else {
        ctx.log.info("no recheck_all handler registered; evaluating only");
      }
      deps.enqueue({ type: EVAL_PASS_JOB, payload: { reason: "refresh-all" }, dedupe: true });
      await Promise.resolve();
    },
  });
}

/** The schedules. `every` intervals are fixed at registration; a settings change applies on restart. */
export function registerRuleSchedules(scheduler: Pick<Scheduler, "every">, deps: RulesDeps): void {
  const minutes = deps.getSettings()["eval.interval_minutes"];
  scheduler.every(EVAL_HOURLY_SCHEDULE, minutes * 60_000, () =>
    deps.enqueue({ type: EVAL_PASS_JOB, payload: { reason: "hourly" }, dedupe: true }),
  );
  scheduler.every(EVAL_DUE_SCHEDULE, EVAL_DUE_TICK_MS, () => {
    const now = (deps.now ?? Date.now)();
    if (dueVideoIds(deps.db, now, 1).length === 0) {
      return undefined;
    }
    return deps.enqueue({
      type: EVAL_PASS_JOB,
      payload: { reason: "due", dueOnly: true },
      dedupe: true,
    });
  });
}
