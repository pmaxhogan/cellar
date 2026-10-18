import { describe, expect, it } from "vitest";
import {
  ConditionSchema,
  DEFAULT_RULES,
  defaultRules,
  effectDefaults,
  EffectsSchema,
  nextEvalAt,
  resolveEffective,
  RuleDraftSchema,
  validateAst,
  type Rule,
  type RuleLayers,
  type VideoFacts,
} from "../../src/index.ts";
import { at, DAY, INSTALLED_AT, NOW, src, video } from "./fixtures.ts";

const GLOBAL_ID = 100;

/** Default rules with ids: the global rule is 100, custom rule N has id N. */
function layers(): RuleLayers {
  const [g, ...custom] = defaultRules();
  return {
    globalRule: { ...g!, id: GLOBAL_ID },
    customRules: custom.map((r): Rule => ({ ...r, id: r.position })),
    videoRule: null,
  };
}

function resolve(v: VideoFacts, now = NOW) {
  return resolveEffective(layers(), v, at(now));
}

describe("DEFAULT_RULES encoding", () => {
  it("has the 8 rows of spec 4.5 with exact names, kinds and positions", () => {
    expect(DEFAULT_RULES.map((r) => [r.kind, r.position, r.name])).toEqual([
      ["global", 0, "Global defaults"],
      ["custom", 1, "Expire: subscriptions after 2 weeks"],
      ["custom", 2, "Expire: watched after 2 months"],
      ["custom", 3, "Expire: liked after 2 years"],
      ["custom", 4, "Guard: no subscription backfill older than 7 days before install"],
      ["custom", 5, "Captions: English only"],
      ["custom", 6, "Keep unlisted and gone forever"],
      ["custom", 7, "Notify when a video goes gone"],
    ]);
    for (const r of DEFAULT_RULES) {
      expect(r.enabled).toBe(true);
      expect(r.video_id).toBeNull();
    }
  });

  it("every rule validates and round-trips through JSON", () => {
    for (const r of DEFAULT_RULES) {
      const json = JSON.parse(JSON.stringify(r));
      expect(RuleDraftSchema.parse(json)).toEqual(r);
      expect(EffectsSchema.parse(json.effects)).toEqual(r.effects);
      if (r.condition !== null) {
        expect(validateAst(json.condition)).toMatchObject({ ok: true });
        expect(ConditionSchema.parse(json.condition)).toEqual(r.condition);
      }
    }
  });

  it("encodes the global rule's effects exactly as the table says", () => {
    expect(DEFAULT_RULES[0]!.condition).toBeNull();
    expect(DEFAULT_RULES[0]!.effects).toEqual({
      reclaim_priority: -1,
      location_id: null,
      media_mode: "video",
      format_policy: "prefer_av1",
      transcode: {
        mode: "if_not_av1",
        codec: "hevc_nvenc",
        quality: 28,
        preset: "p5",
        audio_codec: "copy",
      },
      captions: { enabled: true, languages: "all", auto_generated: true },
      live: "vod_only",
      download_accounts: "sourcing",
      proxy: "none",
      recheck_interval: "tiered",
      notify: { enabled: false, max_times: 1, channel: "push" },
    });
    expect("include" in DEFAULT_RULES[0]!.effects).toBe(false);
  });

  it("encodes the custom rule conditions exactly", () => {
    const c = DEFAULT_RULES.map((r) => r.condition);
    expect(c[1]).toEqual({
      type: "group",
      op: "and",
      children: [
        { type: "cond", field: "source", op: "has_only", value: ["subscription", "channel"] },
        {
          type: "group",
          op: "or",
          children: [
            {
              type: "cond",
              field: "first_seen",
              source: "subscription",
              op: "age_gt",
              value: { days: 14 },
            },
            {
              type: "cond",
              field: "first_seen",
              source: "channel",
              op: "age_gt",
              value: { days: 14 },
            },
          ],
        },
      ],
    });
    expect(c[2]).toEqual({
      type: "group",
      op: "and",
      children: [
        { type: "cond", field: "source", op: "has_none", value: ["liked", "watch_later"] },
        { type: "cond", field: "source", op: "has_any", value: ["history"] },
        {
          type: "cond",
          field: "first_seen",
          source: "history",
          op: "age_gt",
          value: { months: 2 },
        },
      ],
    });
    expect(c[3]).toEqual({
      type: "group",
      op: "and",
      children: [
        { type: "cond", field: "source", op: "has_any", value: ["liked"] },
        { type: "cond", field: "source", op: "has_none", value: ["watch_later"] },
        { type: "cond", field: "first_seen", source: "liked", op: "age_gt", value: { years: 2 } },
      ],
    });
    expect(c[4]).toEqual({
      type: "group",
      op: "and",
      children: [
        { type: "cond", field: "source", op: "has_only", value: ["subscription", "channel"] },
        { type: "cond", field: "upload_date", op: "before_install_minus", value: { days: 7 } },
      ],
    });
    expect(c[5]).toEqual({ type: "group", op: "and", children: [] });
    expect(c[6]).toEqual({ type: "cond", field: "status", op: "in", value: ["unlisted", "gone"] });
    expect(c[7]).toEqual({ type: "cond", field: "status", op: "eq", value: "gone" });
  });

  it("encodes the custom rule effects exactly", () => {
    expect(DEFAULT_RULES.slice(1).map((r) => r.effects)).toEqual([
      { reclaim_priority: 0 },
      { reclaim_priority: 0 },
      { reclaim_priority: 0 },
      { reclaim_priority: 0 },
      { captions: { enabled: true, languages: ["en"], auto_generated: true } },
      { reclaim_priority: -1 },
      { notify: { enabled: true, max_times: 1, channel: "push" } },
    ]);
  });

  it("is frozen, and defaultRules() returns independent copies", () => {
    expect(Object.isFrozen(DEFAULT_RULES)).toBe(true);
    const a = defaultRules();
    a[1]!.name = "changed";
    expect(defaultRules()[1]!.name).toBe("Expire: subscriptions after 2 weeks");
    expect(DEFAULT_RULES[1]!.name).toBe("Expire: subscriptions after 2 weeks");
  });
});

describe("default rules: resulting retention (spec 4.5)", () => {
  it("leaves a fresh video at pri -1 with the global settings and English captions", () => {
    const r = resolve(video());
    expect(r.effective.reclaim_priority).toBe(-1);
    expect(r.provenance.reclaim_priority).toBe(GLOBAL_ID);
    expect(r.effective.include).toBe(true);
    expect(r.provenance.include).toBe("default");
    expect(r.effective.captions).toEqual({
      enabled: true,
      languages: ["en"],
      auto_generated: true,
    });
    expect(r.provenance.captions).toBe(5);
    expect(r.effective.notify.enabled).toBe(false);
    expect(r.matchedRuleIds).toEqual([GLOBAL_ID, 5]);
    expect(r.effective.location_id).toBeNull();
    const { captions: _c, ...rest } = r.effective;
    const { captions: _d, ...defaults } = effectDefaults();
    expect(rest).toEqual(defaults);
  });

  describe("subscription / channel only: 2 weeks", () => {
    it.each<[string, VideoFacts["sources"], number, number | "default"]>([
      ["subscription 15 days", [src("subscription", NOW - 15 * DAY)], 0, 1],
      ["subscription 14 days exactly", [src("subscription", NOW - 14 * DAY)], 0, 1],
      ["subscription 13 days", [src("subscription", NOW - 13 * DAY)], -1, GLOBAL_ID],
      [
        "manual channel (no account) 15 days",
        [src("channel", NOW - 15 * DAY, { account_id: null })],
        0,
        1,
      ],
      [
        "subscription and channel, either older",
        [src("subscription", NOW - 2 * DAY), src("channel", NOW - 20 * DAY)],
        0,
        1,
      ],
      [
        "subscription on two accounts, earliest decides",
        [
          src("subscription", NOW - 3 * DAY),
          src("subscription", NOW - 16 * DAY, { account_id: 2 }),
        ],
        0,
        1,
      ],
    ])("%s -> pri %s", (_name, sources, pri, by) => {
      const r = resolve(video({ sources }));
      expect(r.effective.reclaim_priority).toBe(pri);
      expect(r.provenance.reclaim_priority).toBe(by);
    });

    it("flips to pri 0 exactly 14 days after first seen", () => {
      const v = video({ sources: [src("subscription", NOW - 5 * DAY)] });
      const all = layers();
      const rules = [all.globalRule!, ...all.customRules];
      const t = nextEvalAt(rules, v, at(NOW));
      expect(t).toBe(NOW + 9 * DAY);
      expect(resolve(v, t! - 1).effective.reclaim_priority).toBe(-1);
      expect(resolve(v, t!).effective.reclaim_priority).toBe(0);
    });
  });

  describe("watched (not liked, not watch later): 2 months", () => {
    it.each<[string, VideoFacts["sources"], number, number]>([
      ["watched 3 months ago", [src("history", Date.UTC(2026, 6, 18, 12))], 0, 2],
      ["watched exactly 2 months ago", [src("history", Date.UTC(2026, 7, 18, 12))], 0, 2],
      ["watched 2 months minus 1 day", [src("history", Date.UTC(2026, 7, 19, 12))], -1, GLOBAL_ID],
      ["watched 1 month ago", [src("history", NOW - 30 * DAY)], -1, GLOBAL_ID],
      [
        "subscribed and watched gets the 2-month window, not 2 weeks",
        [src("subscription", NOW - 40 * DAY), src("history", NOW - 40 * DAY)],
        -1,
        GLOBAL_ID,
      ],
      [
        "subscribed and watched, past 2 months",
        [src("subscription", NOW - 90 * DAY), src("history", NOW - 70 * DAY)],
        0,
        2,
      ],
    ])("%s -> pri %s", (_name, sources, pri, by) => {
      const r = resolve(video({ sources }));
      expect(r.effective.reclaim_priority).toBe(pri);
      expect(r.provenance.reclaim_priority).toBe(by);
    });
  });

  describe("liked (not watch later): 2 years", () => {
    it.each<[string, VideoFacts["sources"], number, number]>([
      ["liked 2 years and a day ago", [src("liked", Date.UTC(2024, 9, 17, 12))], 0, 3],
      ["liked 1 year ago", [src("liked", NOW - 365 * DAY)], -1, GLOBAL_ID],
      [
        "watched and liked keeps the 2-year window",
        [src("history", NOW - 300 * DAY), src("liked", NOW - 300 * DAY)],
        -1,
        GLOBAL_ID,
      ],
      [
        "subscribed and liked keeps the 2-year window",
        [src("subscription", NOW - 300 * DAY), src("liked", NOW - 300 * DAY)],
        -1,
        GLOBAL_ID,
      ],
      [
        "watched, liked, both past 2 years",
        [src("history", NOW - 800 * DAY), src("liked", NOW - 800 * DAY)],
        0,
        3,
      ],
    ])("%s -> pri %s", (_name, sources, pri, by) => {
      const r = resolve(video({ sources }));
      expect(r.effective.reclaim_priority).toBe(pri);
      expect(r.provenance.reclaim_priority).toBe(by);
    });
  });

  describe("watch later: forever", () => {
    it.each<[string, VideoFacts["sources"]]>([
      ["watch later only, 5 years", [src("watch_later", NOW - 1800 * DAY)]],
      [
        "watch later plus everything, all ancient",
        [
          src("watch_later", NOW - 1800 * DAY),
          src("history", NOW - 1800 * DAY),
          src("liked", NOW - 1800 * DAY),
          src("subscription", NOW - 1800 * DAY),
        ],
      ],
    ])("%s -> pri -1", (_name, sources) => {
      const r = resolve(video({ sources, upload_date: NOW - 2000 * DAY }));
      expect(r.effective.reclaim_priority).toBe(-1);
      expect(r.provenance.reclaim_priority).toBe(GLOBAL_ID);
    });
  });

  describe("unlisted and gone: forever, even when old", () => {
    const old = {
      upload_date: INSTALLED_AT - 400 * DAY,
      sources: [src("subscription", NOW - 300 * DAY)],
    };

    it.each<[string, Partial<VideoFacts>, boolean]>([
      ["unlisted", { privacy: "unlisted" }, false],
      ["private (gone)", { privacy: "private" }, true],
      ["removed (gone)", { privacy: "removed" }, true],
      ["unavailable (gone)", { privacy: "unavailable" }, true],
      ["public but gone_since set", { privacy: "public", gone_since: NOW - DAY }, true],
    ])("%s -> pri -1 from rule 6", (_name, overrides, gone) => {
      const r = resolve(video({ ...old, ...overrides }));
      expect(r.effective.reclaim_priority).toBe(-1);
      expect(r.provenance.reclaim_priority).toBe(6);
      expect(r.matchedRuleIds).toContain(1);
      expect(r.matchedRuleIds).toContain(4);
      expect(r.effective.notify.enabled).toBe(gone);
    });

    it("an old watched video that goes gone is kept", () => {
      const r = resolve(video({ privacy: "removed", sources: [src("history", NOW - 200 * DAY)] }));
      expect(r.effective.reclaim_priority).toBe(-1);
      expect(r.matchedRuleIds).toEqual([GLOBAL_ID, 2, 5, 6, 7]);
    });
  });

  describe("rule 7: notify when gone", () => {
    it("enables a single push notification and leaves pri to rule 6", () => {
      const r = resolve(video({ privacy: "private" }));
      expect(r.effective.notify).toEqual({ enabled: true, max_times: 1, channel: "push" });
      expect(r.provenance.notify).toBe(7);
      expect(r.provenance.reclaim_priority).toBe(6);
    });

    it("does not fire for public or unlisted videos", () => {
      for (const privacy of ["public", "unlisted"] as const) {
        const r = resolve(video({ privacy }));
        expect(r.effective.notify.enabled).toBe(false);
        expect(r.provenance.notify).toBe(GLOBAL_ID);
      }
    });
  });

  describe("rule 4: subscription backfill guard", () => {
    it.each<[string, Partial<VideoFacts>, number, number]>([
      [
        "subscription-only uploaded 8 days before install, seen yesterday",
        { upload_date: INSTALLED_AT - 8 * DAY, sources: [src("subscription", NOW - DAY)] },
        0,
        4,
      ],
      [
        "channel-only uploaded a year before install",
        { upload_date: INSTALLED_AT - 365 * DAY, sources: [src("channel", NOW - DAY)] },
        0,
        4,
      ],
      [
        "subscription-only uploaded 6 days before install",
        { upload_date: INSTALLED_AT - 6 * DAY, sources: [src("subscription", NOW - DAY)] },
        -1,
        GLOBAL_ID,
      ],
      [
        "subscription-only uploaded after install",
        { upload_date: INSTALLED_AT + DAY, sources: [src("subscription", NOW - DAY)] },
        -1,
        GLOBAL_ID,
      ],
      [
        "pre-install upload that was also watched is not guarded",
        {
          upload_date: INSTALLED_AT - 300 * DAY,
          sources: [src("subscription", NOW - DAY), src("history", NOW - DAY)],
        },
        -1,
        GLOBAL_ID,
      ],
      [
        "pre-install liked upload is not guarded",
        { upload_date: INSTALLED_AT - 300 * DAY, sources: [src("liked", NOW - DAY)] },
        -1,
        GLOBAL_ID,
      ],
      [
        "unknown upload date falls back to published_at",
        {
          upload_date: null,
          published_at: INSTALLED_AT - 30 * DAY,
          sources: [src("subscription", NOW - DAY)],
        },
        0,
        4,
      ],
    ])("%s -> pri %s", (_name, overrides, pri, by) => {
      const r = resolve(video(overrides));
      expect(r.effective.reclaim_priority).toBe(pri);
      expect(r.provenance.reclaim_priority).toBe(by);
    });
  });

  it("making rule 1 reap-eligible (0 -> 1) changes the outcome as the owner expects", () => {
    const l = layers();
    const rule1 = l.customRules.find((r) => r.position === 1)!;
    const edited = {
      ...l,
      customRules: l.customRules.map((r) =>
        r === rule1 ? { ...r, effects: { reclaim_priority: 1 } } : r,
      ),
    };
    const v = video({ sources: [src("subscription", NOW - 30 * DAY)] });
    expect(resolveEffective(edited, v, at(NOW)).effective.reclaim_priority).toBe(1);
  });
});
