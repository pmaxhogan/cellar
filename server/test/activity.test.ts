import { resolveSettings } from "@cellar/shared";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getKv } from "../src/db/kv.ts";
import { Where } from "../src/db/paged.ts";
import {
  ACTIVITY_RETENTION_DAYS,
  dirSize,
  listActivity,
  logActivity,
  LOGS_RETENTION_JOB,
  registerLogsRetention,
  runLogsRetention,
} from "../src/domain/activity.ts";
import { VAPID_KV_KEY } from "../src/domain/notifications.ts";
import { EventBus, type CellarEvent } from "../src/events.ts";
import { bootScheduler } from "../src/jobs/boot.ts";
import { createJobLogger } from "../src/jobs/jobLog.ts";
import { JobRegistry, type JobContext } from "../src/jobs/types.ts";
import { baseLoggerOptions, createConsoleLogger } from "../src/logging.ts";
import { createTempDb, type TempDb } from "./helpers.ts";

const DAY = 24 * 60 * 60_000;

let temp: TempDb;
let events: EventBus;
let seen: CellarEvent[];

beforeEach(() => {
  temp = createTempDb();
  events = new EventBus();
  seen = [];
  events.subscribe((event) => seen.push(event));
});

afterEach(() => {
  temp.close();
});

describe("activity log", () => {
  it("inserts a row, publishes it and defaults the level to info", () => {
    const row = logActivity(
      { db: temp.db, events, now: () => 42 },
      { kind: "download", message: "Downloaded abc", videoId: "abc", data: { bytes: 5 } },
    );
    expect(row).toEqual({
      id: row.id,
      at: 42,
      level: "info",
      kind: "download",
      message: "Downloaded abc",
      video_id: "abc",
      job_id: null,
      data: { bytes: 5 },
    });
    expect(seen).toEqual([expect.objectContaining({ type: "activity", payload: row })]);
    // No bus is fine too.
    expect(logActivity({ db: temp.db }, { kind: "x", message: "y" }).data).toBeNull();
  });

  it("pages newest first and filters by level, kind and video", () => {
    const deps = { db: temp.db, now: () => 0 };
    let at = 0;
    deps.now = () => (at += 1);
    logActivity(deps, { kind: "download", message: "1", videoId: "a" });
    logActivity(deps, { kind: "download", message: "2", videoId: "b", level: "error" });
    logActivity(deps, { kind: "recheck", message: "3", videoId: "a", level: "warn" });
    temp.db.run(
      `INSERT INTO activity (at, level, kind, message, data_json) VALUES (0, 'info', 'k', 'bad', '{')`,
    );

    const all = listActivity(temp.db, { page: 1, perPage: 2 });
    expect(all.total).toBe(4);
    expect(all.rows.map((row) => row.message)).toEqual(["3", "2"]);
    expect(listActivity(temp.db, { page: 2, perPage: 2 }).rows.at(-1)?.data).toBeNull();
    expect(listActivity(temp.db, { page: 1, perPage: 9, level: "error" }).total).toBe(1);
    expect(listActivity(temp.db, { page: 1, perPage: 9, kind: "download" }).total).toBe(2);
    expect(listActivity(temp.db, { page: 1, perPage: 9, videoId: "a" }).total).toBe(2);
  });

  it("builds WHERE clauses from optional filters", () => {
    expect(new Where().sql).toBe("");
    const where = new Where().maybe("a = ?", undefined).maybe("b = ?", 2).add("c IS NULL");
    expect(where.sql).toBe("WHERE b = ? AND c IS NULL");
    expect(where.params).toEqual([2]);
  });
});

describe("log retention", () => {
  const now = 1_000 * DAY;
  let logsDir: string;

  function jobRow(status: string, finishedAt: number | null): number {
    return temp.db.run(
      "INSERT INTO jobs (type, status, finished_at, created_at) VALUES ('t', ?, ?, 1)",
      status,
      finishedAt,
    ).lastInsertRowid;
  }

  function jobDir(name: string, bytes: number): string {
    const dir = join(logsDir, "jobs", name);
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(join(dir, "job.log"), "x".repeat(bytes));
    writeFileSync(join(dir, "nested", "body.json.gz"), "");
    return dir;
  }

  beforeEach(() => {
    logsDir = join(temp.dir, "logs");
  });

  it("deletes activity older than 90 days and copes without a jobs dir", () => {
    const old = now - (ACTIVITY_RETENTION_DAYS + 1) * DAY;
    logActivity({ db: temp.db, now: () => old }, { kind: "k", message: "old" });
    logActivity({ db: temp.db, now: () => now - DAY }, { kind: "k", message: "recent" });
    const result = runLogsRetention({
      db: temp.db,
      logsDir,
      settings: resolveSettings({}),
      now: () => now,
    });
    expect(result).toEqual({ activityDeleted: 1, dirsDeleted: 0, bytesFreed: 0 });
    expect(listActivity(temp.db, { page: 1, perPage: 5 }).rows.map((r) => r.message)).toEqual([
      "recent",
    ]);
  });

  it("applies the age limits, keeps failed jobs longer and never touches active jobs", () => {
    const settings = resolveSettings({
      "logs.job_retention_days": 14,
      "logs.failed_job_retention_days": 60,
    });
    const oldDone = jobDir(String(jobRow("done", now - 15 * DAY)), 10);
    const freshDone = jobDir(String(jobRow("done", now - 13 * DAY)), 10);
    const oldFailed = jobDir(String(jobRow("failed", now - 61 * DAY)), 10);
    const keptFailed = jobDir(String(jobRow("failed", now - 30 * DAY)), 10);
    const running = jobDir(String(jobRow("running", null)), 10);
    const orphan = jobDir("999999", 10);
    const named = jobDir("not-a-job", 10);
    writeFileSync(join(logsDir, "jobs", "stray.txt"), "ignored");
    for (const dir of [running, orphan, named]) {
      const old = (now - 100 * DAY) / 1000;
      utimesSync(dir, old, old);
    }

    const result = runLogsRetention({ db: temp.db, logsDir, settings, now: () => now });
    expect(result.dirsDeleted).toBe(4);
    expect(result.bytesFreed).toBe(40);
    expect(existsSync(oldDone)).toBe(false);
    expect(existsSync(oldFailed)).toBe(false);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(named)).toBe(false);
    for (const dir of [freshDone, keptFailed, running]) {
      expect(existsSync(dir)).toBe(true);
    }
  });

  it("prunes the oldest dirs while the total is over the size cap", () => {
    // 1e-7 GiB is about 107 bytes.
    const settings = resolveSettings({ "logs.job_retention_gb": 1e-7 });
    const oldest = jobDir(String(jobRow("done", now - 3 * DAY)), 60);
    const middle = jobDir(String(jobRow("failed", now - 2 * DAY)), 60);
    const newest = jobDir(String(jobRow("done", now - DAY)), 40);
    const active = jobDir(String(jobRow("queued", null)), 200);

    const result = runLogsRetention({ db: temp.db, logsDir, settings, now: () => now });
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(middle)).toBe(false);
    // Still over the cap, but the only dir left is an active job's.
    expect(existsSync(newest)).toBe(false);
    expect(existsSync(active)).toBe(true);
    expect(result.dirsDeleted).toBe(3);
  });

  it("stops pruning once under the cap", () => {
    const settings = resolveSettings({ "logs.job_retention_gb": 1e-7 });
    const oldest = jobDir(String(jobRow("done", now - 3 * DAY)), 60);
    const newest = jobDir(String(jobRow("done", now - DAY)), 60);
    runLogsRetention({ db: temp.db, logsDir, settings, now: () => now });
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(newest)).toBe(true);
  });

  it("measures directories and treats missing ones as empty", () => {
    const dir = jobDir("1", 7);
    expect(dirSize(dir)).toBe(7);
    expect(dirSize(join(temp.dir, "missing"))).toBe(0);
  });

  it("registers a maintenance handler that runs the pass", async () => {
    const registry = new JobRegistry();
    registerLogsRetention(registry, { logsDir, getSettings: () => resolveSettings({}) });
    const registration = registry.get(LOGS_RETENTION_JOB);
    expect(registration?.class).toBe("maintenance");
    logActivity({ db: temp.db, now: () => 1 }, { kind: "k", message: "ancient" });
    await registration?.handler({
      db: temp.db,
      log: createConsoleLogger("silent"),
    } as unknown as JobContext);
    expect(listActivity(temp.db, { page: 1, perPage: 5 }).total).toBe(0);
  });
});

describe("job logger", () => {
  it("writes debug to job.log and the parent's level to the main stream", () => {
    const lines: string[] = [];
    const parent = pino(baseLoggerOptions("info"), {
      write(line: string) {
        lines.push(line);
      },
    });
    const file = join(temp.dir, "jobs", "1", "job.log");
    const { log, close } = createJobLogger(parent, file, { jobId: 1, type: "t" });
    log.debug("only in the file");
    log.info({ refresh_token: "tok" }, "in both");
    close();
    close();

    const content = readFileSync(file, "utf8");
    expect(content).toContain("only in the file");
    expect(content).toContain("in both");
    expect(content).not.toContain('tok"');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      msg: "in both",
      jobId: 1,
      mod: "jobs",
      refresh_token: "[redacted]",
    });
  });

  it("follows a trace-level parent and skips a silent one", () => {
    const lines: string[] = [];
    const parent = pino(baseLoggerOptions("trace"), {
      write(line: string) {
        lines.push(line);
      },
    });
    const traced = createJobLogger(parent, join(temp.dir, "a.log"), {});
    traced.log.trace("t");
    traced.close();
    expect(lines).toHaveLength(1);
    expect(readFileSync(join(temp.dir, "a.log"), "utf8")).toContain('"msg":"t"');

    const silent = createJobLogger(createConsoleLogger("silent"), join(temp.dir, "b.log"), {});
    silent.log.info("quiet main log");
    silent.close();
    expect(readFileSync(join(temp.dir, "b.log"), "utf8")).toContain("quiet main log");
  });
});

describe("bootScheduler", () => {
  it("registers built-ins, creates VAPID keys, schedules retention and stops on close", async () => {
    const hooks: (() => Promise<void>)[] = [];
    const registry = new JobRegistry();
    const scheduler = bootScheduler(
      {
        addHook: (_name, hook) => {
          hooks.push(hook);
        },
      },
      {
        config: { logsDir: join(temp.dir, "logs") },
        db: temp.db,
        log: createConsoleLogger("silent"),
        events,
        registry,
        tickMs: 0,
        budgetOk: () => true,
        canConsumeScrape: () => true,
        now: () => 5_000,
      },
    );
    try {
      expect(registry.has(LOGS_RETENTION_JOB)).toBe(true);
      expect(getKv(temp.db, VAPID_KV_KEY)).toMatchObject({ publicKey: expect.any(String) });
      await new Promise((resolve) => setImmediate(resolve));
      await scheduler.waitForIdle();
      const jobs = scheduler.queue.list({ page: 1, perPage: 5, type: LOGS_RETENTION_JOB });
      expect(jobs.rows.map((row) => row.status)).toEqual(["done"]);
      expect(scheduler.started).toBe(true);
    } finally {
      expect(hooks).toHaveLength(1);
      await hooks[0]?.();
    }
    expect(scheduler.started).toBe(false);

    // A second boot on the same registry does not re-register.
    const again = bootScheduler(
      { addHook: () => undefined },
      {
        config: { logsDir: join(temp.dir, "logs") },
        db: temp.db,
        log: createConsoleLogger("silent"),
        events,
        registry,
        tickMs: 0,
      },
    );
    await again.stop();
  });
});
