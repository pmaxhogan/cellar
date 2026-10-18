import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StatsDailyPoint } from "@cellar/shared";
import type { Db } from "../src/db/db.ts";
import {
  addDays,
  backfill,
  daySpan,
  hasRollup,
  readDaily,
  readSummary,
  resolveWindow,
  rollupDaily,
  rollupWithBackfill,
  statsLocations,
  utcDay,
} from "../src/domain/stats.ts";
import {
  nextRollupAt,
  registerStatsRollup,
  runStatsRollupJob,
  scheduleStatsRollup,
  STATS_ROLLUP_JOB,
} from "../src/jobs/handlers/statsRollup.ts";
import { JobQueue } from "../src/jobs/queue.ts";
import { JobRegistry, type JobContext, type JobRecord } from "../src/jobs/types.ts";
import { createConsoleLogger } from "../src/logging.ts";
import { createTempDb, type TempDb } from "./helpers.ts";
import { seedLocation, seedMedia, seedVideo, vid } from "./videoSeed.ts";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 18, 12);
const TODAY = "2026-10-18";
const at = (day: string, hour = 0): number => Date.parse(`${day}T00:00:00Z`) + hour * HOUR;

let temp: TempDb;
let db: Db;
/** The migration seeds location 1 ("media", enabled). */
const MEDIA = 1;
let second: number;
let cold: number;

function seedQuota(accountId: number, day: string, units: number): void {
  db.run(
    "INSERT INTO quota_usage (account_id, day, api_units) VALUES (?, ?, ?)",
    accountId,
    day,
    units,
  );
}

/**
 * Four videos, five media rows (an older version, captions with no location,
 * a file on a disabled location) and quota rows for two days.
 */
function seedCatalog(): void {
  second = seedLocation(db, "second", "/media2");
  cold = seedLocation(db, "cold", "/media3");
  db.run("UPDATE locations SET enabled = 0 WHERE id = ?", cold);

  seedVideo(db, { id: vid("v1"), created_at: at("2026-10-10") });
  seedVideo(db, { id: vid("v2"), created_at: at("2026-10-17") });
  seedVideo(db, { id: vid("v3"), created_at: at(TODAY, 2), gone_since: at(TODAY, 8) });
  seedVideo(db, { id: vid("v4"), created_at: at("2026-10-01"), gone_since: at("2026-10-16") });

  seedMedia(db, {
    video_id: vid("v1"),
    kind: "video",
    rel_path: "v1.v2.mkv",
    version: 2,
    location_id: MEDIA,
    size_bytes: 1000,
    downloaded_at: at(TODAY, 1),
    created_at: at(TODAY, 1),
  });
  seedMedia(db, {
    video_id: vid("v1"),
    kind: "video",
    rel_path: "v1.v1.mkv",
    version: 1,
    is_current: 0,
    location_id: MEDIA,
    size_bytes: 400,
    downloaded_at: at("2026-10-10"),
    created_at: at("2026-10-10"),
  });
  seedMedia(db, {
    video_id: vid("v2"),
    kind: "audio",
    rel_path: "v2.m4a",
    location_id: second,
    size_bytes: 300,
    downloaded_at: at("2026-10-17", 5),
    created_at: at("2026-10-17", 5),
  });
  seedMedia(db, {
    video_id: vid("v2"),
    kind: "captions",
    rel_path: "v2.en.vtt",
    location_id: null,
    size_bytes: 50,
    downloaded_at: at("2026-10-17", 5),
    created_at: at("2026-10-17", 5),
  });
  seedMedia(db, {
    video_id: vid("v4"),
    kind: "video",
    rel_path: "v4.mkv",
    location_id: cold,
    size_bytes: 2000,
    downloaded_at: at("2026-10-01"),
    created_at: at("2026-10-01"),
  });

  seedQuota(0, TODAY, 120);
  seedQuota(1, TODAY, 120);
  seedQuota(0, "2026-10-17", 55);
  // An hour row of the scrape budget never counts as a day.
  seedQuota(0, `${TODAY}T05`, 9);
}

function row(day: string, locationId: number): StatsDailyPoint | undefined {
  return db.get<StatsDailyPoint>(
    `SELECT day, location_id, bytes_used, downloads, catalog, gone, api_units
     FROM stats_daily WHERE day = ? AND location_id = ?`,
    day,
    locationId,
  );
}

function rowCount(): number {
  return db.get<{ n: number }>("SELECT COUNT(*) AS n FROM stats_daily")?.n ?? 0;
}

beforeEach(() => {
  temp = createTempDb();
  db = temp.db;
});

afterEach(() => {
  temp.close();
});

describe("day helpers", () => {
  it("formats, offsets and spans UTC days", () => {
    expect(utcDay(at(TODAY, 23) + HOUR - 1)).toBe(TODAY);
    expect(addDays(TODAY, -1)).toBe("2026-10-17");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(daySpan("2026-10-01", "2026-10-01")).toBe(1);
    expect(daySpan("2026-10-01", TODAY)).toBe(18);
  });

  it("defaults the window to the 90 days ending today", () => {
    expect(resolveWindow({ now: NOW })).toEqual({ from: "2026-07-21", to: TODAY });
    expect(daySpan("2026-07-21", TODAY)).toBe(90);
    expect(resolveWindow({ to: "2026-10-01", now: NOW })).toEqual({
      from: "2026-07-04",
      to: "2026-10-01",
    });
    expect(resolveWindow({ from: "2026-10-10", now: NOW })).toEqual({
      from: "2026-10-10",
      to: TODAY,
    });
  });

  it("rejects an inverted or too wide window", () => {
    expect(() => resolveWindow({ from: TODAY, to: "2026-10-01", now: NOW })).toThrow(/after/);
    expect(() => resolveWindow({ from: "2025-01-01", to: TODAY, now: NOW })).toThrow(/at most/);
  });
});

describe("rollupDaily", () => {
  beforeEach(seedCatalog);

  it("computes today's all-locations row and one row per enabled location", () => {
    const points = rollupDaily(db, { now: NOW });
    expect(points.map((point) => point.location_id)).toEqual([0, MEDIA, second]);
    // Current and older versions on every location count, captions (no location) do not.
    expect(row(TODAY, 0)).toEqual({
      day: TODAY,
      location_id: 0,
      bytes_used: 3700,
      downloads: 1,
      catalog: 4,
      gone: 2,
      api_units: 120,
    });
    expect(row(TODAY, MEDIA)).toEqual({
      day: TODAY,
      location_id: MEDIA,
      bytes_used: 1400,
      downloads: 1,
      catalog: 1,
      gone: 0,
      api_units: 0,
    });
    expect(row(TODAY, second)).toMatchObject({ bytes_used: 300, downloads: 0, catalog: 1 });
    expect(row(TODAY, cold)).toBeUndefined();
    expect(hasRollup(db, TODAY)).toBe(true);
  });

  it("rebuilds a past day from the timestamps the catalog keeps", () => {
    rollupDaily(db, { day: "2026-10-17", now: NOW });
    expect(row("2026-10-17", 0)).toEqual({
      day: "2026-10-17",
      location_id: 0,
      bytes_used: 2700,
      downloads: 1,
      catalog: 3,
      gone: 1,
      api_units: 55,
    });
    expect(row("2026-10-17", second)).toMatchObject({ bytes_used: 300, downloads: 1 });
    expect(row("2026-10-17", MEDIA)).toMatchObject({ bytes_used: 400, catalog: 0 });
  });

  it("is idempotent", () => {
    rollupDaily(db, { now: NOW });
    const first = readDaily(db, { from: TODAY, to: TODAY, location_id: "all" });
    rollupDaily(db, { now: NOW });
    expect(readDaily(db, { from: TODAY, to: TODAY, location_id: "all" })).toEqual(first);
    expect(rowCount()).toBe(3);
  });

  it("always refreshes today's bytes but keeps a past day's snapshot", () => {
    db.run(
      `INSERT INTO stats_daily (day, location_id, bytes_used, downloads, catalog, gone, api_units)
       VALUES (?, 0, 5, 5, 5, 5, 5), ('2026-10-17', 0, 9999, 42, 42, 42, 42)`,
      TODAY,
    );
    rollupDaily(db, { now: NOW });
    rollupDaily(db, { day: "2026-10-17", now: NOW });
    expect(row(TODAY, 0)?.bytes_used).toBe(3700);
    expect(row("2026-10-17", 0)).toEqual({
      day: "2026-10-17",
      location_id: 0,
      bytes_used: 9999,
      downloads: 1,
      catalog: 3,
      gone: 1,
      api_units: 55,
    });
  });

  it("refuses a day that has not started", () => {
    expect(() => rollupDaily(db, { day: "2026-10-19", now: NOW })).toThrow(/not started/);
  });
});

describe("backfill", () => {
  beforeEach(seedCatalog);

  it("recomputes exactly the whole days before today", () => {
    const result = backfill(db, { days: 3, now: NOW });
    expect(result).toEqual({ points: 9, from: "2026-10-15", to: "2026-10-17" });
    const days = db
      .all<{ day: string }>("SELECT DISTINCT day FROM stats_daily ORDER BY day")
      .map((entry) => entry.day);
    expect(days).toEqual(["2026-10-15", "2026-10-16", "2026-10-17"]);
    expect(row("2026-10-15", 0)).toMatchObject({ catalog: 2, gone: 0 });
    expect(row("2026-10-16", 0)).toMatchObject({ catalog: 2, gone: 1 });
  });

  it("converges when repeated and does nothing for zero days", () => {
    backfill(db, { days: 2, now: NOW });
    const first = readDaily(db, { from: "2026-10-01", to: TODAY, location_id: "all" });
    backfill(db, { days: 2, now: NOW });
    expect(readDaily(db, { from: "2026-10-01", to: TODAY, location_id: "all" })).toEqual(first);
    expect(backfill(db, { days: 0, now: NOW })).toEqual({ points: 0, from: TODAY, to: TODAY });
  });

  it("rolls up today on top of the backfill", () => {
    expect(rollupWithBackfill(db, { days: 7, now: NOW })).toEqual({
      points: 24,
      from: "2026-10-11",
      to: TODAY,
    });
    expect(hasRollup(db, TODAY)).toBe(true);
  });
});

describe("readDaily and readSummary", () => {
  beforeEach(() => {
    seedCatalog();
    backfill(db, { days: 2, now: NOW });
    rollupDaily(db, { now: NOW });
  });

  it("filters by window and location", () => {
    const allRows = readDaily(db, { from: "2026-10-16", to: TODAY });
    expect(allRows.map((point) => [point.day, point.location_id])).toEqual([
      ["2026-10-16", 0],
      ["2026-10-17", 0],
      [TODAY, 0],
    ]);
    expect(readDaily(db, { from: TODAY, to: TODAY, location_id: second })).toHaveLength(1);
    expect(readDaily(db, { from: "2026-10-17", to: TODAY, location_id: "all" })).toHaveLength(6);
    expect(readDaily(db, { from: "2026-01-01", to: "2026-01-31" })).toEqual([]);
  });

  it("labels every location, enabled or not", () => {
    expect(statsLocations(db)).toEqual([
      { id: MEDIA, label: "media" },
      { id: second, label: "second" },
      { id: cold, label: "cold" },
    ]);
  });

  it("reads the summary tiles live", () => {
    expect(readSummary(db, { now: NOW, budget: 10_000 })).toEqual({
      videos: 4,
      downloaded: 3,
      gone: 2,
      bytes_by_location: [
        { id: MEDIA, label: "media", enabled: true, bytes_used: 1400, quota_bytes: 0 },
        { id: second, label: "second", enabled: true, bytes_used: 300, quota_bytes: 0 },
        { id: cold, label: "cold", enabled: false, bytes_used: 2000, quota_bytes: 0 },
      ],
      api_units_today: 120,
      api_units_budget: 10_000,
      downloads_7d: 2,
      downloads_30d: 3,
    });
  });
});

describe("stats_rollup job", () => {
  function makeCtx(queue: JobQueue, payload: unknown): JobContext {
    const { id } = queue.enqueue({ type: STATS_ROLLUP_JOB, payload });
    const job = queue.get(id) as JobRecord;
    const logDir = join(temp.dir, "logs", String(id));
    mkdirSync(logDir, { recursive: true });
    return {
      job,
      db,
      log: createConsoleLogger("silent"),
      logDir,
      signal: new AbortController().signal,
      progress: () => undefined,
      checkpoint: () => undefined,
    };
  }

  it("finds the next 00:10 UTC", () => {
    expect(nextRollupAt(at(TODAY) + 5 * 60_000)).toBe(at(TODAY) + 10 * 60_000);
    expect(nextRollupAt(at(TODAY) + 10 * 60_000)).toBe(at("2026-10-19") + 10 * 60_000);
    expect(nextRollupAt(NOW)).toBe(at("2026-10-19") + 10 * 60_000);
  });

  it("registers a maintenance handler that rolls up and logs an activity", async () => {
    seedCatalog();
    const registry = new JobRegistry();
    registerStatsRollup(registry, { db, now: () => NOW });
    expect(registry.classOf(STATS_ROLLUP_JOB)).toBe("maintenance");
    const queue = new JobQueue(db, { registry, now: () => NOW });
    const ctx = makeCtx(queue, { trigger: "boot" });
    await registry.get(STATS_ROLLUP_JOB)?.handler(ctx);

    expect(db.all("SELECT DISTINCT day FROM stats_daily ORDER BY day")).toEqual([
      { day: "2026-10-16" },
      { day: "2026-10-17" },
      { day: TODAY },
    ]);
    const activity = db.get<{ kind: string; message: string; job_id: number; data_json: string }>(
      "SELECT kind, message, job_id, data_json FROM activity",
    );
    expect(activity?.kind).toBe("stats.rollup");
    expect(activity?.message).toBe("Daily statistics rolled up (9 points)");
    expect(activity?.job_id).toBe(ctx.job.id);
    expect(JSON.parse(activity?.data_json ?? "{}")).toMatchObject({
      trigger: "boot",
      from: "2026-10-16",
      to: TODAY,
      catalog: 4,
      bytes_used: 3700,
    });
  });

  it("finalises yesterday's storage figure only on a timely daily run", async () => {
    seedCatalog();
    const yesterday = "2026-10-17";
    const queue = new JobQueue(db, { registry: new JobRegistry() });
    const run = async (trigger: string, now: number): Promise<number | undefined> => {
      db.run(
        `INSERT INTO stats_daily (day, location_id, bytes_used) VALUES (?, 0, 9999)
         ON CONFLICT (day, location_id) DO UPDATE SET bytes_used = 9999`,
        yesterday,
      );
      await runStatsRollupJob({ db, now: () => now }, makeCtx(queue, { trigger }));
      return row(yesterday, 0)?.bytes_used;
    };
    const justAfterMidnight = at(TODAY) + 12 * 60_000;
    // Yesterday's files: the older v1 version, v2's audio and v4 on the disabled location.
    expect(await run("daily", justAfterMidnight)).toBe(2700);
    expect(await run("boot", justAfterMidnight)).toBe(9999);
    expect(await run("daily", NOW)).toBe(9999);
  });

  it("treats an unknown payload as the daily trigger", async () => {
    const queue = new JobQueue(db, { registry: new JobRegistry() });
    await runStatsRollupJob({ db, now: () => NOW }, makeCtx(queue, null));
    const data = db.get<{ data_json: string }>("SELECT data_json FROM activity");
    expect(JSON.parse(data?.data_json ?? "{}")).toMatchObject({ trigger: "daily" });
  });

  it("dedupes boot and daily runs separately", () => {
    const registry = new JobRegistry();
    registerStatsRollup(registry, { db });
    const queue = new JobQueue(db, { registry });
    const boot = queue.enqueue({
      type: STATS_ROLLUP_JOB,
      payload: { trigger: "boot" },
      dedupe: true,
    });
    const daily = queue.enqueue({
      type: STATS_ROLLUP_JOB,
      payload: { trigger: "daily" },
      dedupe: true,
    });
    const again = queue.enqueue({
      type: STATS_ROLLUP_JOB,
      payload: { trigger: "daily" },
      dedupe: true,
    });
    expect(boot.id).not.toBe(daily.id);
    expect(again).toEqual({ id: daily.id, deduped: true });
  });

  it("schedules a daily run and an immediate one only when today is missing", () => {
    const every: { name: string; ms: number; fn: () => unknown }[] = [];
    const enqueued: unknown[] = [];
    const scheduler = {
      every: (name: string, ms: number, fn: () => unknown) => {
        every.push({ name, ms, fn });
      },
      enqueue: (input: unknown) => {
        enqueued.push(input);
        return { id: enqueued.length, deduped: false };
      },
    };

    expect(scheduleStatsRollup(scheduler, { db, now: () => NOW })).toBe(true);
    expect(every).toHaveLength(1);
    expect(every[0]).toMatchObject({ name: STATS_ROLLUP_JOB, ms: 86_400_000 });
    expect(enqueued).toEqual([
      { type: STATS_ROLLUP_JOB, payload: { trigger: "boot" }, dedupe: true },
    ]);
    every[0]?.fn();
    expect(enqueued[1]).toEqual({
      type: STATS_ROLLUP_JOB,
      payload: { trigger: "daily" },
      runAfter: at("2026-10-19") + 10 * 60_000,
      dedupe: true,
    });

    rollupDaily(db, { now: NOW });
    const later = { ...scheduler, every: () => undefined };
    enqueued.length = 0;
    expect(scheduleStatsRollup(later, { db, now: () => NOW })).toBe(false);
    expect(enqueued).toEqual([]);
  });
});
