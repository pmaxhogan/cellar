import {
  nextEvalAt,
  PRIVACY_VALUES,
  resolveEffective,
  SOURCE_KINDS,
  VIDEO_TYPES,
  type EffectiveSettings,
  type EvalContext,
  type Privacy,
  type Provenance,
  type SourceKind,
  type VideoFacts,
  type VideoSourceFact,
  type VideoType,
} from "@cellar/shared";
import type { Logger } from "pino";
import type { SQLInputValue } from "node:sqlite";
import type { Db } from "../db/db.ts";
import { getKv, INSTALLED_AT_KEY } from "../db/kv.ts";
import { parseJsonColumn } from "../db/paged.ts";
import type { EventBus } from "../events.ts";
import { loadRuleLayers, type RuleLayersCache } from "./rules.ts";

/**
 * Per-video evaluation: build the `VideoFacts` a condition reads, merge the
 * rule layers with the shared `resolveEffective`, substitute the first enabled
 * location for a null `location_id`, compute `next_eval_at` and upsert
 * `video_effective`.
 */

/** A notification a rule's `notify` effect asks for (spec 4.3 `notify`). */
export interface RuleNotifyInput {
  type: "rule_notify";
  title: string;
  body: string;
  videoId: string;
  force: true;
  data: { ruleId: number };
}

export interface EvalDeps {
  db: Db;
  log: Logger;
  events?: EventBus | undefined;
  now?: () => number;
  /** Lowest-id enabled location; wired to domain/locations.ts by the orchestrator. */
  firstEnabledLocationId(): number | null;
  /** Create a notification (domain/notifications.ts notify). */
  notify(input: RuleNotifyInput): Promise<unknown>;
}

/** The denormalised columns the reaper, mover and download scheduler read. */
export interface EffectiveSummary {
  reclaim_priority: number;
  location_id: number | null;
  include: boolean;
}

/** Inputs shared by every video of one pass. */
export interface EvalPassContext {
  layers: RuleLayersCache;
  installedAt: number;
  firstLocationId: number | null;
}

export interface PendingNotification {
  ruleId: number;
  ruleName: string;
  videoId: string;
  title: string;
}

export interface EvaluateResult {
  videoId: string;
  /** reclaim_priority, location_id or include differ from the stored row (or it is new). */
  changed: boolean;
  before: EffectiveSummary | null;
  after: EffectiveSummary | null;
  /** Rule notifications already counted in rule_notify_counts, to dispatch after commit. */
  notifications: PendingNotification[];
}

export interface ComputedEffective {
  effective: EffectiveSettings;
  provenance: Provenance;
  matchedRuleIds: number[];
  nextEvalAt: number | null;
}

export function loadEvalContext(
  deps: Pick<EvalDeps, "db" | "log" | "firstEnabledLocationId">,
  now: number,
): EvalPassContext {
  return {
    layers: loadRuleLayers(deps.db, deps.log),
    installedAt: getKv<number>(deps.db, INSTALLED_AT_KEY) ?? now,
    firstLocationId: deps.firstEnabledLocationId(),
  };
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

interface VideoDbRow {
  id: string;
  channel_id: string | null;
  channel_title: string | null;
  title: string | null;
  description: string | null;
  tags_json: string | null;
  type: string | null;
  privacy: string | null;
  gone_since: number | null;
  upload_date: number | null;
  published_at: number | null;
  duration_s: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  ryd_ratio: number | null;
  max_height: number | null;
  max_fps: number | null;
  has_av1: number | null;
  has_vp9: number | null;
  has_h264: number | null;
  is_hdr: number | null;
  caption_available: number | null;
}

interface SourceDbRow {
  video_id: string;
  account_id: number | null;
  source: string;
  first_seen_at: number;
  last_seen_at: number;
  source_ts: number | null;
}

interface MediaDbRow {
  video_id: string;
  downloaded_at: number | null;
  location_id: number | null;
  vcodec: string | null;
}

const VIDEO_COLUMNS = `v.id, v.channel_id, c.title AS channel_title, v.title, v.description,
  v.tags_json, v.type, v.privacy, v.gone_since, v.upload_date, v.published_at, v.duration_s,
  v.views, v.likes, v.comments, v.ryd_ratio, v.max_height, v.max_fps, v.has_av1, v.has_vp9,
  v.has_h264, v.is_hdr, v.caption_available`;

function bool(value: number | null): boolean | null {
  return value === null ? null : value !== 0;
}

function tagsOf(json: string | null): string[] {
  const parsed = parseJsonColumn(json);
  return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
}

function oneOf<T extends string>(values: readonly T[], value: string | null): T | null {
  return value !== null && (values as readonly string[]).includes(value) ? (value as T) : null;
}

/** Facts for an id the catalog does not know: no metadata, no sources, no media. */
export function emptyFacts(id: string): VideoFacts {
  return {
    id,
    channel_id: null,
    channel_title: null,
    title: null,
    description: null,
    tags: [],
    type: null,
    privacy: null,
    gone_since: null,
    upload_date: null,
    published_at: null,
    duration_s: null,
    views: null,
    likes: null,
    comments: null,
    ryd_ratio: null,
    max_height: null,
    max_fps: null,
    has_av1: null,
    has_vp9: null,
    has_h264: null,
    is_hdr: null,
    caption_available: null,
    sources: [],
    media: null,
    share_link_count: 0,
  };
}

function placeholders(count: number): string {
  return new Array<string>(count).fill("?").join(", ");
}

/**
 * Bulk facts for up to a few hundred ids: one query per table with an IN
 * list, so a pass or a preview over the whole catalog stays cheap. Ids that
 * are not in `videos` are absent from the map.
 */
export function loadVideoFacts(
  db: Db,
  ids: readonly string[],
  now: number = Date.now(),
): Map<string, VideoFacts> {
  const out = new Map<string, VideoFacts>();
  if (ids.length === 0) {
    return out;
  }
  const marks = placeholders(ids.length);
  const params: SQLInputValue[] = [...ids];
  for (const row of db.all<VideoDbRow>(
    `SELECT ${VIDEO_COLUMNS} FROM videos v LEFT JOIN channels c ON c.id = v.channel_id
      WHERE v.id IN (${marks})`,
    ...params,
  )) {
    out.set(row.id, {
      ...emptyFacts(row.id),
      channel_id: row.channel_id,
      channel_title: row.channel_title,
      title: row.title,
      description: row.description,
      tags: tagsOf(row.tags_json),
      type: oneOf<VideoType>(VIDEO_TYPES, row.type),
      privacy: oneOf<Privacy>(PRIVACY_VALUES, row.privacy),
      gone_since: row.gone_since,
      upload_date: row.upload_date,
      published_at: row.published_at,
      duration_s: row.duration_s,
      views: row.views,
      likes: row.likes,
      comments: row.comments,
      ryd_ratio: row.ryd_ratio,
      max_height: row.max_height,
      max_fps: row.max_fps,
      has_av1: bool(row.has_av1),
      has_vp9: bool(row.has_vp9),
      has_h264: bool(row.has_h264),
      is_hdr: bool(row.is_hdr),
      caption_available: bool(row.caption_available),
    });
  }
  for (const row of db.all<SourceDbRow>(
    `SELECT video_id, account_id, source, first_seen_at, last_seen_at, source_ts
       FROM video_sources WHERE video_id IN (${marks}) ORDER BY id`,
    ...params,
  )) {
    const source = oneOf<SourceKind>(SOURCE_KINDS, row.source);
    const facts = out.get(row.video_id);
    if (facts === undefined || source === null) {
      continue;
    }
    const fact: VideoSourceFact = {
      account_id: row.account_id,
      source,
      first_seen_at: row.first_seen_at,
      last_seen_at: row.last_seen_at,
      source_ts: row.source_ts,
    };
    facts.sources.push(fact);
  }
  // The current video track wins over the current audio track; then the newest version.
  for (const row of db.all<MediaDbRow>(
    `SELECT video_id, downloaded_at, location_id, vcodec FROM media
      WHERE video_id IN (${marks}) AND is_current = 1 AND kind IN ('video', 'audio')
      ORDER BY video_id, CASE kind WHEN 'video' THEN 0 ELSE 1 END, version DESC, id DESC`,
    ...params,
  )) {
    const facts = out.get(row.video_id);
    if (facts !== undefined && facts.media === null) {
      facts.media = {
        downloaded_at: row.downloaded_at,
        location_id: row.location_id,
        vcodec: row.vcodec,
      };
    }
  }
  for (const row of db.all<{ video_id: string; n: number }>(
    `SELECT video_id, COUNT(*) AS n FROM share_links
      WHERE video_id IN (${marks}) AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
      GROUP BY video_id`,
    ...params,
    now,
  )) {
    const facts = out.get(row.video_id);
    if (facts !== undefined) {
      facts.share_link_count = row.n;
    }
  }
  return out;
}

/** Facts for one catalog video, or null when the id is not in `videos`. */
export function videoFacts(db: Db, videoId: string, now: number = Date.now()): VideoFacts | null {
  return loadVideoFacts(db, [videoId], now).get(videoId) ?? null;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Merge the layers for one video; pure apart from the context it is given. */
export function computeEffective(
  ctx: EvalPassContext,
  facts: VideoFacts,
  now: number,
): ComputedEffective {
  const evalCtx: EvalContext = { now, installed_at: ctx.installedAt };
  const { layers } = ctx;
  const resolved = resolveEffective(
    {
      globalRule: layers.globalRule,
      customRules: layers.customRules,
      videoRule: layers.videoRules.get(facts.id) ?? null,
    },
    facts,
    evalCtx,
  );
  const effective = { ...resolved.effective };
  if (effective.location_id === null) {
    effective.location_id = ctx.firstLocationId;
  }
  return {
    effective,
    provenance: resolved.provenance,
    matchedRuleIds: resolved.matchedRuleIds,
    nextEvalAt: nextEvalAt(layers.customRules, facts, evalCtx),
  };
}

interface EffectiveDbRow {
  reclaim_priority: number;
  location_id: number | null;
  include: number;
  matched_rule_ids: string;
}

function summaryOf(row: EffectiveDbRow): EffectiveSummary {
  return {
    reclaim_priority: row.reclaim_priority,
    location_id: row.location_id,
    include: row.include === 1,
  };
}

function sameSummary(a: EffectiveSummary | null, b: EffectiveSummary): boolean {
  return (
    a !== null &&
    a.reclaim_priority === b.reclaim_priority &&
    a.location_id === b.location_id &&
    a.include === b.include
  );
}

function idList(json: string | null): number[] {
  const parsed = parseJsonColumn(json);
  return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === "number") : [];
}

export interface EvaluateOptions {
  /** Reuse a pass-wide context (rules loaded once). Default: load now. */
  ctx?: EvalPassContext;
  /** Pre-loaded facts (bulk loader). Default: load this video's facts. */
  facts?: VideoFacts | null;
  /** Publish SSE `video.effective` when the summary changed. Default true. */
  emit?: boolean;
}

/**
 * Evaluate one video and upsert its `video_effective` row. Synchronous: the
 * rule notifications it triggers are counted here and returned in
 * `notifications` for the caller to dispatch once its transaction commits
 * (see `dispatchRuleNotifications`).
 *
 * Notify semantics: a matched rule whose own `notify` effect is enabled fires
 * when the video starts matching it (the rule was not in the previous
 * `matched_rule_ids`, which includes a first evaluation), at most
 * `max_times` times per (rule, video); null = no limit.
 */
export function evaluateVideo(
  deps: EvalDeps,
  videoId: string,
  now: number = (deps.now ?? Date.now)(),
  options: EvaluateOptions = {},
): EvaluateResult {
  const { db } = deps;
  const facts = options.facts === undefined ? videoFacts(db, videoId, now) : options.facts;
  if (facts === null) {
    return { videoId, changed: false, before: null, after: null, notifications: [] };
  }
  const ctx = options.ctx ?? loadEvalContext(deps, now);
  const computed = computeEffective(ctx, facts, now);

  return db.tx((): EvaluateResult => {
    const beforeRow = db.get<EffectiveDbRow>(
      `SELECT reclaim_priority, location_id, include, matched_rule_ids
         FROM video_effective WHERE video_id = ?`,
      videoId,
    );
    const before = beforeRow === undefined ? null : summaryOf(beforeRow);
    const after: EffectiveSummary = {
      reclaim_priority: computed.effective.reclaim_priority,
      location_id: computed.effective.location_id,
      include: computed.effective.include,
    };
    db.run(
      `INSERT INTO video_effective (video_id, effective_json, provenance_json, matched_rule_ids,
                                    evaluated_at, next_eval_at, reclaim_priority, location_id,
                                    include)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (video_id) DO UPDATE SET
         effective_json = excluded.effective_json, provenance_json = excluded.provenance_json,
         matched_rule_ids = excluded.matched_rule_ids, evaluated_at = excluded.evaluated_at,
         next_eval_at = excluded.next_eval_at, reclaim_priority = excluded.reclaim_priority,
         location_id = excluded.location_id, include = excluded.include`,
      videoId,
      JSON.stringify(computed.effective),
      JSON.stringify(computed.provenance),
      JSON.stringify(computed.matchedRuleIds),
      now,
      computed.nextEvalAt,
      after.reclaim_priority,
      after.location_id,
      after.include ? 1 : 0,
    );

    const previouslyMatched = new Set(idList(beforeRow?.matched_rule_ids ?? null));
    const notifications: PendingNotification[] = [];
    for (const ruleId of computed.matchedRuleIds) {
      const rule = ctx.layers.byId.get(ruleId);
      const notify = rule?.effects.notify;
      if (rule === undefined || notify === undefined || !notify.enabled) {
        continue;
      }
      if (previouslyMatched.has(ruleId)) {
        continue;
      }
      const count =
        db.get<{ count: number }>(
          "SELECT count FROM rule_notify_counts WHERE rule_id = ? AND video_id = ?",
          ruleId,
          videoId,
        )?.count ?? 0;
      if (notify.max_times !== null && count >= notify.max_times) {
        continue;
      }
      db.run(
        `INSERT INTO rule_notify_counts (rule_id, video_id, count) VALUES (?, ?, 1)
         ON CONFLICT (rule_id, video_id) DO UPDATE SET count = count + 1`,
        ruleId,
        videoId,
      );
      notifications.push({ ruleId, ruleName: rule.name, videoId, title: facts.title ?? videoId });
    }

    const changed = !sameSummary(before, after);
    if (changed && options.emit !== false) {
      deps.events?.publish("video.effective", { videoId, before, after });
    }
    return { videoId, changed, before, after, notifications };
  });
}

/** Send counted rule notifications. Failures are logged, never thrown. */
export async function dispatchRuleNotifications(
  deps: Pick<EvalDeps, "log" | "notify">,
  pending: readonly PendingNotification[],
): Promise<void> {
  for (const item of pending) {
    try {
      await deps.notify({
        type: "rule_notify",
        title: item.ruleName,
        body: item.title,
        videoId: item.videoId,
        force: true,
        data: { ruleId: item.ruleId },
      });
    } catch (error) {
      deps.log.warn(
        { err: error, ruleId: item.ruleId, videoId: item.videoId },
        "rule notification failed",
      );
    }
  }
}
