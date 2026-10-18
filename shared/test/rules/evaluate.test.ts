import { describe, expect, it } from "vitest";
import {
  ConditionSchema,
  evaluateCondition,
  evaluateLeaf,
  isGone,
  LeafSchema,
  matchAll,
  sourceSet,
  VideoFactsSchema,
  videoStatuses,
  type ConditionNode,
  type LeafNode,
  type VideoFacts,
} from "../../src/index.ts";
import { at, ctx, DAY, HOUR, INSTALLED_AT, NOW, src, video } from "./fixtures.ts";

type Case = [name: string, leaf: unknown, overrides: Partial<VideoFacts>, expected: boolean];

function run(cases: Case[]): void {
  it.each(cases)("%s", (_name, leaf, overrides, expected) => {
    const parsed = LeafSchema.parse(leaf);
    expect(evaluateLeaf(parsed, video(overrides), ctx)).toBe(expected);
    expect(evaluateCondition(parsed, video(overrides), ctx)).toBe(expected);
  });
}

function cond(field: string, op: string, value: unknown, extra: object = {}): unknown {
  return { type: "cond", field, op, value, ...extra };
}

const subOnly = { sources: [src("subscription", NOW - DAY), src("channel", NOW - DAY)] };
const multi = {
  sources: [
    src("subscription", NOW - 30 * DAY, { account_id: 1 }),
    src("history", NOW - 3 * DAY, { account_id: 2 }),
    src("liked", NOW - 2 * DAY, { account_id: 2 }),
  ],
};

describe("account", () => {
  run([
    ["eq matches a source account", cond("account", "eq", 2), multi, true],
    ["eq misses", cond("account", "eq", 3), multi, false],
    ["in matches any", cond("account", "in", [3, 1]), multi, true],
    ["in misses", cond("account", "in", [3, 4]), multi, false],
    [
      "manual channel (null account) never matches",
      cond("account", "eq", 1),
      { sources: [src("channel", NOW, { account_id: null })] },
      false,
    ],
    ["no sources", cond("account", "in", [1]), { sources: [] }, false],
  ]);
});

describe("source", () => {
  run([
    ["has_any hit", cond("source", "has_any", ["liked", "watch_later"]), multi, true],
    ["has_any miss", cond("source", "has_any", ["watch_later"]), multi, false],
    ["has_all hit", cond("source", "has_all", ["liked", "history"]), multi, true],
    ["has_all miss", cond("source", "has_all", ["liked", "watch_later"]), multi, false],
    ["has_only hit", cond("source", "has_only", ["subscription", "channel"]), subOnly, true],
    [
      "has_only hit with a subset",
      cond("source", "has_only", ["subscription", "channel"]),
      { sources: [src("subscription", NOW)] },
      true,
    ],
    ["has_only miss", cond("source", "has_only", ["subscription", "channel"]), multi, false],
    [
      "has_only on no sources is false",
      cond("source", "has_only", ["liked"]),
      { sources: [] },
      false,
    ],
    ["has_none hit", cond("source", "has_none", ["watch_later"]), multi, true],
    ["has_none miss", cond("source", "has_none", ["liked", "watch_later"]), multi, false],
    [
      "has_none on no sources is true",
      cond("source", "has_none", ["liked"]),
      { sources: [] },
      true,
    ],
    [
      "has_any on no sources is false",
      cond("source", "has_any", ["liked"]),
      { sources: [] },
      false,
    ],
  ]);
});

describe("type", () => {
  run([
    ["eq hit", cond("type", "eq", "video"), {}, true],
    ["eq miss", cond("type", "eq", "short"), {}, false],
    ["in hit", cond("type", "in", ["short", "premiere"]), { type: "premiere" }, true],
    ["in miss", cond("type", "in", ["short", "livestream"]), {}, false],
    ["null type never matches", cond("type", "in", ["video"]), { type: null }, false],
  ]);
});

describe("channel", () => {
  run([
    ["eq hit", cond("channel", "eq", "UCsynthetic000000000001"), {}, true],
    ["eq miss", cond("channel", "eq", "UCother"), {}, false],
    ["in hit", cond("channel", "in", ["UCother", "UCsynthetic000000000001"]), {}, true],
    ["in miss", cond("channel", "in", ["UCother"]), {}, false],
    ["null channel", cond("channel", "eq", "UCother"), { channel_id: null }, false],
  ]);
});

describe("status", () => {
  run([
    ["public", cond("status", "eq", "public"), {}, true],
    ["public is not gone", cond("status", "eq", "gone"), {}, false],
    ["unlisted", cond("status", "eq", "unlisted"), { privacy: "unlisted" }, true],
    ["private is gone", cond("status", "eq", "gone"), { privacy: "private" }, true],
    ["private is private", cond("status", "eq", "private"), { privacy: "private" }, true],
    ["removed is gone", cond("status", "eq", "gone"), { privacy: "removed" }, true],
    ["removed is removed", cond("status", "eq", "removed"), { privacy: "removed" }, true],
    ["unavailable is gone", cond("status", "eq", "gone"), { privacy: "unavailable" }, true],
    [
      "unavailable is neither private nor removed",
      cond("status", "in", ["private", "removed", "public"]),
      { privacy: "unavailable" },
      false,
    ],
    ["gone_since makes public gone", cond("status", "eq", "gone"), { gone_since: NOW - DAY }, true],
    ["gone_since hides public", cond("status", "eq", "public"), { gone_since: NOW - DAY }, false],
    ["in hit", cond("status", "in", ["unlisted", "gone"]), { privacy: "removed" }, true],
    ["in miss", cond("status", "in", ["unlisted", "gone"]), {}, false],
    ["null privacy has no status", cond("status", "eq", "public"), { privacy: null }, false],
  ]);
});

const NUMERIC = ["duration_s", "views", "likes", "comments", "ryd_ratio", "max_height", "max_fps"];

describe.each(NUMERIC)("numeric field %s", (field) => {
  const v = 100;
  run([
    ["lt true", cond(field, "lt", 101), { [field]: v }, true],
    ["lt false at equal", cond(field, "lt", 100), { [field]: v }, false],
    ["lte true at equal", cond(field, "lte", 100), { [field]: v }, true],
    ["lte false", cond(field, "lte", 99), { [field]: v }, false],
    ["gt true", cond(field, "gt", 99), { [field]: v }, true],
    ["gt false at equal", cond(field, "gt", 100), { [field]: v }, false],
    ["gte true at equal", cond(field, "gte", 100), { [field]: v }, true],
    ["gte false", cond(field, "gte", 101), { [field]: v }, false],
    ["between inclusive low", cond(field, "between", [100, 200]), { [field]: v }, true],
    ["between inclusive high", cond(field, "between", [50, 100]), { [field]: v }, true],
    ["between outside", cond(field, "between", [101, 200]), { [field]: v }, false],
    ["null is false for lt", cond(field, "lt", 1e9), { [field]: null }, false],
    ["null is false for gte", cond(field, "gte", -1e9), { [field]: null }, false],
    ["null is false for between", cond(field, "between", [-1e9, 1e9]), { [field]: null }, false],
  ]);
});

describe("ryd_ratio fractions", () => {
  run([["fractional compare", cond("ryd_ratio", "gt", 0.85), { ryd_ratio: 0.9 }, true]]);
});

describe("has_codec", () => {
  run([
    ["eq av1", cond("has_codec", "eq", "av1"), {}, true],
    ["eq h264 false", cond("has_codec", "eq", "h264"), {}, false],
    ["eq vp9", cond("has_codec", "eq", "vp9"), {}, true],
    ["eq h264 true", cond("has_codec", "eq", "h264"), { has_h264: true }, true],
    ["in any", cond("has_codec", "in", ["h264", "vp9"]), {}, true],
    ["in none", cond("has_codec", "in", ["av1", "vp9"]), { has_av1: false, has_vp9: null }, false],
  ]);
});

describe.each(["is_hdr", "caption_available"])("bool field %s", (field) => {
  run([
    ["eq true hit", cond(field, "eq", true), { [field]: true }, true],
    ["eq true miss", cond(field, "eq", true), { [field]: false }, false],
    ["eq false hit", cond(field, "eq", false), { [field]: false }, true],
    ["eq false miss", cond(field, "eq", false), { [field]: true }, false],
    ["null matches neither true", cond(field, "eq", true), { [field]: null }, false],
    ["null matches neither false", cond(field, "eq", false), { [field]: null }, false],
  ]);
});

describe("has_share_link", () => {
  run([
    ["no links", cond("has_share_link", "eq", false), {}, true],
    ["no links is not true", cond("has_share_link", "eq", true), {}, false],
    ["links", cond("has_share_link", "eq", true), { share_link_count: 2 }, true],
    ["links is not false", cond("has_share_link", "eq", false), { share_link_count: 1 }, false],
  ]);
});

const downloadedMedia = { media: { downloaded_at: NOW - HOUR, location_id: 2, vcodec: "av01" } };

describe("downloaded and current_location", () => {
  run([
    ["downloaded true", cond("downloaded", "eq", true), downloadedMedia, true],
    ["downloaded false when media null", cond("downloaded", "eq", false), {}, true],
    ["downloaded true misses when media null", cond("downloaded", "eq", true), {}, false],
    [
      "unfinished media is not downloaded",
      cond("downloaded", "eq", true),
      { media: { downloaded_at: null, location_id: 2, vcodec: null } },
      false,
    ],
    ["location hit", cond("current_location", "eq", 2), downloadedMedia, true],
    ["location miss", cond("current_location", "eq", 1), downloadedMedia, false],
    ["no media no location", cond("current_location", "eq", 2), {}, false],
  ]);
});

describe.each([
  ["title", { title: "Hello World Example" }, { title: null }],
  ["description", { description: "Hello World Example" }, { description: null }],
  ["channel_title", { channel_title: "Hello World Example" }, { channel_title: null }],
  ["tags", { tags: ["intro", "Hello World Example"] }, { tags: [] }],
] as const)("text field %s", (field, withText, empty) => {
  const o = withText as Partial<VideoFacts>;
  const e = empty as Partial<VideoFacts>;
  run([
    ["contains hit", cond(field, "contains", "World"), o, true],
    ["contains is case sensitive", cond(field, "contains", "world"), o, false],
    ["contains ci", cond(field, "contains", "world", { ci: true }), o, true],
    ["not_contains hit", cond(field, "not_contains", "Bye"), o, true],
    ["not_contains miss", cond(field, "not_contains", "World"), o, false],
    ["not_contains ci miss", cond(field, "not_contains", "WORLD", { ci: true }), o, false],
    ["starts_with hit", cond(field, "starts_with", "Hello"), o, true],
    ["starts_with miss", cond(field, "starts_with", "World"), o, false],
    ["starts_with ci", cond(field, "starts_with", "hello", { ci: true }), o, true],
    ["ends_with hit", cond(field, "ends_with", "Example"), o, true],
    ["ends_with miss", cond(field, "ends_with", "Hello"), o, false],
    ["ends_with ci", cond(field, "ends_with", "EXAMPLE", { ci: true }), o, true],
    ["eq hit", cond(field, "eq", "Hello World Example"), o, true],
    ["eq miss", cond(field, "eq", "Hello World"), o, false],
    ["eq ci", cond(field, "eq", "hello world example", { ci: true }), o, true],
    ["regex hit", cond(field, "regex", "^Hello\\s\\w+"), o, true],
    ["regex miss", cond(field, "regex", "^world"), o, false],
    ["regex ci", cond(field, "regex", "^hello", { ci: true }), o, true],
    ["not_regex hit", cond(field, "not_regex", "^Bye"), o, true],
    ["not_regex miss", cond(field, "not_regex", "Example$"), o, false],
    ["not_regex ci miss", cond(field, "not_regex", "example$", { ci: true }), o, false],
    ["empty value: contains", cond(field, "contains", "x"), e, false],
    ["empty value: not_contains", cond(field, "not_contains", "x"), e, true],
    ["empty value: not_regex", cond(field, "not_regex", "x"), e, true],
  ]);
});

describe("tags semantics", () => {
  const tags = { tags: ["alpha", "Beta"] };
  run([
    ["any tag eq", cond("tags", "eq", "Beta"), tags, true],
    ["eq does not join tags", cond("tags", "eq", "alpha Beta"), tags, false],
    ["not_contains means no tag contains", cond("tags", "not_contains", "lph"), tags, false],
    ["not_contains true when none", cond("tags", "not_contains", "gamma"), tags, true],
    ["regex any tag", cond("tags", "regex", "^B"), tags, true],
    ["not_regex means no tag matches", cond("tags", "not_regex", "^B"), tags, false],
  ]);
});

describe("unsafe regex at evaluation time", () => {
  it("never matches, for regex and not_regex alike", () => {
    // Bypass the schema to simulate a stored pattern that predates a stricter guard.
    const evil = { type: "cond", field: "title", op: "regex", value: "(a+)+$" } as LeafNode;
    const notEvil = { ...evil, op: "not_regex" } as LeafNode;
    const v = video({ title: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!" });
    expect(evaluateLeaf(evil, v, ctx)).toBe(false);
    expect(evaluateLeaf(notEvil, v, ctx)).toBe(false);
  });
});

describe("time anchors", () => {
  const anchors = {
    upload_date: NOW - 30 * DAY,
    published_at: NOW - 31 * DAY,
    sources: [
      src("subscription", NOW - 20 * DAY, { last_seen_at: NOW - 2 * DAY }),
      src("history", NOW - 10 * DAY, { last_seen_at: NOW - HOUR }),
      src("liked", NOW - 400 * DAY, { account_id: 2, last_seen_at: NOW - 3 * DAY }),
      src("history", NOW - 15 * DAY, { account_id: 2 }),
    ],
    media: { downloaded_at: NOW - 5 * DAY, location_id: 1, vcodec: "hevc" },
  } satisfies Partial<VideoFacts>;

  describe("upload_date", () => {
    run([
      ["age_gt hit", cond("upload_date", "age_gt", "P29D"), anchors, true],
      ["age_gt miss", cond("upload_date", "age_gt", { days: 31 }), anchors, false],
      ["age_gt at the exact threshold", cond("upload_date", "age_gt", { days: 30 }), anchors, true],
      ["age_lt hit", cond("upload_date", "age_lt", { days: 31 }), anchors, true],
      ["age_lt at the exact threshold", cond("upload_date", "age_lt", "P30D"), anchors, false],
      ["before hit", cond("upload_date", "before", NOW - 29 * DAY), anchors, true],
      ["before miss", cond("upload_date", "before", NOW - 30 * DAY), anchors, false],
      ["after hit", cond("upload_date", "after", "2026-09-01T00:00:00Z"), anchors, true],
      ["after miss", cond("upload_date", "after", NOW - 30 * DAY), anchors, false],
      ["is_null false", cond("upload_date", "is_null", true), anchors, false],
      ["is_null(false) true", cond("upload_date", "is_null", false), anchors, true],
      [
        "falls back to published_at",
        cond("upload_date", "age_gt", { days: 31 }),
        { ...anchors, upload_date: null },
        true,
      ],
      [
        "is_null when both missing",
        cond("upload_date", "is_null", true),
        { upload_date: null, published_at: null },
        true,
      ],
      [
        "age_gt false when missing",
        cond("upload_date", "age_gt", { days: 0 }),
        { upload_date: null, published_at: null },
        false,
      ],
      [
        "age_lt false when missing",
        cond("upload_date", "age_lt", { years: 100 }),
        { upload_date: null, published_at: null },
        false,
      ],
      [
        "before false when missing",
        cond("upload_date", "before", NOW),
        { upload_date: null, published_at: null },
        false,
      ],
      [
        "after false when missing",
        cond("upload_date", "after", 0),
        { upload_date: null, published_at: null },
        false,
      ],
    ]);
  });

  describe("upload_date before_install_minus", () => {
    run([
      [
        "8 days before install",
        cond("upload_date", "before_install_minus", { days: 7 }),
        { upload_date: INSTALLED_AT - 8 * DAY },
        true,
      ],
      [
        "exactly 7 days before install is not before",
        cond("upload_date", "before_install_minus", "P7D"),
        { upload_date: INSTALLED_AT - 7 * DAY },
        false,
      ],
      [
        "6 days before install",
        cond("upload_date", "before_install_minus", { days: 7 }),
        { upload_date: INSTALLED_AT - 6 * DAY },
        false,
      ],
      [
        "after install",
        cond("upload_date", "before_install_minus", { days: 7 }),
        { upload_date: INSTALLED_AT + DAY },
        false,
      ],
      [
        "missing upload date",
        cond("upload_date", "before_install_minus", { days: 7 }),
        { upload_date: null, published_at: null },
        false,
      ],
    ]);
  });

  describe("first_seen", () => {
    run([
      ["any source: earliest is 400d", cond("first_seen", "age_gt", { days: 399 }), anchors, true],
      ["any source: not 401d", cond("first_seen", "age_gt", { days: 401 }), anchors, false],
      [
        "history: earliest across accounts is 15d",
        cond("first_seen", "age_gt", { days: 14 }, { source: "history" }),
        anchors,
        true,
      ],
      [
        "history: not 16d",
        cond("first_seen", "age_gt", { days: 16 }, { source: "history" }),
        anchors,
        false,
      ],
      [
        "subscription age_lt",
        cond("first_seen", "age_lt", { days: 21 }, { source: "subscription" }),
        anchors,
        true,
      ],
      [
        "liked 1 year",
        cond("first_seen", "age_gt", { years: 1 }, { source: "liked" }),
        anchors,
        true,
      ],
      [
        "missing source: is_null",
        cond("first_seen", "is_null", true, { source: "watch_later" }),
        anchors,
        true,
      ],
      [
        "missing source: age_gt false",
        cond("first_seen", "age_gt", { days: 0 }, { source: "watch_later" }),
        anchors,
        false,
      ],
      [
        "missing source: age_lt false",
        cond("first_seen", "age_lt", { years: 9 }, { source: "watch_later" }),
        anchors,
        false,
      ],
      [
        "missing source: before false",
        cond("first_seen", "before", NOW, { source: "watch_later" }),
        anchors,
        false,
      ],
      [
        "missing source: after false",
        cond("first_seen", "after", 0, { source: "watch_later" }),
        anchors,
        false,
      ],
      ["present: is_null false", cond("first_seen", "is_null", true), anchors, false],
      ["no sources: is_null", cond("first_seen", "is_null", true), { sources: [] }, true],
      ["before", cond("first_seen", "before", NOW - 9 * DAY, { source: "history" }), anchors, true],
      [
        "after (earliest decides)",
        cond("first_seen", "after", NOW - 12 * DAY, { source: "history" }),
        anchors,
        false,
      ],
    ]);
  });

  describe("downloaded_at", () => {
    run([
      ["age_gt", cond("downloaded_at", "age_gt", { days: 4 }), anchors, true],
      ["age_lt", cond("downloaded_at", "age_lt", { days: 4 }), anchors, false],
      ["before", cond("downloaded_at", "before", NOW), anchors, true],
      ["after", cond("downloaded_at", "after", NOW - 4 * DAY), anchors, false],
      ["is_null when not downloaded", cond("downloaded_at", "is_null", true), {}, true],
      ["is_null false when downloaded", cond("downloaded_at", "is_null", true), anchors, false],
      ["age_gt false when not downloaded", cond("downloaded_at", "age_gt", "PT1H"), {}, false],
    ]);
  });

  describe("last_seen", () => {
    run([
      ["latest across sources is 1h", cond("last_seen", "age_lt", "PT2H"), anchors, true],
      ["age_gt", cond("last_seen", "age_gt", "PT2H"), anchors, false],
      ["before", cond("last_seen", "before", NOW), anchors, true],
      ["after", cond("last_seen", "after", NOW - 2 * HOUR), anchors, true],
      ["is_null with no sources", cond("last_seen", "is_null", true), { sources: [] }, true],
      ["age_gt false with no sources", cond("last_seen", "age_gt", "PT1H"), { sources: [] }, false],
    ]);
  });

  describe("now", () => {
    run([
      ["before a future instant", cond("now", "before", NOW + 1), {}, true],
      ["not before itself", cond("now", "before", NOW), {}, false],
      ["after a past instant", cond("now", "after", "2026-10-18T11:59:59Z"), {}, true],
      ["not after itself", cond("now", "after", NOW), {}, false],
      ["never null", cond("now", "is_null", true), {}, false],
      ["age of now is zero: age_gt", cond("now", "age_gt", "PT1H"), {}, false],
      ["age of now is zero: age_lt", cond("now", "age_lt", "PT1H"), {}, true],
    ]);
  });

  it("uses calendar months for age (2 months from Aug 18 is Oct 18)", () => {
    const leaf = LeafSchema.parse(
      cond("first_seen", "age_gt", { months: 2 }, { source: "history" }),
    );
    const v = video({ sources: [src("history", Date.UTC(2026, 7, 18, 12))] });
    expect(evaluateLeaf(leaf, v, at(Date.UTC(2026, 9, 18, 12) - 1))).toBe(false);
    expect(evaluateLeaf(leaf, v, at(Date.UTC(2026, 9, 18, 12)))).toBe(true);
  });

  it("uses calendar years for age (leap day)", () => {
    const leaf = LeafSchema.parse(cond("first_seen", "age_gt", { years: 2 }));
    const v = video({ sources: [src("liked", Date.UTC(2024, 1, 29))] });
    expect(evaluateLeaf(leaf, v, at(Date.UTC(2026, 1, 28) - 1))).toBe(false);
    expect(evaluateLeaf(leaf, v, at(Date.UTC(2026, 1, 28)))).toBe(true);
  });

  it("uses fixed days and hours for age", () => {
    const leaf = LeafSchema.parse(cond("upload_date", "age_gt", { days: 1, hours: 2 }));
    const v = video({ upload_date: NOW - DAY - 2 * HOUR });
    expect(evaluateLeaf(leaf, v, ctx)).toBe(true);
    expect(evaluateLeaf(leaf, v, at(NOW - 1))).toBe(false);
  });
});

describe("groups", () => {
  const T: ConditionNode = { type: "cond", field: "type", op: "eq", value: "video" };
  const F: ConditionNode = { type: "cond", field: "type", op: "eq", value: "short" };
  const g = (op: "and" | "or", children: ConditionNode[], not?: boolean): ConditionNode =>
    not === undefined ? { type: "group", op, children } : { type: "group", op, not, children };
  const v = video();

  it.each<[string, ConditionNode, boolean]>([
    ["empty and matches all", matchAll(), true],
    ["empty or matches none", g("or", []), false],
    ["not empty and", g("and", [], true), false],
    ["not empty or", g("or", [], true), true],
    ["and all true", g("and", [T, T]), true],
    ["and one false", g("and", [T, F]), false],
    ["or one true", g("or", [F, T]), true],
    ["or all false", g("or", [F, F]), false],
    ["not and", g("and", [T, F], true), true],
    ["not or", g("or", [F, T], true), false],
    ["not false is explicit no-op", g("and", [T], false), true],
    ["nested", g("or", [g("and", [T, F]), g("and", [T, g("or", [F, T])])]), true],
    ["nested negations", g("and", [g("and", [g("or", [F], true)], true)], true), true],
  ])("%s", (_name, node, expected) => {
    expect(evaluateCondition(node, v, ctx)).toBe(expected);
  });

  it("short-circuits and/or", () => {
    let calls = 0;
    const spy = new Proxy(video(), {
      get(target, prop, receiver) {
        if (prop === "views") calls += 1;
        return Reflect.get(target, prop, receiver);
      },
    });
    const views: ConditionNode = { type: "cond", field: "views", op: "gt", value: 0 };
    evaluateCondition(g("and", [F, views]), spy, ctx);
    evaluateCondition(g("or", [T, views]), spy, ctx);
    expect(calls).toBe(0);
  });
});

describe("spec 1.1 example", () => {
  // (channel == veritasium OR channel == 3blue1brown) AND (duration > 1m)
  //   AND ((NOT(type == livestream)) OR (duration < 1hr))
  const VERITASIUM = "UCveritasium00000000000";
  const THREEB1B = "UC3blue1brown0000000000";
  const rule: ConditionNode = ConditionSchema.parse({
    type: "group",
    op: "and",
    children: [
      {
        type: "group",
        op: "or",
        children: [
          { type: "cond", field: "channel", op: "eq", value: VERITASIUM },
          { type: "cond", field: "channel", op: "eq", value: THREEB1B },
        ],
      },
      { type: "cond", field: "duration_s", op: "gt", value: 60 },
      {
        type: "group",
        op: "or",
        children: [
          {
            type: "group",
            op: "and",
            not: true,
            children: [{ type: "cond", field: "type", op: "eq", value: "livestream" }],
          },
          { type: "cond", field: "duration_s", op: "lt", value: 3600 },
        ],
      },
    ],
  });

  it.each<[string, Partial<VideoFacts>, boolean]>([
    ["veritasium video, 10 min", { channel_id: VERITASIUM, duration_s: 600 }, true],
    ["3b1b video, 2 h", { channel_id: THREEB1B, duration_s: 7200 }, true],
    ["other channel", { channel_id: "UCother", duration_s: 600 }, false],
    ["veritasium short, 30 s", { channel_id: VERITASIUM, type: "short", duration_s: 30 }, false],
    ["exactly 1 min is not > 1m", { channel_id: VERITASIUM, duration_s: 60 }, false],
    [
      "veritasium livestream, 30 min",
      { channel_id: VERITASIUM, type: "livestream", duration_s: 1800 },
      true,
    ],
    [
      "3b1b livestream, 3 h",
      { channel_id: THREEB1B, type: "livestream", duration_s: 10_800 },
      false,
    ],
    [
      "livestream exactly 1 h is not < 1hr",
      { channel_id: THREEB1B, type: "livestream", duration_s: 3600 },
      false,
    ],
    ["unknown duration", { channel_id: VERITASIUM, duration_s: null }, false],
  ])("%s", (_name, overrides, expected) => {
    expect(evaluateCondition(rule, video(overrides), ctx)).toBe(expected);
  });
});

describe("helpers", () => {
  it("isGone and videoStatuses", () => {
    expect(isGone({ privacy: "public", gone_since: null })).toBe(false);
    expect(isGone({ privacy: "unavailable", gone_since: null })).toBe(true);
    expect(isGone({ privacy: "unlisted", gone_since: 1 })).toBe(true);
    expect(videoStatuses({ privacy: "private", gone_since: null })).toEqual(["gone", "private"]);
    expect(videoStatuses({ privacy: "unlisted", gone_since: null })).toEqual(["unlisted"]);
    expect(videoStatuses({ privacy: "unlisted", gone_since: 5 })).toEqual(["gone"]);
    expect(videoStatuses({ privacy: null, gone_since: null })).toEqual([]);
  });

  it("sourceSet dedupes across accounts", () => {
    expect([...sourceSet(video(multi))].sort()).toEqual(["history", "liked", "subscription"]);
  });
});

describe("VideoFactsSchema", () => {
  it("round-trips the fixture through JSON", () => {
    const v = video({ ...multi, media: downloadedMedia.media, share_link_count: 3 });
    expect(VideoFactsSchema.parse(JSON.parse(JSON.stringify(v)))).toEqual(v);
  });

  it.each<[string, Partial<Record<keyof VideoFacts, unknown>>]>([
    ["bad privacy", { privacy: "deleted" }],
    ["bad type", { type: "clip" }],
    ["negative share links", { share_link_count: -1 }],
    ["bad source", { sources: [{ ...src("history", 0), source: "feed" }] }],
    ["tags not array", { tags: "a,b" }],
  ])("rejects %s", (_name, overrides) => {
    expect(VideoFactsSchema.safeParse({ ...video(), ...overrides }).success).toBe(false);
  });
});
