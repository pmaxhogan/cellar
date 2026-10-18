import { z } from "zod";
import { pagedSchema } from "@cellar/shared";
import { buildQuery, type ApiClient } from "./client.ts";

/**
 * Jobs API (/api/jobs). Local schemas until the wave1B block of
 * shared/src/apiTypes.ts lands with the same shape.
 *
 *   GET  /api/jobs?page&perPage&status&type -> paged JobRow
 *   GET  /api/jobs/:id                      -> JobRow
 *   GET  /api/jobs/:id/log                  -> { files: [{ name, size }] }
 *   GET  /api/jobs/:id/log/:name            -> text/plain
 *   POST /api/jobs/:id/cancel
 *   POST /api/jobs/:id/retry
 */
export const JOB_STATUSES = ["queued", "running", "done", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Known job types (docs/ARCHITECTURE.md, Jobs and scheduler), for the filter. */
export const JOB_TYPES = [
  "ingest_history",
  "ingest_watch_later",
  "ingest_liked",
  "ingest_subscriptions",
  "ingest_channel_uploads",
  "recheck_batch",
  "takeout_import",
  "download",
  "transcode",
  "move",
  "reap",
  "eval_pass",
  "canary",
  "selfcheck",
  "tools_update",
  "stats_rollup",
  "log_retention",
] as const;

export const JobRowSchema = z.object({
  id: z.number().int(),
  type: z.string(),
  status: z.enum(JOB_STATUSES),
  priority: z.number().int(),
  account_id: z.number().int().nullable(),
  video_id: z.string().nullable(),
  attempts: z.number().int(),
  max_attempts: z.number().int(),
  run_after: z.number(),
  started_at: z.number().nullable(),
  finished_at: z.number().nullable(),
  error: z.string().nullable(),
  created_at: z.number(),
});
export type JobRow = z.infer<typeof JobRowSchema>;

export const JobsListResponseSchema = pagedSchema(JobRowSchema);
export type JobsListResponse = z.infer<typeof JobsListResponseSchema>;

export const JobLogFileSchema = z.object({ name: z.string(), size: z.number() });
export type JobLogFile = z.infer<typeof JobLogFileSchema>;
export const JobLogListSchema = z.object({ files: z.array(JobLogFileSchema) });

export interface JobsQuery {
  page?: number;
  perPage?: number;
  status?: JobStatus | null;
  type?: string | null;
}

export function listJobs(
  api: ApiClient,
  query: JobsQuery = {},
  signal?: AbortSignal,
): Promise<JobsListResponse> {
  const path = `/api/jobs${buildQuery({
    page: query.page,
    perPage: query.perPage,
    status: query.status,
    type: query.type,
  })}`;
  return api.request(path, { schema: JobsListResponseSchema, signal });
}

export function getJob(api: ApiClient, id: number, signal?: AbortSignal): Promise<JobRow> {
  return api.request(`/api/jobs/${id}`, { schema: JobRowSchema, signal });
}

export async function listJobLogs(api: ApiClient, id: number): Promise<JobLogFile[]> {
  const result = await api.request(`/api/jobs/${id}/log`, { schema: JobLogListSchema });
  return result.files;
}

/** One log file as plain text. The server streams it; this reads it whole. */
export async function fetchJobLog(
  api: ApiClient,
  id: number,
  name: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await api.raw(`/api/jobs/${id}/log/${encodeURIComponent(name)}`, {
    method: "GET",
    headers: { Accept: "text/plain" },
    signal,
  });
  return response.text();
}

export function cancelJob(api: ApiClient, id: number): Promise<void> {
  return api.request(`/api/jobs/${id}/cancel`, { method: "POST" });
}

export function retryJob(api: ApiClient, id: number): Promise<void> {
  return api.request(`/api/jobs/${id}/retry`, { method: "POST" });
}

/** A queued or running job can be cancelled; a failed or cancelled one retried. */
export function canCancel(job: Pick<JobRow, "status">): boolean {
  return job.status === "queued" || job.status === "running";
}

export function canRetry(job: Pick<JobRow, "status">): boolean {
  return job.status === "failed" || job.status === "cancelled";
}

/**
 * What a `job.*` SSE payload may carry. The publisher's payload shape is not
 * pinned yet, so this accepts a job row, a partial one, or an id plus progress
 * under any of the spellings a publisher is likely to use.
 */
export const JobEventPayloadSchema = z
  .object({
    id: z.number().int().optional(),
    job_id: z.number().int().optional(),
    jobId: z.number().int().optional(),
    status: z.enum(JOB_STATUSES).optional(),
    progress: z.number().optional(),
    percent: z.number().optional(),
    error: z.string().nullable().optional(),
  })
  .passthrough();

export interface JobEventUpdate {
  id: number;
  status: JobStatus | null;
  /** 0..100, or null when the event carries none. */
  progress: number | null;
  row: JobRow | null;
}

const STATUS_BY_EVENT: Record<string, JobStatus> = {
  "job.queued": "queued",
  "job.started": "running",
  "job.progress": "running",
  "job.done": "done",
  "job.failed": "failed",
  "job.cancelled": "cancelled",
};

/**
 * Normalise a progress reading to a whole 0..100 percentage. `percent` is
 * always a percentage; `progress` is a fraction when it is at most 1.
 */
export function toPercent(progress: number | undefined, percent?: number): number | null {
  let value: number | null = null;
  if (percent !== undefined && Number.isFinite(percent)) value = percent;
  else if (progress !== undefined && Number.isFinite(progress)) {
    value = progress <= 1 ? progress * 100 : progress;
  }
  if (value === null) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** Read a `job.*` event; null when it names no job. */
export function readJobEvent(type: string, payload: unknown): JobEventUpdate | null {
  if (!type.startsWith("job.")) return null;
  const parsed = JobEventPayloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  const data = parsed.data;
  const id = data.id ?? data.job_id ?? data.jobId;
  if (id === undefined) return null;
  const row = JobRowSchema.safeParse(payload);
  return {
    id,
    status: STATUS_BY_EVENT[type] ?? data.status ?? null,
    progress: toPercent(data.progress, data.percent),
    row: row.success ? row.data : null,
  };
}
