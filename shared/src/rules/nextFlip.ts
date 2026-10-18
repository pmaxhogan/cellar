import type { ConditionNode } from "./ast.ts";
import { ageThreshold, anchorValue, type EvalContext, type VideoFacts } from "./evaluate.ts";
import type { Rule } from "./rule.ts";
import { instantMs } from "./time.ts";

/**
 * `next_eval_at` (spec 4.4): the soonest instant strictly after `ctx.now` at
 * which any time leaf of any enabled rule changes value for this video.
 *
 * Only two kinds of leaf move with the clock:
 *   - `age_gt` / `age_lt` on a stored anchor flip at `anchor + duration`
 *     (`age_gt` turns true there, `age_lt` turns false there);
 *   - `before X` / `after X` on the `now` field flip at X and X + 1 ms.
 * Leaves on stored anchors with `before` / `after` / `is_null` /
 * `before_install_minus`, and `age_*` on `now` itself, never flip as time
 * passes. The result is conservative: a flip that does not change the rule's
 * overall outcome is still reported, and the hourly pass is the safety net.
 */

function leafFlips(node: ConditionNode, video: VideoFacts, ctx: EvalContext, out: number[]): void {
  if (node.type === "group") {
    for (const child of node.children) leafFlips(child, video, ctx, out);
    return;
  }
  switch (node.field) {
    case "now":
      if (node.op === "before") out.push(instantMs(node.value));
      else if (node.op === "after") out.push(instantMs(node.value) + 1);
      return;
    case "upload_date":
    case "first_seen":
    case "downloaded_at":
    case "last_seen": {
      if (node.op !== "age_gt" && node.op !== "age_lt") return;
      const anchor = anchorValue(node, video, ctx);
      if (anchor !== null) out.push(ageThreshold(anchor, node.value));
      return;
    }
    default:
      return;
  }
}

/** Soonest future flip across all enabled rules with a condition, or null when none. */
export function nextEvalAt(
  rules: readonly Pick<Rule, "enabled" | "condition">[],
  video: VideoFacts,
  ctx: EvalContext,
): number | null {
  const candidates: number[] = [];
  for (const rule of rules) {
    if (!rule.enabled || rule.condition === null) continue;
    leafFlips(rule.condition, video, ctx, candidates);
  }
  let best: number | null = null;
  for (const t of candidates) {
    if (Number.isFinite(t) && t > ctx.now && (best === null || t < best)) best = t;
  }
  return best;
}
