import {
  applySettingsPatch,
  isSettingKey,
  resolveSettings,
  type ResolvedSettings,
} from "@cellar/shared";
import type { Config } from "../config.ts";
import type { Db } from "../db/db.ts";
import { invalid } from "./errors.ts";

/**
 * The global settings store. The `settings` table is sparse: only keys the
 * owner changed are stored, as JSON. Reads go through a per-database cache
 * that every write invalidates, so the hot path (every job reads settings)
 * does not touch sqlite.
 */

interface CacheEntry {
  sparse: Record<string, unknown>;
  resolved: ResolvedSettings;
}

const cache = new WeakMap<Db, CacheEntry>();

function readSparse(db: Db): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const rows = db.all<{ key: string; value_json: string }>(
    "SELECT key, value_json FROM settings ORDER BY key",
  );
  for (const row of rows) {
    if (!isSettingKey(row.key)) {
      continue;
    }
    try {
      out[row.key] = JSON.parse(row.value_json) as unknown;
    } catch {
      // A row that no longer parses reads as unset, like resolveSettings does.
    }
  }
  return out;
}

function load(db: Db): CacheEntry {
  const hit = cache.get(db);
  if (hit !== undefined) {
    return hit;
  }
  const sparse = readSparse(db);
  const entry = { sparse, resolved: resolveSettings(sparse) };
  cache.set(db, entry);
  return entry;
}

/** Drop the cached settings for this database. */
export function invalidateSettingsCache(db: Db): void {
  cache.delete(db);
}

/** The stored overrides only, as GET /api/settings returns them. */
export function getSettingsOverrides(db: Db): Record<string, unknown> {
  return structuredClone(load(db).sparse);
}

/**
 * The fully resolved settings. When `config` is given and the owner has not
 * overridden `tools.pot_provider_url`, the env POT_PROVIDER_URL is the
 * default instead of the registry's.
 */
export function getSettings(db: Db, config?: Pick<Config, "potProviderUrl">): ResolvedSettings {
  const entry = load(db);
  const resolved = structuredClone(entry.resolved);
  if (config !== undefined && !Object.hasOwn(entry.sparse, "tools.pot_provider_url")) {
    resolved["tools.pot_provider_url"] = config.potProviderUrl;
  }
  return resolved;
}

/**
 * Apply a SettingsPatch (`null` clears a key) and persist the result. Only
 * changed keys are written. Returns the new sparse overrides.
 */
export function updateSettings(
  db: Db,
  patch: unknown,
  now: number = Date.now(),
): Record<string, unknown> {
  const before = load(db).sparse;
  const result = applySettingsPatch(before, patch);
  if (!result.ok) {
    // `fields` matches the other routes; `errors` is the flat key -> message map the
    // Settings page reads.
    throw invalid("Invalid settings.", { fields: result.errors, errors: result.errors });
  }
  const after = result.sparse as Record<string, unknown>;
  db.tx(() => {
    for (const key of Object.keys(before)) {
      if (!Object.hasOwn(after, key)) {
        db.run("DELETE FROM settings WHERE key = ?", key);
      }
    }
    for (const [key, value] of Object.entries(after)) {
      const json = JSON.stringify(value);
      if (Object.hasOwn(before, key) && JSON.stringify(before[key]) === json) {
        continue;
      }
      db.run(
        `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json,
                                         updated_at = excluded.updated_at`,
        key,
        json,
        now,
      );
    }
  });
  invalidateSettingsCache(db);
  return getSettingsOverrides(db);
}
