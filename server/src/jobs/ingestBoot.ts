import type { ResolvedSettings } from "@cellar/shared";
import type { Logger } from "pino";
import type { Config } from "../config.ts";
import type { Db } from "../db/db.ts";
import { getKv, setKv } from "../db/kv.ts";
import type { FetchLike, ServiceDeps } from "../domain/deps.ts";
import { nowOf } from "../domain/deps.ts";
import { dueRecheckIds, type RecheckDeps } from "../domain/recheck.ts";
import { getSettings } from "../domain/settings.ts";
import type { EventBus } from "../events.ts";
import {
  ACTION_INGEST_NOW,
  apiAccountIds,
  channelsNeedingBackfill,
  cookieAccountIds,
  INGEST_CHANNEL_BACKFILL_JOB,
  INGEST_CHANNEL_UPLOADS_JOB,
  INGEST_HISTORY_JOB,
  INGEST_LIKED_JOB,
  INGEST_SUBSCRIPTIONS_JOB,
  INGEST_WATCH_LATER_JOB,
  RECHECK_BATCH_JOB,
  RECHECK_LEFTOVER_JOB,
} from "../youtube/ingest.ts";
import { apiUsage, scrapeUsage } from "../youtube/quota.ts";
import { createRydClient, type RydClient } from "../youtube/ryd.ts";
import { registerIngestHandlers, type IngestHandlerDeps } from "./handlers/ingest.ts";
import { registerRecheckHandlers } from "./handlers/recheck.ts";
import type { EnqueueInput } from "./queue.ts";
import type { Scheduler } from "./scheduler.ts";
import { jobRegistry, type JobClass, type JobRegistry } from "./types.ts";

/**
 * Boot of the ingestion subsystem: the ingest and recheck handlers, the
 * `action:ingest-now` action, the periodic feeds and due rechecks, and the
 * two budget hooks the scheduler takes (budgetOk, canConsumeScrape).
 *
 * Every feed has one `every()` that ticks each minute, re-reads the account
 * (or channel) list and the interval setting, and queues a deduped job for
 * whatever is due, so a settings change or a newly linked account applies
 * without a restart. Last-queue times persist in kv (`ingest_last:*`).
 */

export const INGEST_TICK_MS = 60_000;
export const RECHECK_DUE_TICK_MS = 5 * 60_000;
export const RECHECK_DUE_LIMIT = 200;
/** The leftover class runs only while today's project units stay under this share. */
export const LEFTOVER_BUDGET_SHARE = 0.8;
export const INGEST_LAST_KV_PREFIX = "ingest_last:";
/**
 * Feeds and channel polls outrank the immediate rechecks of newly seen videos
 * (RECHECK_NEW_PRIORITY): a steady stream of rechecks must never starve the
 * jobs that discover videos in the first place.
 */
export const FEED_PRIORITY = 10;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

// ---------------------------------------------------------------------------
// Budget hooks
// ---------------------------------------------------------------------------

/**
 * The quota gate: every class may start, except `leftover`, which only runs
 * while today's project-wide API units are under 80% of the daily budget.
 */
export function budgetOk(deps: Pick<ServiceDeps, "db" | "now">, cls: JobClass): boolean {
  if (cls !== "leftover") {
    return true;
  }
  const usage = apiUsage(deps);
  return usage.used < usage.budget * LEFTOVER_BUDGET_SHARE;
}

/**
 * The per-account scrape gate: `io` and `download` jobs of an account wait
 * while its hourly scrape budget (`quota.scrape_requests_per_hour`, or the
 * account's own) is spent. Other classes never scrape.
 */
export function canConsumeScrape(
  deps: Pick<ServiceDeps, "db" | "now">,
  accountId: number,
  cls: JobClass,
): boolean {
  if (cls !== "io" && cls !== "download") {
    return true;
  }
  return scrapeUsage(deps, accountId).remaining > 0;
}

/** The hooks in the shape bootScheduler takes. */
export interface BudgetHooks {
  budgetOk: (cls: JobClass) => boolean;
  canConsumeScrape: (accountId: number, cls: JobClass) => boolean;
}

export function budgetHooks(deps: Pick<ServiceDeps, "db" | "now">): BudgetHooks {
  return {
    budgetOk: (cls) => budgetOk(deps, cls),
    canConsumeScrape: (accountId, cls) => canConsumeScrape(deps, accountId, cls),
  };
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

type IntervalKey = {
  [K in keyof ResolvedSettings]: ResolvedSettings[K] extends number ? K : never;
}[keyof ResolvedSettings];

interface AccountFeed {
  name: string;
  setting: IntervalKey;
  unitMs: number;
  accounts: (db: Db) => number[];
  job: (accountId: number) => EnqueueInput;
}

export const ACCOUNT_FEEDS: readonly AccountFeed[] = [
  {
    name: "history",
    setting: "ingest.history_minutes",
    unitMs: MINUTE_MS,
    accounts: cookieAccountIds,
    job: (accountId) => ({
      type: INGEST_HISTORY_JOB,
      accountId,
      priority: FEED_PRIORITY,
      dedupe: true,
    }),
  },
  {
    name: "watch_later",
    setting: "ingest.watch_later_minutes",
    unitMs: MINUTE_MS,
    accounts: cookieAccountIds,
    job: (accountId) => ({
      type: INGEST_WATCH_LATER_JOB,
      accountId,
      priority: FEED_PRIORITY,
      dedupe: true,
    }),
  },
  {
    name: "liked",
    setting: "ingest.liked_minutes",
    unitMs: MINUTE_MS,
    accounts: apiAccountIds,
    job: (accountId) => ({
      type: INGEST_LIKED_JOB,
      payload: { account_id: accountId },
      priority: FEED_PRIORITY,
      dedupe: true,
    }),
  },
  {
    name: "subscriptions",
    setting: "ingest.subscriptions_hours",
    unitMs: HOUR_MS,
    accounts: apiAccountIds,
    job: (accountId) => ({
      type: INGEST_SUBSCRIPTIONS_JOB,
      payload: { account_id: accountId },
      priority: FEED_PRIORITY,
      dedupe: true,
    }),
  },
];

export interface ScheduleDeps {
  db: Db;
  now?: (() => number) | undefined;
  enqueue(input: EnqueueInput): unknown;
}

function isDue(deps: ScheduleDeps, key: string, intervalMs: number, force: boolean): boolean {
  if (force) {
    return true;
  }
  const last = getKv<number>(deps.db, INGEST_LAST_KV_PREFIX + key);
  return typeof last !== "number" || nowOf(deps) - last >= intervalMs;
}

function markQueued(deps: ScheduleDeps, key: string): void {
  setKv(deps.db, INGEST_LAST_KV_PREFIX + key, nowOf(deps), nowOf(deps));
}

/** Queue one feed for every eligible account whose interval has passed. Returns the count. */
export function tickAccountFeed(deps: ScheduleDeps, feed: AccountFeed, force = false): number {
  const intervalMs = getSettings(deps.db)[feed.setting] * feed.unitMs;
  let queued = 0;
  for (const accountId of feed.accounts(deps.db)) {
    const key = `${feed.name}:${String(accountId)}`;
    if (isDue(deps, key, intervalMs, force)) {
      deps.enqueue(feed.job(accountId));
      markQueued(deps, key);
      queued += 1;
    }
  }
  return queued;
}

/** Channels with any channel source (subscribed by some account, or manual). */
export function trackedChannelIds(db: Db): string[] {
  return db
    .all<{ channel_id: string }>(
      "SELECT DISTINCT channel_id FROM channel_sources ORDER BY channel_id",
    )
    .map((row) => row.channel_id);
}

/** Queue an uploads poll for every tracked channel once per `ingest.channel_uploads_minutes`. */
export function tickChannelUploads(deps: ScheduleDeps, force = false): number {
  const intervalMs = getSettings(deps.db)["ingest.channel_uploads_minutes"] * MINUTE_MS;
  if (!isDue(deps, "channel_uploads", intervalMs, force)) {
    return 0;
  }
  const channels = trackedChannelIds(deps.db);
  for (const channelId of channels) {
    deps.enqueue({
      type: INGEST_CHANNEL_UPLOADS_JOB,
      payload: { channel_id: channelId },
      priority: FEED_PRIORITY,
      dedupe: true,
    });
  }
  markQueued(deps, "channel_uploads");
  return channels.length;
}

/** Queue the leftover-class full scan of manual channels not caught up yet. */
export function tickChannelBackfill(deps: ScheduleDeps, force = false): number {
  const intervalMs = getSettings(deps.db)["ingest.manual_channel_full_scan_hours"] * HOUR_MS;
  if (!isDue(deps, "channel_backfill", intervalMs, force)) {
    return 0;
  }
  const channels = channelsNeedingBackfill(deps.db);
  for (const channelId of channels) {
    deps.enqueue({
      type: INGEST_CHANNEL_BACKFILL_JOB,
      payload: { channel_id: channelId },
      dedupe: true,
    });
  }
  markQueued(deps, "channel_backfill");
  return channels.length;
}

/** Queue the due rechecks: main class for evaluated non-pri-0 videos, leftover for pri 0. */
export function tickDueRechecks(deps: ScheduleDeps): number {
  const now = nowOf(deps);
  let queued = 0;
  if (dueRecheckIds(deps.db, now, 1, { pri0: false }).length > 0) {
    deps.enqueue({
      type: RECHECK_BATCH_JOB,
      payload: { due: true, limit: RECHECK_DUE_LIMIT },
      dedupe: true,
    });
    queued += 1;
  }
  if (dueRecheckIds(deps.db, now, 1, { pri0: true }).length > 0) {
    deps.enqueue({
      type: RECHECK_LEFTOVER_JOB,
      payload: { due: true, limit: RECHECK_DUE_LIMIT },
      dedupe: true,
    });
    queued += 1;
  }
  return queued;
}

/** `action:ingest-now`: every feed of every account, every channel, and the due rechecks. */
export function ingestEverythingNow(deps: ScheduleDeps): number {
  let queued = 0;
  for (const feed of ACCOUNT_FEEDS) {
    queued += tickAccountFeed(deps, feed, true);
  }
  queued += tickChannelUploads(deps, true);
  queued += tickChannelBackfill(deps, true);
  queued += tickDueRechecks(deps);
  return queued;
}

export function registerIngestSchedules(
  scheduler: Pick<Scheduler, "every">,
  deps: ScheduleDeps,
): void {
  for (const feed of ACCOUNT_FEEDS) {
    scheduler.every(`ingest:${feed.name}`, INGEST_TICK_MS, () => tickAccountFeed(deps, feed));
  }
  scheduler.every("ingest:channel_uploads", INGEST_TICK_MS, () => tickChannelUploads(deps));
  scheduler.every("ingest:channel_backfill", INGEST_TICK_MS, () => tickChannelBackfill(deps));
  scheduler.every("recheck:due", RECHECK_DUE_TICK_MS, () => tickDueRechecks(deps));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export interface BootIngestionDeps {
  config: Config;
  db: Db;
  log: Logger;
  events?: EventBus | undefined;
  scheduler: Pick<Scheduler, "every" | "enqueue">;
  registry?: JobRegistry;
  fetch?: FetchLike;
  now?: () => number;
  /** Shared RYD client; one is created (1 req/s) when absent. */
  ryd?: RydClient;
}

/**
 * Register the ingestion and recheck handlers, `action:ingest-now`, and the
 * schedules. Returns the budget hooks for bootScheduler (the scheduler is
 * already running by the time this boots, so the orchestrator passes them in
 * when it builds the scheduler).
 */
export function bootIngestion(deps: BootIngestionDeps): BudgetHooks {
  const registry = deps.registry ?? jobRegistry;
  const hooks = budgetHooks(deps);
  const base: IngestHandlerDeps & RecheckDeps = {
    config: deps.config,
    db: deps.db,
    log: deps.log,
    events: deps.events,
    registry,
    enqueue: (input) => deps.scheduler.enqueue(input),
    ryd:
      deps.ryd ??
      createRydClient({
        log: deps.log,
        ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      }),
    budgetOk: hooks.budgetOk,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  };
  registerIngestHandlers(registry, base);
  registerRecheckHandlers(registry, base);
  if (!registry.has(ACTION_INGEST_NOW)) {
    registry.register(ACTION_INGEST_NOW, {
      class: "maintenance",
      maxAttempts: 1,
      handler: async (ctx) => {
        const queued = ingestEverythingNow({ ...base, db: ctx.db });
        ctx.log.info({ queued }, "ingest-now queued every feed");
        await Promise.resolve();
      },
    });
  }
  registerIngestSchedules(deps.scheduler, base);
  deps.log.info("ingestion booted");
  return hooks;
}
