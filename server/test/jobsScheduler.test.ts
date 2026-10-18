import { resolveSettings, type ResolvedSettings } from "@cellar/shared";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.ts";
import { getKv } from "../src/db/kv.ts";
import { listActivity } from "../src/domain/activity.ts";
import { EventBus, type CellarEvent } from "../src/events.ts";
import { createConsoleLogger } from "../src/logging.ts";
import { Scheduler, SCHEDULE_KV_PREFIX, type SchedulerDeps } from "../src/jobs/scheduler.ts";
import {
  JobAbortedError,
  JobRegistry,
  type JobClass,
  type JobContext,
  type JobHandler,
} from "../src/jobs/types.ts";
import { createTempDb, type TempDb } from "./helpers.ts";

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued microtasks and promise continuations run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function addAccount(db: Db, label: string): number {
  return db.run("INSERT INTO accounts (label, created_at, updated_at) VALUES (?, 1, 1)", label)
    .lastInsertRowid;
}

let temp: TempDb;
let registry: JobRegistry;
let events: EventBus;
let seen: CellarEvent[];
let clock: number;
let settings: ResolvedSettings;
let scheduler: Scheduler | undefined;

function makeScheduler(extra: Partial<SchedulerDeps> = {}): Scheduler {
  scheduler = new Scheduler({
    db: temp.db,
    log: createConsoleLogger("silent"),
    events,
    logsDir: join(temp.dir, "logs"),
    registry,
    getSettings: () => settings,
    now: () => clock,
    random: () => 0,
    tickMs: 0,
    pumpOnEnqueue: false,
    ...extra,
  });
  return scheduler;
}

/** A handler that blocks until released, recording which jobs started. */
function gate(): { handler: JobHandler; started: number[]; release(id: number): void } {
  const waits = new Map<number, Deferred>();
  const started: number[] = [];
  return {
    started,
    handler: async (ctx) => {
      started.push(ctx.job.id);
      const wait = deferred();
      waits.set(ctx.job.id, wait);
      await wait.promise;
    },
    release(id) {
      waits.get(id)?.resolve();
    },
  };
}

beforeEach(() => {
  temp = createTempDb();
  registry = new JobRegistry();
  events = new EventBus();
  seen = [];
  events.subscribe((event) => seen.push(event));
  clock = 10_000_000;
  settings = resolveSettings({});
});

afterEach(async () => {
  await scheduler?.stop();
  scheduler = undefined;
  temp.close();
});

describe("running a job", () => {
  it("runs a handler to done with a job log, progress and lifecycle events", async () => {
    const contexts: JobContext[] = [];
    registry.register("work", {
      class: "io",
      handler: async (ctx) => {
        contexts.push(ctx);
        ctx.log.info({ cookie: "SID=secret" }, "hello from the job");
        ctx.log.debug("debug detail");
        ctx.progress(10, "starting");
        ctx.progress(20);
        clock += 600;
        ctx.progress(150, "done");
        ctx.checkpoint();
        await Promise.resolve();
      },
    });
    const s = makeScheduler();
    s.start();
    const { id } = s.enqueue({ type: "work", videoId: "vid", payload: { a: 1 } });
    s.tick();
    await s.waitForIdle();

    expect(s.queue.get(id)?.status).toBe("done");
    const ctx = contexts[0] as JobContext;
    expect(ctx.job).toMatchObject({ id, payload: { a: 1 }, attempts: 1 });
    expect(ctx.logDir).toBe(join(temp.dir, "logs", "jobs", String(id)));
    expect(s.queue.get(id)?.logDir).toBe(ctx.logDir);

    const log = readFileSync(join(ctx.logDir, "job.log"), "utf8");
    expect(log).toContain("hello from the job");
    expect(log).toContain("debug detail");
    expect(log).toContain('"jobId":' + String(id));
    expect(log).toContain("[redacted]");
    expect(log).not.toContain("SID=secret");

    const types = seen.map((event) => event.type);
    expect(types).toEqual([
      "job.queued",
      "job.started",
      "job.progress",
      "job.progress",
      "job.done",
    ]);
    const progress = seen.filter((event) => event.type === "job.progress");
    expect(progress.map((event) => event.payload["pct"])).toEqual([10, 100]);
    expect(progress[0]?.payload).toMatchObject({ id, videoId: "vid", message: "starting" });
    expect(progress[1]?.payload).toMatchObject({ message: "done" });
  });

  it("starts queued work without waiting for a tick when pumpOnEnqueue is on", async () => {
    const ran: number[] = [];
    registry.register("work", {
      class: "io",
      handler: async (ctx) => {
        ran.push(ctx.job.id);
        await Promise.resolve();
      },
    });
    const s = makeScheduler({ pumpOnEnqueue: true });
    s.start();
    const a = s.enqueue({ type: "work" }).id;
    const b = s.enqueue({ type: "work" }).id;
    await flush();
    await s.waitForIdle();
    expect(ran.sort()).toEqual([a, b]);
  });

  it("fails the job when its log dir cannot be created", async () => {
    registry.register("work", { class: "io", handler: async () => {}, maxAttempts: 1 });
    writeFileSync(join(temp.dir, "logs"), "a file where a dir should be");
    const s = makeScheduler();
    s.start();
    const { id } = s.enqueue({ type: "work" });
    s.tick();
    await s.waitForIdle();
    expect(s.queue.get(id)?.status).toBe("failed");
  });

  it("requeues jobs a crash left running when it starts", async () => {
    const ran: number[] = [];
    registry.register("work", {
      class: "io",
      handler: async (ctx) => {
        ran.push(ctx.job.attempts);
        await Promise.resolve();
      },
    });
    temp.db.run(
      `INSERT INTO jobs (type, status, attempts, started_at, created_at)
       VALUES ('work', 'running', 1, 5, 5)`,
    );
    const s = makeScheduler();
    s.start();
    await s.waitForIdle();
    expect(ran).toEqual([2]);
    s.start(); // idempotent
  });

  it("records failures in the activity log and retries with backoff", async () => {
    registry.register("flaky", {
      class: "io",
      maxAttempts: 2,
      handler: async () => {
        await Promise.resolve();
        throw new Error("upstream said no");
      },
    });
    registry.register("thrower", {
      class: "io",
      maxAttempts: 1,
      handler: () => Promise.reject(new Error("")),
    });
    const s = makeScheduler();
    s.start();
    const { id } = s.enqueue({ type: "flaky", videoId: "v1" });
    s.tick();
    await s.waitForIdle();
    expect(s.queue.get(id)).toMatchObject({ status: "queued", runAfter: clock + 30_000 });

    clock += 30_000;
    s.tick();
    await s.waitForIdle();
    expect(s.queue.get(id)).toMatchObject({ status: "failed", error: "upstream said no" });

    const other = s.enqueue({ type: "thrower" }).id;
    s.tick();
    await s.waitForIdle();
    expect(s.queue.get(other)?.error).toBe("Error");

    const activity = listActivity(temp.db, { page: 1, perPage: 10 }).rows;
    expect(activity.map((row) => [row.level, row.kind])).toEqual([
      ["error", "job.failed"],
      ["error", "job.failed"],
      ["warn", "job.retry"],
    ]);
    expect(activity[1]).toMatchObject({ video_id: "v1", job_id: id });
    expect(activity[1]?.message).toContain("after 2 attempts: upstream said no");
  });
});

describe("worker pools", () => {
  it("caps each class at its concurrency and refills as jobs finish", async () => {
    const downloads = gate();
    const ios = gate();
    const maint = gate();
    registry.register("download", { class: "download", handler: downloads.handler });
    registry.register("io", { class: "io", handler: ios.handler });
    registry.register("maint", { class: "maintenance", handler: maint.handler });
    settings = resolveSettings({ "download.concurrency": 2 });

    const s = makeScheduler();
    s.start();
    const d = [1, 2, 3].map((n) => s.enqueue({ type: "download", videoId: `v${String(n)}` }).id);
    for (let i = 0; i < 6; i += 1) {
      s.enqueue({ type: "io" });
    }
    s.enqueue({ type: "maint" });
    s.enqueue({ type: "maint" });
    s.tick();
    await flush();

    expect(downloads.started).toEqual([d[0], d[1]]);
    expect(ios.started).toHaveLength(4);
    expect(maint.started).toHaveLength(1);
    expect(s.status()).toMatchObject({
      running: { io: 4, download: 2, transcode: 0, maintenance: 1, leftover: 0 },
      queuedDue: 4,
    });
    expect(s.runningIds()).toHaveLength(7);

    downloads.release(d[0] as number);
    await flush();
    expect(downloads.started).toEqual(d);

    for (const id of [...ios.started, ...maint.started, ...downloads.started]) {
      ios.release(id);
      maint.release(id);
      downloads.release(id);
    }
    await flush();
    for (const id of [...ios.started, ...maint.started]) {
      ios.release(id);
      maint.release(id);
    }
    await s.waitForIdle();
    expect(s.status().queuedDue).toBe(0);
  });

  it("holds the transcode pool to transcode.concurrency", async () => {
    const work = gate();
    registry.register("transcode", { class: "transcode", handler: work.handler });
    settings = resolveSettings({ "transcode.concurrency": 1 });
    const s = makeScheduler();
    s.start();
    s.enqueue({ type: "transcode", videoId: "a" });
    s.enqueue({ type: "transcode", videoId: "b" });
    s.tick();
    await flush();
    expect(work.started).toHaveLength(1);
    work.release(work.started[0] as number);
    await flush();
    expect(work.started).toHaveLength(2);
    work.release(work.started[1] as number);
    await s.waitForIdle();
  });

  it("runs leftover work only while the budget gate allows it", async () => {
    let budget = false;
    const calls: JobClass[] = [];
    registry.register("pri0", { class: "leftover", handler: async () => {} });
    const s = makeScheduler({
      budgetOk: (cls) => {
        calls.push(cls);
        return cls !== "leftover" || budget;
      },
    });
    s.start();
    const { id } = s.enqueue({ type: "pri0" });
    s.tick();
    await s.waitForIdle();
    expect(s.queue.get(id)?.status).toBe("queued");
    expect(calls).toContain("leftover");

    budget = true;
    s.tick();
    await s.waitForIdle();
    expect(s.queue.get(id)?.status).toBe("done");
  });
});

describe("per-account gates", () => {
  it("keeps the download gap per account and lets other accounts run", async () => {
    const work = gate();
    registry.register("download", { class: "download", handler: work.handler });
    settings = resolveSettings({ "download.concurrency": 4, "download.account_gap_seconds": 30 });
    const a = addAccount(temp.db, "a");
    const b = addAccount(temp.db, "b");

    const s = makeScheduler();
    s.start();
    const a1 = s.enqueue({ type: "download", videoId: "a1", accountId: a }).id;
    const a2 = s.enqueue({ type: "download", videoId: "a2", accountId: a }).id;
    const b1 = s.enqueue({ type: "download", videoId: "b1", accountId: b }).id;
    const free = s.enqueue({ type: "download", videoId: "free" }).id;
    s.tick();
    await flush();
    // One download per account at a time; account-less work is not gated.
    expect(work.started.sort()).toEqual([a1, b1, free].sort());

    work.release(a1);
    await flush();
    expect(s.queue.get(a1)?.status).toBe("done");
    expect(work.started).not.toContain(a2);

    clock += 29_000;
    s.tick();
    await flush();
    expect(work.started).not.toContain(a2);

    clock += 1000;
    s.tick();
    await flush();
    expect(work.started).toContain(a2);

    for (const id of [a2, b1, free]) {
      work.release(id);
    }
    await s.waitForIdle();
  });

  it("does not hold an account when the gap is zero, beyond one download at a time", async () => {
    const work = gate();
    registry.register("download", { class: "download", handler: work.handler });
    settings = resolveSettings({ "download.concurrency": 4, "download.account_gap_seconds": 0 });
    const a = addAccount(temp.db, "a");
    const s = makeScheduler();
    s.start();
    const first = s.enqueue({ type: "download", videoId: "1", accountId: a }).id;
    const second = s.enqueue({ type: "download", videoId: "2", accountId: a }).id;
    s.tick();
    await flush();
    expect(work.started).toEqual([first]);
    work.release(first);
    await flush();
    expect(work.started).toEqual([first, second]);
    work.release(second);
    await s.waitForIdle();
  });

  it("holds an account's jobs while the scrape budget hook refuses", async () => {
    registry.register("scrape", { class: "io", handler: async () => {} });
    const a = addAccount(temp.db, "a");
    const b = addAccount(temp.db, "b");
    const asked: [number, JobClass][] = [];
    const s = makeScheduler({
      canConsumeScrape: (accountId, cls) => {
        asked.push([accountId, cls]);
        return accountId !== a;
      },
    });
    s.start();
    const forA = s.enqueue({ type: "scrape", accountId: a }).id;
    const forB = s.enqueue({ type: "scrape", accountId: b }).id;
    s.tick();
    await s.waitForIdle();
    expect(s.queue.get(forA)?.status).toBe("queued");
    expect(s.queue.get(forB)?.status).toBe("done");
    expect(asked).toContainEqual([a, "io"]);
  });
});

describe("circuit breaker", () => {
  it("opens after five consecutive failures, probes once when half-open, then closes", async () => {
    let fail = true;
    const started: number[] = [];
    registry.register("api", {
      class: "io",
      maxAttempts: 1,
      handler: async (ctx) => {
        started.push(ctx.job.id);
        await Promise.resolve();
        if (fail) {
          throw new Error("api down");
        }
      },
    });
    const s = makeScheduler();
    s.start();
    for (let i = 0; i < 5; i += 1) {
      s.enqueue({ type: "api" });
    }
    s.tick();
    await s.waitForIdle();
    expect(started).toHaveLength(5);
    expect(s.status().breakers.io).toBe("open");
    expect(listActivity(temp.db, { page: 1, perPage: 1, kind: "scheduler.breaker" }).total).toBe(1);

    const waiting = [1, 2, 3].map(() => s.enqueue({ type: "api" }).id);
    s.tick();
    await s.waitForIdle();
    expect(started).toHaveLength(5);

    // Half-open: exactly one probe, which fails and reopens the breaker.
    clock += 5 * 60_000;
    expect(s.status().breakers.io).toBe("half-open");
    s.tick();
    await s.waitForIdle();
    expect(started).toEqual(expect.arrayContaining([waiting[0]]));
    expect(started).toHaveLength(6);
    expect(s.status().breakers.io).toBe("open");

    // Next probe succeeds and the breaker closes; the rest drain.
    fail = false;
    clock += 5 * 60_000;
    s.tick();
    await s.waitForIdle();
    await flush();
    s.tick();
    await s.waitForIdle();
    expect(s.status().breakers.io).toBe("closed");
    expect(started).toHaveLength(8);
    expect(waiting.map((id) => s.queue.get(id)?.status)).toEqual(["failed", "done", "done"]);
  });

  it("does not trip on failures spread across a success", async () => {
    const outcomes = [true, true, true, true, false, true, true, true, true];
    registry.register("api", {
      class: "io",
      maxAttempts: 1,
      handler: async () => {
        await Promise.resolve();
        if (outcomes.shift() === true) {
          throw new Error("nope");
        }
      },
    });
    const s = makeScheduler({ breakerThreshold: 5 });
    s.start();
    for (let i = 0; i < 9; i += 1) {
      s.enqueue({ type: "api" });
      s.tick();
      await s.waitForIdle();
    }
    expect(s.status().breakers.io).toBe("closed");
  });

  it("treats a cancelled probe as neutral", async () => {
    let mode: "fail" | "hang" = "fail";
    const hang = deferred();
    registry.register("api", {
      class: "io",
      maxAttempts: 1,
      handler: async (ctx) => {
        if (mode === "fail") {
          throw new Error("down");
        }
        ctx.signal.addEventListener("abort", () => {
          hang.reject(new JobAbortedError("cancel"));
        });
        await hang.promise;
      },
    });
    const s = makeScheduler({ breakerThreshold: 1, breakerOpenMs: 1000 });
    s.start();
    s.enqueue({ type: "api" });
    s.tick();
    await s.waitForIdle();
    expect(s.status().breakers.io).toBe("open");

    mode = "hang";
    clock += 1000;
    const probe = s.enqueue({ type: "api" }).id;
    s.tick();
    await flush();
    expect(s.runningIds()).toEqual([probe]);
    s.queue.cancel(probe);
    await s.waitForIdle();
    expect(s.status().breakers.io).toBe("half-open");
  });
});

describe("cancel", () => {
  it("aborts a running job when job.cancelled is published", async () => {
    const reasons: unknown[] = [];
    registry.register("long", {
      class: "io",
      handler: async (ctx) => {
        await new Promise<void>((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => {
            reasons.push(ctx.signal.reason);
            try {
              ctx.checkpoint();
            } catch (error) {
              reject(error as Error);
            }
          });
        });
      },
    });
    const s = makeScheduler();
    s.start();
    const { id } = s.enqueue({ type: "long" });
    s.tick();
    await flush();
    s.queue.cancel(id);
    await s.waitForIdle();
    expect(reasons).toEqual(["cancel"]);
    expect(s.queue.get(id)?.status).toBe("cancelled");
    expect(seen.map((event) => event.type)).not.toContain("job.failed");
  });

  it("aborts a running job whose row was cancelled behind its back", async () => {
    registry.register("long", {
      class: "io",
      handler: async (ctx) => {
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener("abort", () => {
            resolve();
          });
        });
      },
    });
    const s = makeScheduler();
    s.start();
    const { id } = s.enqueue({ type: "long" });
    s.tick();
    await flush();
    temp.db.run("UPDATE jobs SET status = 'cancelled' WHERE id = ?", id);
    s.tick();
    await s.waitForIdle();
    expect(s.queue.get(id)?.status).toBe("cancelled");
  });

  it("checkpoint() passes while the job is live", () => {
    expect(new JobAbortedError("shutdown").message).toBe("server shutting down");
    expect(new JobAbortedError("cancel").reason).toBe("cancel");
  });
});

describe("graceful stop", () => {
  it("aborts running jobs and requeues them without charging an attempt", async () => {
    registry.register("polite", {
      class: "io",
      handler: async (ctx) => {
        await new Promise<void>((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => {
            reject(new JobAbortedError("shutdown"));
          });
        });
      },
    });
    const s = makeScheduler();
    s.start();
    const { id } = s.enqueue({ type: "polite" });
    s.tick();
    await flush();
    expect(s.queue.get(id)?.attempts).toBe(1);
    await s.stop();
    expect(s.queue.get(id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(s.started).toBe(false);
    await s.stop(); // idempotent
  });

  it("requeues a job that ignores the abort once the grace period runs out", async () => {
    const stuck = deferred();
    registry.register("stubborn", {
      class: "io",
      handler: () => stuck.promise,
    });
    const s = makeScheduler({ shutdownGraceMs: 20 });
    s.start();
    const { id } = s.enqueue({ type: "stubborn" });
    s.tick();
    await flush();
    await s.stop();
    expect(s.queue.get(id)).toMatchObject({ status: "queued", attempts: 0 });

    // When it finally returns, nothing is overwritten.
    stuck.resolve();
    await flush();
    expect(s.queue.get(id)).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("does nothing while stopped", async () => {
    registry.register("work", { class: "io", handler: async () => {} });
    const s = makeScheduler();
    await s.stop();
    const { id } = s.enqueue({ type: "work" });
    s.tick();
    await flush();
    expect(s.queue.get(id)?.status).toBe("queued");
  });
});

describe("every()", () => {
  it("runs a new schedule on the first tick and persists its last run", async () => {
    const runs: number[] = [];
    const s = makeScheduler();
    s.every("nightly", 60_000, () => runs.push(clock));
    s.start();
    expect(runs).toEqual([clock]);
    expect(getKv(temp.db, SCHEDULE_KV_PREFIX + "nightly")).toBe(clock);

    clock += 59_999;
    s.tick();
    expect(runs).toHaveLength(1);
    clock += 1;
    s.tick();
    expect(runs).toHaveLength(2);
    await s.stop();

    // A restart resumes the cadence instead of running again at once.
    const later = makeScheduler();
    const again: number[] = [];
    later.every("nightly", 60_000, () => again.push(clock));
    later.start();
    expect(again).toEqual([]);
    clock += 60_000;
    later.tick();
    expect(again).toEqual([clock]);
  });

  it("orders due schedules and survives failing ones", async () => {
    const order: string[] = [];
    const s = makeScheduler();
    s.every("c", 3000, () => order.push("c"));
    s.every("boom", 1000, () => {
      order.push("boom");
      throw new Error("schedule failed");
    });
    s.every("async-boom", 2000, () => {
      order.push("async-boom");
      return Promise.reject(new Error("async failure"));
    });
    s.every("a", 1000, () => order.push("a"));
    s.start();
    expect(order).toEqual(["c", "boom", "async-boom", "a"]);
    clock += 1000;
    s.tick();
    expect(order.slice(4)).toEqual(["boom", "a"]);
    clock += 1000;
    s.tick();
    expect(order.slice(6)).toEqual(["boom", "async-boom", "a"]);
    await flush();
  });

  it("enqueues through the schedule with dedupe", async () => {
    const work = gate();
    registry.register("sweep", { class: "maintenance", handler: work.handler });
    const s = makeScheduler();
    s.every("sweep", 1000, () => s.enqueue({ type: "sweep", dedupe: true }));
    s.start();
    await flush();
    clock += 1000;
    s.tick();
    clock += 1000;
    s.tick();
    expect(s.queue.list({ page: 1, perPage: 10, type: "sweep" }).total).toBe(1);
    work.release(work.started[0] as number);
    await s.waitForIdle();
  });

  it("rejects duplicate names and non-positive intervals", () => {
    const s = makeScheduler();
    s.every("x", 1000, () => {});
    expect(() => {
      s.every("x", 1000, () => {});
    }).toThrow(/already registered/);
    expect(() => {
      s.every("y", 0, () => {});
    }).toThrow(/positive interval/);
  });
});

describe("timer and defaults", () => {
  it("ticks on its own timer and uses registry defaults without a settings hook", async () => {
    const ran: number[] = [];
    registry.register("work", {
      class: "io",
      handler: async (ctx) => {
        ran.push(ctx.job.id);
        await Promise.resolve();
      },
    });
    const s = new Scheduler({
      db: temp.db,
      log: createConsoleLogger("silent"),
      events,
      logsDir: join(temp.dir, "logs"),
      registry,
      tickMs: 5,
      pumpOnEnqueue: false,
    });
    scheduler = s;
    s.start();
    const { id } = s.enqueue({ type: "work" });
    for (let i = 0; i < 100 && ran.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await s.waitForIdle();
    expect(ran).toEqual([id]);
    expect(existsSync(join(temp.dir, "logs", "jobs", String(id), "job.log"))).toBe(true);
  });
});
