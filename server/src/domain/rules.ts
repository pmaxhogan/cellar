import {
  defaultRules,
  EffectsSchema,
  RuleDraftSchema,
  RuleSchema,
  sortCustomRules,
  validateAst,
  type Effects,
  type Rule,
  type RuleKind,
  type RuleRow,
} from "@cellar/shared";
import type { Logger } from "pino";
import type { z } from "zod";
import type { Db } from "../db/db.ts";
import { getKv, setKv } from "../db/kv.ts";
import { parseJsonColumn } from "../db/paged.ts";
import type { EventBus } from "../events.ts";
import { logActivity } from "./activity.ts";
import { DomainError, invalid, notFound } from "./errors.ts";

/**
 * The `rules` table: one global rule (position 0, never deleted or disabled,
 * never sets `include`), custom rules at positions 1..n (contiguous, later =
 * higher priority) and at most one `video` rule per video id (created through
 * per-video overrides and the trash action).
 *
 * Every mutation logs an activity row, publishes SSE `rules.changed` and asks
 * for a debounced evaluation pass through `RulesMutationDeps.onRulesChanged`.
 */

export const DEFAULT_RULES_SEEDED_KEY = "default_rules_seeded";

export interface RuleDbRow {
  id: number;
  kind: RuleKind;
  video_id: string | null;
  position: number;
  name: string;
  enabled: number;
  condition_json: string | null;
  effects_json: string;
  created_at: number;
  updated_at: number;
}

export interface RulesMutationDeps {
  db: Db;
  log: Logger;
  events?: EventBus | undefined;
  now?: () => number;
  /** Called after every committed mutation; schedules the debounced eval pass. */
  onRulesChanged?: (reason: string, videoIds?: string[]) => void;
}

/** The wire row (shared RuleRowSchema). */
export function toRuleRow(row: RuleDbRow): RuleRow {
  const effects = parseJsonColumn(row.effects_json);
  return {
    id: row.id,
    kind: row.kind,
    video_id: row.video_id,
    position: row.position,
    name: row.name,
    enabled: row.enabled === 1,
    condition: row.condition_json === null ? null : parseJsonColumn(row.condition_json),
    effects:
      effects !== null && typeof effects === "object" && !Array.isArray(effects)
        ? (effects as Record<string, unknown>)
        : {},
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** The evaluator form of a stored row, or null when the stored JSON no longer validates. */
export function toRule(row: RuleDbRow): Rule | null {
  const wire = toRuleRow(row);
  const parsed = RuleSchema.safeParse({
    id: wire.id,
    kind: wire.kind,
    video_id: wire.video_id,
    position: wire.position,
    name: wire.name,
    enabled: wire.enabled,
    condition: wire.condition,
    effects: wire.effects,
  });
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getRuleRow(db: Db, id: number): RuleDbRow | undefined {
  return db.get<RuleDbRow>("SELECT * FROM rules WHERE id = ?", id);
}

export function getVideoRuleRow(db: Db, videoId: string): RuleDbRow | undefined {
  return db.get<RuleDbRow>("SELECT * FROM rules WHERE kind = 'video' AND video_id = ?", videoId);
}

/** GET /api/rules: the global rule first, then custom rules by position. No video rules. */
export function listRules(db: Db): RuleRow[] {
  return db
    .all<RuleDbRow>(
      `SELECT * FROM rules WHERE kind IN ('global', 'custom')
        ORDER BY CASE kind WHEN 'global' THEN 0 ELSE 1 END, position, id`,
    )
    .map(toRuleRow);
}

/** Everything the evaluator needs, loaded once per pass. */
export interface RuleLayersCache {
  globalRule: Rule | null;
  /** Ascending priority. */
  customRules: Rule[];
  videoRules: Map<string, Rule>;
  /** Rule names by id, for notifications and the Inspect page. */
  byId: Map<number, Rule>;
}

export function loadRuleLayers(db: Db, log?: Logger): RuleLayersCache {
  let globalRule: Rule | null = null;
  const customRules: Rule[] = [];
  const videoRules = new Map<string, Rule>();
  const byId = new Map<number, Rule>();
  for (const row of db.all<RuleDbRow>("SELECT * FROM rules ORDER BY id")) {
    const rule = toRule(row);
    if (rule === null) {
      log?.warn(
        { ruleId: row.id, kind: row.kind },
        "skipping a stored rule that does not validate",
      );
      continue;
    }
    byId.set(rule.id, rule);
    if (rule.kind === "global") {
      globalRule ??= rule;
    } else if (rule.kind === "custom") {
      customRules.push(rule);
    } else if (rule.video_id !== null) {
      videoRules.set(rule.video_id, rule);
    }
  }
  return { globalRule, customRules: sortCustomRules(customRules), videoRules, byId };
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * Boot-time install of the default rule set (spec 4.5). Seeds only when the
 * `kv.default_rules_seeded` flag is absent AND the rules table is empty, then
 * sets the flag, so a later boot never re-seeds (even after the owner deletes
 * every custom rule). Returns true when it inserted the defaults.
 */
export function ensureDefaultRules(db: Db, log: Logger, now: number = Date.now()): boolean {
  return db.tx(() => {
    if (getKv(db, DEFAULT_RULES_SEEDED_KEY) !== undefined) {
      return false;
    }
    const count = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM rules")?.n ?? 0;
    let seeded = false;
    if (count === 0) {
      for (const rule of defaultRules()) {
        insertRule(db, rule, now);
      }
      seeded = true;
      log.info({ rules: defaultRules().length }, "installed the default rule set");
    } else {
      log.info({ rules: count }, "rules already present; default rule set not installed");
    }
    setKv(db, DEFAULT_RULES_SEEDED_KEY, { at: now, seeded }, now);
    return seeded;
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

interface DraftShape {
  kind: RuleKind;
  video_id: string | null;
  position: number;
  name: string;
  enabled: boolean;
  condition: z.output<typeof RuleDraftSchema>["condition"];
  effects: Effects;
}

function insertRule(db: Db, rule: DraftShape, now: number): RuleDbRow {
  return db.get<RuleDbRow>(
    `INSERT INTO rules (kind, video_id, position, name, enabled, condition_json, effects_json,
                        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    rule.kind,
    rule.video_id,
    rule.position,
    rule.name,
    rule.enabled ? 1 : 0,
    rule.condition === null ? null : JSON.stringify(rule.condition),
    JSON.stringify(rule.effects),
    now,
    now,
  ) as RuleDbRow;
}

function zodDetails(error: z.ZodError): Record<string, unknown> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.map(String).join(".");
    fields[path === "" ? "(root)" : path] = issue.message;
  }
  return { fields };
}

/**
 * Validate an untrusted draft: the condition first through `validateAst`
 * (bounded depth, JSON-pointer errors), then the whole rule through
 * `RuleDraftSchema` (kind invariants, effect allowedIn).
 */
export function parseRuleDraft(body: unknown): DraftShape {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw invalid("A rule must be a JSON object.");
  }
  const condition = (body as { condition?: unknown }).condition;
  if (condition !== undefined && condition !== null) {
    const ast = validateAst(condition);
    if (!ast.ok) {
      throw invalid("The rule condition is not valid.", { condition: ast.errors });
    }
  }
  const parsed = RuleDraftSchema.safeParse(body);
  if (!parsed.success) {
    throw invalid("The rule is not valid.", zodDetails(parsed.error));
  }
  return parsed.data;
}

/** Parse a sparse effects map for a `video` rule (every key is allowed there). */
export function parseVideoEffects(body: unknown): Effects {
  const parsed = EffectsSchema.safeParse(body);
  if (!parsed.success) {
    throw invalid("The overrides are not valid.", zodDetails(parsed.error));
  }
  return parsed.data;
}

function immutable(message: string): DomainError {
  return new DomainError("immutable", message);
}

function publishChange(
  deps: RulesMutationDeps,
  input: { reason: string; message: string; ruleId?: number; videoIds?: string[]; data?: unknown },
): void {
  logActivity(
    { db: deps.db, events: deps.events, ...(deps.now === undefined ? {} : { now: deps.now }) },
    {
      kind: `rules.${input.reason}`,
      message: input.message,
      videoId: input.videoIds?.length === 1 ? input.videoIds[0] : null,
      data: { ruleId: input.ruleId ?? null, ...(input.data as object | undefined) },
    },
  );
  deps.events?.publish("rules.changed", {
    reason: input.reason,
    ruleId: input.ruleId ?? null,
    ...(input.videoIds === undefined ? {} : { videoIds: input.videoIds }),
  });
  deps.onRulesChanged?.(`rules.${input.reason}`, input.videoIds);
}

function nowOf(deps: RulesMutationDeps): number {
  return (deps.now ?? Date.now)();
}

/** Renumber custom rules to 1..n keeping their relative order. */
function compactCustomPositions(db: Db, now: number): void {
  const rows = db.all<{ id: number; position: number }>(
    "SELECT id, position FROM rules WHERE kind = 'custom' ORDER BY position, id",
  );
  rows.forEach((row, index) => {
    if (row.position !== index + 1) {
      db.run("UPDATE rules SET position = ?, updated_at = ? WHERE id = ?", index + 1, now, row.id);
    }
  });
}

/** POST /api/rules: a new custom rule, appended at the highest priority (position n + 1). */
export function createRule(deps: RulesMutationDeps, body: unknown): RuleRow {
  const draft = parseRuleDraft(body);
  if (draft.kind !== "custom") {
    throw invalid("Only custom rules can be created here.", { kind: draft.kind });
  }
  const now = nowOf(deps);
  const row = deps.db.tx(() => {
    compactCustomPositions(deps.db, now);
    const max =
      deps.db.get<{ m: number | null }>(
        "SELECT MAX(position) AS m FROM rules WHERE kind = 'custom'",
      )?.m ?? 0;
    return insertRule(deps.db, { ...draft, position: max + 1 }, now);
  });
  publishChange(deps, { reason: "created", ruleId: row.id, message: `Rule "${row.name}" created` });
  return toRuleRow(row);
}

/**
 * PUT /api/rules/:id: replace a rule's name, enabled flag, condition and
 * effects. The kind (and a video rule's video id) cannot change; the stored
 * position is kept (reorder with PUT /api/rules/order). The global rule cannot
 * be disabled.
 */
export function updateRule(deps: RulesMutationDeps, id: number, body: unknown): RuleRow {
  const existing = getRuleRow(deps.db, id);
  if (existing === undefined) {
    throw notFound("Rule", id);
  }
  const draft = parseRuleDraft(body);
  if (draft.kind !== existing.kind) {
    throw invalid("A rule's kind cannot change.", { kind: existing.kind });
  }
  if (existing.kind === "video" && draft.video_id !== existing.video_id) {
    throw invalid("A video rule's video id cannot change.", { video_id: existing.video_id });
  }
  if (existing.kind === "global" && !draft.enabled) {
    throw immutable("The global rule cannot be disabled.");
  }
  const now = nowOf(deps);
  const row = deps.db.get<RuleDbRow>(
    `UPDATE rules SET name = ?, enabled = ?, condition_json = ?, effects_json = ?, updated_at = ?
      WHERE id = ? RETURNING *`,
    draft.name,
    draft.enabled ? 1 : 0,
    draft.condition === null ? null : JSON.stringify(draft.condition),
    JSON.stringify(draft.effects),
    now,
    id,
  ) as RuleDbRow;
  publishChange(deps, {
    reason: "updated",
    ruleId: id,
    message: `Rule "${row.name}" updated`,
    ...(row.kind === "video" && row.video_id !== null ? { videoIds: [row.video_id] } : {}),
  });
  return toRuleRow(row);
}

/** DELETE /api/rules/:id: custom rules only; the rest are renumbered 1..n. */
export function deleteRule(deps: RulesMutationDeps, id: number): void {
  const existing = getRuleRow(deps.db, id);
  if (existing === undefined) {
    throw notFound("Rule", id);
  }
  if (existing.kind === "global") {
    throw immutable("The global rule cannot be deleted.");
  }
  if (existing.kind === "video") {
    throw immutable("Video rules are cleared through PUT /api/videos/:id/overrides.");
  }
  const now = nowOf(deps);
  deps.db.tx(() => {
    deps.db.run("DELETE FROM rules WHERE id = ?", id);
    compactCustomPositions(deps.db, now);
  });
  publishChange(deps, {
    reason: "deleted",
    ruleId: id,
    message: `Rule "${existing.name}" deleted`,
  });
}

/**
 * PUT /api/rules/order: `ids` must be exactly the set of custom rule ids, in
 * the new ascending-priority order; they get positions 1..n.
 */
export function reorderRules(deps: RulesMutationDeps, ids: readonly number[]): RuleRow[] {
  const now = nowOf(deps);
  deps.db.tx(() => {
    const current = deps.db
      .all<{ id: number }>("SELECT id FROM rules WHERE kind = 'custom'")
      .map((row) => row.id);
    const wanted = new Set(ids);
    const same =
      wanted.size === ids.length &&
      ids.length === current.length &&
      current.every((id) => wanted.has(id));
    if (!same) {
      throw invalid("The order must list every custom rule id exactly once.", {
        expected: [...current].sort((a, b) => a - b),
      });
    }
    ids.forEach((id, index) => {
      deps.db.run(
        "UPDATE rules SET position = ?, updated_at = ? WHERE id = ? AND position <> ?",
        index + 1,
        now,
        id,
        index + 1,
      );
    });
  });
  publishChange(deps, {
    reason: "reordered",
    message: "Rules reordered",
    data: { ids: [...ids] },
  });
  return listRules(deps.db);
}

/** The default name of a video rule set from the Inspect page. */
export const VIDEO_OVERRIDE_RULE_NAME = "Video override";
/** The name trashVideos gives the video rule. */
export const TRASH_RULE_NAME = "Trashed";

/**
 * Create, replace or (effects null / empty) delete the `video` rule for one
 * video. Does not publish; callers batch their own change notice.
 */
export function upsertVideoRule(
  db: Db,
  videoId: string,
  effects: Effects | null,
  name: string,
  now: number,
): RuleDbRow | null {
  return db.tx(() => {
    const existing = getVideoRuleRow(db, videoId);
    if (effects === null || Object.keys(effects).length === 0) {
      if (existing !== undefined) {
        db.run("DELETE FROM rules WHERE id = ?", existing.id);
      }
      return null;
    }
    if (existing === undefined) {
      return insertRule(
        db,
        {
          kind: "video",
          video_id: videoId,
          position: 0,
          name,
          enabled: true,
          condition: null,
          effects,
        },
        now,
      );
    }
    return db.get<RuleDbRow>(
      `UPDATE rules SET name = ?, enabled = 1, effects_json = ?, updated_at = ?
        WHERE id = ? RETURNING *`,
      name,
      JSON.stringify(effects),
      now,
      existing.id,
    ) as RuleDbRow;
  });
}

/** Publish a change notice for video rules written through upsertVideoRule. */
export function publishVideoRuleChange(
  deps: RulesMutationDeps,
  reason: string,
  message: string,
  videoIds: string[],
): void {
  publishChange(deps, { reason, message, videoIds, data: { count: videoIds.length } });
}
