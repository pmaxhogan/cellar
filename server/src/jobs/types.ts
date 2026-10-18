import type { JobStatus } from "@cellar/shared";
import type { Logger } from "pino";
import type { Db } from "../db/db.ts";

/**
 * Job type registry. A job type is a plain string ("download", "recheck_batch",
 * "action:eval-now", ...); what the scheduler needs to know about it (its
 * worker pool, how often it may be attempted, how it dedupes) comes from the
 * handler registered for it. A queued row whose type has no handler is never
 * claimed.
 */
export type JobType = string;

/**
 * Worker pools. `leftover` runs only when the budget gate says the main class
 * left something unused (pri-0 rechecks, deep backfill).
 */
export type JobClass = "io" | "download" | "transcode" | "maintenance" | "leftover";

export const JOB_CLASSES: readonly JobClass[] = [
  "io",
  "download",
  "transcode",
  "maintenance",
  "leftover",
];

/** One `jobs` row with the payload parsed and the columns camel cased. */
export interface JobRecord {
  id: number;
  type: JobType;
  status: JobStatus;
  priority: number;
  payload: unknown;
  accountId: number | null;
  videoId: string | null;
  attempts: number;
  maxAttempts: number;
  runAfter: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  logDir: string | null;
  createdAt: number;
}

export interface JobContext {
  job: JobRecord;
  db: Db;
  /** Child logger bound to { jobId, type }; also written to <logDir>/job.log. */
  log: Logger;
  /** $DATA_DIR/logs/jobs/<id>/, created before the handler runs. */
  logDir: string;
  /** Aborted on cancel (reason "cancel") and on shutdown (reason "shutdown"). */
  signal: AbortSignal;
  /** Report progress (0-100) over SSE `job.progress`. Throttled. */
  progress(pct: number, message?: string): void;
  /** Throws JobAbortedError when the job was cancelled or the server is stopping. */
  checkpoint(): void;
}

export type JobHandler = (ctx: JobContext) => Promise<void>;

export interface HandlerRegistration {
  class: JobClass;
  handler: JobHandler;
  /** Defaults to 3 (the jobs.max_attempts column default). */
  maxAttempts?: number;
  /**
   * Dedupe identity for `enqueue({ dedupe: true })`. Without it a job dedupes
   * on type + video id, or type + account id when there is no video.
   */
  dedupeKey?: (payload: unknown) => string;
}

export type AbortReason = "cancel" | "shutdown";

/** Thrown by checkpoint(); the scheduler maps it from the signal's reason. */
export class JobAbortedError extends Error {
  override readonly name = "JobAbortedError";
  readonly reason: AbortReason;

  constructor(reason: AbortReason) {
    super(reason === "cancel" ? "job cancelled" : "server shutting down");
    this.reason = reason;
  }
}

/** Handlers by type. One process-wide instance (`jobRegistry`); tests build their own. */
export class JobRegistry {
  readonly #handlers = new Map<JobType, HandlerRegistration>();

  register(type: JobType, registration: HandlerRegistration): void {
    if (this.#handlers.has(type)) {
      throw new Error(`A handler for job type "${type}" is already registered.`);
    }
    if (registration.maxAttempts !== undefined && registration.maxAttempts < 1) {
      throw new Error(`maxAttempts for "${type}" must be at least 1.`);
    }
    this.#handlers.set(type, registration);
  }

  get(type: JobType): HandlerRegistration | undefined {
    return this.#handlers.get(type);
  }

  has(type: JobType): boolean {
    return this.#handlers.has(type);
  }

  classOf(type: JobType): JobClass | undefined {
    return this.#handlers.get(type)?.class;
  }

  /** Registered types whose handler belongs to one of `classes`. */
  typesFor(classes: readonly JobClass[]): JobType[] {
    const wanted = new Set(classes);
    return [...this.#handlers]
      .filter(([, registration]) => wanted.has(registration.class))
      .map(([type]) => type);
  }

  /** Test seam. */
  clear(): void {
    this.#handlers.clear();
  }
}

export const jobRegistry = new JobRegistry();

/** Register a handler on the process-wide registry. Other modules call this at boot. */
export function registerHandler(type: JobType, registration: HandlerRegistration): void {
  jobRegistry.register(type, registration);
}
