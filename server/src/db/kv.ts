import type { Db } from "./db.ts";

/**
 * The kv table: small JSON values the server owns. Values are JSON encoded on
 * write and parsed on read; a row that no longer parses reads as absent rather
 * than throwing, because nothing in kv is worth failing a request over.
 */

export function getKv<T = unknown>(db: Db, key: string): T | undefined {
  const row = db.get<{ value_json: string }>("SELECT value_json FROM kv WHERE key = ?", key);
  if (row === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return undefined;
  }
}

export function setKv(db: Db, key: string, value: unknown, now: number = Date.now()): void {
  db.run(
    `INSERT INTO kv (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json,
                                     updated_at = excluded.updated_at`,
    key,
    JSON.stringify(value),
    now,
  );
}

export const INSTALLED_AT_KEY = "installed_at";

/**
 * Record when this instance was first initialised (epoch ms). Written once and
 * never overwritten: later boots leave the original value alone.
 */
export function ensureInstalledAt(db: Db, now: number = Date.now()): number {
  db.run(
    `INSERT INTO kv (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO NOTHING`,
    INSTALLED_AT_KEY,
    JSON.stringify(now),
    now,
  );
  return getKv<number>(db, INSTALLED_AT_KEY) ?? now;
}
