import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, validateAst, type Field } from "@cellar/shared";
import {
  changeField,
  changeOp,
  contains,
  defaultValue,
  errorsByKey,
  fieldInfo,
  findParent,
  joinSeconds,
  moveNode,
  newGroup,
  newLeaf,
  removeNode,
  shiftNode,
  splitSeconds,
  toAst,
  toDurationObject,
  todayIso,
  toUi,
  type UiGroup,
  type UiLeaf,
} from "../../src/lib/rulesTree.ts";
import {
  addableEffects,
  effectErrors,
  initialEffectValue,
  setKeys,
  visibleCodecs,
} from "../../src/lib/rulesEffects.ts";
import { moveItem, nextPosition, sortedCustom } from "../../src/lib/rulesOrder.ts";
import { defaultRows, makeRow } from "./fakeApi.ts";

describe("rulesTree: conversion", () => {
  it("round-trips every default rule condition through the editable model", () => {
    for (const rule of DEFAULT_RULES) {
      if (rule.condition === null) continue;
      const ui = toUi(rule.condition);
      const back = toAst(ui);
      expect(validateAst(back).ok).toBe(true);
      if (rule.condition.type === "group") expect(back).toEqual(rule.condition);
    }
  });

  it("wraps a lone leaf and repairs junk", () => {
    const ui = toUi({ type: "cond", field: "title", op: "eq", value: "x", ci: false });
    expect(ui.type).toBe("group");
    expect(toAst(ui)).toEqual({
      type: "group",
      op: "and",
      children: [{ type: "cond", field: "title", op: "eq", value: "x", ci: false }],
    });
    expect(toAst(toUi(null))).toEqual({ type: "group", op: "and", children: [] });
    const notGroup = toUi({ type: "group", op: "or", not: true, children: "bad" });
    expect(toAst(notGroup)).toEqual({ type: "group", op: "or", not: true, children: [] });
  });

  it("gives every node a distinct key", () => {
    const ui = toUi(DEFAULT_RULES[1]!.condition);
    const keys = new Set<number>();
    const walk = (node: UiGroup | UiLeaf): void => {
      keys.add(node._key);
      if (node.type === "group") node.children.forEach(walk);
    };
    walk(ui);
    expect(keys.size).toBe(5);
  });
});

describe("rulesTree: defaults and edits", () => {
  it("starts every field on a value its first operator accepts, or asks for a choice", () => {
    const needsChoice = new Set<Field>(["account", "channel", "current_location", "source"]);
    const fields = [
      "account",
      "source",
      "type",
      "channel",
      "status",
      "duration_s",
      "views",
      "has_codec",
      "is_hdr",
      "current_location",
      "title",
      "upload_date",
      "first_seen",
      "now",
    ] as Field[];
    for (const field of fields) {
      const group = { type: "group", op: "and", children: [toAst(newLeaf(field))] };
      expect(validateAst(group).ok, field).toBe(!needsChoice.has(field));
    }
  });

  it("defaults each value kind", () => {
    const info = fieldInfo("duration_s");
    expect(defaultValue("number_range", info)).toEqual([0, 600]);
    expect(defaultValue("number_range", fieldInfo("views"))).toEqual([0, 100]);
    expect(defaultValue("duration", info)).toEqual({ days: 14 });
    expect(defaultValue("null_flag", info)).toBe(true);
    expect(defaultValue("regex", info)).toBe("");
    expect(defaultValue("enum", info)).toBe("");
    expect(defaultValue("channel_ids", info)).toEqual([]);
    expect(defaultValue("location_id", info)).toBeNull();
    expect(todayIso(Date.UTC(2026, 2, 4, 15, 30))).toBe("2026-03-04T00:00:00.000Z");
  });

  it("changes field and resets field-specific flags", () => {
    const leaf = newLeaf("first_seen");
    leaf.source = "liked";
    changeField(leaf, "title");
    expect(leaf).toMatchObject({ field: "title", op: "contains", value: "", ci: true });
    expect(leaf.source).toBeUndefined();
    changeField(leaf, "views");
    expect(leaf.ci).toBeUndefined();
    expect(leaf).toMatchObject({ field: "views", op: "lt", value: 0 });
  });

  it("keeps or converts values across operator changes", () => {
    const num = newLeaf("views");
    num.value = 7;
    changeOp(num, "gte");
    expect(num.value).toBe(7);
    changeOp(num, "between");
    expect(num.value).toEqual([7, 7]);
    changeOp(num, "lt");
    expect(num.value).toBe(7);

    const en = newLeaf("status");
    en.value = "gone";
    changeOp(en, "in");
    expect(en.value).toEqual(["gone"]);
    changeOp(en, "eq");
    expect(en.value).toBe("gone");
    changeOp(en, "in");
    en.value = [];
    changeOp(en, "eq");
    expect(en.value).toBe("public");

    const acct = newLeaf("account");
    changeOp(acct, "in");
    expect(acct.value).toEqual([]);

    const text = newLeaf("title");
    text.value = "abc";
    changeOp(text, "regex");
    expect(text.value).toBe("abc");
    changeOp(text, "eq");
    expect(text.value).toBe("abc");

    const time = newLeaf("upload_date");
    changeOp(time, "before");
    expect(typeof time.value).toBe("string");
    changeOp(time, "before_install_minus");
    expect(time.value).toEqual({ days: 14 });
    changeOp(time, "nonsense");
    expect(time.op).toBe("nonsense");
  });
});

describe("rulesTree: structure", () => {
  function sample() {
    const a = newLeaf("title");
    const b = newLeaf("views");
    const inner = newGroup("or");
    const c = inner.children[0] as UiLeaf;
    const root: UiGroup = { _key: 9999, type: "group", op: "and", children: [a, inner, b] };
    return { root, a, b, inner, c };
  }

  it("finds parents and containment", () => {
    const { root, inner, c, a } = sample();
    expect(findParent(root, c)).toEqual({ parent: inner, index: 0 });
    expect(findParent(root, root)).toBeNull();
    expect(contains(inner, c)).toBe(true);
    expect(contains(a, c)).toBe(false);
  });

  it("moves nodes between groups and refuses cycles", () => {
    const { root, a, b, inner, c } = sample();
    expect(moveNode(root, a, inner, c)).toBe(true);
    expect(inner.children).toEqual([a, c]);
    expect(moveNode(root, b, inner, null)).toBe(true);
    expect(inner.children).toEqual([a, c, b]);
    expect(moveNode(root, inner, inner, null)).toBe(false);
    expect(moveNode(root, a, inner, a)).toBe(false);
    expect(moveNode(root, root, inner, null)).toBe(false);
    expect(moveNode(root, newLeaf(), inner, null)).toBe(false);
    expect(moveNode(root, a, newGroup(), null)).toBe(false);
    expect(moveNode(root, a, root, c)).toBe(false);
    expect(moveNode(root, c, root, inner)).toBe(true);
    expect(root.children).toEqual([c, inner]);
  });

  it("shifts and removes", () => {
    const { root, a, b, inner } = sample();
    expect(shiftNode(root, a, -1)).toBe(false);
    expect(shiftNode(root, a, 1)).toBe(true);
    expect(root.children).toEqual([inner, a, b]);
    expect(shiftNode(root, b, 1)).toBe(false);
    expect(shiftNode(root, root, 1)).toBe(false);
    expect(removeNode(root, a)).toBe(true);
    expect(removeNode(root, a)).toBe(false);
    expect(root.children).toEqual([inner, b]);
  });

  it("maps validation errors to the node their pointer reaches", () => {
    const { root, inner, c, b } = sample();
    b.op = "between";
    b.value = [5, 1];
    c.value = "(a+)+";
    c.op = "regex";
    const result = validateAst(toAst(root));
    expect(result.ok).toBe(false);
    const byKey = errorsByKey(root, result.errors);
    expect(byKey.get(b._key)?.[0]?.pointer).toBe("/children/2/value");
    expect(byKey.get(c._key)?.[0]?.code).toBe("unsafe_regex");
    expect(byKey.has(inner._key)).toBe(false);
    const stray = errorsByKey(root, [
      { path: ["children", 7], pointer: "/children/7", code: "invalid", message: "x" },
    ]);
    expect(stray.get(root._key)).toHaveLength(1);
  });
});

describe("rulesTree: durations", () => {
  it("splits and joins seconds", () => {
    expect(splitSeconds(3723)).toEqual({ h: 1, m: 2, s: 3 });
    expect(splitSeconds(-5)).toEqual({ h: 0, m: 0, s: 0 });
    expect(joinSeconds({ h: 1, m: 2, s: 3 })).toBe(3723);
  });

  it("converts ISO and object durations for the age editor", () => {
    expect(toDurationObject("P14D")).toEqual({ days: 14 });
    expect(toDurationObject("P2W3D")).toEqual({ days: 17 });
    expect(toDurationObject("P1Y2MT5H")).toEqual({ years: 1, months: 2, hours: 5 });
    expect(toDurationObject("PT5M")).toBeNull();
    expect(toDurationObject("nope")).toBeNull();
    expect(toDurationObject(5)).toBeNull();
    expect(toDurationObject({ months: 2, junk: 1 })).toEqual({ months: 2 });
  });
});

describe("rulesEffects", () => {
  it("never offers include on the global rule", () => {
    const keys = (kind: "global" | "custom") =>
      addableEffects(kind, []).flatMap((group) => group.items.map((item) => item.key));
    expect(keys("global")).not.toContain("include");
    expect(keys("custom")).toContain("include");
    const groups = addableEffects("custom", ["notify"]).map((group) => group.group);
    expect(groups).not.toContain("notifications");
  });

  it("lists set keys in registry order and copies defaults", () => {
    expect(setKeys({ notify: {}, include: true, other: 1, proxy: undefined })).toEqual([
      "include",
      "notify",
    ]);
    const a = initialEffectValue("captions");
    const b = initialEffectValue("captions");
    expect(a).toEqual({ enabled: true, languages: "all", auto_generated: true });
    expect(a).not.toBe(b);
  });

  it("groups validation problems by effect key", () => {
    expect(effectErrors({ reclaim_priority: 0 }, "custom").size).toBe(0);
    const errors = effectErrors(
      {
        include: false,
        reclaim_priority: -5,
        captions: { languages: [] },
        ytdlp: { sleep_requests_min: 5, sleep_requests_max: 1 },
      },
      "global",
    );
    expect(errors.get("include")).toEqual(["A global rule cannot set this."]);
    expect(errors.get("reclaim_priority")?.[0]).toMatch(/>=/);
    expect(errors.get("captions")?.[0]).toMatch(/^languages/);
    expect(errors.get("ytdlp")?.[0]).toMatch(/sleep_requests_max/);
    expect(effectErrors({ bogus: 1 } as Record<string, unknown>, "custom").get("")).toHaveLength(1);
  });

  it("shows NVENC codecs unless the server says they are missing", () => {
    expect(visibleCodecs({})).toEqual(["hevc_nvenc", "h264_nvenc", "av1_svt", "av1_nvenc"]);
    expect(visibleCodecs({ hevc_nvenc: false, h264_nvenc: false, av1_nvenc: false })).toEqual([
      "av1_svt",
    ]);
    expect(visibleCodecs({ hevc_nvenc: true, h264_nvenc: true, av1_nvenc: false })).toEqual([
      "hevc_nvenc",
      "h264_nvenc",
      "av1_svt",
    ]);
    expect(visibleCodecs({ hevc_nvenc: false }, "hevc_nvenc")).toContain("hevc_nvenc");
  });
});

describe("rulesOrder", () => {
  it("sorts custom rules by position then id", () => {
    const rows = [
      makeRow({ id: 3, position: 2 }),
      makeRow({ id: 1, kind: "global", position: 0 }),
      makeRow({ id: 2, position: 2 }),
      makeRow({ id: 4, position: 1 }),
    ];
    expect(sortedCustom(rows).map((row) => row.id)).toEqual([4, 2, 3]);
    expect(nextPosition(rows)).toBe(3);
    expect(nextPosition([])).toBe(1);
    expect(nextPosition(defaultRows())).toBe(8);
  });

  it("moves items with clamping", () => {
    expect(moveItem([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
    expect(moveItem([1, 2, 3], 2, 0)).toEqual([3, 1, 2]);
    expect(moveItem([1, 2, 3], 1, 9)).toEqual([1, 3, 2]);
    expect(moveItem([1, 2, 3], 5, 0)).toEqual([1, 2, 3]);
  });
});

describe("rulesTree fallbacks", () => {
  it("handles missing values, odd lists and stray error paths", () => {
    const bare = toUi({
      type: "group",
      op: "and",
      children: [{ type: "cond", field: "is_hdr", op: "eq" }],
    });
    expect(toAst(bare)).toEqual({
      type: "group",
      op: "and",
      children: [{ type: "cond", field: "is_hdr", op: "eq", value: undefined }],
    });
    expect(defaultValue("enum_list", fieldInfo("status"))).toEqual([]);
    const list = newLeaf("status");
    changeOp(list, "in");
    list.value = "not a list";
    changeOp(list, "eq");
    expect(list.value).toBe("public");
    const range = newLeaf("views");
    changeOp(range, "between");
    range.value = [];
    changeOp(range, "gt");
    expect(range.value).toBe(0);
    const root = toUi({ type: "group", op: "and", children: [] });
    const odd = errorsByKey(root, [
      { path: ["op"], pointer: "/op", code: "invalid", message: "x" },
    ]);
    expect(odd.get(root._key)).toHaveLength(1);
    expect(toDurationObject("P2W")).toEqual({ days: 14 });
  });
});
