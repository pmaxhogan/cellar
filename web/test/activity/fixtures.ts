import type { ActivityRow } from "../../src/api/activity.ts";
import type { JobRow } from "../../src/api/jobs.ts";
import { fakeServer, json } from "../helpers/fakeServer.ts";

export const NOW = 1_760_000_000_000;

export function makeJob(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 1,
    type: "download",
    status: "queued",
    priority: 0,
    account_id: null,
    video_id: null,
    attempts: 0,
    max_attempts: 3,
    run_after: 0,
    started_at: null,
    finished_at: null,
    error: null,
    created_at: NOW - 60_000,
    ...overrides,
  };
}

export function makeActivity(overrides: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: 1,
    at: NOW - 30_000,
    level: "info",
    kind: "download",
    message: "Downloaded a video",
    video_id: null,
    job_id: null,
    data: null,
    ...overrides,
  };
}

export function paged<T>(rows: T[], total = rows.length, page = 1, perPage = 25) {
  return { rows, total, page, perPage };
}

/** A server with an empty activity log and job list unless a test overrides them. */
export function activityServer(options: { jobs?: JobRow[]; activity?: ActivityRow[] } = {}) {
  return fakeServer()
    .on("GET", "/api/activity", () => json(paged(options.activity ?? [])))
    .on("GET", "/api/jobs", () => json(paged(options.jobs ?? [])));
}
