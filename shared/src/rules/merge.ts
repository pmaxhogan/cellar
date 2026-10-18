import { cloneJson } from "./clone.ts";
import {
  effectAllowedIn,
  effectDefaults,
  effectRegistry,
  EFFECT_KEYS,
  type EffectiveSettings,
  type EffectKey,
} from "./effects.ts";
import { evaluateCondition, type EvalContext, type VideoFacts } from "./evaluate.ts";
import type { Rule } from "./rule.ts";

/**
 * Effective-settings merge (spec 4.3):
 *
 *   registry defaults
 *     -> global rule effects
 *     -> each matching enabled custom rule, ascending position (later wins)
 *     -> the video rule for this id
 *
 * A rule overrides only the keys it sets. Values replace whole at effect-key
 * granularity: an object-valued effect (`transcode`, `captions`, `ytdlp`,
 * `notify`) is never deep-merged; fields a rule omits take the schema's field
 * defaults. `location_id` null stays null here; the server substitutes the
 * first enabled location.
 */

export type RuleId = Rule["id"];
export type Provenance = Record<EffectKey, RuleId | "default">;

export interface RuleLayers {
  globalRule: Rule | null;
  /** Custom rules; sorted here by ascending position (then id) regardless of input order. */
  customRules: readonly Rule[];
  videoRule: Rule | null;
}

export interface ResolvedEffective {
  effective: EffectiveSettings;
  /** Which rule set each key, or "default" when no rule did. */
  provenance: Provenance;
  /** Global rule, every matching custom rule (in priority order), then the video rule. */
  matchedRuleIds: RuleId[];
}

/** Custom rules in ascending priority: position ascending, ties broken by id. */
export function sortCustomRules<T extends Pick<Rule, "position" | "id">>(rules: readonly T[]): T[] {
  return [...rules].sort((a, b) => a.position - b.position || a.id - b.id);
}

/** True when an enabled custom rule's condition holds (a missing condition matches all). */
export function customRuleMatches(rule: Rule, video: VideoFacts, ctx: EvalContext): boolean {
  if (!rule.enabled) return false;
  return rule.condition === null || evaluateCondition(rule.condition, video, ctx);
}

function apply(rule: Rule, effective: Record<EffectKey, unknown>, provenance: Provenance): void {
  for (const key of EFFECT_KEYS) {
    const raw = rule.effects[key];
    if (raw === undefined) continue;
    // `include` on the global rule (or any key outside a kind's allowedIn) is ignored.
    if (!effectAllowedIn(key, rule.kind)) continue;
    // Re-parse so subfield defaults are filled even for a hand-built effects object.
    effective[key] = effectRegistry[key].schema.parse(cloneJson(raw));
    provenance[key] = rule.id;
  }
}

/** Resolves the effective settings for one video. Pure; never mutates its inputs. */
export function resolveEffective(
  layers: RuleLayers,
  video: VideoFacts,
  ctx: EvalContext,
): ResolvedEffective {
  const effective = effectDefaults() as Record<EffectKey, unknown>;
  const provenance = Object.fromEntries(EFFECT_KEYS.map((k) => [k, "default"])) as Provenance;
  const matchedRuleIds: RuleId[] = [];

  const { globalRule, videoRule } = layers;
  if (globalRule && globalRule.enabled) {
    apply(globalRule, effective, provenance);
    matchedRuleIds.push(globalRule.id);
  }
  for (const rule of sortCustomRules(layers.customRules)) {
    if (!customRuleMatches(rule, video, ctx)) continue;
    apply(rule, effective, provenance);
    matchedRuleIds.push(rule.id);
  }
  if (videoRule && videoRule.enabled) {
    apply(videoRule, effective, provenance);
    matchedRuleIds.push(videoRule.id);
  }

  return { effective: effective as EffectiveSettings, provenance, matchedRuleIds };
}
