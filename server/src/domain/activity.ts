import type { ActivityLevel, ActivityRow, ResolvedSettings } from "@cellar/shared";
import { existsSync, lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import type { Db } from "../db/db.ts";
import { pagedQuery, parseJsonColumn, Where, type Paged } from "../db/paged.ts";
import type { EventBus } from "../events.ts";
import type { JobRegistry } from "../jobs/types.ts";

/**
 * The activity log: the high-level events the Activity page lists. Rows are
 * written by the scheduler and by domain code; every insert is also pushed to
 * open browsers as an SSE `activity` frame.
 */

export interface ActivityDeps {
  db: Db;
  events?: EventBus | undefined;
  now?: () => number;
}

export interface ActivityInput {
  level?: ActivityLevel;
  kind: string;
  message: string;
  videoId?: string | null;
  jobId?: number | null;
  /** Small JSON detail. Never credentials. */
  data?: unknown;
}

interface ActivityDbRow {
  id: number;
  at: number;
  level: ActivityLevel;
  kind: string;
  message: string;
  video_id: string | null;
  job_id: number | null;
  data_json: string | null;
}

function toActivityRow(row: ActivityDbRow): ActivityRow {
  return {
    id: row.id,
    at: row.at,
    level: row.level,
    kind: row.kind,
    message: row.message,
    video_id: row.video_id,
    job_id: row.job_id,
    data: parseJsonColumn(row.data_json),
  };
}

export function logActivity(deps: ActivityDeps, input: ActivityInput): ActivityRow {
  const at = (deps.now ?? Date.now)();
  const row = deps.db.get<ActivityDbRow>(
    `INSERT INTO activity (at, level, kind, message, video_id, job_id, data_json)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    at,
    input.level ?? "info",
    input.kind,
    input.message,
    input.videoId ?? null,
    input.jobId ?? null,
    input.data === undefined ? null : JSON.stringify(input.data),
  ) as ActivityDbRow;
  const out = toActivityRow(row);
  deps.events?.publish("activity", { ...out });
  return out;
}

export interface ListActivityInput {
  page: number;
  perPage: number;
  level?: ActivityLevel | undefined;
  kind?: string | undefined;
  videoId?: string | undefined;
}

/** Paged, newest first. */
export function listActivity(db: Db, input: ListActivityInput): Paged<ActivityRow> {
  const where = new Where()
    .maybe("level = ?", input.level)
    .maybe("kind = ?", input.kind)
    .maybe("video_id = ?", input.videoId);
  return pagedQuery<ActivityDbRow, ActivityRow>(db, {
    select: "*",
    from: "activity",
    where,
    orderBy: "at DESC, id DESC",
    page: input.page,
    perPage: input.perPage,
    map: toActivityRow,
  });
}

// ---------------------------------------------------------------------------
// Retention (job type logs_retention, maintenance class, daily)
// ---------------------------------------------------------------------------

export const LOGS_RETENTION_JOB = "logs_retention";
export const ACTIVITY_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60_000;
const GIB = 1024 ** 3;

export interface LogsRetentionDeps {
  db: Db;
  logsDir: string;
  settings: ResolvedSettings;
  log?: Logger;
  now?: () => number;
}

export interface LogsRetentionResult {
  activityDeleted: number;
  dirsDeleted: number;
  bytesFreed: number;
}

interface JobDir {
  path: string;
  size: number;
  /** Epoch ms the age is measured from: finished_at, else the dir mtime. */
  ref: number;
  status: string | null;
}

/** Total size of the regular files under `path`; unreadable entries count as 0. */
export function dirSize(path: string): number {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      total += dirSize(child);
    } else {
      try {
        total += lstatSync(child).size;
      } catch {
        // Removed while we walked it.
      }
    }
  }
  return total;
}

function readJobDirs(db: Db, jobsDir: string): JobDir[] {
  const out: JobDir[] = [];
  for (const entry of readdirSync(jobsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const path = join(jobsDir, entry.name);
    const job = /^\d+$/.test(entry.name)
      ? db.get<{ status: string; finished_at: number | null }>(
          "SELECT status, finished_at FROM jobs WHERE id = ?",
          Number(entry.name),
        )
      : undefined;
    let ref = job?.finished_at ?? null;
    if (ref === null) {
      try {
        ref = statSync(path).mtimeMs;
      } catch {
        continue;
      }
    }
    out.push({ path, size: dirSize(path), ref, status: job?.status ?? null });
  }
  return out;
}

/**
 * Delete activity rows older than 90 days, then per-job log dirs older than
 * `logs.job_retention_days` (failed jobs: `logs.failed_job_retention_days`),
 * then the oldest remaining dirs while the total exceeds `logs.job_retention_gb`.
 * Dirs of queued or running jobs are never touched.
 */
export function runLogsRetention(deps: LogsRetentionDeps): LogsRetentionResult {
  const now = (deps.now ?? Date.now)();
  const { settings } = deps;
  const activityDeleted = deps.db.run(
    "DELETE FROM activity WHERE at < ?",
    now - ACTIVITY_RETENTION_DAYS * DAY_MS,
  ).changes;

  const result: LogsRetentionResult = { activityDeleted, dirsDeleted: 0, bytesFreed: 0 };
  const jobsDir = join(deps.logsDir, "jobs");
  if (!existsSync(jobsDir)) {
    return result;
  }

  const remove = (dir: JobDir): boolean => {
    try {
      rmSync(dir.path, { recursive: true, force: true });
      result.dirsDeleted += 1;
      result.bytesFreed += dir.size;
      return true;
    } catch (error) {
      deps.log?.warn({ err: error, dir: dir.path }, "could not delete a job log dir");
      return false;
    }
  };

  const active = (dir: JobDir): boolean => dir.status === "queued" || dir.status === "running";
  const kept: JobDir[] = [];
  for (const dir of readJobDirs(deps.db, jobsDir)) {
    const days =
      dir.status === "failed"
        ? settings["logs.failed_job_retention_days"]
        : settings["logs.job_retention_days"];
    if (!active(dir) && now - dir.ref > days * DAY_MS && remove(dir)) {
      continue;
    }
    kept.push(dir);
  }

  const cap = settings["logs.job_retention_gb"] * GIB;
  let total = kept.reduce((sum, dir) => sum + dir.size, 0);
  const oldestFirst = kept.filter((dir) => !active(dir)).sort((a, b) => a.ref - b.ref);
  for (const dir of oldestFirst) {
    if (total <= cap) {
      break;
    }
    if (remove(dir)) {
      total -= dir.size;
    }
  }
  return result;
}

/** Register the logs_retention handler (maintenance class) on `registry`. */
export function registerLogsRetention(
  registry: JobRegistry,
  deps: { logsDir: string; getSettings: () => ResolvedSettings },
): void {
  registry.register(LOGS_RETENTION_JOB, {
    class: "maintenance",
    maxAttempts: 1,
    handler: async (ctx) => {
      const result = runLogsRetention({
        db: ctx.db,
        logsDir: deps.logsDir,
        settings: deps.getSettings(),
        log: ctx.log,
      });
      ctx.log.info({ ...result }, "log retention pass finished");
      await Promise.resolve();
    },
  });
}
