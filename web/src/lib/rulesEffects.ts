import {
  EFFECT_GROUPS,
  EFFECT_KEYS,
  EffectsSchema,
  TRANSCODE_CODECS,
  effectAllowedIn,
  effectRegistry,
  type EffectGroup,
  type EffectKey,
  type RuleKind,
} from "@cellar/shared";
import type { CodecSupport } from "../api/rules.ts";

/**
 * Helpers for the sparse effects editor. A rule's effects are a sparse map:
 * a key that is absent inherits from lower-priority rules, a key that is
 * present overrides. The editor adds keys with their registry default and
 * removes them to inherit again.
 */

export const GROUP_LABELS: Record<EffectGroup, string> = {
  storage: "Storage",
  media: "Media",
  download: "Download",
  metadata: "Metadata",
  notifications: "Notifications",
};

export interface EffectOptionGroup {
  group: EffectGroup;
  label: string;
  items: { key: EffectKey; label: string }[];
}

/** Keys a rule of `kind` may still add, grouped by `ui.group` for the "Add effect" menu. */
export function addableEffects(kind: RuleKind, set: readonly string[]): EffectOptionGroup[] {
  return EFFECT_GROUPS.map((group) => ({
    group,
    label: GROUP_LABELS[group],
    items: EFFECT_KEYS.filter(
      (key) =>
        effectRegistry[key].ui.group === group && effectAllowedIn(key, kind) && !set.includes(key),
    ).map((key) => ({ key, label: effectRegistry[key].ui.label })),
  })).filter((entry) => entry.items.length > 0);
}

/** The keys a sparse effects map sets, in registry order. */
export function setKeys(effects: Record<string, unknown>): EffectKey[] {
  return EFFECT_KEYS.filter((key) => effects[key] !== undefined);
}

/** A fresh copy of a key's registry default, the value a newly added effect starts from. */
export function initialEffectValue(key: EffectKey): unknown {
  return JSON.parse(JSON.stringify(effectRegistry[key].default)) as unknown;
}

/**
 * Validates a sparse effects map for a rule kind. Problems are grouped by the
 * effect key they belong to; a key the kind may not set is reported too.
 */
export function effectErrors(
  effects: Record<string, unknown>,
  kind: RuleKind,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (key: string, message: string): void => {
    const list = out.get(key) ?? [];
    list.push(message);
    out.set(key, list);
  };
  const parsed = EffectsSchema.safeParse(effects);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = typeof issue.path[0] === "string" ? issue.path[0] : "";
      const rest = issue.path.slice(1).map(String).join(".");
      add(key, rest === "" ? issue.message : `${rest}: ${issue.message}`);
    }
  }
  for (const key of setKeys(effects)) {
    if (!effectAllowedIn(key, kind)) add(key, `A ${kind} rule cannot set this.`);
  }
  return out;
}

const NVENC: Partial<Record<string, keyof CodecSupport>> = {
  hevc_nvenc: "hevc_nvenc",
  h264_nvenc: "h264_nvenc",
  av1_nvenc: "av1_nvenc",
};

/**
 * Codec choices to offer. Every codec shows while the server reports nothing
 * about NVENC; an NVENC codec hides only when the server says it is
 * unavailable. The current value always stays visible so it never vanishes
 * from its own select.
 */
export function visibleCodecs(support: CodecSupport, current?: unknown): string[] {
  return TRANSCODE_CODECS.filter((codec) => {
    if (codec === current) return true;
    const flag = NVENC[codec];
    return flag === undefined || support[flag] !== false;
  });
}
