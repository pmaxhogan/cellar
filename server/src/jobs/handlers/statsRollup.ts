import type { Db } from "../../db/db.ts";
import { logActivity } from "../../domain/activity.ts";
import { backfill, DAY_MS, hasRollup, rollupDaily, utcDay } from "../../domain/stats.ts";
import type { EventBus } from "../../events.ts";
import type { Scheduler } from "../scheduler.ts";
import type { JobContext, JobRegistry } from "../types.ts";

/**
 * The `stats_rollup` job (maintenance class): today's stats_daily points plus
 * a short backfill, so the day that just ended is finalised even when one
 * daily run was missed. The daily run also takes yesterday's storage figure
 * from the files on disk just after midnight, so bytes_used reads as the end
 * of each day.
 *
 * Scheduler.every() is interval based, not wall-clock based, so the daily
 * schedule enqueues the job with run_after set to the next 00:10 UTC: the
 * rollup itself lands just after midnight whatever time the process booted.
 * A boot with no row for today also enqueues an immediate run.
 */

export const STATS_ROLLUP_JOB = "stats_rollup";
/** Minutes past midnight UTC the daily rollup runs at. */
export const STATS_ROLLUP_MINUTE = 10;
/** Whole days before today each run recomputes. */
export const STATS_ROLLUP_BACKFILL_DAYS = 2;

export type StatsRollupTrigger = "daily" | "boot";

export interface StatsRollupDeps {
  db: Db;
  events?: EventBus | undefined;
  now?: () => number;
}

/** The next 00:10 UTC strictly after `now`. */
export function nextRollupAt(now: number): number {
  const today = Date.parse(`${utcDay(now)}T00:00:00Z`) + STATS_ROLLUP_MINUTE * 60_000;
  return today > now ? today : today + DAY_MS;
}

function triggerOf(payload: unknown): StatsRollupTrigger {
  const trigger = (payload as { trigger?: unknown } | null)?.trigger;
  return trigger === "boot" ? "boot" : "daily";
}

/**
 * How long after midnight UTC the live storage figure still stands in for the
 * end of yesterday. A daily run that lands later (the process was down) leaves
 * yesterday's snapshot alone rather than book today's changes against it.
 */
export const FINALISE_WINDOW_MS = 6 * 3_600_000;

export async function runStatsRollupJob(deps: StatsRollupDeps, ctx: JobContext): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const today0 = Date.parse(`${utcDay(now)}T00:00:00Z`);
  if (triggerOf(ctx.job.payload) === "daily" && now - today0 < FINALISE_WINDOW_MS) {
    rollupDaily(ctx.db, { day: utcDay(today0 - DAY_MS), now, refreshBytes: true });
  }
  const filled = backfill(ctx.db, { days: STATS_ROLLUP_BACKFILL_DAYS, now });
  const today = rollupDaily(ctx.db, { now });
  ctx.checkpoint();
  const points = filled.points + today.length;
  const all = today[0];
  logActivity(
    { db: ctx.db, events: deps.events, now: () => now },
    {
      kind: "stats.rollup",
      message: `Daily statistics rolled up (${String(points)} points)`,
      jobId: ctx.job.id,
      data: {
        trigger: triggerOf(ctx.job.payload),
        from: filled.from,
        to: utcDay(now),
        points,
        catalog: all?.catalog ?? 0,
        bytes_used: all?.bytes_used ?? 0,
      },
    },
  );
  ctx.log.info({ points, from: filled.from, to: utcDay(now) }, "stats rollup finished");
  await Promise.resolve();
}

export function registerStatsRollup(registry: JobRegistry, deps: StatsRollupDeps): void {
  registry.register(STATS_ROLLUP_JOB, {
    class: "maintenance",
    maxAttempts: 2,
    // The boot run and the next daily run are separate jobs.
    dedupeKey: (payload) => triggerOf(payload),
    handler: (ctx) => runStatsRollupJob(deps, ctx),
  });
}

/**
 * Register the daily schedule and, when today has no all-locations row yet,
 * enqueue an immediate run. Returns whether the boot run was queued.
 */
export function scheduleStatsRollup(
  scheduler: Pick<Scheduler, "every" | "enqueue">,
  deps: StatsRollupDeps,
): boolean {
  const now = deps.now ?? Date.now;
  scheduler.every(STATS_ROLLUP_JOB, DAY_MS, () =>
    scheduler.enqueue({
      type: STATS_ROLLUP_JOB,
      payload: { trigger: "daily" },
      runAfter: nextRollupAt(now()),
      dedupe: true,
    }),
  );
  if (hasRollup(deps.db, utcDay(now()))) {
    return false;
  }
  scheduler.enqueue({ type: STATS_ROLLUP_JOB, payload: { trigger: "boot" }, dedupe: true });
  return true;
}
