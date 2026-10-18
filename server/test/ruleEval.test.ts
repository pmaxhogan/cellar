import { InspectResponseSchema, RulePreviewSchema, type ResolvedSettings } from "@cellar/shared";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setKv } from "../src/db/kv.ts";
import { listActivity } from "../src/domain/activity.ts";
import { DomainError } from "../src/domain/errors.ts";
import {
  createRulesDeps,
  dueVideoIds,
  EVAL_DEBOUNCE_MAX_WAIT_MS,
  EVAL_DEBOUNCE_MS,
  EVAL_PASS_JOB,
  EVAL_TARGETED_MAX_IDS,
  inspectVideo,
  mutationDeps,
  previewCondition,
  queryFirstEnabledLocationId,
  readStoredSettings,
  REAP_JOB,
  RECHECK_ALL_JOB,
  runEvalPass,
  scheduleEvalPass,
  setVideoOverrides,
  trashVideos,
} from "../src/domain/ruleEval.ts";
import { createRule, ensureDefaultRules, getVideoRuleRow, listRules } from "../src/domain/rules.ts";
import { EventBus } from "../src/events.ts";
import {
  ACTION_EVAL_NOW,
  ACTION_REFRESH_ALL,
  EVAL_DUE_SCHEDULE,
  EVAL_DUE_TICK_MS,
  EVAL_HOURLY_SCHEDULE,
  evalPassKey,
  registerRuleHandlers,
  registerRuleSchedules,
} from "../src/jobs/handlers/evalPass.ts";
import { PRI0_SWEEP_JOB } from "../src/jobs/handlers/pri0Sweep.ts";
import { JobQueue } from "../src/jobs/queue.ts";
import { JobRegistry, type JobContext } from "../src/jobs/types.ts";
import { createConsoleLogger } from "../src/logging.ts";
import { createTempDb, type TempDb } from "./helpers.ts";
import {
  addAccount,
  addChannel,
  addMedia,
  addSource,
  addVideo,
  DAY,
  effectiveRow,
  harness,
  NOW,
  vid,
  type Harness,
} from "./rulesFixtures.ts";

const log = createConsoleLogger("silent");
const noop = async (): Promise<void> => {};

let temp: TempDb;
let h: Harness;
let account: number;

interface JobDb {
  id: number;
  type: string;
  status: string;
  payload_json: string;
  run_after: number;
}

function jobs(type?: string): JobDb[] {
  return type === undefined
    ? temp.db.all<JobDb>("SELECT * FROM jobs ORDER BY id")
    : temp.db.all<JobDb>("SELECT * FROM jobs WHERE type = ? ORDER BY id", type);
}

function payload(job: JobDb | undefined): Record<string, unknown> {
  return JSON.parse(job?.payload_json ?? "{}") as Record<string, unknown>;
}

function ctxFor(type: string, jobPayload: unknown): JobContext {
  return {
    job: {
      id: 1,
      type,
      status: "running",
      priority: 0,
      payload: jobPayload,
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
    },
    db: temp.db,
    log,
    logDir: temp.dir,
    signal: new AbortController().signal,
    progress: vi.fn(),
    checkpoint: vi.fn(),
  };
}

beforeEach(() => {
  temp = createTempDb();
  h = harness(temp.db, join(temp.dir, "data"));
  account = addAccount(temp.db);
  ensureDefaultRules(temp.db, log);
});

afterEach(() => {
  temp.close();
});

describe("runEvalPass", () => {
  it("evaluates the whole catalog, logs activity and publishes changes", async () => {
    const a = addVideo(temp.db, vid("passA"));
    const b = addVideo(temp.db, vid("passB"));
    addSource(temp.db, a, "subscription", NOW - 10 * DAY);
    addSource(temp.db, b, "watch_later", NOW - 10 * DAY, account);
    const result = await runEvalPass(h.deps, { reason: "test" });
    expect(result).toMatchObject({ mode: "full", evaluated: 2, changed: 2, becamePri0: [] });
    expect(effectiveRow(temp.db, a)?.reclaim_priority).toBe(-1);
    expect(h.seen.filter((e) => e.type === "video.effective")).toHaveLength(2);
    const activity = listActivity(temp.db, { page: 1, perPage: 5 }).rows;
    expect(activity[0]).toMatchObject({
      kind: "rules.eval_pass",
      data: { evaluated: 2, changed: 2 },
    });

    // Nothing changed: no activity row unless the pass was manual.
    await runEvalPass(h.deps, { reason: "hourly" });
    expect(listActivity(temp.db, { page: 1, perPage: 5 }).total).toBe(1);
    await runEvalPass(h.deps, { reason: "manual" });
    expect(listActivity(temp.db, { page: 1, perPage: 5 }).total).toBe(2);
  });

  it("queues the pri-0 sweep when a video became pri 0, and reap per location when registered", async () => {
    const a = addVideo(temp.db, vid("expire"));
    addSource(temp.db, a, "subscription", NOW - 10 * DAY);
    addMedia(temp.db, a, { location_id: 1 });
    await runEvalPass(h.deps, { reason: "first" });
    expect(jobs(PRI0_SWEEP_JOB)).toHaveLength(0);

    h.clock.now = NOW + 5 * DAY;
    const result = await runEvalPass(h.deps, { reason: "later", videoIds: [a] });
    expect(result).toMatchObject({ mode: "ids", evaluated: 1, becamePri0: [a], reapJobIds: [] });
    expect(result.sweepJobId).toBe(jobs(PRI0_SWEEP_JOB)[0]?.id);

    // A full pass re-queues the sweep while pri-0 media remains (deduped) and reaps every location.
    h.registry.register(REAP_JOB, {
      class: "maintenance",
      handler: noop,
      dedupeKey: (p) => JSON.stringify(p),
    });
    temp.db.run(
      `INSERT INTO locations (label, container_path, enabled, created_at, updated_at)
       VALUES ('cold', '/cold', 1, 1, 1), ('off', '/off', 0, 1, 1)`,
    );
    const full = await runEvalPass(h.deps, { reason: "hourly" });
    expect(full.sweepJobId).toBe(result.sweepJobId);
    expect(jobs(PRI0_SWEEP_JOB)).toHaveLength(1);
    expect(jobs(REAP_JOB).map((j) => payload(j))).toEqual([{ location_id: 1 }, { location_id: 2 }]);
    expect(full.reapJobIds).toHaveLength(2);
  });

  it("reaps only the locations a targeted pass touched, and skips follow-ups on request", async () => {
    h.registry.register(REAP_JOB, {
      class: "maintenance",
      handler: noop,
      dedupeKey: (p) => JSON.stringify(p),
    });
    temp.db.run(
      `INSERT INTO locations (label, container_path, enabled, created_at, updated_at)
       VALUES ('cold', '/cold', 1, 1, 1)`,
    );
    const a = addVideo(temp.db, vid("move"));
    await runEvalPass(h.deps, { reason: "first", videoIds: [a], followUps: false });
    expect(jobs()).toHaveLength(0);
    createRule(
      { db: temp.db, log },
      {
        kind: "custom",
        video_id: null,
        position: 1,
        name: "Cold",
        enabled: true,
        condition: { type: "group", op: "and", children: [] },
        effects: { location_id: 2 },
      },
    );
    const result = await runEvalPass(h.deps, { reason: "rule", videoIds: [a, a, vid("unknown")] });
    expect(result.evaluated).toBe(1);
    expect(jobs(REAP_JOB).map((j) => payload(j))).toEqual([{ location_id: 1 }, { location_id: 2 }]);
  });

  it("evaluates only due and never-evaluated videos in due mode", async () => {
    const due = addVideo(temp.db, vid("due"));
    const fresh = addVideo(temp.db, vid("fresh"));
    const later = addVideo(temp.db, vid("later"));
    addSource(temp.db, due, "subscription", NOW - 10 * DAY);
    addSource(temp.db, later, "subscription", NOW - DAY);
    await runEvalPass(h.deps, { reason: "seed", videoIds: [due, later] });
    expect(dueVideoIds(temp.db, NOW)).toEqual([fresh]);
    h.clock.now = NOW + 4 * DAY;
    expect(dueVideoIds(temp.db, h.clock.now)).toEqual([due, fresh]);
    expect(dueVideoIds(temp.db, h.clock.now, 1)).toEqual([due]);
    const result = await runEvalPass(h.deps, { reason: "due", dueOnly: true });
    expect(result).toMatchObject({ mode: "due", evaluated: 2, becamePri0: [due] });
  });

  it("walks big catalogs in batches with progress and one bulk event", async () => {
    temp.db.tx(() => {
      for (let i = 0; i < 1203; i += 1) {
        addVideo(temp.db, `b${String(i).padStart(10, "0")}`);
      }
    });
    const progress = vi.fn();
    const checkpoint = vi.fn();
    const result = await runEvalPass(h.deps, { reason: "big", progress, checkpoint });
    expect(result.evaluated).toBe(1203);
    expect(checkpoint).toHaveBeenCalledTimes(3);
    expect(progress.mock.calls.map((c) => c[0] as number)).toEqual([42, 83, 100]);
    const frames = h.seen.filter((e) => e.type === "video.effective");
    expect(frames).toEqual([expect.objectContaining({ payload: { bulk: true, changed: 1203 } })]);
  });

  it("stops when the checkpoint throws and dispatches rule notifications", async () => {
    const gone = addVideo(temp.db, vid("goneA"), { privacy: "removed", title: "Bye" });
    await expect(
      runEvalPass(h.deps, {
        reason: "x",
        checkpoint: () => {
          throw new Error("cancelled");
        },
      }),
    ).rejects.toThrow("cancelled");
    expect(effectiveRow(temp.db, gone)).toBeUndefined();

    const result = await runEvalPass(h.deps, { reason: "x" });
    expect(result.notifications).toBe(1);
    expect(h.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "rule_notify",
        title: "Notify when a video goes gone",
        body: "Bye",
      }),
    );
  });

  it("handles an empty catalog", async () => {
    const progress = vi.fn();
    expect(await runEvalPass(h.deps, { reason: "empty", progress })).toMatchObject({
      evaluated: 0,
      changed: 0,
      sweepJobId: null,
    });
    expect(progress).not.toHaveBeenCalled();
  });
});

describe("scheduleEvalPass", () => {
  it("debounces to 5 s after the last trigger, capped at 60 s after the first", () => {
    const first = scheduleEvalPass(h.deps, "rules.created");
    expect(first.deduped).toBe(false);
    expect(jobs(EVAL_PASS_JOB)[0]?.run_after).toBe(NOW + EVAL_DEBOUNCE_MS);
    expect(payload(jobs(EVAL_PASS_JOB)[0])).toEqual({
      reason: "rules.created",
      firstTriggerAt: NOW,
    });

    h.clock.now = NOW + 2000;
    expect(scheduleEvalPass(h.deps, "rules.updated")).toEqual({ id: first.id, deduped: true });
    expect(jobs(EVAL_PASS_JOB)[0]?.run_after).toBe(NOW + 2000 + EVAL_DEBOUNCE_MS);

    h.clock.now = NOW + 58_000;
    scheduleEvalPass(h.deps, "rules.updated");
    expect(jobs(EVAL_PASS_JOB)[0]?.run_after).toBe(NOW + EVAL_DEBOUNCE_MAX_WAIT_MS);
    h.clock.now = NOW + 90_000;
    scheduleEvalPass(h.deps, "rules.updated");
    expect(jobs(EVAL_PASS_JOB)[0]?.run_after).toBe(NOW + 90_000);
    expect(jobs(EVAL_PASS_JOB)).toHaveLength(1);
  });

  it("merges targeted triggers and lets a full trigger absorb them", () => {
    const a = scheduleEvalPass(h.deps, "video", { videoIds: ["a", "b"] });
    scheduleEvalPass(h.deps, "video", { videoIds: ["b", "c"] });
    expect(payload(jobs(EVAL_PASS_JOB)[0])["videoIds"]).toEqual(["a", "b", "c"]);
    expect(scheduleEvalPass(h.deps, "rules.updated").id).toBe(a.id);
    expect(payload(jobs(EVAL_PASS_JOB)[0])).toEqual({
      reason: "rules.updated",
      firstTriggerAt: NOW,
    });
    // A queued full pass absorbs later targeted triggers.
    scheduleEvalPass(h.deps, "video", { videoIds: ["d"] });
    expect(payload(jobs(EVAL_PASS_JOB)[0])).not.toHaveProperty("videoIds");
    expect(jobs(EVAL_PASS_JOB)).toHaveLength(1);
  });

  it("turns oversized targeted passes into full passes", () => {
    const many = Array.from({ length: EVAL_TARGETED_MAX_IDS + 1 }, (_, i) => `id${String(i)}`);
    scheduleEvalPass(h.deps, "bulk", { videoIds: many });
    expect(payload(jobs(EVAL_PASS_JOB)[0])).not.toHaveProperty("videoIds");

    temp.db.run("DELETE FROM jobs");
    scheduleEvalPass(h.deps, "one", { videoIds: ["x"] });
    scheduleEvalPass(h.deps, "bulk", { videoIds: many.slice(0, EVAL_TARGETED_MAX_IDS) });
    expect(payload(jobs(EVAL_PASS_JOB)[0])).toEqual({ reason: "bulk", firstTriggerAt: NOW });
  });

  it("never reuses a running pass or a due-only pass", () => {
    h.queue.enqueue({ type: EVAL_PASS_JOB, payload: { reason: "due", dueOnly: true } });
    const first = scheduleEvalPass(h.deps, "a");
    temp.db.run("UPDATE jobs SET status = 'running' WHERE id = ?", first.id);
    const second = scheduleEvalPass(h.deps, "b");
    expect(second.deduped).toBe(false);
    expect(jobs(EVAL_PASS_JOB)).toHaveLength(3);
    temp.db.run("UPDATE jobs SET payload_json = 'null' WHERE id = ?", second.id);
    expect(scheduleEvalPass(h.deps, "c").id).toBe(second.id);
  });

  it("is what rule mutations trigger through mutationDeps", () => {
    const deps = mutationDeps(h.deps);
    createRule(deps, {
      kind: "custom",
      video_id: null,
      position: 1,
      name: "x",
      enabled: true,
      condition: { type: "group", op: "and", children: [] },
      effects: {},
    });
    expect(payload(jobs(EVAL_PASS_JOB)[0])["reason"]).toBe("rules.created");
    deps.onRulesChanged?.("video", ["abcdefghijk"]);
    expect(jobs(EVAL_PASS_JOB)).toHaveLength(1);
  });
});

describe("handlers and schedules", () => {
  it("registers eval_pass, pri0_sweep and the two actions", async () => {
    const registry = new JobRegistry();
    registerRuleHandlers(registry, h.deps);
    for (const type of [EVAL_PASS_JOB, PRI0_SWEEP_JOB, ACTION_EVAL_NOW, ACTION_REFRESH_ALL]) {
      expect(registry.classOf(type)).toBe("maintenance");
    }
    const a = addVideo(temp.db, vid("hA"));
    const b = addVideo(temp.db, vid("hB"));

    const evalPass = registry.get(EVAL_PASS_JOB);
    const ctx = ctxFor(EVAL_PASS_JOB, { reason: "q", videoIds: [a, 3] });
    await evalPass?.handler(ctx);
    expect(effectiveRow(temp.db, a)).toBeDefined();
    expect(effectiveRow(temp.db, b)).toBeUndefined();
    expect(ctx.checkpoint).toHaveBeenCalled();
    expect(ctx.progress).toHaveBeenCalledWith(100, undefined);
    await evalPass?.handler(ctxFor(EVAL_PASS_JOB, { dueOnly: true }));
    expect(effectiveRow(temp.db, b)).toBeDefined();
    await evalPass?.handler(ctxFor(EVAL_PASS_JOB, "junk"));

    const now = ctxFor(ACTION_EVAL_NOW, {});
    await registry.get(ACTION_EVAL_NOW)?.handler(now);
    expect(now.progress).toHaveBeenCalled();
    expect(
      listActivity(temp.db, { page: 1, perPage: 10, kind: "rules.eval_pass" }).rows[0]?.data,
    ).toMatchObject({ reason: "manual" });

    await registry.get(ACTION_REFRESH_ALL)?.handler(ctxFor(ACTION_REFRESH_ALL, {}));
    expect(jobs().map((j) => j.type)).toEqual([EVAL_PASS_JOB]);
    h.registry.register(RECHECK_ALL_JOB, { class: "io", handler: noop });
    await registry.get(ACTION_REFRESH_ALL)?.handler(ctxFor(ACTION_REFRESH_ALL, {}));
    expect(jobs().map((j) => j.type)).toEqual([EVAL_PASS_JOB, RECHECK_ALL_JOB]);
  });

  it("keys eval_pass dedupe by mode", () => {
    expect(evalPassKey({})).toBe("full");
    expect(evalPassKey(null)).toBe("full");
    expect(evalPassKey({ dueOnly: true })).toBe("due");
    expect(evalPassKey({ videoIds: ["b", "a"] })).toBe("ids:a,b");
  });

  it("schedules the interval pass from settings and a cheap due tick", () => {
    const schedules = new Map<string, { ms: number; fn: () => unknown }>();
    const scheduler = {
      every: (name: string, ms: number, fn: () => unknown): void => {
        schedules.set(name, { ms, fn });
      },
    };
    h.settings.value = { ...h.settings.value, "eval.interval_minutes": 15 } as ResolvedSettings;
    h.registry.register(EVAL_PASS_JOB, {
      class: "maintenance",
      handler: noop,
      dedupeKey: evalPassKey,
    });
    registerRuleSchedules(scheduler, h.deps);
    expect(schedules.get(EVAL_HOURLY_SCHEDULE)?.ms).toBe(15 * 60_000);
    expect(schedules.get(EVAL_DUE_SCHEDULE)?.ms).toBe(EVAL_DUE_TICK_MS);

    schedules.get(EVAL_HOURLY_SCHEDULE)?.fn();
    schedules.get(EVAL_HOURLY_SCHEDULE)?.fn();
    expect(jobs(EVAL_PASS_JOB).map((j) => payload(j))).toEqual([{ reason: "hourly" }]);

    expect(schedules.get(EVAL_DUE_SCHEDULE)?.fn()).toBeUndefined();
    addVideo(temp.db, vid("tick"));
    schedules.get(EVAL_DUE_SCHEDULE)?.fn();
    schedules.get(EVAL_DUE_SCHEDULE)?.fn();
    expect(jobs(EVAL_PASS_JOB).map((j) => payload(j))).toEqual([
      { reason: "hourly" },
      { reason: "due", dueOnly: true },
    ]);
  });
});

describe("inspectVideo", () => {
  it("answers the live merge for a known video, by id or URL", async () => {
    addChannel(temp.db, "UCx", "Chan");
    const id = addVideo(temp.db, vid("insp"), { channel_id: "UCx", title: "Hello" });
    addSource(temp.db, id, "subscription", NOW - 20 * DAY);
    const before = inspectVideo(h.deps, `https://youtu.be/${id}`);
    expect(() => InspectResponseSchema.parse(before)).not.toThrow();
    expect(before).toMatchObject({
      video_id: id,
      known: true,
      title: "Hello",
      channel_title: "Chan",
      overrides: null,
      evaluated_at: null,
    });
    expect(before.matched.map((m) => m.name)).toEqual([
      "Global defaults",
      "Expire: subscriptions after 2 weeks",
      "Captions: English only",
    ]);
    expect(before.effective["reclaim_priority"]).toBe(0);
    expect(before.effective["location_id"]).toBe(1);
    expect(before.provenance["reclaim_priority"]).toBe(before.matched[1]?.id);
    await runEvalPass(h.deps, { reason: "x", videoIds: [id] });
    expect(inspectVideo(h.deps, id).evaluated_at).toBe(NOW);
  });

  it("evaluates unknown ids against empty facts and rejects garbage", () => {
    const unknown = inspectVideo(h.deps, "zzzzzzzzzzz");
    expect(unknown).toMatchObject({ known: false, title: null, channel_title: null });
    expect(unknown.matched.map((m) => m.kind)).toEqual(["global", "custom"]);
    expect(unknown.effective["reclaim_priority"]).toBe(-1);
    expect(() => inspectVideo(h.deps, "not a video")).toThrow(DomainError);
  });

  it("skips matched ids that are not in the rule cache", () => {
    temp.db.run(
      "UPDATE rules SET effects_json = '{\"bogus\":1}' WHERE name = 'Captions: English only'",
    );
    const view = inspectVideo(h.deps, "zzzzzzzzzzz");
    expect(view.matched.map((m) => m.name)).toEqual(["Global defaults"]);
  });
});

describe("setVideoOverrides", () => {
  it("sets, re-evaluates immediately, and clears", async () => {
    const id = addVideo(temp.db, vid("ovr"));
    const view = await setVideoOverrides(h.deps, id, { include: false, max_height: 720 });
    expect(view.overrides).toEqual({ include: false, max_height: 720 });
    expect(view.matched.at(-1)).toMatchObject({ kind: "video", name: "Video override" });
    expect(view.provenance["include"]).toBe(view.matched.at(-1)?.id);
    expect(effectiveRow(temp.db, id)?.include).toBe(0);
    expect(h.seen.some((e) => e.type === "rules.changed")).toBe(true);
    expect(jobs(EVAL_PASS_JOB)).toHaveLength(0);

    const pri0 = await setVideoOverrides(h.deps, id, { reclaim_priority: 0 });
    expect(pri0.effective["reclaim_priority"]).toBe(0);
    expect(jobs(PRI0_SWEEP_JOB)).toHaveLength(1);

    const cleared = await setVideoOverrides(h.deps, id, null);
    expect(cleared.overrides).toBeNull();
    expect(effectiveRow(temp.db, id)?.reclaim_priority).toBe(-1);
    expect(getVideoRuleRow(temp.db, id)).toBeUndefined();
  });

  it("validates, accepts unknown videos and keeps the Trashed name while pri 0", async () => {
    await expect(setVideoOverrides(h.deps, vid("bad"), { nope: 1 })).rejects.toThrow(DomainError);
    await expect(setVideoOverrides(h.deps, "??", {})).rejects.toThrow(DomainError);
    const ghost = await setVideoOverrides(h.deps, "yyyyyyyyyyy", { include: false });
    expect(ghost).toMatchObject({ known: false, overrides: { include: false } });

    const id = addVideo(temp.db, vid("trashname"));
    await trashVideos(h.deps, [id]);
    await setVideoOverrides(h.deps, id, { reclaim_priority: 0, include: false });
    expect(getVideoRuleRow(temp.db, id)?.name).toBe("Trashed");
    await setVideoOverrides(h.deps, id, { include: false });
    expect(getVideoRuleRow(temp.db, id)?.name).toBe("Video override");
  });
});

describe("trashVideos", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cellar-trash-"));
    temp.db.run("UPDATE locations SET container_path = ? WHERE id = 1", root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("adds a pri-0 video rule, evaluates and sweeps immediately, keeping other overrides", async () => {
    const a = addVideo(temp.db, vid("trashA"));
    const b = addVideo(temp.db, vid("trashB"));
    addSource(temp.db, a, "watch_later", NOW - DAY, account);
    await setVideoOverrides(h.deps, b, { max_height: 480 });
    for (const id of [a, b]) {
      mkdirSync(join(root, "UC", id), { recursive: true });
      writeFileSync(join(root, "UC", id, "v.mkv"), "data");
      addMedia(temp.db, id, { rel_path: `UC/${id}/v.mkv`, size_bytes: 4 });
    }
    const result = await trashVideos(h.deps, [a, b, a]);
    expect(result).toEqual({
      videoIds: [a, b],
      evaluated: 2,
      sweep: { videos: 2, files: 2, bytes: 8, errors: 0 },
    });
    expect(existsSync(join(root, "UC", a))).toBe(false);
    expect(getVideoRuleRow(temp.db, a)?.name).toBe("Trashed");
    expect(JSON.parse(getVideoRuleRow(temp.db, b)?.effects_json ?? "{}")).toEqual({
      max_height: 480,
      reclaim_priority: 0,
    });
    expect(effectiveRow(temp.db, a)?.reclaim_priority).toBe(0);
    expect(jobs(PRI0_SWEEP_JOB)).toHaveLength(0);
    const kinds = listActivity(temp.db, { page: 1, perPage: 20 }).rows.map((r) => r.kind);
    expect(kinds).toContain("rules.trashed");
    expect(kinds.filter((k) => k === "media.deleted")).toHaveLength(2);
  });

  it("rejects bad ids and does nothing for an empty list", async () => {
    await expect(trashVideos(h.deps, ["nope"])).rejects.toThrow(DomainError);
    expect(await trashVideos(h.deps, [])).toEqual({
      videoIds: [],
      evaluated: 0,
      sweep: { videos: 0, files: 0, bytes: 0, errors: 0 },
    });
  });
});

describe("previewCondition", () => {
  it("counts matches over the catalog with a sample of 10", () => {
    addChannel(temp.db, "UCp", "Preview Channel");
    for (let i = 0; i < 15; i += 1) {
      addVideo(temp.db, `p${String(i).padStart(10, "0")}`, {
        channel_id: "UCp",
        views: i,
        title: i === 0 ? null : `T${String(i)}`,
      });
    }
    const preview = previewCondition(h.deps, {
      type: "cond",
      field: "views",
      op: "lt",
      value: 12,
    });
    expect(() => RulePreviewSchema.parse(preview)).not.toThrow();
    expect(preview.count).toBe(12);
    expect(preview.total).toBe(15);
    expect(preview.sample).toHaveLength(10);
    expect(preview.sample[0]).toEqual({
      id: "p0000000000",
      title: "",
      channel_title: "Preview Channel",
    });

    const capped = previewCondition(
      h.deps,
      { type: "group", op: "and", children: [] },
      { maxVideos: 4 },
    );
    expect(capped).toMatchObject({ count: 4, total: 4 });
  });

  it("rejects invalid conditions and falls back to now without installed_at", () => {
    expect(() => previewCondition(h.deps, { type: "cond", field: "zzz" })).toThrow(DomainError);
    temp.db.run("DELETE FROM kv WHERE key = 'installed_at'");
    expect(
      previewCondition(h.deps, {
        type: "cond",
        field: "upload_date",
        op: "before_install_minus",
        value: "P1D",
      }),
    ).toMatchObject({ count: 0, total: 0 });
  });
});

describe("createRulesDeps defaults", () => {
  it("reads settings and the first location from their tables and notifies for real", async () => {
    setKv(temp.db, "unused", 1);
    temp.db.run(
      "INSERT INTO settings (key, value_json, updated_at) VALUES ('eval.interval_minutes', '30', 1)",
    );
    expect(readStoredSettings(temp.db)["eval.interval_minutes"]).toBe(30);
    expect(queryFirstEnabledLocationId(temp.db)).toBe(1);
    temp.db.run("UPDATE locations SET enabled = 0");
    expect(queryFirstEnabledLocationId(temp.db)).toBeNull();

    const registry = new JobRegistry();
    const queue = new JobQueue(temp.db, { registry });
    const deps = createRulesDeps({
      db: temp.db,
      log,
      events: new EventBus(),
      dataDir: temp.dir,
      registry,
      enqueue: (input) => queue.enqueue(input),
    });
    expect(deps.getSettings()["eval.interval_minutes"]).toBe(30);
    expect(deps.firstEnabledLocationId()).toBeNull();
    await deps.notify({
      type: "rule_notify",
      title: "Rule",
      body: "Video",
      videoId: "abcdefghijk",
      force: true,
      data: { ruleId: 1 },
    });
    await deps.recordFsError("disk on fire");
    const types = temp.db
      .all<{ type: string }>("SELECT type FROM notifications ORDER BY id")
      .map((r) => r.type);
    expect(types).toEqual(["rule_notify", "fs_error"]);
    expect(listRules(temp.db)).toHaveLength(8);
  });
});
