import {
  SETTING_KEYS,
  SettingsResponseSchema,
  applySettingsPatch,
  resolveSettings,
  settingsRegistry,
  type ResolvedSettings,
  type SettingKey,
  type SettingsPatch,
} from "@cellar/shared";
import type { ApiClient } from "./client.ts";

/**
 * Settings API plus the pure editing logic behind the Settings page: a draft
 * of every resolved value, a set of keys explicitly reset to their default,
 * and the sparse patch those produce. `null` in a patch clears an override.
 */

export type Overrides = Record<string, unknown>;
export type Draft = Record<SettingKey, unknown>;

export async function getSettings(api: ApiClient, signal?: AbortSignal): Promise<Overrides> {
  const result = await api.request("/api/settings", { schema: SettingsResponseSchema, signal });
  return result.overrides;
}

/** The body is the sparse patch itself, as SettingsPatchSchema describes it. */
export async function putSettings(api: ApiClient, patch: SettingsPatch): Promise<Overrides> {
  const result = await api.request("/api/settings", {
    method: "PUT",
    body: patch,
    schema: SettingsResponseSchema,
  });
  return result.overrides;
}

export function hasOverride(overrides: Overrides, key: SettingKey): boolean {
  return Object.prototype.hasOwnProperty.call(overrides, key) && overrides[key] !== undefined;
}

/** Integer settings reject a half step; the registry has no explicit int flag. */
export function isIntegerSetting(key: SettingKey): boolean {
  const def = settingsRegistry[key];
  if (def.ui.control !== "number") return false;
  const probe = (def.ui.min ?? 0) + 0.5;
  return !def.schema.safeParse(probe).success;
}

/** A number setting whose null means something (rendered with a switch). */
export function isNullableSetting(key: SettingKey): boolean {
  return settingsRegistry[key].ui.nullLabel !== undefined;
}

export function defaultValue(key: SettingKey): unknown {
  const value = settingsRegistry[key].default as unknown;
  return Array.isArray(value) ? [...value] : value;
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return Object.is(a, b);
}

export function draftFrom(resolved: ResolvedSettings): Draft {
  const draft = {} as Draft;
  for (const key of SETTING_KEYS) {
    const value = resolved[key] as unknown;
    draft[key] = Array.isArray(value) ? [...value] : value;
  }
  return draft;
}

/** Keys whose draft differs from what is stored now, or that were reset. */
export function dirtyKeys(
  draft: Draft,
  overrides: Overrides,
  cleared: ReadonlySet<SettingKey>,
): SettingKey[] {
  const resolved = resolveSettings(overrides);
  return SETTING_KEYS.filter(
    (key) =>
      (cleared.has(key) && hasOverride(overrides, key)) ||
      (!cleared.has(key) && !sameValue(draft[key], resolved[key])),
  );
}

/**
 * The sparse patch for the dirty keys. A reset key, or an edit back to the
 * registry default, clears the override (null) rather than storing a copy of
 * the default.
 */
export function buildPatch(
  draft: Draft,
  overrides: Overrides,
  cleared: ReadonlySet<SettingKey>,
): SettingsPatch {
  const patch: Record<string, unknown> = {};
  for (const key of dirtyKeys(draft, overrides, cleared)) {
    if (cleared.has(key) || sameValue(draft[key], defaultValue(key))) {
      if (hasOverride(overrides, key)) patch[key] = null;
      continue;
    }
    patch[key] = draft[key];
  }
  return patch as SettingsPatch;
}

function emptyNumber(value: unknown): boolean {
  return (
    value === null || value === undefined || (typeof value === "number" && !Number.isFinite(value))
  );
}

/** Friendlier messages for the checks the controls can express. */
function fieldProblem(key: SettingKey, value: unknown): string | null {
  const ui = settingsRegistry[key].ui;
  if (ui.control !== "number") return null;
  if (emptyNumber(value)) {
    return isNullableSetting(key)
      ? `Enter a value, or switch ${ui.nullLabel ?? "the limit"} back on.`
      : "Enter a value.";
  }
  const number = value as number;
  if (ui.min !== undefined && number < ui.min) return `Must be at least ${ui.min}.`;
  if (ui.max !== undefined && number > ui.max) return `Must be at most ${ui.max}.`;
  if (isIntegerSetting(key) && !Number.isInteger(number)) return "Must be a whole number.";
  return null;
}

export type ValidationResult =
  { ok: true; patch: SettingsPatch } | { ok: false; errors: Partial<Record<SettingKey, string>> };

/**
 * Field checks first (an empty number must never become a null that silently
 * resets the key), then the shared zod patch schema and the cross-key
 * invariants via applySettingsPatch, exactly as the server will run them.
 */
export function validateDraft(
  draft: Draft,
  overrides: Overrides,
  cleared: ReadonlySet<SettingKey>,
): ValidationResult {
  const errors: Partial<Record<SettingKey, string>> = {};
  for (const key of dirtyKeys(draft, overrides, cleared)) {
    if (cleared.has(key)) continue;
    if (isNullableSetting(key) && draft[key] === null) continue;
    const problem = fieldProblem(key, draft[key]);
    if (problem !== null) errors[key] = problem;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const patch = buildPatch(draft, overrides, cleared);
  const applied = applySettingsPatch(overrides, patch);
  if (applied.ok) return { ok: true, patch };
  for (const [key, message] of Object.entries(applied.errors)) {
    errors[key as SettingKey] = message;
  }
  // The shared check stops at the first schema failure, before the cross-key
  // invariants run. Run them on the keys that did parse so both kinds of
  // problem show at once.
  const parsed = Object.fromEntries(Object.entries(patch).filter(([key]) => !(key in errors)));
  const rest = applySettingsPatch(overrides, parsed);
  if (!rest.ok) {
    for (const [key, message] of Object.entries(rest.errors)) {
      errors[key as SettingKey] ??= message;
    }
  }
  return { ok: false, errors };
}

/** Per-key messages from a server 400, when its details carry them. */
export function serverFieldErrors(details: Record<string, unknown> | null): Record<string, string> {
  if (details === null) return {};
  const source =
    details.errors !== null && typeof details.errors === "object" && !Array.isArray(details.errors)
      ? (details.errors as Record<string, unknown>)
      : details;
  const out: Record<string, string> = {};
  for (const [key, message] of Object.entries(source)) {
    if (
      typeof message === "string" &&
      Object.prototype.hasOwnProperty.call(settingsRegistry, key)
    ) {
      out[key] = message;
    }
  }
  return out;
}

/** Text for the "Default: ..." hint under a field. */
export function formatSettingValue(key: SettingKey, value: unknown): string {
  const ui = settingsRegistry[key].ui;
  if (value === null || value === undefined) return ui.nullLabel ?? "none";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (Array.isArray(value)) return value.join(", ");
  if (value === "") return "empty";
  return ui.unit === undefined ? String(value) : `${String(value)} ${ui.unit}`;
}
