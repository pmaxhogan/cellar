import {
  evaluateCondition,
  parseVideoId,
  resolveSettings,
  validateAst,
  VIDEO_ID_RE,
  type Effects,
  type InspectResponse,
  type ResolvedSettings,
  type RulePreview,
} from "@cellar/shared";
import type { Logger } from "pino";
import type { Db } from "../db/db.ts";
import { getKv, INSTALLED_AT_KEY } from "../db/kv.ts";
import { parseJsonColumn } from "../db/paged.ts";
import type { EventBus } from "../events.ts";
import {
  PRI0_SWEEP_JOB,
  sweepPri0,
  type SweepDeps,
  type SweepResult,
} from "../jobs/handlers/pri0Sweep.ts";
import type { EnqueueInput, EnqueueResult } from "../jobs/queue.ts";
import type { JobRegistry } from "../jobs/types.ts";
import { logActivity } from "./activity.ts";
import {
  computeEffective,
  dispatchRuleNotifications,
  emptyFacts,
  evaluateVideo,
  loadEvalContext,
  loadVideoFacts,
  type EvalDeps,
  type EvaluateResult,
  type PendingNotification,
  type RuleNotifyInput,
} from "./effective.ts";
import { invalid } from "./errors.ts";
import { notify, recordFsError } from "./notifications.ts";
import {
  getVideoRuleRow,
  parseVideoEffects,
  publishVideoRuleChange,
  toRuleRow,
  TRASH_RULE_NAME,
  upsertVideoRule,
  VIDEO_OVERRIDE_RULE_NAME,
  type RulesMutationDeps,
} from "./rules.ts";

/**
 * Evaluation passes over the catalog, the debounced trigger every rule or
 * catalog change goes through, and the per-video entry points (Inspect,
 * overrides, trash, preview).
 */

export const EVAL_PASS_JOB = "eval_pass";
export const REAP_JOB = "reap";
export const RECHECK_ALL_JOB = "recheck_all";
/** Batch size: one transaction and one bulk facts load per batch. */
export const EVAL_BATCH_SIZE = 500;
/** A debounced pass runs no sooner than this after the last trigger... */
export const EVAL_DEBOUNCE_MS = 5000;
/** ...and no later than this after the first one, so a stream of edits cannot starve it. */
export const EVAL_DEBOUNCE_MAX_WAIT_MS = 60_000;
/** A queued targeted pass that grows past this many ids becomes a full pass. */
export const EVAL_TARGETED_MAX_IDS = 5000;
/** Per-video `video.effective` SSE frames per pass before one bulk frame replaces them. */
export const EVAL_EVENT_LIMIT = 200;
/** `POST /api/rules/preview` evaluates at most this many videos. */
export const PREVIEW_MAX_VIDEOS = 50_000;
export const PREVIEW_SAMPLE_SIZE = 10;

/** Everything the rules subsystem needs from the rest of the server. */
export interface RulesDeps extends EvalDeps, SweepDeps {
  db: Db;
  log: Logger;
  events?: EventBus | undefined;
  now?: () => number;
  /** Wired to domain/settings.ts by the orchestrator. */
  getSettings(): ResolvedSettings;
  /** Scheduler.enqueue or a JobQueue over the same db (the scheduler pumps on job.queued). */
  enqueue(input: EnqueueInput): EnqueueResult;
  /** To ask whether optional job types (reap, recheck_all) exist yet. */
  registry: Pick<JobRegistry, "has">;
}

export interface CreateRulesDepsInput {
  db: Db;
  log: Logger;
  events?: EventBus | undefined;
  dataDir: string;
  registry: Pick<JobRegistry, "has">;
  enqueue: (input: EnqueueInput) => EnqueueResult;
  now?: () => number;
  getSettings?: () => ResolvedSettings;
  firstEnabledLocationId?: () => number | null;
  notify?: (input: RuleNotifyInput) => Promise<unknown>;
  recordFsError?: (detail: string) => Promise<unknown>;
}

/** Sparse overrides straight from the `settings` table, until domain/settings.ts is wired. */
export function readStoredSettings(db: Db): ResolvedSettings {
  const sparse: Record<string, unknown> = {};
  for (const row of db.all<{ key: string; value_json: string }>(
    "SELECT key, value_json FROM settings",
  )) {
    sparse[row.key] = parseJsonColumn(row.value_json);
  }
  return resolveSettings(sparse);
}

/** Lowest-id enabled location, straight from the table, until domain/locations.ts is wired. */
export function queryFirstEnabledLocationId(db: Db): number | null {
  return (
    db.get<{ id: number }>("SELECT id FROM locations WHERE enabled = 1 ORDER BY id LIMIT 1")?.id ??
    null
  );
}

/**
 * Build RulesDeps with working defaults for every seam the orchestrator has
 * not wired yet (settings and locations read their tables directly;
 * notifications go through domain/notifications.ts).
 */
export function createRulesDeps(input: CreateRulesDepsInput): RulesDeps {
  const getSettings = input.getSettings ?? (() => readStoredSettings(input.db));
  const notifyDeps = { db: input.db, log: input.log, events: input.events, getSettings };
  return {
    db: input.db,
    log: input.log,
    events: input.events,
    ...(input.now === undefined ? {} : { now: input.now }),
    dataDir: input.dataDir,
    registry: input.registry,
    enqueue: input.enqueue,
    getSettings,
    firstEnabledLocationId:
      input.firstEnabledLocationId ?? (() => queryFirstEnabledLocationId(input.db)),
    notify: input.notify ?? ((n) => notify(notifyDeps, n)),
    recordFsError: input.recordFsError ?? ((detail) => recordFsError(notifyDeps, detail)),
  };
}

function nowOf(deps: Pick<RulesDeps, "now">): number {
  return (deps.now ?? Date.now)();
}

// ---------------------------------------------------------------------------
// Passes
// ---------------------------------------------------------------------------

export interface EvalPassPayload {
  reason: string;
  videoIds?: string[];
  dueOnly?: boolean;
  /** When the first trigger of a debounced pass happened (epoch ms). */
  firstTriggerAt?: number;
}

export interface EvalPassOptions {
  reason: string;
  /** Only these videos. */
  videoIds?: readonly string[];
  /** Only videos whose next_eval_at is due, plus videos never evaluated. */
  dueOnly?: boolean;
  /** Enqueue the pri-0 sweep and reap jobs afterwards. Default true. */
  followUps?: boolean;
  /** Called between batches (JobContext.checkpoint); throwing stops the pass. */
  checkpoint?: () => void;
  progress?: (pct: number, message?: string) => void;
}

export interface EvalPassResult {
  mode: "full" | "due" | "ids";
  evaluated: number;
  changed: number;
  /** Videos whose reclaim priority became 0 in this pass. */
  becamePri0: string[];
  notifications: number;
  sweepJobId: number | null;
  reapJobIds: number[];
}

function* chunks<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}

/** Video ids in id order, a batch at a time (keyset paging, so inserts mid-pass are safe). */
function* allVideoBatches(db: Db, size: number): Generator<string[]> {
  let after = "";
  for (;;) {
    const ids = db
      .all<{ id: string }>("SELECT id FROM videos WHERE id > ? ORDER BY id LIMIT ?", after, size)
      .map((row) => row.id);
    if (ids.length === 0) {
      return;
    }
    yield ids;
    after = ids[ids.length - 1] as string;
  }
}

/** Ids due for evaluation: next_eval_at reached, or never evaluated. */
export function dueVideoIds(db: Db, now: number, limit?: number): string[] {
  return db
    .all<{ id: string }>(
      `SELECT v.id FROM videos v LEFT JOIN video_effective e ON e.video_id = v.id
        WHERE e.video_id IS NULL OR e.next_eval_at <= ?
        ORDER BY v.id ${limit === undefined ? "" : "LIMIT ?"}`,
      now,
      ...(limit === undefined ? [] : [limit]),
    )
    .map((row) => row.id);
}

function enabledLocationIds(db: Db): number[] {
  return db
    .all<{ id: number }>("SELECT id FROM locations WHERE enabled = 1 ORDER BY id")
    .map((row) => row.id);
}

function hasPri0Media(db: Db): boolean {
  return (
    db.get(
      `SELECT 1 FROM media m JOIN video_effective e ON e.video_id = m.video_id
        WHERE e.reclaim_priority = 0 AND m.kind IN ('video', 'audio')
          AND m.location_id IS NOT NULL LIMIT 1`,
    ) !== undefined
  );
}

function publishEffectiveEvents(deps: RulesDeps, changed: readonly EvaluateResult[]): void {
  if (deps.events === undefined || changed.length === 0) {
    return;
  }
  if (changed.length > EVAL_EVENT_LIMIT) {
    deps.events.publish("video.effective", { bulk: true, changed: changed.length });
    return;
  }
  for (const result of changed) {
    deps.events.publish("video.effective", {
      videoId: result.videoId,
      before: result.before,
      after: result.after,
    });
  }
}

/**
 * Evaluate every video (or the given ids, or the due ones) in batches of 500,
 * one transaction per batch, rules loaded once. Afterwards: dispatch the rule
 * notifications, enqueue a `pri0_sweep` when a video became pri 0 (or, on a
 * full pass, when any pri-0 media is left), and a `reap` job per affected
 * location (every enabled location after a full pass) when that handler is
 * registered.
 */
export async function runEvalPass(
  deps: RulesDeps,
  options: EvalPassOptions,
): Promise<EvalPassResult> {
  const log = deps.log.child({ mod: "ruleEval" });
  const now = nowOf(deps);
  const mode: EvalPassResult["mode"] =
    options.videoIds !== undefined ? "ids" : options.dueOnly === true ? "due" : "full";
  const ctx = loadEvalContext(deps, now);

  let batches: Iterable<string[]>;
  let total: number;
  if (mode === "ids") {
    const ids = [...new Set(options.videoIds)];
    batches = chunks(ids, EVAL_BATCH_SIZE);
    total = ids.length;
  } else if (mode === "due") {
    const ids = dueVideoIds(deps.db, now);
    batches = chunks(ids, EVAL_BATCH_SIZE);
    total = ids.length;
  } else {
    batches = allVideoBatches(deps.db, EVAL_BATCH_SIZE);
    total = deps.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM videos")?.n ?? 0;
  }

  const changed: EvaluateResult[] = [];
  const becamePri0: string[] = [];
  const pending: PendingNotification[] = [];
  let evaluated = 0;
  for (const batch of batches) {
    options.checkpoint?.();
    const facts = loadVideoFacts(deps.db, batch, now);
    const results = deps.db.tx(() =>
      batch.map((id) =>
        evaluateVideo(deps, id, now, { ctx, facts: facts.get(id) ?? null, emit: false }),
      ),
    );
    for (const result of results) {
      if (result.after === null) {
        continue;
      }
      evaluated += 1;
      pending.push(...result.notifications);
      if (result.changed) {
        changed.push(result);
        if (result.after.reclaim_priority === 0 && result.before?.reclaim_priority !== 0) {
          becamePri0.push(result.videoId);
        }
      }
    }
    if (total > 0) {
      options.progress?.(Math.min(100, Math.round((evaluated / total) * 100)));
    }
  }

  publishEffectiveEvents(deps, changed);
  await dispatchRuleNotifications(deps, pending);

  let sweepJobId: number | null = null;
  const reapJobIds: number[] = [];
  if (options.followUps !== false) {
    if (becamePri0.length > 0 || (mode === "full" && hasPri0Media(deps.db))) {
      sweepJobId = deps.enqueue({ type: PRI0_SWEEP_JOB, payload: {}, dedupe: true }).id;
    }
    const locations = new Set<number>();
    if (mode === "full") {
      for (const id of enabledLocationIds(deps.db)) locations.add(id);
    }
    for (const result of changed) {
      if (result.before?.location_id != null) locations.add(result.before.location_id);
      if (result.after?.location_id != null) locations.add(result.after.location_id);
    }
    // Newly included or re-prioritised videos may now be downloadable.
    if (changed.length > 0 && deps.registry.has("download_scan")) {
      deps.enqueue({ type: "download_scan", payload: {}, dedupe: true });
    }
    if (locations.size > 0) {
      if (deps.registry.has(REAP_JOB)) {
        for (const locationId of [...locations].sort((a, b) => a - b)) {
          reapJobIds.push(
            deps.enqueue({ type: REAP_JOB, payload: { location_id: locationId }, dedupe: true }).id,
          );
        }
      } else {
        log.debug({ locations: [...locations] }, "no reap handler registered; reap not queued");
      }
    }
  }

  const result: EvalPassResult = {
    mode,
    evaluated,
    changed: changed.length,
    becamePri0,
    notifications: pending.length,
    sweepJobId,
    reapJobIds,
  };
  log.info(
    { ...result, becamePri0: becamePri0.length, reason: options.reason },
    "eval pass finished",
  );
  if (changed.length > 0 || options.reason === "manual") {
    logActivity(
      { db: deps.db, events: deps.events, ...(deps.now === undefined ? {} : { now: deps.now }) },
      {
        kind: "rules.eval_pass",
        message: `Evaluated ${String(evaluated)} video(s), ${String(changed.length)} changed`,
        data: {
          mode,
          reason: options.reason,
          evaluated,
          changed: changed.length,
          pri0: becamePri0.length,
        },
      },
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Debounced trigger
// ---------------------------------------------------------------------------

interface QueuedPass {
  id: number;
  payload: EvalPassPayload;
  run_after: number;
}

function queuedPasses(db: Db): QueuedPass[] {
  return db
    .all<{ id: number; payload_json: string; run_after: number }>(
      "SELECT id, payload_json, run_after FROM jobs WHERE type = ? AND status = 'queued' ORDER BY id",
      EVAL_PASS_JOB,
    )
    .map((row) => {
      const payload = parseJsonColumn(row.payload_json);
      return {
        id: row.id,
        run_after: row.run_after,
        payload: (payload !== null && typeof payload === "object"
          ? payload
          : {}) as EvalPassPayload,
      };
    });
}

function isFull(payload: EvalPassPayload): boolean {
  return payload.videoIds === undefined && payload.dueOnly !== true;
}

/**
 * Ask for an evaluation pass after a change (any rule edit, video metadata or
 * sources). Calls within the debounce window collapse into one queued
 * `eval_pass` that runs no sooner than 5 s after the LAST trigger and no later
 * than 60 s after the first. A full request absorbs targeted ones; targeted
 * requests merge their ids. A pass already running is never reused: it may
 * have loaded the rules before the change.
 */
export function scheduleEvalPass(
  deps: Pick<RulesDeps, "db" | "enqueue" | "now">,
  reason: string,
  options: { videoIds?: readonly string[] } = {},
): EnqueueResult {
  const now = nowOf(deps);
  const ids = options.videoIds === undefined ? undefined : [...new Set(options.videoIds)];
  return deps.db.tx((): EnqueueResult => {
    const queued = queuedPasses(deps.db).filter((pass) => pass.payload.dueOnly !== true);
    const full = queued.find((pass) => isFull(pass.payload));
    const targeted = queued.find((pass) => !isFull(pass.payload));
    const bump = (pass: QueuedPass, payload: EvalPassPayload): EnqueueResult => {
      const first = payload.firstTriggerAt ?? now;
      const runAfter = Math.max(
        now,
        Math.min(now + EVAL_DEBOUNCE_MS, first + EVAL_DEBOUNCE_MAX_WAIT_MS),
      );
      deps.db.run(
        "UPDATE jobs SET run_after = ?, payload_json = ? WHERE id = ? AND status = 'queued'",
        runAfter,
        JSON.stringify({ ...payload, firstTriggerAt: first }),
        pass.id,
      );
      return { id: pass.id, deduped: true };
    };

    if (full !== undefined) {
      return bump(full, full.payload);
    }
    if (ids !== undefined && targeted !== undefined) {
      const merged = [...new Set([...(targeted.payload.videoIds ?? []), ...ids])];
      if (merged.length <= EVAL_TARGETED_MAX_IDS) {
        return bump(targeted, { ...targeted.payload, videoIds: merged });
      }
      const { videoIds: _drop, ...rest } = targeted.payload;
      return bump(targeted, { ...rest, reason });
    }
    if (ids === undefined && targeted !== undefined) {
      const { videoIds: _drop, ...rest } = targeted.payload;
      return bump(targeted, { ...rest, reason });
    }
    const payload: EvalPassPayload = {
      reason,
      ...(ids === undefined || ids.length > EVAL_TARGETED_MAX_IDS ? {} : { videoIds: ids }),
      firstTriggerAt: now,
    };
    return deps.enqueue({ type: EVAL_PASS_JOB, payload, runAfter: now + EVAL_DEBOUNCE_MS });
  });
}

/** RulesMutationDeps without the debounced trigger (the caller evaluates right away). */
function plainMutationDeps(deps: RulesDeps): RulesMutationDeps {
  return {
    db: deps.db,
    log: deps.log,
    events: deps.events,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  };
}

/** RulesMutationDeps for rule CRUD: every committed change schedules a debounced pass. */
export function mutationDeps(deps: RulesDeps): RulesMutationDeps {
  return {
    ...plainMutationDeps(deps),
    onRulesChanged: (reason, videoIds) => {
      scheduleEvalPass(deps, reason, videoIds === undefined ? {} : { videoIds });
    },
  };
}

// ---------------------------------------------------------------------------
// Inspect, overrides, trash
// ---------------------------------------------------------------------------

/** Normalise any identifier to a video id or throw a 400. */
export function requireVideoId(input: string): string {
  const id = parseVideoId(input);
  if (id === null) {
    throw invalid("That is not a YouTube video id or URL.", { id: input });
  }
  return id;
}

/**
 * GET /api/inspect: the live merge for one video (rules as they are now),
 * with provenance and the matched rules in priority order. An id the catalog
 * does not know is evaluated against empty facts and answers `known: false`.
 */
export function inspectVideo(deps: RulesDeps, input: string): InspectResponse {
  const videoId = requireVideoId(input);
  const now = nowOf(deps);
  const facts = loadVideoFacts(deps.db, [videoId], now).get(videoId);
  const ctx = loadEvalContext(deps, now);
  const computed = computeEffective(ctx, facts ?? emptyFacts(videoId), now);
  const videoRule = getVideoRuleRow(deps.db, videoId);
  const evaluatedAt =
    deps.db.get<{ evaluated_at: number }>(
      "SELECT evaluated_at FROM video_effective WHERE video_id = ?",
      videoId,
    )?.evaluated_at ?? null;
  return {
    video_id: videoId,
    known: facts !== undefined,
    title: facts?.title ?? null,
    channel_title: facts?.channel_title ?? null,
    matched: computed.matchedRuleIds.flatMap((id) => {
      const rule = ctx.layers.byId.get(id);
      return rule === undefined
        ? []
        : [{ id: rule.id, kind: rule.kind, name: rule.name, position: rule.position }];
    }),
    effective: computed.effective as Record<string, unknown>,
    provenance: computed.provenance,
    overrides: videoRule === undefined ? null : toRuleRow(videoRule).effects,
    evaluated_at: evaluatedAt,
  };
}

/**
 * PUT /api/videos/:id/overrides: set (or with null / {} clear) the video
 * rule, re-evaluate the video immediately (sweeping it when it became pri 0)
 * and answer the Inspect view.
 */
export async function setVideoOverrides(
  deps: RulesDeps,
  input: string,
  effects: unknown,
): Promise<InspectResponse> {
  const videoId = requireVideoId(input);
  const parsed: Effects | null = effects === null ? null : parseVideoEffects(effects);
  const now = nowOf(deps);
  const existing = getVideoRuleRow(deps.db, videoId);
  const keepTrashName = existing?.name === TRASH_RULE_NAME && parsed?.reclaim_priority === 0;
  const name = keepTrashName ? TRASH_RULE_NAME : VIDEO_OVERRIDE_RULE_NAME;
  const row = upsertVideoRule(deps.db, videoId, parsed, name, now);
  publishVideoRuleChange(
    plainMutationDeps(deps),
    row === null ? "video_cleared" : "video_set",
    row === null ? `Overrides cleared for ${videoId}` : `Overrides set for ${videoId}`,
    [videoId],
  );
  await runEvalPass(deps, { reason: "overrides", videoIds: [videoId] });
  return inspectVideo(deps, videoId);
}

export interface TrashResult {
  videoIds: string[];
  evaluated: number;
  sweep: SweepResult;
}

/**
 * The trash action (POST /api/videos/trash calls this): a `video` rule named
 * "Trashed" with reclaim_priority 0 per id (other overrides are kept), an
 * immediate evaluation and an immediate pri-0 sweep of those ids. Metadata,
 * history, thumbnails and captions stay.
 */
export async function trashVideos(deps: RulesDeps, ids: readonly string[]): Promise<TrashResult> {
  const videoIds = [...new Set(ids)];
  const bad = videoIds.filter((id) => !VIDEO_ID_RE.test(id));
  if (bad.length > 0) {
    throw invalid("Some ids are not YouTube video ids.", { ids: bad.slice(0, 20) });
  }
  if (videoIds.length === 0) {
    return { videoIds, evaluated: 0, sweep: { videos: 0, files: 0, bytes: 0, errors: 0 } };
  }
  const now = nowOf(deps);
  deps.db.tx(() => {
    for (const id of videoIds) {
      const existing = getVideoRuleRow(deps.db, id);
      const current = existing === undefined ? {} : toRuleRow(existing).effects;
      upsertVideoRule(
        deps.db,
        id,
        parseVideoEffects({ ...current, reclaim_priority: 0 }),
        TRASH_RULE_NAME,
        now,
      );
    }
  });
  publishVideoRuleChange(
    plainMutationDeps(deps),
    "trashed",
    `Trashed ${String(videoIds.length)} video(s)`,
    videoIds,
  );
  const pass = await runEvalPass(deps, { reason: "trash", videoIds, followUps: false });
  const sweep = await sweepPri0(deps, { videoIds });
  return { videoIds, evaluated: pass.evaluated, sweep };
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/**
 * POST /api/rules/preview: run a condition over the catalog (at most 50k
 * videos, in id order). `total` is the number of videos evaluated, so
 * `count / total` is always a true ratio; `sample` is the first 10 matches.
 */
export function previewCondition(
  deps: Pick<RulesDeps, "db" | "now">,
  condition: unknown,
  options: { maxVideos?: number } = {},
): RulePreview {
  const maxVideos = options.maxVideos ?? PREVIEW_MAX_VIDEOS;
  const ast = validateAst(condition);
  if (!ast.ok) {
    throw invalid("The rule condition is not valid.", { condition: ast.errors });
  }
  const now = nowOf(deps);
  const ctx = { now, installed_at: getKv<number>(deps.db, INSTALLED_AT_KEY) ?? now };
  let count = 0;
  let total = 0;
  const sample: RulePreview["sample"] = [];
  for (const batch of allVideoBatches(deps.db, EVAL_BATCH_SIZE)) {
    const facts = loadVideoFacts(deps.db, batch, now);
    for (const id of batch) {
      if (total >= maxVideos) {
        return { count, total, sample };
      }
      const video = facts.get(id);
      if (video === undefined) {
        continue;
      }
      total += 1;
      if (evaluateCondition(ast.node, video, ctx)) {
        count += 1;
        if (sample.length < PREVIEW_SAMPLE_SIZE) {
          sample.push({ id, title: video.title ?? "", channel_title: video.channel_title });
        }
      }
    }
  }
  return { count, total, sample };
}
