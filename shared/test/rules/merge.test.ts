import { describe, expect, it } from "vitest";
import {
  effectDefaults,
  EFFECT_KEYS,
  resolveEffective,
  RuleSchema,
  setEffectKeys,
  sortCustomRules,
  type ConditionNode,
  type EffectsInput,
  type Rule,
} from "../../src/index.ts";
import { ctx, video } from "./fixtures.ts";

const isShort: ConditionNode = { type: "cond", field: "type", op: "eq", value: "short" };
const isVideo: ConditionNode = { type: "cond", field: "type", op: "eq", value: "video" };

type RuleInput = Partial<Omit<Rule, "effects">> &
  Pick<Rule, "id" | "kind"> & { effects?: EffectsInput };

function rule(partial: RuleInput): Rule {
  return RuleSchema.parse({
    video_id: partial.kind === "video" ? "vid00000001" : null,
    position: 0,
    name: `rule ${partial.id}`,
    enabled: true,
    condition: partial.kind === "custom" ? { type: "group", op: "and", children: [] } : null,
    effects: {},
    ...partial,
  });
}

const globalRule = rule({
  id: 1,
  kind: "global",
  effects: { reclaim_priority: 5, media_mode: "audio_only", transcode: { codec: "av1_svt" } },
});

describe("resolveEffective", () => {
  it("returns registry defaults with provenance default when there are no rules", () => {
    const r = resolveEffective(
      { globalRule: null, customRules: [], videoRule: null },
      video(),
      ctx,
    );
    expect(r.effective).toEqual(effectDefaults());
    expect(r.matchedRuleIds).toEqual([]);
    for (const key of EFFECT_KEYS) expect(r.provenance[key]).toBe("default");
  });

  it("applies global, then matching custom rules by position, then the video rule", () => {
    const customRules = [
      rule({
        id: 12,
        kind: "custom",
        position: 2,
        condition: isVideo,
        effects: { reclaim_priority: 2 },
      }),
      rule({
        id: 11,
        kind: "custom",
        position: 1,
        condition: isVideo,
        effects: { reclaim_priority: 1, proxy: "pool" },
      }),
      rule({
        id: 13,
        kind: "custom",
        position: 3,
        condition: isShort,
        effects: { reclaim_priority: 3 },
      }),
    ];
    const videoRule = rule({ id: 20, kind: "video", effects: { include: false } });
    const r = resolveEffective({ globalRule, customRules, videoRule }, video(), ctx);
    expect(r.matchedRuleIds).toEqual([1, 11, 12, 20]);
    expect(r.effective.reclaim_priority).toBe(2);
    expect(r.provenance.reclaim_priority).toBe(12);
    expect(r.effective.proxy).toBe("pool");
    expect(r.provenance.proxy).toBe(11);
    expect(r.effective.media_mode).toBe("audio_only");
    expect(r.provenance.media_mode).toBe(1);
    expect(r.effective.include).toBe(false);
    expect(r.provenance.include).toBe(20);
    expect(r.provenance.format_policy).toBe("default");
  });

  it("lets the video rule override every layer", () => {
    const customRules = [
      rule({ id: 11, kind: "custom", position: 9, effects: { reclaim_priority: 0 } }),
    ];
    const videoRule = rule({ id: 20, kind: "video", effects: { reclaim_priority: -1 } });
    const r = resolveEffective({ globalRule, customRules, videoRule }, video(), ctx);
    expect(r.effective.reclaim_priority).toBe(-1);
    expect(r.provenance.reclaim_priority).toBe(20);
  });

  it("breaks position ties by id", () => {
    const customRules = [
      rule({ id: 31, kind: "custom", position: 1, effects: { reclaim_priority: 31 } }),
      rule({ id: 30, kind: "custom", position: 1, effects: { reclaim_priority: 30 } }),
    ];
    const r = resolveEffective({ globalRule: null, customRules, videoRule: null }, video(), ctx);
    expect(r.matchedRuleIds).toEqual([30, 31]);
    expect(r.effective.reclaim_priority).toBe(31);
  });

  it("skips disabled custom, global and video rules", () => {
    const r = resolveEffective(
      {
        globalRule: { ...globalRule, enabled: false },
        customRules: [
          rule({ id: 11, kind: "custom", enabled: false, effects: { reclaim_priority: 0 } }),
        ],
        videoRule: rule({
          id: 20,
          kind: "video",
          enabled: false,
          effects: { live: "record_live" },
        }),
      },
      video(),
      ctx,
    );
    expect(r.matchedRuleIds).toEqual([]);
    expect(r.effective).toEqual(effectDefaults());
  });

  it("treats a custom rule with a null condition as match-all", () => {
    const r = resolveEffective(
      {
        globalRule: null,
        customRules: [{ ...rule({ id: 11, kind: "custom" }), condition: null }],
        videoRule: null,
      },
      video(),
      ctx,
    );
    expect(r.matchedRuleIds).toEqual([11]);
  });

  it("replaces object effects whole, with field defaults, never deep-merging", () => {
    const customRules = [
      rule({ id: 11, kind: "custom", effects: { transcode: { mode: "always" } } }),
    ];
    const r = resolveEffective({ globalRule, customRules, videoRule: null }, video(), ctx);
    // The global rule set codec av1_svt; the custom rule's transcode replaces the whole value.
    expect(r.effective.transcode).toEqual({
      mode: "always",
      codec: "hevc_nvenc",
      quality: 28,
      preset: "p5",
      audio_codec: "copy",
    });
    expect(r.provenance.transcode).toBe(11);
  });

  it("fills subfield defaults even for unparsed effects objects", () => {
    const raw = {
      ...rule({ id: 11, kind: "custom" }),
      effects: { captions: { languages: ["en"] } },
    } as unknown as Rule;
    const r = resolveEffective(
      { globalRule: null, customRules: [raw], videoRule: null },
      video(),
      ctx,
    );
    expect(r.effective.captions).toEqual({
      enabled: true,
      languages: ["en"],
      auto_generated: true,
    });
  });

  it("ignores include on the global rule", () => {
    const sneaky = { ...globalRule, effects: { ...globalRule.effects, include: false } };
    const r = resolveEffective(
      { globalRule: sneaky, customRules: [], videoRule: null },
      video(),
      ctx,
    );
    expect(r.effective.include).toBe(true);
    expect(r.provenance.include).toBe("default");
    expect(r.matchedRuleIds).toEqual([1]);
  });

  it("keeps location_id null for the server to resolve", () => {
    const r = resolveEffective({ globalRule, customRules: [], videoRule: null }, video(), ctx);
    expect(r.effective.location_id).toBeNull();
    const moved = resolveEffective(
      {
        globalRule,
        customRules: [rule({ id: 11, kind: "custom", effects: { location_id: 4 } })],
        videoRule: null,
      },
      video(),
      ctx,
    );
    expect(moved.effective.location_id).toBe(4);
  });

  it("does not mutate rules, and results do not alias rule effects", () => {
    const custom = rule({
      id: 11,
      kind: "custom",
      effects: { captions: { enabled: true, languages: ["en"], auto_generated: true } },
    });
    const before = JSON.stringify([globalRule, custom]);
    const customRules = [custom];
    const r = resolveEffective({ globalRule, customRules, videoRule: null }, video(), ctx);
    (r.effective.captions.languages as string[]).push("de");
    r.effective.transcode.quality = 1;
    expect(JSON.stringify([globalRule, custom])).toBe(before);
    expect(customRules).toEqual([custom]);
    expect(effectDefaults().transcode.quality).toBe(28);
  });
});

describe("sortCustomRules", () => {
  it("sorts by position then id without mutating the input", () => {
    const input = [
      { id: 3, position: 2 },
      { id: 2, position: 1 },
      { id: 1, position: 2 },
    ];
    expect(sortCustomRules(input).map((r) => r.id)).toEqual([2, 1, 3]);
    expect(input.map((r) => r.id)).toEqual([3, 2, 1]);
  });
});

describe("RuleSchema", () => {
  it("round-trips through JSON", () => {
    const r = rule({
      id: 9,
      kind: "custom",
      position: 4,
      condition: isShort,
      effects: { include: false, notify: { enabled: true, max_times: null, channel: "push" } },
    });
    expect(RuleSchema.parse(JSON.parse(JSON.stringify(r)))).toEqual(r);
    expect(setEffectKeys(r)).toEqual(["include", "notify"]);
  });

  it.each<[string, Record<string, unknown>, (string | number)[]]>([
    ["include on global", { kind: "global", effects: { include: true } }, ["effects", "include"]],
    ["custom without condition", { kind: "custom", condition: null }, ["condition"]],
    ["custom with video_id", { kind: "custom", video_id: "abc" }, ["video_id"]],
    ["global with condition", { kind: "global", condition: isShort }, ["condition"]],
    ["global with video_id", { kind: "global", video_id: "abc" }, ["video_id"]],
    ["video without video_id", { kind: "video", video_id: null }, ["video_id"]],
    ["video with condition", { kind: "video", video_id: "abc", condition: isShort }, ["condition"]],
    [
      "bad effect",
      { kind: "global", effects: { reclaim_priority: -5 } },
      ["effects", "reclaim_priority"],
    ],
    ["bad id", { kind: "global", id: 0 }, ["id"]],
  ])("rejects %s", (_name, patch, path) => {
    const base = {
      id: 1,
      kind: "custom",
      video_id: null,
      position: 0,
      name: "x",
      enabled: true,
      condition: isShort,
      effects: {},
    };
    const result = RuleSchema.safeParse({
      ...base,
      condition: patch["kind"] === "custom" ? isShort : null,
      ...patch,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path)).toContainEqual(path);
  });
});
