import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/db.ts";
import { DomainError } from "../src/domain/errors.ts";
import { EventBus, type CellarEvent } from "../src/events.ts";
import {
  BACKOFF_CAP_MS,
  backoffMs,
  DEFAULT_MAX_ATTEMPTS,
  JobQueue,
  MAX_ERROR_LENGTH,
  toJobRow,
} from "../src/jobs/queue.ts";
import { jobRegistry, JobRegistry, registerHandler } from "../src/jobs/types.ts";
import { createTempDb, type TempDb } from "./helpers.ts";

const noop = async (): Promise<void> => {};

function addAccount(db: Db, label: string): number {
  return db.run("INSERT INTO accounts (label, created_at, updated_at) VALUES (?, 1, 1)", label)
    .lastInsertRowid;
}

let temp: TempDb;
let registry: JobRegistry;
let events: EventBus;
let seen: CellarEvent[];
let clock: number;
let queue: JobQueue;

beforeEach(() => {
  temp = createTempDb();
  registry = new JobRegistry();
  registry.register("download", { class: "download", handler: noop, maxAttempts: 5 });
  registry.register("recheck", { class: "io", handler: noop });
  registry.register("eval", { class: "maintenance", handler: noop });
  registry.register("keyed", {
    class: "io",
    handler: noop,
    dedupeKey: (payload) => String((payload as { channel: string }).channel),
  });
  events = new EventBus();
  seen = [];
  events.subscribe((event) => seen.push(event));
  clock = 1_000_000;
  queue = new JobQueue(temp.db, { registry, events, now: () => clock, random: () => 0 });
});

afterEach(() => {
  temp.close();
});

describe("backoffMs", () => {
  it("grows with the square of the attempts and caps at one hour", () => {
    expect(backoffMs(1, () => 0)).toBe(30_000);
    expect(backoffMs(2, () => 0)).toBe(120_000);
    expect(backoffMs(3, () => 0)).toBe(270_000);
    expect(backoffMs(11, () => 0)).toBe(BACKOFF_CAP_MS);
    expect(backoffMs(50, () => 1)).toBe(BACKOFF_CAP_MS);
  });

  it("adds up to ten percent jitter", () => {
    expect(backoffMs(2, () => 1)).toBe(132_000);
    const sample = backoffMs(2);
    expect(sample).toBeGreaterThanOrEqual(120_000);
    expect(sample).toBeLessThanOrEqual(132_000);
  });
});

describe("JobRegistry", () => {
  it("rejects duplicate types and a max attempts below one", () => {
    expect(() => registry.register("download", { class: "io", handler: noop })).toThrow(
      /already registered/,
    );
    expect(() => registry.register("bad", { class: "io", handler: noop, maxAttempts: 0 })).toThrow(
      /at least 1/,
    );
  });

  it("maps types to classes", () => {
    expect(registry.classOf("download")).toBe("download");
    expect(registry.classOf("nope")).toBeUndefined();
    expect(registry.typesFor(["io"]).sort()).toEqual(["keyed", "recheck"]);
    expect(registry.typesFor([])).toEqual([]);
  });

  it("registerHandler writes to the process-wide registry", () => {
    registerHandler("global-test", { class: "io", handler: noop });
    expect(jobRegistry.has("global-test")).toBe(true);
    jobRegistry.clear();
    expect(jobRegistry.has("global-test")).toBe(false);
  });
});

describe("enqueue", () => {
  it("inserts a queued row with defaults and publishes job.queued", () => {
    const { id, deduped } = queue.enqueue({ type: "recheck", payload: { ids: ["a"] } });
    expect(deduped).toBe(false);
    const job = queue.get(id);
    expect(job).toMatchObject({
      type: "recheck",
      status: "queued",
      priority: 0,
      payload: { ids: ["a"] },
      attempts: 0,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      runAfter: clock,
      createdAt: clock,
      accountId: null,
      videoId: null,
    });
    expect(seen).toEqual([
      expect.objectContaining({
        type: "job.queued",
        payload: { id, type: "recheck", videoId: null, accountId: null },
      }),
    ]);
  });

  it("takes max attempts from the handler, then from the input", () => {
    expect(queue.get(queue.enqueue({ type: "download", videoId: "v1" }).id)?.maxAttempts).toBe(5);
    expect(
      queue.get(queue.enqueue({ type: "download", videoId: "v2", maxAttempts: 9 }).id)?.maxAttempts,
    ).toBe(9);
    expect(queue.get(queue.enqueue({ type: "unregistered" }).id)?.maxAttempts).toBe(3);
  });

  it("dedupes on type and video id against queued and running jobs", () => {
    const first = queue.enqueue({ type: "download", videoId: "v1", dedupe: true });
    const second = queue.enqueue({ type: "download", videoId: "v1", dedupe: true });
    expect(second).toEqual({ id: first.id, deduped: true });
    expect(seen.filter((event) => event.type === "job.queued")).toHaveLength(1);

    queue.claimNext(["download"]);
    expect(queue.enqueue({ type: "download", videoId: "v1", dedupe: true }).id).toBe(first.id);

    // A different video, or a different type for the same video, is a new job.
    expect(queue.enqueue({ type: "download", videoId: "v2", dedupe: true }).deduped).toBe(false);
    expect(queue.enqueue({ type: "recheck", videoId: "v1", dedupe: true }).deduped).toBe(false);

    // Finished jobs do not count.
    queue.complete(first.id);
    expect(queue.enqueue({ type: "download", videoId: "v1", dedupe: true }).deduped).toBe(false);
  });

  it("does not dedupe unless asked", () => {
    const a = queue.enqueue({ type: "download", videoId: "v1" });
    const b = queue.enqueue({ type: "download", videoId: "v1" });
    expect(a.id).not.toBe(b.id);
  });

  it("dedupes on type and account when there is no video", () => {
    const one = addAccount(temp.db, "one");
    const two = addAccount(temp.db, "two");
    const first = queue.enqueue({ type: "recheck", accountId: one, dedupe: true });
    expect(queue.enqueue({ type: "recheck", accountId: one, dedupe: true }).id).toBe(first.id);
    expect(queue.enqueue({ type: "recheck", accountId: two, dedupe: true }).deduped).toBe(false);
    const global = queue.enqueue({ type: "eval", dedupe: true });
    expect(queue.enqueue({ type: "eval", dedupe: true }).id).toBe(global.id);
  });

  it("uses the handler's dedupe key when it has one", () => {
    const first = queue.enqueue({ type: "keyed", payload: { channel: "UC1" }, dedupe: true });
    expect(
      queue.enqueue({ type: "keyed", payload: { channel: "UC1" }, videoId: "x", dedupe: true }).id,
    ).toBe(first.id);
    expect(
      queue.enqueue({ type: "keyed", payload: { channel: "UC2" }, dedupe: true }).deduped,
    ).toBe(false);
  });

  it("treats a stored payload the dedupe key cannot read as a different job", () => {
    temp.db.run(
      `INSERT INTO jobs (type, payload_json, created_at) VALUES ('keyed', 'not json', 1)`,
    );
    registry.clear();
    registry.register("keyed", {
      class: "io",
      handler: noop,
      dedupeKey: (payload) => {
        if (payload === null) {
          throw new Error("unreadable");
        }
        return "k";
      },
    });
    expect(queue.enqueue({ type: "keyed", payload: {}, dedupe: true }).deduped).toBe(false);
  });
});

describe("claimNext", () => {
  it("claims by priority, then run_after, then id, and marks the row running", () => {
    const low = queue.enqueue({ type: "recheck", priority: 0 });
    const high = queue.enqueue({ type: "recheck", priority: 5 });
    const early = queue.enqueue({ type: "recheck", priority: 0, runAfter: clock - 10 });
    const later = queue.enqueue({ type: "recheck", runAfter: clock + 1000 });

    const order = [1, 2, 3].map(() => queue.claimNext(["io"])?.id);
    expect(order).toEqual([high.id, early.id, low.id]);
    expect(queue.claimNext(["io"])).toBeUndefined();

    clock += 1000;
    const claimed = queue.claimNext(["io"]);
    expect(claimed).toMatchObject({
      id: later.id,
      status: "running",
      attempts: 1,
      startedAt: clock,
    });
    expect(seen.at(-1)).toMatchObject({
      type: "job.started",
      payload: { id: later.id, type: "recheck", attempts: 1 },
    });
  });

  it("only claims registered types of the requested classes", () => {
    queue.enqueue({ type: "unregistered" });
    const download = queue.enqueue({ type: "download", videoId: "v" });
    expect(queue.claimNext(["io"])).toBeUndefined();
    expect(queue.claimNext(["leftover"])).toBeUndefined();
    expect(queue.claimNext(["io", "download"])?.id).toBe(download.id);
  });

  it("skips excluded accounts but still claims account-less jobs", () => {
    const a = addAccount(temp.db, "a");
    const b = addAccount(temp.db, "b");
    queue.enqueue({ type: "download", videoId: "1", accountId: a, priority: 9 });
    const forB = queue.enqueue({ type: "download", videoId: "2", accountId: b, priority: 5 });
    const none = queue.enqueue({ type: "download", videoId: "3" });
    expect(queue.claimNext(["download"], clock, { excludeAccountIds: [a] })?.id).toBe(forB.id);
    expect(queue.claimNext(["download"], clock, { excludeAccountIds: [a] })?.id).toBe(none.id);
    expect(queue.claimNext(["download"], clock, { excludeAccountIds: [a] })).toBeUndefined();
    expect(queue.dueAccounts(registry.typesFor(["download"]))).toEqual([a]);
    expect(queue.dueAccounts([])).toEqual([]);
  });

  it("never hands the same row to two connections", async () => {
    const path = join(temp.dir, "cellar.db");
    const other = openDb(path);
    try {
      const otherQueue = new JobQueue(other, { registry, now: () => clock });
      const ids = new Set<number>();
      for (let i = 0; i < 40; i += 1) {
        ids.add(queue.enqueue({ type: "recheck", payload: { i } }).id);
      }
      const claimedBy = async (q: JobQueue): Promise<number[]> => {
        const out: number[] = [];
        for (;;) {
          await Promise.resolve();
          const job = q.claimNext(["io"]);
          if (job === undefined) {
            return out;
          }
          out.push(job.id);
        }
      };
      const [mine, theirs] = await Promise.all([claimedBy(queue), claimedBy(otherQueue)]);
      const all = [...mine, ...theirs];
      expect(mine.length).toBeGreaterThan(0);
      expect(theirs.length).toBeGreaterThan(0);
      expect(new Set(all).size).toBe(all.length);
      expect(new Set(all)).toEqual(ids);
    } finally {
      other.close();
    }
  });
});

describe("complete, fail and requeue", () => {
  it("completes only running jobs", () => {
    const { id } = queue.enqueue({ type: "recheck" });
    expect(queue.complete(id)).toBe(false);
    queue.claimNext(["io"]);
    clock += 50;
    expect(queue.complete(id)).toBe(true);
    expect(queue.get(id)).toMatchObject({ status: "done", finishedAt: clock, error: null });
    expect(seen.at(-1)).toMatchObject({ type: "job.done", payload: { id } });
    expect(queue.complete(id)).toBe(false);
  });

  it("requeues with backoff until max attempts, then fails permanently", () => {
    const { id } = queue.enqueue({ type: "recheck", videoId: "v" });
    queue.claimNext(["io"]);
    expect(queue.fail(id, "boom")).toEqual({
      status: "queued",
      runAfter: clock + 30_000,
      attempts: 1,
    });
    expect(queue.get(id)).toMatchObject({ status: "queued", error: "boom", startedAt: null });
    expect(seen.at(-1)).toMatchObject({
      type: "job.failed",
      payload: { id, videoId: "v", error: "boom", willRetry: true, runAfter: clock + 30_000 },
    });

    expect(queue.claimNext(["io"])).toBeUndefined();
    clock += 30_000;
    queue.claimNext(["io"]);
    expect(queue.fail(id, "boom again")?.status).toBe("queued");
    expect(queue.get(id)?.runAfter).toBe(clock + 120_000);

    clock += 120_000;
    queue.claimNext(["io"]);
    expect(queue.fail(id, "final")).toEqual({ status: "failed", attempts: 3 });
    expect(queue.get(id)).toMatchObject({ status: "failed", finishedAt: clock, error: "final" });
    expect(seen.at(-1)).toMatchObject({ type: "job.failed", payload: { willRetry: false } });
  });

  it("ignores a failure of a job that is not running and truncates long errors", () => {
    const { id } = queue.enqueue({ type: "recheck", maxAttempts: 1 });
    expect(queue.fail(id, "x")).toBeUndefined();
    queue.claimNext(["io"]);
    queue.fail(id, "e".repeat(MAX_ERROR_LENGTH + 50));
    expect(queue.get(id)?.error).toHaveLength(MAX_ERROR_LENGTH + 3);
  });

  it("requeues an interrupted job without charging the attempt", () => {
    const { id } = queue.enqueue({ type: "recheck" });
    expect(queue.requeueInterrupted(id)).toBe(false);
    queue.claimNext(["io"]);
    expect(queue.get(id)?.attempts).toBe(1);
    expect(queue.requeueInterrupted(id)).toBe(true);
    expect(queue.get(id)).toMatchObject({ status: "queued", attempts: 0, runAfter: clock });
  });

  it("requeues running jobs on boot and fails those on their final attempt", () => {
    const resumable = queue.enqueue({ type: "recheck" }).id;
    const final = queue.enqueue({ type: "recheck", maxAttempts: 1 }).id;
    const untouched = queue.enqueue({ type: "recheck", runAfter: clock + 999 }).id;
    queue.claimNext(["io"]);
    queue.claimNext(["io"]);
    clock += 5;
    expect(queue.requeueRunning()).toEqual({ requeued: 1, failed: 1 });
    expect(queue.get(resumable)).toMatchObject({ status: "queued", runAfter: clock, attempts: 1 });
    expect(queue.get(final)).toMatchObject({
      status: "failed",
      error: "interrupted by a restart on its final attempt",
    });
    expect(queue.get(untouched)?.runAfter).toBe(clock + 994);
  });
});

describe("cancel and retry", () => {
  it("cancels queued and running jobs and refuses finished ones", () => {
    const queued = queue.enqueue({ type: "recheck" }).id;
    const running = queue.enqueue({ type: "download", videoId: "v" }).id;
    queue.claimNext(["download"]);

    expect(queue.cancel(queued).status).toBe("cancelled");
    expect(seen.at(-1)).toMatchObject({ type: "job.cancelled", payload: { id: queued } });
    expect(queue.cancel(running)).toMatchObject({ status: "cancelled", finishedAt: clock });
    // A late worker cannot overwrite the cancel.
    expect(queue.complete(running)).toBe(false);
    expect(queue.fail(running, "late")).toBeUndefined();

    expect(() => queue.cancel(queued)).toThrow(/cancelled and cannot be cancelled/);
    expect(() => queue.cancel(999)).toThrow(DomainError);
  });

  it("retries failed and cancelled jobs with a fresh attempt budget", () => {
    const { id } = queue.enqueue({ type: "recheck", maxAttempts: 1 });
    queue.claimNext(["io"]);
    queue.fail(id, "nope");
    clock += 100;
    expect(queue.retry(id)).toMatchObject({
      status: "queued",
      attempts: 0,
      error: null,
      runAfter: clock,
      finishedAt: null,
    });
    expect(seen.at(-1)).toMatchObject({ type: "job.queued", payload: { id } });
    expect(() => queue.retry(id)).toThrow(/queued and cannot be retried/);
    expect(() => queue.retry(424242)).toThrow(/does not exist/);
    queue.cancel(id);
    expect(queue.retry(id).status).toBe("queued");
  });
});

describe("list and lookups", () => {
  it("pages newest first and filters by status and type", () => {
    for (let i = 0; i < 5; i += 1) {
      queue.enqueue({ type: "recheck" });
    }
    const download = queue.enqueue({ type: "download", videoId: "v" }).id;
    queue.claimNext(["download"]);

    const page = queue.list({ page: 1, perPage: 4 });
    expect(page.total).toBe(6);
    expect(page.rows).toHaveLength(4);
    expect(page.rows[0]?.id).toBe(download);
    expect(queue.list({ page: 2, perPage: 4 }).rows).toHaveLength(2);
    expect(queue.list({ page: 1, perPage: 50, status: "running" }).rows.map((r) => r.id)).toEqual([
      download,
    ]);
    expect(queue.list({ page: 1, perPage: 50, type: "recheck" }).total).toBe(5);
  });

  it("maps records to the wire shape without payload or log dir", () => {
    const { id } = queue.enqueue({ type: "recheck", payload: { secret: "no" } });
    const row = toJobRow(queue.get(id)!);
    expect(row).not.toHaveProperty("payload");
    expect(row).not.toHaveProperty("log_dir");
    expect(row).toMatchObject({ id, type: "recheck", status: "queued", max_attempts: 3 });
  });

  it("reports statuses and due counts", () => {
    const a = queue.enqueue({ type: "recheck" }).id;
    queue.enqueue({ type: "recheck", runAfter: clock + 5 });
    expect(queue.statuses([])).toEqual(new Map());
    expect(queue.statuses([a, 999])).toEqual(new Map([[a, "queued"]]));
    expect(queue.countDue()).toBe(1);
    expect(queue.get(999)).toBeUndefined();
    queue.setLogDir(a, "/x");
    expect(queue.get(a)?.logDir).toBe("/x");
  });

  it("defaults to the process-wide registry and the real clock", () => {
    const plain = new JobQueue(temp.db);
    expect(plain.registry).toBe(jobRegistry);
    const before = Date.now();
    const { id } = plain.enqueue({ type: "anything" });
    expect(plain.get(id)?.createdAt).toBeGreaterThanOrEqual(before);
  });
});
