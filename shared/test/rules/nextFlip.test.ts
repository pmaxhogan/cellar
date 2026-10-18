import { describe, expect, it } from "vitest";
import {
  evaluateCondition,
  LeafSchema,
  nextEvalAt,
  type ConditionNode,
  type VideoFacts,
} from "../../src/index.ts";
import { at, ctx, DAY, HOUR, NOW, src, video } from "./fixtures.ts";

function leaf(raw: unknown): ConditionNode {
  return LeafSchema.parse(raw);
}

function rules(...conditions: (ConditionNode | null)[]) {
  return conditions.map((condition) => ({ enabled: true, condition }));
}

/** Asserts the condition's value differs one millisecond before `t` and at `t`. */
function expectFlipAt(node: ConditionNode, v: VideoFacts, t: number): void {
  expect(evaluateCondition(node, v, at(t - 1))).not.toBe(evaluateCondition(node, v, at(t)));
}

describe("nextEvalAt", () => {
  it("returns null when no rule has a time leaf", () => {
    const r = rules(null, leaf({ type: "cond", field: "views", op: "gt", value: 1 }));
    expect(nextEvalAt(r, video(), ctx)).toBeNull();
    expect(nextEvalAt([], video(), ctx)).toBeNull();
  });

  it("schedules age_gt at anchor + duration, where the leaf turns true", () => {
    const node = leaf({ type: "cond", field: "upload_date", op: "age_gt", value: { days: 14 } });
    const v = video({ upload_date: NOW - 10 * DAY });
    const t = nextEvalAt(rules(node), v, ctx);
    expect(t).toBe(NOW + 4 * DAY);
    expectFlipAt(node, v, t!);
    expect(evaluateCondition(node, v, at(t!))).toBe(true);
  });

  it("schedules age_lt at anchor + duration, where the leaf turns false", () => {
    const node = leaf({ type: "cond", field: "last_seen", op: "age_lt", value: "PT6H" });
    const v = video({ sources: [src("history", NOW - 2 * HOUR)] });
    const t = nextEvalAt(rules(node), v, ctx);
    expect(t).toBe(NOW + 4 * HOUR);
    expectFlipAt(node, v, t!);
    expect(evaluateCondition(node, v, at(t!))).toBe(false);
  });

  it("uses calendar months", () => {
    const node = leaf({
      type: "cond",
      field: "first_seen",
      source: "history",
      op: "age_gt",
      value: { months: 2 },
    });
    const v = video({ sources: [src("history", Date.UTC(2026, 8, 30, 8))] });
    const t = nextEvalAt(rules(node), v, ctx);
    expect(t).toBe(Date.UTC(2026, 10, 30, 8));
    expectFlipAt(node, v, t!);
  });

  it("uses the parametrised first_seen anchor", () => {
    const v = video({
      sources: [src("liked", NOW - 100 * DAY), src("history", NOW - 3 * DAY)],
    });
    const liked = leaf({
      type: "cond",
      field: "first_seen",
      source: "liked",
      op: "age_gt",
      value: { days: 101 },
    });
    const any = leaf({ type: "cond", field: "first_seen", op: "age_gt", value: { days: 101 } });
    const history = leaf({
      type: "cond",
      field: "first_seen",
      source: "history",
      op: "age_gt",
      value: { days: 101 },
    });
    expect(nextEvalAt(rules(liked), v, ctx)).toBe(NOW + DAY);
    expect(nextEvalAt(rules(any), v, ctx)).toBe(NOW + DAY);
    expect(nextEvalAt(rules(history), v, ctx)).toBe(NOW + 98 * DAY);
  });

  it("ignores missing anchors", () => {
    const node = leaf({
      type: "cond",
      field: "first_seen",
      source: "watch_later",
      op: "age_gt",
      value: { days: 1 },
    });
    expect(nextEvalAt(rules(node), video(), ctx)).toBeNull();
    const dl = leaf({ type: "cond", field: "downloaded_at", op: "age_lt", value: { days: 1 } });
    expect(nextEvalAt(rules(dl), video({ media: null }), ctx)).toBeNull();
  });

  it("ignores thresholds already passed, including exactly now", () => {
    const node = leaf({ type: "cond", field: "upload_date", op: "age_gt", value: { days: 14 } });
    expect(nextEvalAt(rules(node), video({ upload_date: NOW - 20 * DAY }), ctx)).toBeNull();
    expect(nextEvalAt(rules(node), video({ upload_date: NOW - 14 * DAY }), ctx)).toBeNull();
    expect(nextEvalAt(rules(node), video({ upload_date: NOW - 14 * DAY + 1 }), ctx)).toBe(NOW + 1);
  });

  it("schedules now before / after", () => {
    const before = leaf({ type: "cond", field: "now", op: "before", value: NOW + HOUR });
    const after = leaf({ type: "cond", field: "now", op: "after", value: "2026-10-19T00:00:00Z" });
    const v = video();
    expect(nextEvalAt(rules(before), v, ctx)).toBe(NOW + HOUR);
    expectFlipAt(before, v, NOW + HOUR);
    const t = nextEvalAt(rules(after), v, ctx);
    expect(t).toBe(Date.UTC(2026, 9, 19) + 1);
    expectFlipAt(after, v, t!);
    const past = leaf({ type: "cond", field: "now", op: "before", value: NOW - 1 });
    expect(nextEvalAt(rules(past), v, ctx)).toBeNull();
  });

  it("never schedules leaves that do not move with the clock", () => {
    const v = video({ media: { downloaded_at: NOW - DAY, location_id: 1, vcodec: null } });
    const statics = rules(
      leaf({ type: "cond", field: "upload_date", op: "before_install_minus", value: { days: 7 } }),
      leaf({ type: "cond", field: "upload_date", op: "before", value: NOW + DAY }),
      leaf({ type: "cond", field: "downloaded_at", op: "after", value: NOW + DAY }),
      leaf({ type: "cond", field: "last_seen", op: "is_null", value: true }),
      leaf({ type: "cond", field: "now", op: "age_gt", value: { days: 1 } }),
      leaf({ type: "cond", field: "now", op: "is_null", value: false }),
    );
    expect(nextEvalAt(statics, v, ctx)).toBeNull();
  });

  it("returns the soonest flip across nested groups and rules", () => {
    const v = video({ upload_date: NOW - 10 * DAY, sources: [src("history", NOW - DAY)] });
    const a: ConditionNode = {
      type: "group",
      op: "and",
      children: [
        {
          type: "group",
          op: "or",
          not: true,
          children: [
            leaf({ type: "cond", field: "upload_date", op: "age_gt", value: { days: 30 } }),
          ],
        },
      ],
    };
    const b = leaf({
      type: "cond",
      field: "first_seen",
      source: "history",
      op: "age_lt",
      value: { days: 3 },
    });
    expect(nextEvalAt(rules(a, b), v, ctx)).toBe(NOW + 2 * DAY);
    expect(nextEvalAt(rules(a), v, ctx)).toBe(NOW + 20 * DAY);
  });

  it("skips disabled rules", () => {
    const node = leaf({ type: "cond", field: "upload_date", op: "age_gt", value: { days: 14 } });
    const v = video({ upload_date: NOW - 10 * DAY });
    expect(nextEvalAt([{ enabled: false, condition: node }], v, ctx)).toBeNull();
  });
});
