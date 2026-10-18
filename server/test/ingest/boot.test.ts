import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getKv } from "../../src/db/kv.ts";
import { updateSettings } from "../../src/domain/settings.ts";
import {
  ACCOUNT_FEEDS,
  bootIngestion,
  budgetHooks,
  budgetOk,
  canConsumeScrape,
  ingestEverythingNow,
  INGEST_LAST_KV_PREFIX,
  INGEST_TICK_MS,
  RECHECK_DUE_TICK_MS,
  tickAccountFeed,
  tickChannelBackfill,
  tickChannelUploads,
  tickDueRechecks,
  trackedChannelIds,
} from "../../src/jobs/ingestBoot.ts";
import { registerIngestHandlers } from "../../src/jobs/handlers/ingest.ts";
import { registerRecheckHandlers } from "../../src/jobs/handlers/recheck.ts";
import type { EnqueueInput } from "../../src/jobs/queue.ts";
import {
  ACTION_INGEST_NOW,
  ensureChannel,
  INGEST_CHANNEL_BACKFILL_JOB,
  INGEST_CHANNEL_UPLOADS_JOB,
  INGEST_HISTORY_JOB,
  INGEST_LIKED_JOB,
  INGEST_SUBSCRIPTIONS_JOB,
  INGEST_WATCH_LATER_JOB,
  RECHECK_BATCH_JOB,
  RECHECK_LEFTOVER_JOB,
  recordSighting,
} from "../../src/youtube/ingest.ts";
import { recordScrape } from "../../src/youtube/quota.ts";
import { DAY, IngestEnv, log, NOW, RICK, THREE_B1B } from "./ingestHelpers.ts";

let env: IngestEnv;
let schedules: { name: string; ms: number; fn: () => unknown }[];

function fakeScheduler() {
  return {
    every: (name: string, ms: number, fn: () => unknown) => {
      schedules.push({ name, ms, fn });
    },
    enqueue: (input: EnqueueInput) => env.queue.enqueue(input),
  };
}

function scheduleDeps() {
  return {
    db: env.db,
    now: () => env.now,
    enqueue: (input: EnqueueInput) => env.queue.enqueue(input),
  };
}

function feed(name: string) {
  return ACCOUNT_FEEDS.find((entry) => entry.name === name) as (typeof ACCOUNT_FEEDS)[number];
}

function track(channelId: string, kind: "subscription" | "manual", account: number | null): void {
  ensureChannel(env.db, { id: channelId }, NOW);
  env.db.run(
    "INSERT INTO channel_sources (channel_id, account_id, kind, created_at) VALUES (?, ?, ?, ?)",
    channelId,
    account,
    kind,
    NOW,
  );
}

beforeEach(async () => {
  env = await IngestEnv.create();
  schedules = [];
});

afterEach(() => {
  env.close();
});

describe("bootIngestion", () => {
  it("registers every handler with its class, the schedules, and returns the hooks", () => {
    const hooks = bootIngestion({
      config: env.config,
      db: env.db,
      log,
      events: env.events,
      scheduler: fakeScheduler(),
      registry: env.registry,
      fetch: env.fetch,
      now: () => env.now,
    });
    expect(
      Object.fromEntries(
        [
          INGEST_HISTORY_JOB,
          INGEST_WATCH_LATER_JOB,
          INGEST_LIKED_JOB,
          INGEST_SUBSCRIPTIONS_JOB,
          INGEST_CHANNEL_UPLOADS_JOB,
          INGEST_CHANNEL_BACKFILL_JOB,
          RECHECK_BATCH_JOB,
          RECHECK_LEFTOVER_JOB,
          "recheck_all",
          ACTION_INGEST_NOW,
        ].map((type) => [type, env.registry.classOf(type)]),
      ),
    ).toEqual({
      ingest_history: "io",
      ingest_watch_later: "io",
      ingest_liked: "io",
      ingest_subscriptions: "io",
      ingest_channel_uploads: "io",
      ingest_channel_backfill: "leftover",
      recheck_batch: "io",
      recheck_batch_leftover: "leftover",
      recheck_all: "maintenance",
      "action:ingest-now": "maintenance",
    });
    expect(schedules.map((s) => [s.name, s.ms])).toEqual([
      ["ingest:history", INGEST_TICK_MS],
      ["ingest:watch_later", INGEST_TICK_MS],
      ["ingest:liked", INGEST_TICK_MS],
      ["ingest:subscriptions", INGEST_TICK_MS],
      ["ingest:channel_uploads", INGEST_TICK_MS],
      ["ingest:channel_backfill", INGEST_TICK_MS],
      ["recheck:due", RECHECK_DUE_TICK_MS],
    ]);
    expect(hooks.budgetOk("io")).toBe(true);
    expect(hooks.canConsumeScrape(1, "maintenance")).toBe(true);

    // A second boot on the same registry does not throw.
    schedules = [];
    bootIngestion({
      config: env.config,
      db: env.db,
      log,
      scheduler: fakeScheduler(),
      registry: env.registry,
    });
    expect(schedules).toHaveLength(7);
  });

  it("the schedules queue jobs and ingest-now queues everything", async () => {
    bootIngestion({
      config: env.config,
      db: env.db,
      log,
      scheduler: fakeScheduler(),
      registry: env.registry,
      now: () => env.now,
    });
    const account = env.account();
    for (const schedule of schedules) {
      schedule.fn();
    }
    expect(env.jobs().map((job) => job.type)).toEqual([
      INGEST_HISTORY_JOB,
      INGEST_WATCH_LATER_JOB,
      INGEST_LIKED_JOB,
      INGEST_SUBSCRIPTIONS_JOB,
    ]);
    const history = env.db.get(
      "SELECT account_id, payload_json FROM jobs WHERE type = ?",
      INGEST_HISTORY_JOB,
    );
    expect(history).toEqual({ account_id: account, payload_json: "{}" });
    const liked = env.db.get(
      "SELECT account_id, payload_json FROM jobs WHERE type = ?",
      INGEST_LIKED_JOB,
    );
    expect(liked).toEqual({
      account_id: null,
      payload_json: JSON.stringify({ account_id: account }),
    });

    env.db.run("DELETE FROM jobs");
    const action = env.registry.get(ACTION_INGEST_NOW)?.handler;
    await action?.(env.ctx(ACTION_INGEST_NOW));
    expect(env.jobs()).toHaveLength(4);
  });
});

describe("feed ticks", () => {
  beforeEach(() => {
    // The production dedupe keys come with the handlers.
    registerIngestHandlers(env.registry, env.deps());
    registerRecheckHandlers(env.registry, env.deps());
  });

  it("queues each account once per interval and picks up new accounts and settings", () => {
    const deps = scheduleDeps();
    const a = env.account();
    const apiOnly = env.account({ cookies: false });
    expect(tickAccountFeed(deps, feed("history"))).toBe(1);
    expect(tickAccountFeed(deps, feed("liked"))).toBe(2);
    expect(tickAccountFeed(deps, feed("history"))).toBe(0);
    expect(getKv(env.db, `${INGEST_LAST_KV_PREFIX}history:${String(a)}`)).toBe(NOW);

    const b = env.account();
    expect(tickAccountFeed(deps, feed("history"))).toBe(1);
    env.now += 29 * 60_000;
    expect(tickAccountFeed(deps, feed("history"))).toBe(0);
    updateSettings(env.db, { "ingest.history_minutes": 10 });
    expect(tickAccountFeed(deps, feed("history"))).toBe(2);
    expect(tickAccountFeed(deps, feed("history"), true)).toBe(2);

    env.now += 6 * 60 * 60_000;
    expect(tickAccountFeed(deps, feed("subscriptions"))).toBe(3);
    expect(env.jobs(INGEST_SUBSCRIPTIONS_JOB).map((job) => job.payload)).toEqual([
      { account_id: a },
      { account_id: apiOnly },
      { account_id: b },
    ]);
  });

  it("queues uploads for every tracked channel and backfill for manual channels", () => {
    const deps = scheduleDeps();
    const account = env.account();
    track(THREE_B1B, "subscription", account);
    track(RICK, "manual", null);
    expect(trackedChannelIds(env.db)).toEqual([THREE_B1B, RICK]);
    expect(tickChannelUploads(deps)).toBe(2);
    expect(tickChannelUploads(deps)).toBe(0);
    env.now += 30 * 60_000;
    expect(tickChannelUploads(deps)).toBe(2);
    // Deduped per channel while the first jobs are still queued.
    expect(env.jobs(INGEST_CHANNEL_UPLOADS_JOB)).toHaveLength(2);

    expect(tickChannelBackfill(deps)).toBe(1);
    expect(env.jobs(INGEST_CHANNEL_BACKFILL_JOB)[0]?.payload).toEqual({ channel_id: RICK });
    expect(tickChannelBackfill(deps)).toBe(0);
    expect(tickChannelBackfill(deps, true)).toBe(1);
  });

  it("queues due rechecks per class only when something is due", () => {
    const deps = scheduleDeps();
    expect(tickDueRechecks(deps)).toBe(0);
    for (const [id, pri] of [
      ["dQw4w9WgXcQ", 1],
      ["jNQXAC9IVRw", 0],
    ] as const) {
      recordSighting(env.db, { videoId: id, channelId: null, fill: {}, sources: [] }, NOW);
      env.db.run(
        `INSERT INTO video_effective (video_id, effective_json, provenance_json, matched_rule_ids,
                                      evaluated_at, reclaim_priority, include)
         VALUES (?, '{}', '{}', '[]', ?, ?, 1)`,
        id,
        NOW,
        pri,
      );
    }
    expect(tickDueRechecks(deps)).toBe(2);
    expect(env.jobs(RECHECK_BATCH_JOB)[0]?.payload).toEqual({ due: true, limit: 200 });
    expect(env.jobs(RECHECK_LEFTOVER_JOB)[0]?.payload).toEqual({ due: true, limit: 200 });
    env.db.run("UPDATE videos SET next_recheck_at = ?", NOW + DAY);
    expect(tickDueRechecks(deps)).toBe(0);
    expect(ingestEverythingNow(deps)).toBe(0);
  });
});

describe("budget hooks", () => {
  it("holds the leftover class from 80% of the daily API units", () => {
    const deps = { db: env.db, now: () => env.now };
    const day = new Date(NOW).toISOString().slice(0, 10);
    expect(budgetOk(deps, "leftover")).toBe(true);
    env.db.run("INSERT INTO quota_usage (account_id, day, api_units) VALUES (0, ?, 7999)", day);
    expect(budgetOk(deps, "leftover")).toBe(true);
    env.db.run("UPDATE quota_usage SET api_units = 8000");
    expect(budgetOk(deps, "leftover")).toBe(false);
    expect(budgetOk(deps, "io")).toBe(true);
    expect(budgetOk(deps, "download")).toBe(true);
    expect(budgetHooks(deps).budgetOk("leftover")).toBe(false);
  });

  it("holds an account's io and download jobs once its scrape budget is spent", () => {
    const deps = { db: env.db, now: () => env.now };
    const account = env.account();
    updateSettings(env.db, { "quota.scrape_requests_per_hour": 2 });
    expect(canConsumeScrape(deps, account, "io")).toBe(true);
    recordScrape(deps, account);
    recordScrape(deps, account);
    expect(canConsumeScrape(deps, account, "io")).toBe(false);
    expect(canConsumeScrape(deps, account, "download")).toBe(false);
    expect(canConsumeScrape(deps, account, "maintenance")).toBe(true);
    expect(canConsumeScrape(deps, account, "leftover")).toBe(true);
    expect(budgetHooks(deps).canConsumeScrape(account, "io")).toBe(false);
    env.now += 60 * 60_000;
    expect(canConsumeScrape(deps, account, "io")).toBe(true);
  });
});
