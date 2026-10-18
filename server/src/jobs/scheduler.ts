import { resolveSettings, type ResolvedSettings } from "@cellar/shared";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import type { Db } from "../db/db.ts";
import { getKv, setKv } from "../db/kv.ts";
import { logActivity } from "../domain/activity.ts";
import type { EventBus } from "../events.ts";
import { createJobLogger, JOB_LOG_FILE, type JobLogger } from "./jobLog.ts";
import { JobQueue, type EnqueueInput, type EnqueueResult } from "./queue.ts";
import {
  JOB_CLASSES,
  JobAbortedError,
  jobRegistry,
  type AbortReason,
  type JobClass,
  type JobContext,
  type JobRecord,
  type JobRegistry,
} from "./types.ts";

/**
 * One Scheduler (amber shape): the persistent `jobs` table is the queue, a
 * worker pool per class bounds concurrency, per-account gates hold the
 * download gap and the scrape budget, a budget gate holds the leftover class,
 * and a circuit breaker per class stops a broken subsystem from burning
 * through its whole queue. Periodic work is registered with every() and kept
 * in an in-memory min-heap whose last-run times persist in kv.
 */

export const DEFAULT_TICK_MS = 5000;
export const DEFAULT_SHUTDOWN_GRACE_MS = 20_000;
export const BREAKER_THRESHOLD = 5;
export const BREAKER_OPEN_MS = 5 * 60_000;
export const PROGRESS_INTERVAL_MS = 500;
export const IO_CONCURRENCY = 4;
export const SCHEDULE_KV_PREFIX = "schedule_last:";

export interface SchedulerDeps {
  db: Db;
  log: Logger;
  events: EventBus;
  /** $DATA_DIR/logs; job logs go to <logsDir>/jobs/<id>/. */
  logsDir: string;
  registry?: JobRegistry;
  getSettings?: () => ResolvedSettings;
  /** Quota gate: may a job of this class start now? `leftover` relies on it. */
  budgetOk?: (cls: JobClass) => boolean;
  /** Scrape budget per account: false holds that account's jobs of this class. */
  canConsumeScrape?: (accountId: number, cls: JobClass) => boolean;
  now?: () => number;
  random?: () => number;
  /** Timer period; 0 disables the timer (tests drive tick() by hand). */
  tickMs?: number;
  shutdownGraceMs?: number;
  breakerThreshold?: number;
  breakerOpenMs?: number;
  progressIntervalMs?: number;
  /** Start work as soon as a job is queued instead of on the next tick. Default true. */
  pumpOnEnqueue?: boolean;
}

export type BreakerState = "closed" | "open" | "half-open";

export interface SchedulerStatus {
  running: Record<JobClass, number>;
  breakers: Record<JobClass, BreakerState>;
  queuedDue: number;
}

class Breaker {
  failures = 0;
  openUntil = 0;
  probing = false;

  constructor(
    readonly threshold: number,
    readonly openMs: number,
  ) {}

  state(now: number): BreakerState {
    if (this.openUntil === 0) {
      return "closed";
    }
    return now < this.openUntil ? "open" : "half-open";
  }

  /** Closed: yes. Open: no. Half-open: one probe at a time. */
  allows(now: number): boolean {
    const state = this.state(now);
    return state === "closed" || (state === "half-open" && !this.probing);
  }

  /** Returns true when this start is the half-open probe. */
  onStart(now: number): boolean {
    if (this.state(now) === "half-open") {
      this.probing = true;
      return true;
    }
    return false;
  }

  onSuccess(): void {
    this.failures = 0;
    this.openUntil = 0;
    this.probing = false;
  }

  /** Returns "opened" when this failure opened (or reopened) the breaker. */
  onFailure(now: number, probe: boolean): "opened" | undefined {
    if (probe) {
      this.probing = false;
      this.failures = 0;
      this.openUntil = now + this.openMs;
      return "opened";
    }
    if (this.openUntil !== 0) {
      // A job started before the breaker opened; it says nothing new.
      return undefined;
    }
    this.failures += 1;
    if (this.failures >= this.threshold) {
      this.failures = 0;
      this.openUntil = now + this.openMs;
      return "opened";
    }
    return undefined;
  }

  /** A probe that was cancelled or interrupted proved nothing either way. */
  onNeutral(probe: boolean): void {
    if (probe) {
      this.probing = false;
    }
  }
}

interface Schedule {
  name: string;
  intervalMs: number;
  fn: () => unknown;
  dueAt: number;
  seq: number;
}

/** Min-heap of schedules by due time, then registration order. */
class ScheduleHeap {
  readonly #items: Schedule[] = [];

  get size(): number {
    return this.#items.length;
  }

  has(name: string): boolean {
    return this.#items.some((item) => item.name === name);
  }

  peek(): Schedule | undefined {
    return this.#items[0];
  }

  push(item: Schedule): void {
    this.#items.push(item);
    let index = this.#items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this.#less(index, parent)) {
        break;
      }
      this.#swap(index, parent);
      index = parent;
    }
  }

  pop(): Schedule | undefined {
    const top = this.#items[0];
    const last = this.#items.pop();
    if (this.#items.length > 0 && last !== undefined) {
      this.#items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < this.#items.length && this.#less(left, smallest)) {
          smallest = left;
        }
        if (right < this.#items.length && this.#less(right, smallest)) {
          smallest = right;
        }
        if (smallest === index) {
          break;
        }
        this.#swap(index, smallest);
        index = smallest;
      }
    }
    return top;
  }

  #less(a: number, b: number): boolean {
    const left = this.#items[a] as Schedule;
    const right = this.#items[b] as Schedule;
    return left.dueAt === right.dueAt ? left.seq < right.seq : left.dueAt < right.dueAt;
  }

  #swap(a: number, b: number): void {
    const left = this.#items[a] as Schedule;
    this.#items[a] = this.#items[b] as Schedule;
    this.#items[b] = left;
  }
}

interface Running {
  job: JobRecord;
  cls: JobClass;
  controller: AbortController;
  probe: boolean;
  promise: Promise<void>;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message === "" ? error.name : error.message;
  }
  return String(error);
}

function abortReason(signal: AbortSignal): AbortReason {
  return signal.reason === "cancel" ? "cancel" : "shutdown";
}

export class Scheduler {
  readonly queue: JobQueue;
  readonly #deps: SchedulerDeps;
  readonly #log: Logger;
  readonly #registry: JobRegistry;
  readonly #running = new Map<number, Running>();
  readonly #breakers = new Map<JobClass, Breaker>();
  readonly #schedules = new ScheduleHeap();
  /** Last time a download-class job of each account ended (in this process). */
  readonly #lastDownloadEnd = new Map<number, number>();
  #seq = 0;
  #timer: NodeJS.Timeout | undefined;
  #unsubscribe: (() => void) | undefined;
  #started = false;
  #stopping = false;
  #ticking = false;
  #pumpQueued = false;

  constructor(deps: SchedulerDeps) {
    this.#deps = deps;
    this.#log = deps.log.child({ mod: "scheduler" });
    this.#registry = deps.registry ?? jobRegistry;
    this.queue = new JobQueue(deps.db, {
      registry: this.#registry,
      events: deps.events,
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(deps.random === undefined ? {} : { random: deps.random }),
    });
    for (const cls of JOB_CLASSES) {
      this.#breakers.set(
        cls,
        new Breaker(
          deps.breakerThreshold ?? BREAKER_THRESHOLD,
          deps.breakerOpenMs ?? BREAKER_OPEN_MS,
        ),
      );
    }
  }

  get started(): boolean {
    return this.#started;
  }

  /** Requeue whatever a crash left running, then start ticking. */
  start(): void {
    if (this.#started) {
      return;
    }
    const recovered = this.queue.requeueRunning(this.#now());
    if (recovered.requeued > 0 || recovered.failed > 0) {
      this.#log.info({ ...recovered }, "recovered jobs left running by the previous process");
    }
    this.#started = true;
    this.#stopping = false;
    this.#unsubscribe = this.#deps.events.subscribe((event) => {
      if (event.type === "job.cancelled") {
        const id = event.payload["id"];
        if (typeof id === "number") {
          this.#abort(id, "cancel");
        }
      } else if (event.type === "job.queued" && this.#deps.pumpOnEnqueue !== false) {
        this.#schedulePump();
      }
    });
    const tickMs = this.#deps.tickMs ?? DEFAULT_TICK_MS;
    if (tickMs > 0) {
      this.#timer = setInterval(() => {
        this.tick();
      }, tickMs);
      this.#timer.unref();
    }
    this.tick();
  }

  /**
   * Graceful stop: abort every running job's signal, wait up to the grace
   * period, then requeue whatever is still running (without charging it an
   * attempt) so the next process picks it up.
   */
  async stop(): Promise<void> {
    if (!this.#started) {
      return;
    }
    this.#stopping = true;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;

    const running = [...this.#running.values()];
    for (const entry of running) {
      entry.controller.abort("shutdown");
    }
    if (running.length > 0) {
      this.#log.info({ active: running.length }, "waiting for running jobs to stop");
      const grace = this.#deps.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled(running.map((entry) => entry.promise)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, grace);
          timer.unref();
        }),
      ]);
      clearTimeout(timer);
    }
    for (const entry of this.#running.values()) {
      if (this.queue.requeueInterrupted(entry.job.id, this.#now())) {
        this.#log.warn(
          { jobId: entry.job.id, type: entry.job.type },
          "job outlived the shutdown grace period; requeued",
        );
      }
    }
    this.#started = false;
  }

  enqueue(input: EnqueueInput): EnqueueResult {
    return this.queue.enqueue(input);
  }

  /**
   * Run `fn` every `intervalMs`. The last run time persists in
   * kv.schedule_last:<name>, so a restart resumes the cadence instead of
   * re-running everything at once; a schedule that has never run is due now.
   */
  every(name: string, intervalMs: number, fn: () => unknown): void {
    if (intervalMs <= 0) {
      throw new Error(`Schedule "${name}" needs a positive interval.`);
    }
    if (this.#schedules.has(name)) {
      throw new Error(`Schedule "${name}" is already registered.`);
    }
    const last = getKv<number>(this.#deps.db, SCHEDULE_KV_PREFIX + name);
    const dueAt = typeof last === "number" ? last + intervalMs : this.#now();
    this.#schedules.push({ name, intervalMs, fn, dueAt, seq: (this.#seq += 1) });
  }

  /** One scheduling pass: reconcile cancels, fire due schedules, start work. */
  tick(): void {
    if (!this.#started || this.#stopping || this.#ticking) {
      return;
    }
    this.#ticking = true;
    try {
      this.#reconcile();
      this.#runSchedules();
      this.#pump();
    } finally {
      this.#ticking = false;
    }
  }

  status(): SchedulerStatus {
    const now = this.#now();
    const running = Object.fromEntries(JOB_CLASSES.map((cls) => [cls, 0])) as Record<
      JobClass,
      number
    >;
    for (const entry of this.#running.values()) {
      running[entry.cls] += 1;
    }
    const breakers = Object.fromEntries(
      JOB_CLASSES.map((cls) => [cls, this.#breaker(cls).state(now)]),
    ) as Record<JobClass, BreakerState>;
    return { running, breakers, queuedDue: this.queue.countDue(now) };
  }

  /** Ids of the jobs this process is running right now. */
  runningIds(): number[] {
    return [...this.#running.keys()];
  }

  /** Resolves once nothing is running (including jobs started meanwhile). */
  async waitForIdle(): Promise<void> {
    while (this.#running.size > 0) {
      await Promise.allSettled([...this.#running.values()].map((entry) => entry.promise));
    }
  }

  // -------------------------------------------------------------------------

  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }

  #settings(): ResolvedSettings {
    return (this.#deps.getSettings ?? (() => resolveSettings({})))();
  }

  #breaker(cls: JobClass): Breaker {
    return this.#breakers.get(cls) as Breaker;
  }

  #limit(cls: JobClass, settings: ResolvedSettings): number {
    switch (cls) {
      case "io":
        return IO_CONCURRENCY;
      case "download":
        return settings["download.concurrency"];
      case "transcode":
        return settings["transcode.concurrency"];
      case "maintenance":
      case "leftover":
        return 1;
    }
  }

  #runningIn(cls: JobClass): number {
    let count = 0;
    for (const entry of this.#running.values()) {
      if (entry.cls === cls) {
        count += 1;
      }
    }
    return count;
  }

  #schedulePump(): void {
    if (this.#pumpQueued) {
      return;
    }
    this.#pumpQueued = true;
    queueMicrotask(() => {
      this.#pumpQueued = false;
      if (this.#started && !this.#stopping) {
        this.#pump();
      }
    });
  }

  /** Abort running jobs whose row is no longer `running` (cancelled elsewhere). */
  #reconcile(): void {
    const ids = [...this.#running.keys()];
    if (ids.length === 0) {
      return;
    }
    const statuses = this.queue.statuses(ids);
    for (const id of ids) {
      if (statuses.get(id) !== "running") {
        this.#abort(id, "cancel");
      }
    }
  }

  #abort(id: number, reason: AbortReason): void {
    const entry = this.#running.get(id);
    if (entry !== undefined && !entry.controller.signal.aborted) {
      this.#log.info({ jobId: id, type: entry.job.type, reason }, "aborting job");
      entry.controller.abort(reason);
    }
  }

  #runSchedules(): void {
    const now = this.#now();
    for (let head = this.#schedules.peek(); head !== undefined && head.dueAt <= now;) {
      const schedule = this.#schedules.pop() as Schedule;
      setKv(this.#deps.db, SCHEDULE_KV_PREFIX + schedule.name, now, now);
      try {
        const out = schedule.fn();
        if (out instanceof Promise) {
          out.catch((error: unknown) => {
            this.#log.error({ err: error, schedule: schedule.name }, "scheduled task failed");
          });
        }
      } catch (error) {
        this.#log.error({ err: error, schedule: schedule.name }, "scheduled task failed");
      }
      schedule.dueAt = now + schedule.intervalMs;
      this.#schedules.push(schedule);
      head = this.#schedules.peek();
    }
  }

  /**
   * Accounts whose queued jobs of `cls` must wait: for downloads, an account
   * with a download running or one that ended less than the gap ago; for any
   * class, an account the scrape budget hook refuses.
   */
  #blockedAccounts(cls: JobClass, now: number, settings: ResolvedSettings): number[] {
    const types = this.#registry.typesFor([cls]);
    const candidates = this.queue.dueAccounts(types, now);
    if (candidates.length === 0) {
      return [];
    }
    const gapMs = settings["download.account_gap_seconds"] * 1000;
    const blocked: number[] = [];
    for (const accountId of candidates) {
      if (cls === "download" && this.#inDownloadGap(accountId, now, gapMs, types)) {
        blocked.push(accountId);
      } else if (this.#deps.canConsumeScrape?.(accountId, cls) === false) {
        blocked.push(accountId);
      }
    }
    return blocked;
  }

  #inDownloadGap(accountId: number, now: number, gapMs: number, types: string[]): boolean {
    for (const entry of this.#running.values()) {
      if (entry.cls === "download" && entry.job.accountId === accountId) {
        return true;
      }
    }
    if (gapMs <= 0) {
      return false;
    }
    const persisted =
      this.#deps.db.get<{ last: number | null }>(
        `SELECT MAX(finished_at) AS last FROM jobs
          WHERE account_id = ? AND finished_at IS NOT NULL
            AND type IN (${types.map(() => "?").join(", ")})`,
        accountId,
        ...types,
      )?.last ?? 0;
    const last = Math.max(persisted, this.#lastDownloadEnd.get(accountId) ?? 0);
    return last > 0 && now - last < gapMs;
  }

  #pump(): void {
    if (!this.#started || this.#stopping) {
      return;
    }
    const settings = this.#settings();
    for (const cls of JOB_CLASSES) {
      const limit = this.#limit(cls, settings);
      const breaker = this.#breaker(cls);
      while (this.#runningIn(cls) < limit) {
        const now = this.#now();
        if (!breaker.allows(now)) {
          break;
        }
        if (this.#deps.budgetOk?.(cls) === false) {
          break;
        }
        const job = this.queue.claimNext([cls], now, {
          excludeAccountIds: this.#blockedAccounts(cls, now, settings),
        });
        if (job === undefined) {
          break;
        }
        this.#start(job, cls, breaker.onStart(now));
      }
    }
  }

  #start(job: JobRecord, cls: JobClass, probe: boolean): void {
    const registration = this.#registry.get(job.type);
    const controller = new AbortController();
    const entry: Running = { job, cls, controller, probe, promise: Promise.resolve() };
    this.#running.set(job.id, entry);

    const logDir = join(this.#deps.logsDir, "jobs", String(job.id));
    let jobLogger: JobLogger | undefined;
    let progressAt = 0;

    const run = async (): Promise<void> => {
      if (registration === undefined) {
        throw new Error(`No handler is registered for job type "${job.type}".`);
      }
      mkdirSync(logDir, { recursive: true });
      this.queue.setLogDir(job.id, logDir);
      jobLogger = createJobLogger(this.#deps.log, join(logDir, JOB_LOG_FILE), {
        jobId: job.id,
        type: job.type,
      });
      const signal = controller.signal;
      const ctx: JobContext = {
        job: { ...job, logDir },
        db: this.#deps.db,
        log: jobLogger.log,
        logDir,
        signal,
        progress: (pct, message) => {
          const now = this.#now();
          const clamped = Math.max(0, Math.min(100, pct));
          const interval = this.#deps.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
          if (clamped < 100 && now - progressAt < interval) {
            return;
          }
          progressAt = now;
          this.#deps.events.publish("job.progress", {
            id: job.id,
            type: job.type,
            videoId: job.videoId,
            accountId: job.accountId,
            pct: clamped,
            ...(message === undefined ? {} : { message }),
          });
        },
        checkpoint: () => {
          if (signal.aborted) {
            throw new JobAbortedError(abortReason(signal));
          }
        },
      };
      jobLogger.log.info({ attempt: job.attempts }, "job started");
      await registration.handler(ctx);
    };

    entry.promise = Promise.resolve()
      .then(run)
      .then(
        () => {
          this.#finish(entry, jobLogger, undefined);
        },
        (error: unknown) => {
          this.#finish(entry, jobLogger, error ?? new Error("job failed"));
        },
      )
      .catch((error: unknown) => {
        // Bookkeeping itself failed (the database went away mid-shutdown).
        this.#log.error({ err: error, jobId: job.id }, "could not record a job outcome");
      })
      .finally(() => {
        jobLogger?.close();
        this.#running.delete(job.id);
        if (cls === "download" && job.accountId !== null) {
          this.#lastDownloadEnd.set(job.accountId, this.#now());
        }
        if (this.#started && !this.#stopping) {
          this.#pump();
        }
      });
  }

  #finish(entry: Running, jobLogger: JobLogger | undefined, error: unknown): void {
    const { job, cls, controller, probe } = entry;
    const breaker = this.#breaker(cls);
    const now = this.#now();
    const log = jobLogger?.log ?? this.#log.child({ jobId: job.id, type: job.type });

    if (controller.signal.aborted) {
      breaker.onNeutral(probe);
      if (abortReason(controller.signal) === "cancel") {
        log.info("job cancelled");
      } else {
        this.queue.requeueInterrupted(job.id, now);
        log.info("job interrupted by shutdown; requeued");
      }
      return;
    }

    if (error === undefined) {
      breaker.onSuccess();
      this.queue.complete(job.id, now);
      log.info("job done");
      return;
    }

    const message = errorMessage(error);
    log.warn({ err: error }, "job failed");
    const result = this.queue.fail(job.id, message, now);
    if (result !== undefined) {
      const permanent = result.status === "failed";
      logActivity(
        { db: this.#deps.db, events: this.#deps.events, now: () => now },
        {
          level: permanent ? "error" : "warn",
          kind: permanent ? "job.failed" : "job.retry",
          message: permanent
            ? `${job.type} failed after ${String(result.attempts)} attempts: ${message}`
            : `${job.type} failed (attempt ${String(result.attempts)}), will retry: ${message}`,
          videoId: job.videoId,
          jobId: job.id,
        },
      );
    }
    if (breaker.onFailure(now, probe) === "opened") {
      this.#log.warn({ cls, openMs: breaker.openMs }, "circuit breaker opened");
      logActivity(
        { db: this.#deps.db, events: this.#deps.events, now: () => now },
        {
          level: "warn",
          kind: "scheduler.breaker",
          message: `Paused ${cls} jobs for ${String(Math.round(breaker.openMs / 60_000))} min after repeated failures.`,
          data: { cls },
        },
      );
    }
  }
}
