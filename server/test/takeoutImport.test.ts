import {
  TakeoutCountsSchema,
  TakeoutUploadResponseSchema,
  type TakeoutCounts,
} from "@cellar/shared";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConsoleLogger } from "../src/logging.ts";
import {
  importTakeout,
  isStagingDir,
  RECHECK_BATCH_JOB,
  removeStagingDir,
  summarize,
  takeoutStatus,
  TARGETED_EVAL_LIMIT,
  type TakeoutImportDeps,
  type TakeoutPayload,
} from "../src/domain/takeout.ts";
import { registerTakeoutHandler, runTakeoutJob } from "../src/jobs/handlers/takeout.ts";
import { JobQueue } from "../src/jobs/queue.ts";
import {
  JobAbortedError,
  JobRegistry,
  type JobContext,
  type JobRecord,
} from "../src/jobs/types.ts";
import { createTempApp, type TempApp } from "./helpers.ts";
import {
  buildZip,
  DESPACITO,
  DEV_CHANNEL,
  GANGNAM,
  playlistCsv,
  RICK,
  RICK_CHANNEL,
  SEE_YOU,
  T_LIKED,
  T_RICK_EARLY,
  T_RICK_LATE,
  T_WL,
  T_ZOO,
  takeoutFiles,
  UPTOWN,
  ZOO,
  multipartBody,
} from "./takeoutFixtures.ts";
import { seedAccount, seedVideo } from "./videoSeed.ts";

const NOW = Date.UTC(2026, 9, 18);
const log = createConsoleLogger("silent");

let temp: TempApp;
let account: number;
let registry: JobRegistry;
let queue: JobQueue;

beforeEach(async () => {
  temp = await createTempApp();
  account = seedAccount(temp.db, "main");
  registry = new JobRegistry();
  queue = new JobQueue(temp.db, { registry });
});

afterEach(async () => {
  await temp.close();
});

function deps(overrides: Partial<TakeoutImportDeps> = {}): TakeoutImportDeps {
  return {
    db: temp.db,
    log,
    now: () => NOW,
    tmpDir: temp.config.tmpDir,
    enqueue: (input) => queue.enqueue(input),
    registry,
    ...overrides,
  };
}

/** Upload a zip of the given files through the real route and return the queued job. */
async function stage(files = takeoutFiles()): Promise<{ id: number; payload: TakeoutPayload }> {
  const { body, contentType } = await multipartBody([
    { filename: "takeout-001.zip", data: buildZip(files) },
  ]);
  const response = await temp.app.inject({
    method: "POST",
    url: `/api/takeout?account_id=${String(account)}`,
    headers: { "content-type": contentType },
    payload: body,
  });
  expect(response.statusCode).toBe(202);
  const id = TakeoutUploadResponseSchema.parse(response.json()).job_id;
  const row = temp.db.get<{ payload_json: string }>(
    "SELECT payload_json FROM jobs WHERE id = ?",
    id,
  );
  return { id, payload: JSON.parse(row?.payload_json ?? "null") as TakeoutPayload };
}

interface SourceRow {
  video_id: string;
  source: string;
  first_seen_at: number;
  last_seen_at: number;
  source_ts: number | null;
  origin: string;
}

function sources(): SourceRow[] {
  return temp.db.all<SourceRow>(
    `SELECT video_id, source, first_seen_at, last_seen_at, source_ts, origin
       FROM video_sources ORDER BY source, video_id`,
  );
}

function stable(
  counts: TakeoutCounts,
): Omit<TakeoutCounts, "duration_ms" | "new_videos" | "new_sources"> {
  const { duration_ms: _d, new_videos: _v, new_sources: _s, ...rest } = counts;
  return rest;
}

describe("importTakeout", () => {
  it("imports history, Watch later, Liked and subscriptions; counts the rest", async () => {
    const { id, payload } = await stage();
    const progress = vi.fn();
    const counts = await importTakeout(deps(), payload, { jobId: id, progress });

    expect(counts).toMatchObject({
      account_id: account,
      history: 3,
      history_videos: 2,
      watch_later: 1,
      liked: 1,
      subscriptions: 2,
      playlists_ignored: 1,
      playlist_videos_ignored: 2,
      new_videos: 4,
      new_sources: 6,
      skipped: { ad: 1, "no-url": 1 },
      recheck_jobs: null,
    });
    expect(TakeoutCountsSchema.parse(counts)).toEqual(counts);

    expect(sources()).toEqual([
      {
        video_id: RICK,
        source: "history",
        first_seen_at: T_RICK_EARLY,
        last_seen_at: T_RICK_LATE,
        source_ts: T_RICK_EARLY,
        origin: "takeout",
      },
      {
        video_id: ZOO,
        source: "history",
        first_seen_at: T_ZOO,
        last_seen_at: T_ZOO,
        source_ts: T_ZOO,
        origin: "takeout",
      },
      {
        video_id: DESPACITO,
        source: "liked",
        first_seen_at: T_LIKED,
        last_seen_at: T_LIKED,
        source_ts: T_LIKED,
        origin: "takeout",
      },
      {
        video_id: GANGNAM,
        source: "watch_later",
        first_seen_at: T_WL,
        last_seen_at: T_WL,
        source_ts: T_WL,
        origin: "takeout",
      },
    ]);
    // Other playlists feed no source and create no videos.
    for (const ignored of [SEE_YOU, UPTOWN]) {
      expect(temp.db.get("SELECT id FROM videos WHERE id = ?", ignored)).toBeUndefined();
    }
    // Unknown videos are metadata-only records without a channel.
    expect(
      temp.db.all<{ id: string; channel_id: string | null }>(
        "SELECT id, channel_id FROM videos ORDER BY id",
      ),
    ).toEqual(
      [DESPACITO, GANGNAM, RICK, ZOO].sort().map((videoId) => ({ id: videoId, channel_id: null })),
    );
    expect(temp.db.all("SELECT id, title FROM channels ORDER BY id")).toEqual([
      { id: DEV_CHANNEL, title: "Developers, Google" },
      { id: RICK_CHANNEL, title: "Rick Astley" },
    ]);
    expect(
      temp.db.all(
        "SELECT channel_id, account_id, kind, subscribed_at FROM channel_sources ORDER BY channel_id",
      ),
    ).toEqual([
      { channel_id: DEV_CHANNEL, account_id: account, kind: "subscription", subscribed_at: null },
      { channel_id: RICK_CHANNEL, account_id: account, kind: "subscription", subscribed_at: null },
    ]);

    const activity = temp.db.get<{
      kind: string;
      job_id: number;
      message: string;
      data_json: string;
    }>("SELECT kind, job_id, message, data_json FROM activity WHERE kind = 'takeout.imported'");
    expect(activity?.job_id).toBe(id);
    expect(activity?.message).toBe(summarize(counts));
    expect(JSON.parse(activity?.data_json ?? "null")).toEqual(counts);

    const evalJob = temp.db.get<{ payload_json: string }>(
      "SELECT payload_json FROM jobs WHERE type = 'eval_pass'",
    );
    const evalPayload = JSON.parse(evalJob?.payload_json ?? "{}") as { videoIds?: string[] };
    expect(evalPayload.videoIds?.sort()).toEqual([DESPACITO, GANGNAM, RICK, ZOO].sort());

    expect(existsSync(payload.dir)).toBe(false);
    expect(progress).toHaveBeenLastCalledWith(100, "Import finished");

    const status = takeoutStatus(temp.db, id);
    expect(status.counts).toEqual(counts);
  });

  it("is idempotent: a second import of the same export creates nothing", async () => {
    const first = await stage();
    const a = await importTakeout(deps(), first.payload, { jobId: first.id });
    const rowsAfterFirst = sources();
    const channelSources = temp.db.all("SELECT * FROM channel_sources ORDER BY id");

    const second = await stage();
    const b = await importTakeout(deps({ now: () => NOW + 60_000 }), second.payload, {
      jobId: second.id,
    });
    expect(stable(b)).toEqual(stable(a));
    expect(b.new_videos).toBe(0);
    expect(b.new_sources).toBe(0);
    expect(sources()).toEqual(rowsAfterFirst);
    expect(temp.db.all("SELECT * FROM channel_sources ORDER BY id")).toEqual(channelSources);
    expect(temp.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM videos")?.n).toBe(4);
  });

  it("moves first_seen_at earlier, never later, and keeps the row's origin", async () => {
    const later = T_RICK_LATE + 86_400_000;
    const earlier = T_ZOO - 86_400_000;
    seedVideo(temp.db, { id: RICK });
    seedVideo(temp.db, { id: ZOO });
    const insert = `INSERT INTO video_sources (video_id, account_id, source, first_seen_at,
                      last_seen_at, source_ts, origin) VALUES (?, ?, 'history', ?, ?, ?, 'live_feed')`;
    temp.db.run(insert, RICK, account, later, later, null);
    temp.db.run(insert, ZOO, account, earlier, NOW, T_ZOO + 1);

    const { id, payload } = await stage();
    const counts = await importTakeout(deps(), payload, { jobId: id });
    expect(counts.new_videos).toBe(2);

    const rows = sources().filter((row) => row.source === "history");
    expect(rows).toEqual([
      {
        video_id: RICK,
        source: "history",
        first_seen_at: T_RICK_EARLY,
        last_seen_at: later,
        source_ts: T_RICK_EARLY,
        origin: "live_feed",
      },
      {
        video_id: ZOO,
        source: "history",
        first_seen_at: earlier,
        last_seen_at: NOW,
        source_ts: T_ZOO,
        origin: "live_feed",
      },
    ]);
  });

  it("uses the import time for rows without a timestamp and keeps sources per account", async () => {
    const other = seedAccount(temp.db, "second");
    const files = [{ name: "Watch later.csv", data: "Video ID\nRgKAFK5djSk\n" }];
    const { id, payload } = await stage(files);
    await importTakeout(deps(), { ...payload, account_id: other }, { jobId: id });
    expect(
      temp.db.all("SELECT account_id, first_seen_at, last_seen_at, source_ts FROM video_sources"),
    ).toEqual([{ account_id: other, first_seen_at: NOW, last_seen_at: NOW, source_ts: null }]);
  });

  it("queues recheck_batch jobs of 50 for unknown videos when the handler exists", async () => {
    registry.register(RECHECK_BATCH_JOB, { class: "io", handler: () => Promise.resolve() });
    const ids = Array.from({ length: 120 }, (_, i) => `vid${String(i).padStart(8, "0")}`);
    seedVideo(temp.db, { id: ids[0] ?? "" });
    const csv = playlistCsv(ids.map((videoId) => [videoId, T_LIKED]));
    const { id, payload } = await stage([{ name: "Liked videos.csv", data: csv }]);
    const counts = await importTakeout(deps(), payload, { jobId: id });
    expect(counts.new_videos).toBe(119);
    expect(counts.recheck_jobs).toBe(3);
    const jobs = temp.db
      .all<{ payload_json: string }>(
        "SELECT payload_json FROM jobs WHERE type = ? ORDER BY id",
        RECHECK_BATCH_JOB,
      )
      .map((row) => JSON.parse(row.payload_json) as { videoIds: string[]; reason: string });
    expect(jobs.map((job) => job.videoIds.length)).toEqual([50, 50, 19]);
    expect(jobs[0]?.reason).toBe("takeout");
    expect(jobs.flatMap((job) => job.videoIds)).not.toContain(ids[0]);
  });

  it("schedules a full eval pass instead of a huge id list", async () => {
    const ids = Array.from(
      { length: TARGETED_EVAL_LIMIT + 1 },
      (_, i) => `big${String(i).padStart(8, "0")}`,
    );
    const csv = playlistCsv(ids.map((videoId) => [videoId, T_WL]));
    const { id, payload } = await stage([{ name: "Watch later-videos.csv", data: csv }]);
    const progress = vi.fn();
    await importTakeout(deps(), payload, { jobId: id, progress });
    const evalJob = temp.db.get<{ payload_json: string }>(
      "SELECT payload_json FROM jobs WHERE type = 'eval_pass'",
    );
    expect(JSON.parse(evalJob?.payload_json ?? "{}")).toMatchObject({ reason: "takeout" });
    expect(JSON.parse(evalJob?.payload_json ?? "{}")).not.toHaveProperty("videoIds");
    expect(progress.mock.calls.length).toBeGreaterThan(5);
  });

  it("only touches subscriptions when that is all the export has", async () => {
    temp.db.run(
      "INSERT INTO channels (id, title, first_seen_at, created_at, updated_at) VALUES (?, ?, 1, 1, 1)",
      RICK_CHANNEL,
      "From the API",
    );
    const files = takeoutFiles().filter((file) => file.name.endsWith("subscriptions.csv"));
    const { id, payload } = await stage(files);
    const counts = await importTakeout(deps(), payload, { jobId: id });
    expect(counts).toMatchObject({ subscriptions: 2, new_videos: 0, new_sources: 2 });
    expect(temp.db.get("SELECT title FROM channels WHERE id = ?", RICK_CHANNEL)).toEqual({
      title: "From the API",
    });
    expect(temp.db.get("SELECT id FROM jobs WHERE type = 'eval_pass'")).toBeUndefined();
  });

  it("counts staged files that went missing or bad instead of failing", async () => {
    const { id, payload } = await stage();
    const history = payload.files.find((file) => file.kind === "history");
    writeFileSync(join(payload.dir, history?.path ?? ""), "not json");
    const files = [
      ...payload.files,
      { path: "../../outside.csv", name: "x", kind: "liked" as const },
    ];
    const counts = await importTakeout(deps(), { ...payload, files }, { jobId: id });
    expect(counts.skipped).toMatchObject({ "unreadable-file": 1, "unsafe-path": 1 });
    expect(counts.history).toBe(0);
  });

  it("refuses a payload outside the staging area or for a deleted account", async () => {
    const { id, payload } = await stage();
    await expect(
      importTakeout(deps(), { ...payload, dir: temp.config.dataDir }, { jobId: id }),
    ).rejects.toThrow(/outside the staging area/);
    await expect(importTakeout(deps(), { nope: true }, { jobId: id })).rejects.toThrow(/malformed/);
    temp.db.run("DELETE FROM accounts WHERE id = ?", account);
    await expect(importTakeout(deps(), payload, { jobId: id })).rejects.toThrow(/does not exist/);
    expect(existsSync(payload.dir)).toBe(true);
  });
});

describe("staging dir guard", () => {
  it("only accepts takeout-* dirs directly under the tmp dir", async () => {
    const tmp = temp.config.tmpDir;
    expect(isStagingDir(tmp, join(tmp, "takeout-abc"))).toBe(true);
    expect(isStagingDir(tmp, tmp)).toBe(false);
    expect(isStagingDir(tmp, join(tmp, "other"))).toBe(false);
    expect(isStagingDir(tmp, join(tmp, "takeout-abc", "nested"))).toBe(false);
    expect(isStagingDir(tmp, join(tmp, "..", "takeout-abc"))).toBe(false);
    const outside = join(temp.dir, "keep");
    mkdirSync(outside);
    await removeStagingDir(tmp, outside);
    expect(existsSync(outside)).toBe(true);
  });
});

describe("takeout_import handler", () => {
  function context(job: Partial<JobRecord>, signal = new AbortController().signal): JobContext {
    const record: JobRecord = {
      id: 1,
      type: "takeout_import",
      status: "running",
      priority: 0,
      payload: {},
      accountId: null,
      videoId: null,
      attempts: 1,
      maxAttempts: 2,
      runAfter: 0,
      startedAt: 0,
      finishedAt: null,
      error: null,
      logDir: null,
      createdAt: 0,
      ...job,
    };
    return {
      job: record,
      db: temp.db,
      log,
      logDir: temp.dir,
      signal,
      progress: vi.fn(),
      checkpoint: () => {
        if (signal.aborted) throw new JobAbortedError(signal.reason as "cancel" | "shutdown");
      },
    };
  }

  const handlerDeps = () => ({
    tmpDir: temp.config.tmpDir,
    now: () => NOW,
    registry,
    enqueue: (input: Parameters<JobQueue["enqueue"]>[0]) => queue.enqueue(input),
  });

  it("registers an io handler that dedupes on the staging dir", () => {
    registerTakeoutHandler(registry, handlerDeps());
    const registration = registry.get("takeout_import");
    expect(registration?.class).toBe("io");
    expect(registration?.maxAttempts).toBe(2);
    expect(registration?.dedupeKey?.({ dir: "/x" })).toBe("/x");
    expect(registration?.dedupeKey?.(null)).toBe("");
  });

  it("runs the import and reports progress", async () => {
    const { id, payload } = await stage();
    const ctx = context({ id, payload });
    await runTakeoutJob(handlerDeps(), ctx);
    expect(ctx.progress).toHaveBeenCalledWith(100, "Import finished");
    expect(sources()).toHaveLength(4);
  });

  it("keeps the staging dir for a retry and deletes it after the last attempt", async () => {
    const { id, payload } = await stage();
    temp.db.run("DELETE FROM accounts WHERE id = ?", account);
    await expect(runTakeoutJob(handlerDeps(), context({ id, payload }))).rejects.toThrow();
    expect(existsSync(payload.dir)).toBe(true);
    await expect(
      runTakeoutJob(handlerDeps(), context({ id, payload, attempts: 2 })),
    ).rejects.toThrow();
    expect(existsSync(payload.dir)).toBe(false);
    // A malformed payload has nothing to clean up.
    await expect(
      runTakeoutJob(handlerDeps(), context({ id, payload: null, attempts: 2 })),
    ).rejects.toThrow();
  });

  it("deletes the dir on cancel and keeps it on shutdown", async () => {
    const shutdown = await stage();
    const stopping = new AbortController();
    stopping.abort("shutdown");
    await expect(
      runTakeoutJob(
        handlerDeps(),
        context({ id: shutdown.id, payload: shutdown.payload }, stopping.signal),
      ),
    ).rejects.toBeInstanceOf(JobAbortedError);
    expect(existsSync(shutdown.payload.dir)).toBe(true);

    const cancelled = await stage();
    const cancel = new AbortController();
    cancel.abort("cancel");
    await expect(
      runTakeoutJob(
        handlerDeps(),
        context({ id: cancelled.id, payload: cancelled.payload }, cancel.signal),
      ),
    ).rejects.toBeInstanceOf(JobAbortedError);
    expect(existsSync(cancelled.payload.dir)).toBe(false);
  });
});
