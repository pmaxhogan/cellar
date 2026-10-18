import { z } from "zod";
import { ConditionSchema } from "./ast.ts";
import {
  EFFECT_KEYS,
  effectAllowedIn,
  EffectsSchema,
  RowIdSchema,
  RuleKindSchema,
  type EffectKey,
} from "./effects.ts";

/**
 * A rule as the evaluator sees it (the parsed form of a `rules` row):
 * `condition` is the AST from `condition_json` (null for global and video
 * rules), `effects` the sparse map from `effects_json`.
 */

const RuleBaseSchema = z.object({
  kind: RuleKindSchema,
  video_id: z.string().min(1).max(64).nullable(),
  position: z.int(),
  name: z.string().min(1).max(200),
  enabled: z.boolean(),
  condition: ConditionSchema.nullable(),
  effects: EffectsSchema,
});

type RuleBase = z.output<typeof RuleBaseSchema>;

function checkRule(rule: RuleBase, ctx: z.RefinementCtx): void {
  if (rule.kind === "custom") {
    if (rule.condition === null) {
      ctx.addIssue({
        code: "custom",
        path: ["condition"],
        message: "custom rules need a condition",
      });
    }
    if (rule.video_id !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["video_id"],
        message: "only video rules have video_id",
      });
    }
  } else {
    if (rule.condition !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["condition"],
        message: `${rule.kind} rules have no condition`,
      });
    }
    if (rule.kind === "video" && rule.video_id === null) {
      ctx.addIssue({ code: "custom", path: ["video_id"], message: "video rules need video_id" });
    }
    if (rule.kind === "global" && rule.video_id !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["video_id"],
        message: "only video rules have video_id",
      });
    }
  }
  for (const key of Object.keys(rule.effects) as EffectKey[]) {
    if (rule.effects[key] !== undefined && !effectAllowedIn(key, rule.kind)) {
      ctx.addIssue({
        code: "custom",
        path: ["effects", key],
        message: `${key} cannot be set by a ${rule.kind} rule`,
      });
    }
  }
}

/** A rule without its database id (defaults, create requests). */
export const RuleDraftSchema = RuleBaseSchema.superRefine(checkRule);
export type RuleDraft = z.output<typeof RuleDraftSchema>;

/** A stored rule. */
export const RuleSchema = RuleBaseSchema.extend({ id: RowIdSchema }).superRefine(checkRule);
export type Rule = z.output<typeof RuleSchema>;

/** The effect keys a rule actually sets (present and not undefined), in registry order. */
export function setEffectKeys(rule: Pick<Rule, "effects">): EffectKey[] {
  return EFFECT_KEYS.filter((k) => rule.effects[k] !== undefined);
}
