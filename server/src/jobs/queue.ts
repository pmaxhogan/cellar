import type { JobRow, JobStatus } from "@cellar/shared";
import type { SQLInputValue } from "node:sqlite";
import type { Db } from "../db/db.ts";
import { pagedQuery, parseJsonColumn, Where, type Paged } from "../db/paged.ts";
import { conflict, notFound } from "../domain/errors.ts";
import type { EventBus } from "../events.ts";
import {
  jobRegistry,
  type JobClass,
  type JobRecord,
  type JobRegistry,
  type JobType,
} from "./types.ts";

/**
 * The persistent job queue over the `jobs` table. Every state transition is a
 * single guarded UPDATE, so a late worker can never overwrite a cancel and two
 * claimers can never take the same row. The queue also publishes the job.*
 * lifecycle events, because it is the one place every transition goes through.
 */

export const DEFAULT_MAX_ATTEMPTS = 3;
export const BACKOFF_STEP_MS = 30_000;
export const BACKOFF_CAP_MS = 60 * 60_000;
/** Up to this fraction of the delay is added as jitter. */
export const BACKOFF_JITTER = 0.1;
/** Error text stored on a row is truncated to this many characters. */
export const MAX_ERROR_LENGTH = 2000;

/** Retry delay after `attempts` attempts: attempts^2 * 30 s, capped at 1 h, plus jitter. */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(attempts * attempts * BACKOFF_STEP_MS, BACKOFF_CAP_MS);
  return Math.min(base + Math.floor(base * BACKOFF_JITTER * random()), BACKOFF_CAP_MS);
}

export interface EnqueueInput {
  type: JobType;
  payload?: unknown;
  /** Higher runs first. Default 0. */
  priority?: number;
  /** Epoch ms before which the job is not claimed. Default now. */
  runAfter?: number;
  accountId?: number | null;
  videoId?: string | null;
  /** Overrides the handler's maxAttempts. */
  maxAttempts?: number;
  /** Skip the insert when an equivalent queued/running job exists; its id is returned. */
  dedupe?: boolean;
}

export interface EnqueueResult {
  id: number;
  /** True when an existing job was returned instead of inserting a new one. */
  deduped: boolean;
}

export type FailResult =
  { status: "queued"; runAfter: number; attempts: number } | { status: "failed"; attempts: number };

export interface ClaimOptions {
  /** Jobs of these accounts are skipped (per-account gap, scrape budget). */
  excludeAccountIds?: readonly number[];
}

export interface ListJobsInput {
  page: number;
  perPage: number;
  status?: JobStatus | undefined;
  type?: string | undefined;
}

export interface JobQueueOptions {
  registry?: JobRegistry;
  events?: EventBus;
  now?: () => number;
  random?: () => number;
}

interface JobDbRow {
  id: number;
  type: string;
  status: JobStatus;
  priority: number;
  payload_json: string;
  account_id: number | null;
  video_id: string | null;
  attempts: number;
  max_attempts: number;
  run_after: number;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
  log_dir: string | null;
  created_at: number;
}

const ACTIVE = "status IN ('queued', 'running')";

function toRecord(row: JobDbRow): JobRecord {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    priority: row.priority,
    payload: parseJsonColumn(row.payload_json),
    accountId: row.account_id,
    videoId: row.video_id,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAfter: row.run_after,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    logDir: row.log_dir,
    createdAt: row.created_at,
  };
}

/** The wire shape. payload and log_dir stay server side. */
export function toJobRow(record: JobRecord): JobRow {
  return {
    id: record.id,
    type: record.type,
    status: record.status,
    priority: record.priority,
    account_id: record.accountId,
    video_id: record.videoId,
    attempts: record.attempts,
    max_attempts: record.maxAttempts,
    run_after: record.runAfter,
    started_at: record.startedAt,
    finished_at: record.finishedAt,
    error: record.error,
    created_at: record.createdAt,
  };
}

function truncateError(message: string): string {
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}...` : message;
}

function placeholders(count: number): string {
  return new Array<string>(count).fill("?").join(", ");
}

export class JobQueue {
  readonly db: Db;
  readonly registry: JobRegistry;
  readonly #events: EventBus | undefined;
  readonly #now: () => number;
  readonly #random: () => number;

  constructor(db: Db, options: JobQueueOptions = {}) {
    this.db = db;
    this.registry = options.registry ?? jobRegistry;
    this.#events = options.events;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
  }

  enqueue(input: EnqueueInput): EnqueueResult {
    const registration = this.registry.get(input.type);
    const now = this.#now();
    const videoId = input.videoId ?? null;
    const accountId = input.accountId ?? null;
    const payload = input.payload ?? {};

    const result = this.db.tx((): EnqueueResult => {
      if (input.dedupe === true) {
        const existing = this.#findDuplicate(input.type, payload, videoId, accountId);
        if (existing !== undefined) {
          return { id: existing, deduped: true };
        }
      }
      const inserted = this.db.run(
        `INSERT INTO jobs (type, status, priority, payload_json, account_id, video_id,
                           max_attempts, run_after, created_at)
         VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
        input.type,
        input.priority ?? 0,
        JSON.stringify(payload),
        accountId,
        videoId,
        input.maxAttempts ?? registration?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        input.runAfter ?? now,
        now,
      );
      return { id: inserted.lastInsertRowid, deduped: false };
    });

    if (!result.deduped) {
      this.#publish("job.queued", { id: result.id, type: input.type, videoId, accountId });
    }
    return result;
  }

  /**
   * Atomically take the best queued job of the given classes: highest
   * priority, then earliest run_after, then oldest. The subselect and the
   * status guard run as one statement, so concurrent claimers (even on other
   * connections) can never both win the same row.
   */
  claimNext(
    classes: readonly JobClass[],
    now: number = this.#now(),
    options: ClaimOptions = {},
  ): JobRecord | undefined {
    const types = this.registry.typesFor(classes);
    if (types.length === 0) {
      return undefined;
    }
    const excluded = options.excludeAccountIds ?? [];
    const accountFilter =
      excluded.length === 0
        ? ""
        : `AND (account_id IS NULL OR account_id NOT IN (${placeholders(excluded.length)}))`;
    const row = this.db.get<JobDbRow>(
      `UPDATE jobs
          SET status = 'running', started_at = ?, finished_at = NULL, attempts = attempts + 1
        WHERE status = 'queued'
          AND id = (SELECT id FROM jobs
                     WHERE status = 'queued' AND run_after <= ?
                       AND type IN (${placeholders(types.length)})
                       ${accountFilter}
                     ORDER BY priority DESC, run_after ASC, id ASC
                     LIMIT 1)
        RETURNING *`,
      now,
      now,
      ...types,
      ...excluded,
    );
    if (row === undefined) {
      return undefined;
    }
    const record = toRecord(row);
    this.#publish("job.started", {
      ...this.#identity(record),
      attempts: record.attempts,
    });
    return record;
  }

  /** running -> done. False when the row is no longer running (cancelled meanwhile). */
  complete(id: number, now: number = this.#now()): boolean {
    const row = this.db.get<JobDbRow>(
      `UPDATE jobs SET status = 'done', finished_at = ?, error = NULL
        WHERE id = ? AND status = 'running' RETURNING *`,
      now,
      id,
    );
    if (row === undefined) {
      return false;
    }
    this.#publish("job.done", this.#identity(toRecord(row)));
    return true;
  }

  /**
   * running -> queued with backoff, or -> failed once attempts reach
   * max_attempts. Undefined when the row is no longer running.
   */
  fail(id: number, message: string, now: number = this.#now()): FailResult | undefined {
    const error = truncateError(message);
    const outcome = this.db.tx((): { row: JobDbRow; result: FailResult } | undefined => {
      const current = this.db.get<JobDbRow>(
        "SELECT * FROM jobs WHERE id = ? AND status = 'running'",
        id,
      );
      if (current === undefined) {
        return undefined;
      }
      if (current.attempts >= current.max_attempts) {
        this.db.run(
          "UPDATE jobs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?",
          now,
          error,
          id,
        );
        return { row: current, result: { status: "failed", attempts: current.attempts } };
      }
      const runAfter = now + backoffMs(current.attempts, this.#random);
      this.db.run(
        `UPDATE jobs SET status = 'queued', run_after = ?, started_at = NULL, error = ?
          WHERE id = ?`,
        runAfter,
        error,
        id,
      );
      return {
        row: current,
        result: { status: "queued", runAfter, attempts: current.attempts },
      };
    });
    if (outcome === undefined) {
      return undefined;
    }
    const { row, result } = outcome;
    this.#publish("job.failed", {
      ...this.#identity(toRecord(row)),
      error,
      willRetry: result.status === "queued",
      ...(result.status === "queued" ? { runAfter: result.runAfter } : {}),
    });
    return result;
  }

  /**
   * running -> queued without charging the attempt: the job was interrupted
   * by a graceful shutdown, not by its own failure.
   */
  requeueInterrupted(id: number, now: number = this.#now()): boolean {
    const row = this.db.get<JobDbRow>(
      `UPDATE jobs
          SET status = 'queued', run_after = ?, started_at = NULL,
              attempts = MAX(attempts - 1, 0)
        WHERE id = ? AND status = 'running' RETURNING *`,
      now,
      id,
    );
    if (row === undefined) {
      return false;
    }
    this.#publish("job.queued", this.#identity(toRecord(row)));
    return true;
  }

  /**
   * Boot recovery. Anything still `running` was interrupted by a crash and
   * goes back to the queue; a job that was already on its final attempt is
   * failed instead, so a job that crashes the process cannot crash-loop it.
   */
  requeueRunning(now: number = this.#now()): { requeued: number; failed: number } {
    return this.db.tx(() => {
      const failed = this.db.run(
        `UPDATE jobs SET status = 'failed', finished_at = ?,
                error = 'interrupted by a restart on its final attempt'
          WHERE status = 'running' AND attempts >= max_attempts`,
        now,
      ).changes;
      const requeued = this.db.run(
        `UPDATE jobs SET status = 'queued', run_after = ?, started_at = NULL
          WHERE status = 'running'`,
        now,
      ).changes;
      return { requeued, failed };
    });
  }

  /** queued|running -> cancelled. A running job's worker is aborted by the scheduler. */
  cancel(id: number, now: number = this.#now()): JobRecord {
    const row = this.db.get<JobDbRow>(
      `UPDATE jobs SET status = 'cancelled', finished_at = ?
        WHERE id = ? AND ${ACTIVE} RETURNING *`,
      now,
      id,
    );
    if (row === undefined) {
      const existing = this.get(id);
      if (existing === undefined) {
        throw notFound("Job", id);
      }
      throw conflict(`Job ${String(id)} is ${existing.status} and cannot be cancelled.`);
    }
    const record = toRecord(row);
    this.#publish("job.cancelled", this.#identity(record));
    return record;
  }

  /** failed|cancelled -> queued with a fresh attempt budget. */
  retry(id: number, now: number = this.#now()): JobRecord {
    const row = this.db.get<JobDbRow>(
      `UPDATE jobs SET status = 'queued', attempts = 0, run_after = ?, started_at = NULL,
                       finished_at = NULL, error = NULL
        WHERE id = ? AND status IN ('failed', 'cancelled') RETURNING *`,
      now,
      id,
    );
    if (row === undefined) {
      const existing = this.get(id);
      if (existing === undefined) {
        throw notFound("Job", id);
      }
      throw conflict(`Job ${String(id)} is ${existing.status} and cannot be retried.`);
    }
    const record = toRecord(row);
    this.#publish("job.queued", this.#identity(record));
    return record;
  }

  setLogDir(id: number, logDir: string): void {
    this.db.run("UPDATE jobs SET log_dir = ? WHERE id = ?", logDir, id);
  }

  get(id: number): JobRecord | undefined {
    const row = this.db.get<JobDbRow>("SELECT * FROM jobs WHERE id = ?", id);
    return row === undefined ? undefined : toRecord(row);
  }

  /** Current status of each id; ids without a row are absent from the map. */
  statuses(ids: readonly number[]): Map<number, JobStatus> {
    const out = new Map<number, JobStatus>();
    if (ids.length === 0) {
      return out;
    }
    const rows = this.db.all<{ id: number; status: JobStatus }>(
      `SELECT id, status FROM jobs WHERE id IN (${placeholders(ids.length)})`,
      ...ids,
    );
    for (const row of rows) {
      out.set(row.id, row.status);
    }
    return out;
  }

  /** Paged, newest first. */
  list(input: ListJobsInput): Paged<JobRow> {
    const where = new Where().maybe("status = ?", input.status).maybe("type = ?", input.type);
    return pagedQuery<JobDbRow, JobRow>(this.db, {
      select: "*",
      from: "jobs",
      where,
      orderBy: "id DESC",
      page: input.page,
      perPage: input.perPage,
      map: (row) => toJobRow(toRecord(row)),
    });
  }

  /** Queued jobs that are due now, for status reporting. */
  countDue(now: number = this.#now()): number {
    return Number(
      this.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued' AND run_after <= ?",
        now,
      )?.n ?? 0,
    );
  }

  /**
   * Distinct accounts that have due queued jobs of the given types: the
   * candidates the scheduler checks against the account gates before a claim.
   */
  dueAccounts(types: readonly JobType[], now: number = this.#now()): number[] {
    if (types.length === 0) {
      return [];
    }
    return this.db
      .all<{ account_id: number }>(
        `SELECT DISTINCT account_id FROM jobs
          WHERE status = 'queued' AND run_after <= ? AND account_id IS NOT NULL
            AND type IN (${placeholders(types.length)})`,
        now,
        ...types,
      )
      .map((row) => row.account_id);
  }

  // -------------------------------------------------------------------------

  #findDuplicate(
    type: JobType,
    payload: unknown,
    videoId: string | null,
    accountId: number | null,
  ): number | undefined {
    const dedupeKey = this.registry.get(type)?.dedupeKey;
    if (dedupeKey !== undefined) {
      const wanted = dedupeKey(payload);
      const rows = this.db.all<{ id: number; payload_json: string }>(
        `SELECT id, payload_json FROM jobs WHERE type = ? AND ${ACTIVE} ORDER BY id`,
        type,
      );
      return rows.find((row) => safeKey(dedupeKey, row.payload_json) === wanted)?.id;
    }
    const params: SQLInputValue[] = [type];
    let match: string;
    if (videoId !== null) {
      match = "video_id = ?";
      params.push(videoId);
    } else {
      match = "video_id IS NULL AND account_id IS ?";
      params.push(accountId);
    }
    return this.db.get<{ id: number }>(
      `SELECT id FROM jobs WHERE type = ? AND ${match} AND ${ACTIVE} ORDER BY id LIMIT 1`,
      ...params,
    )?.id;
  }

  #identity(record: JobRecord): Record<string, unknown> {
    return {
      id: record.id,
      type: record.type,
      videoId: record.videoId,
      accountId: record.accountId,
    };
  }

  #publish(type: string, payload: Record<string, unknown>): void {
    this.#events?.publish(type, payload);
  }
}

function safeKey(dedupeKey: (payload: unknown) => string, payloadJson: string): string | undefined {
  try {
    return dedupeKey(parseJsonColumn(payloadJson));
  } catch {
    return undefined;
  }
}
