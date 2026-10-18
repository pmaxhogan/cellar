import { DEFAULT_RULES, type RuleRow } from "@cellar/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKv } from "../src/db/kv.ts";
import { listActivity } from "../src/domain/activity.ts";
import { DomainError } from "../src/domain/errors.ts";
import {
  createRule,
  DEFAULT_RULES_SEEDED_KEY,
  deleteRule,
  ensureDefaultRules,
  getVideoRuleRow,
  listRules,
  loadRuleLayers,
  parseRuleDraft,
  parseVideoEffects,
  reorderRules,
  toRule,
  toRuleRow,
  updateRule,
  upsertVideoRule,
  type RuleDbRow,
  type RulesMutationDeps,
} from "../src/domain/rules.ts";
import { EventBus, type CellarEvent } from "../src/events.ts";
import { createConsoleLogger } from "../src/logging.ts";
import { createTempDb, type TempDb } from "./helpers.ts";

const log = createConsoleLogger("silent");

let temp: TempDb;
let events: EventBus;
let seen: CellarEvent[];
let changes: { reason: string; videoIds: string[] | undefined }[];
let deps: RulesMutationDeps;

function customDraft(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "custom",
    video_id: null,
    position: 99,
    name,
    enabled: true,
    condition: { type: "group", op: "and", children: [] },
    effects: { reclaim_priority: 3 },
    ...extra,
  };
}

function expectDomainError(fn: () => unknown, code: string): DomainError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
    return error as DomainError;
  }
  throw new Error("expected a DomainError");
}

function customs(): RuleRow[] {
  return listRules(temp.db).filter((r) => r.kind === "custom");
}

beforeEach(() => {
  temp = createTempDb();
  events = new EventBus();
  seen = [];
  events.subscribe((event) => seen.push(event));
  changes = [];
  deps = {
    db: temp.db,
    log,
    events,
    now: () => 1000,
    onRulesChanged: (reason, videoIds) => changes.push({ reason, videoIds }),
  };
});

afterEach(() => {
  temp.close();
});

describe("ensureDefaultRules", () => {
  it("installs the default set once, global at 0 and customs 1..7 with the spec names", () => {
    expect(ensureDefaultRules(temp.db, log, 5)).toBe(true);
    const rows = listRules(temp.db);
    expect(rows).toHaveLength(8);
    expect(rows[0]).toMatchObject({ kind: "global", position: 0, name: "Global defaults" });
    expect(rows.slice(1).map((r) => r.position)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(rows.map((r) => r.name)).toEqual(DEFAULT_RULES.map((r) => r.name));
    expect(rows[0]?.effects).not.toHaveProperty("include");
    expect(rows[7]?.effects).toEqual({ notify: { enabled: true, max_times: 1, channel: "push" } });
    expect(getKv(temp.db, DEFAULT_RULES_SEEDED_KEY)).toEqual({ at: 5, seeded: true });

    // Idempotent: a second boot does nothing.
    expect(ensureDefaultRules(temp.db, log)).toBe(false);
    expect(listRules(temp.db)).toHaveLength(8);
  });

  it("never re-seeds after the owner removes the custom rules", () => {
    ensureDefaultRules(temp.db, log);
    for (const row of customs()) deleteRule(deps, row.id);
    expect(ensureDefaultRules(temp.db, log)).toBe(false);
    expect(listRules(temp.db)).toHaveLength(1);
  });

  it("sets the flag without seeding when rules already exist", () => {
    temp.db.run(
      `INSERT INTO rules (kind, position, name, effects_json, created_at, updated_at)
       VALUES ('global', 0, 'Mine', '{}', 1, 1)`,
    );
    expect(ensureDefaultRules(temp.db, log, 7)).toBe(false);
    expect(listRules(temp.db).map((r) => r.name)).toEqual(["Mine"]);
    expect(getKv(temp.db, DEFAULT_RULES_SEEDED_KEY)).toEqual({ at: 7, seeded: false });
  });
});

describe("row mapping", () => {
  it("maps rows to the wire shape and skips rows that no longer validate", () => {
    ensureDefaultRules(temp.db, log);
    const raw = temp.db.get<RuleDbRow>("SELECT * FROM rules WHERE kind = 'global'") as RuleDbRow;
    expect(toRule(raw)?.kind).toBe("global");
    const broken: RuleDbRow = { ...raw, effects_json: "[1,2]", condition_json: "{bad" };
    expect(toRuleRow(broken).effects).toEqual({});
    expect(toRuleRow(broken).condition).toBeNull();
    const bad: RuleDbRow = { ...raw, effects_json: '{"reclaim_priority":-9}' };
    expect(toRule(bad)).toBeNull();

    temp.db.run("UPDATE rules SET effects_json = ? WHERE id = ?", '{"nope":1}', raw.id);
    const warn = vi.fn();
    const layers = loadRuleLayers(temp.db, { warn } as unknown as typeof log);
    expect(layers.globalRule).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(layers.customRules.map((r) => r.position)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(loadRuleLayers(temp.db).globalRule).toBeNull();
  });

  it("indexes video rules by video id", () => {
    upsertVideoRule(temp.db, "abcdefghijk", { reclaim_priority: 0 }, "Trashed", 1);
    const layers = loadRuleLayers(temp.db);
    expect(layers.videoRules.get("abcdefghijk")?.effects).toEqual({ reclaim_priority: 0 });
    expect(listRules(temp.db)).toHaveLength(0);
  });
});

describe("validation", () => {
  it("rejects non-objects, bad conditions with JSON pointers, and invalid drafts", () => {
    expectDomainError(() => parseRuleDraft(null), "invalid");
    expectDomainError(() => parseRuleDraft([1]), "invalid");
    const astError = expectDomainError(
      () =>
        parseRuleDraft(
          customDraft("x", {
            condition: { type: "group", op: "and", children: [{ type: "cond", field: "nope" }] },
          }),
        ),
      "invalid",
    );
    expect(astError.details?.["condition"]).toEqual([
      expect.objectContaining({ code: "unknown_field", pointer: "/children/0/field" }),
    ]);
    const draftError = expectDomainError(
      () => parseRuleDraft(customDraft("x", { condition: null })),
      "invalid",
    );
    expect(draftError.details?.["fields"]).toHaveProperty("condition");
    expectDomainError(
      () =>
        parseRuleDraft({
          ...customDraft("x"),
          kind: "global",
          condition: null,
          effects: { include: false },
        }),
      "invalid",
    );
    expect(parseRuleDraft(customDraft("ok")).name).toBe("ok");
  });

  it("validates video overrides against the registry", () => {
    expect(parseVideoEffects({ include: false })).toEqual({ include: false });
    expectDomainError(() => parseVideoEffects({ unknown_key: 1 }), "invalid");
    expectDomainError(() => parseVideoEffects({ reclaim_priority: -5 }), "invalid");
  });
});

describe("custom rule CRUD", () => {
  beforeEach(() => {
    ensureDefaultRules(temp.db, log);
  });

  it("creates at the highest position, logs activity, publishes and schedules a pass", () => {
    const row = createRule(deps, customDraft("New"));
    expect(row).toMatchObject({ kind: "custom", position: 8, name: "New", enabled: true });
    expect(row.created_at).toBe(1000);
    expect(seen.map((e) => e.type)).toEqual(["activity", "rules.changed"]);
    expect(seen[1]?.payload).toEqual({ reason: "created", ruleId: row.id });
    expect(changes).toEqual([{ reason: "rules.created", videoIds: undefined }]);
    const activity = listActivity(temp.db, { page: 1, perPage: 10 }).rows;
    expect(activity[0]).toMatchObject({ kind: "rules.created", data: { ruleId: row.id } });
  });

  it("refuses to create anything but a custom rule", () => {
    expectDomainError(
      () => createRule(deps, { ...customDraft("g"), kind: "global", condition: null }),
      "invalid",
    );
    expectDomainError(
      () =>
        createRule(deps, {
          ...customDraft("v"),
          kind: "video",
          video_id: "abcdefghijk",
          condition: null,
        }),
      "invalid",
    );
    expect(changes).toEqual([]);
  });

  it("updates in place and keeps the stored position", () => {
    const target = customs()[2] as RuleRow;
    const row = updateRule(
      deps,
      target.id,
      customDraft("Renamed", { enabled: false, position: 1 }),
    );
    expect(row).toMatchObject({ id: target.id, name: "Renamed", enabled: false, position: 3 });
    expect(row.effects).toEqual({ reclaim_priority: 3 });
    expect(changes.at(-1)?.reason).toBe("rules.updated");
  });

  it("guards the global rule: no disable, no delete, no condition, no include", () => {
    const global = listRules(temp.db)[0] as RuleRow;
    const draft = { ...customDraft("G"), kind: "global", condition: null, effects: {} };
    expectDomainError(() => updateRule(deps, global.id, { ...draft, enabled: false }), "immutable");
    expectDomainError(
      () => updateRule(deps, global.id, { ...draft, effects: { include: true } }),
      "invalid",
    );
    expectDomainError(() => deleteRule(deps, global.id), "immutable");
    const row = updateRule(deps, global.id, { ...draft, effects: { reclaim_priority: 5 } });
    expect(row).toMatchObject({ kind: "global", position: 0, effects: { reclaim_priority: 5 } });
  });

  it("refuses kind changes, unknown ids and video id changes", () => {
    const target = customs()[0] as RuleRow;
    expectDomainError(
      () => updateRule(deps, target.id, { ...customDraft("x"), kind: "global", condition: null }),
      "invalid",
    );
    expectDomainError(() => updateRule(deps, 9999, customDraft("x")), "not_found");
    expectDomainError(() => deleteRule(deps, 9999), "not_found");

    const video = upsertVideoRule(temp.db, "abcdefghijk", { include: false }, "Video override", 1);
    const videoDraft = {
      kind: "video",
      video_id: "abcdefghijk",
      position: 0,
      name: "Edited",
      enabled: true,
      condition: null,
      effects: { include: true },
    };
    expectDomainError(
      () => updateRule(deps, video?.id as number, { ...videoDraft, video_id: "zzzzzzzzzzz" }),
      "invalid",
    );
    const edited = updateRule(deps, video?.id as number, videoDraft);
    expect(edited.effects).toEqual({ include: true });
    expect(changes.at(-1)).toEqual({ reason: "rules.updated", videoIds: ["abcdefghijk"] });
    expectDomainError(() => deleteRule(deps, video?.id as number), "immutable");
  });

  it("deletes custom rules and keeps positions contiguous", () => {
    const before = customs();
    deleteRule(deps, (before[1] as RuleRow).id);
    deleteRule(deps, (before[4] as RuleRow).id);
    const after = customs();
    expect(after.map((r) => r.position)).toEqual([1, 2, 3, 4, 5]);
    expect(after.map((r) => r.id)).toEqual(
      before.filter((_, i) => i !== 1 && i !== 4).map((r) => r.id),
    );
    expect(changes.map((c) => c.reason)).toEqual(["rules.deleted", "rules.deleted"]);
  });

  it("compacts a gap before appending", () => {
    temp.db.run("UPDATE rules SET position = position * 10 WHERE kind = 'custom'");
    const row = createRule(deps, customDraft("After gap"));
    expect(row.position).toBe(8);
    expect(customs().map((r) => r.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("reorderRules", () => {
  beforeEach(() => {
    ensureDefaultRules(temp.db, log);
  });

  it("assigns 1..n in the given order", () => {
    const ids = customs().map((r) => r.id);
    const reversed = [...ids].reverse();
    const rows = reorderRules(deps, reversed);
    expect(rows[0]?.kind).toBe("global");
    expect(rows.slice(1).map((r) => r.id)).toEqual(reversed);
    expect(rows.slice(1).map((r) => r.position)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(changes).toEqual([{ reason: "rules.reordered", videoIds: undefined }]);
  });

  it("requires exactly the set of custom ids", () => {
    const ids = customs().map((r) => r.id);
    const global = (listRules(temp.db)[0] as RuleRow).id;
    expectDomainError(() => reorderRules(deps, ids.slice(1)), "invalid");
    expectDomainError(() => reorderRules(deps, [...ids, global]), "invalid");
    expectDomainError(() => reorderRules(deps, [ids[0] as number, ...ids.slice(0, -1)]), "invalid");
    const error = expectDomainError(() => reorderRules(deps, [...ids.slice(1), 9999]), "invalid");
    expect(error.details?.["expected"]).toEqual([...ids].sort((a, b) => a - b));
    expect(customs().map((r) => r.id)).toEqual(ids);
    expect(changes).toEqual([]);
  });
});

describe("upsertVideoRule", () => {
  it("creates, replaces and clears one rule per video", () => {
    const created = upsertVideoRule(temp.db, "abcdefghijk", { include: false }, "A", 1);
    expect(created).toMatchObject({ kind: "video", video_id: "abcdefghijk", name: "A" });
    const replaced = upsertVideoRule(temp.db, "abcdefghijk", { reclaim_priority: 0 }, "B", 2);
    expect(replaced?.id).toBe(created?.id);
    expect(toRuleRow(replaced as RuleDbRow)).toMatchObject({
      name: "B",
      effects: { reclaim_priority: 0 },
      updated_at: 2,
    });
    expect(upsertVideoRule(temp.db, "abcdefghijk", {}, "C", 3)).toBeNull();
    expect(getVideoRuleRow(temp.db, "abcdefghijk")).toBeUndefined();
    expect(upsertVideoRule(temp.db, "abcdefghijk", null, "C", 3)).toBeNull();
  });
});
