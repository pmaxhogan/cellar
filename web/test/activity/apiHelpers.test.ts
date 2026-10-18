import { describe, expect, it } from "vitest";
import { listActivity, matchesActivityQuery } from "../../src/api/activity.ts";
import { ACTIONS, ACTION_NAMES, isNotImplemented, runAction } from "../../src/api/actions.ts";
import { ApiClientError } from "../../src/api/client.ts";
import {
  canCancel,
  canRetry,
  fetchJobLog,
  listJobLogs,
  listJobs,
  readJobEvent,
  toPercent,
} from "../../src/api/jobs.ts";
import { apiError, fakeServer, json, text } from "../helpers/fakeServer.ts";
import { makeActivity, makeJob, paged } from "./fixtures.ts";

describe("jobs api", () => {
  it("sends paging and filters, and drops empty ones", async () => {
    const fake = fakeServer().on("GET", "/api/jobs", () => json(paged([makeJob()])));
    await listJobs(fake.api, { page: 2, perPage: 50, status: "failed", type: null });
    const query = fake.calls[0]!.query;
    expect(query.get("page")).toBe("2");
    expect(query.get("perPage")).toBe("50");
    expect(query.get("status")).toBe("failed");
    expect(query.has("type")).toBe(false);
  });

  it("rejects a row with an unknown status", async () => {
    const fake = fakeServer().on("GET", "/api/jobs", () =>
      json(paged([{ ...makeJob(), status: "paused" }])),
    );
    await expect(listJobs(fake.api)).rejects.toMatchObject({ problem: "invalid_response" });
  });

  it("reads the log list and a log file as text, encoding the name", async () => {
    const fake = fakeServer()
      .on("GET", "/api/jobs/4/log", () => json({ files: [{ name: "a b.log", size: 3 }] }))
      .on("GET", /^\/api\/jobs\/4\/log\/.+/, () => text("line 1\nline 2\n"));
    expect(await listJobLogs(fake.api, 4)).toEqual([{ name: "a b.log", size: 3 }]);
    expect(await fetchJobLog(fake.api, 4, "a b.log")).toBe("line 1\nline 2\n");
    expect(fake.calls[1]!.path).toBe("/api/jobs/4/log/a%20b.log");
  });

  it("knows which rows can be cancelled or retried", () => {
    expect(canCancel({ status: "queued" })).toBe(true);
    expect(canCancel({ status: "running" })).toBe(true);
    expect(canCancel({ status: "done" })).toBe(false);
    expect(canRetry({ status: "failed" })).toBe(true);
    expect(canRetry({ status: "cancelled" })).toBe(true);
    expect(canRetry({ status: "running" })).toBe(false);
  });
});

describe("readJobEvent", () => {
  it("maps the event type to a status and reads the id under any spelling", () => {
    expect(readJobEvent("job.started", { id: 3 })).toMatchObject({ id: 3, status: "running" });
    expect(readJobEvent("job.done", { job_id: 4 })).toMatchObject({ id: 4, status: "done" });
    expect(readJobEvent("job.failed", { jobId: 5 })).toMatchObject({ id: 5, status: "failed" });
  });

  it("reads progress as a fraction or a percentage", () => {
    expect(readJobEvent("job.progress", { id: 1, progress: 0.42 })?.progress).toBe(42);
    expect(readJobEvent("job.progress", { id: 1, progress: 57 })?.progress).toBe(57);
    expect(readJobEvent("job.progress", { id: 1, percent: 1 })?.progress).toBe(1);
    expect(readJobEvent("job.progress", { id: 1 })?.progress).toBeNull();
  });

  it("carries a full row when the payload is one", () => {
    const row = makeJob({ id: 8, status: "done" });
    expect(readJobEvent("job.done", row)?.row).toEqual(row);
    expect(readJobEvent("job.done", { id: 8 })?.row).toBeNull();
  });

  it("ignores other events and payloads without an id", () => {
    expect(readJobEvent("activity", { id: 1 })).toBeNull();
    expect(readJobEvent("job.done", { status: "done" })).toBeNull();
    expect(readJobEvent("job.done", "nope")).toBeNull();
    expect(readJobEvent("job.custom", { id: 2, status: "queued" })?.status).toBe("queued");
  });

  it("clamps and rounds percentages", () => {
    expect(toPercent(undefined)).toBeNull();
    expect(toPercent(Number.NaN)).toBeNull();
    expect(toPercent(250)).toBe(100);
    expect(toPercent(undefined, -3)).toBe(0);
    expect(toPercent(0.333)).toBe(33);
  });
});

describe("activity api", () => {
  it("sends the video filter as video_id", async () => {
    const fake = fakeServer().on("GET", "/api/activity", () => json(paged([makeActivity()])));
    await listActivity(fake.api, { level: "warn", kind: "reap", videoId: "abc" });
    const query = fake.calls[0]!.query;
    expect(query.get("level")).toBe("warn");
    expect(query.get("kind")).toBe("reap");
    expect(query.get("video_id")).toBe("abc");
  });

  it("matches live rows against the active filters", () => {
    const row = makeActivity({ level: "error", kind: "download", video_id: "v1" });
    expect(matchesActivityQuery(row, {})).toBe(true);
    expect(matchesActivityQuery(row, { level: "error", kind: "download" })).toBe(true);
    expect(matchesActivityQuery(row, { level: "info" })).toBe(false);
    expect(matchesActivityQuery(row, { kind: "reap" })).toBe(false);
    expect(matchesActivityQuery(row, { kind: "" })).toBe(true);
    expect(matchesActivityQuery(row, { videoId: "v2" })).toBe(false);
  });
});

describe("actions api", () => {
  it("lists every action once", () => {
    expect(ACTIONS.map((action) => action.name).sort()).toEqual([...ACTION_NAMES].sort());
  });

  it("posts to the action and reads the job id", async () => {
    const fake = fakeServer().on("POST", "/api/actions/reap-now", () => json({ job_id: 12 }));
    expect(await runAction(fake.api, "reap-now")).toEqual({ job_id: 12 });
  });

  it("recognises a missing handler by status or code", async () => {
    const fake = fakeServer().on("POST", "/api/actions/eval-now", () =>
      apiError(501, "Not implemented.", "not_implemented"),
    );
    const failure = await runAction(fake.api, "eval-now").catch((cause: unknown) => cause);
    expect(isNotImplemented(failure as ApiClientError)).toBe(true);
    expect(isNotImplemented(new ApiClientError("not_implemented", "x", null))).toBe(true);
    expect(isNotImplemented(new ApiClientError("http_500", "x", 500))).toBe(false);
  });
});
