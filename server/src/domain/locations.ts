import { accessSync, constants, statSync, statfsSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import type { LocationRow } from "@cellar/shared";
import type { Config } from "../config.ts";
import type { Db } from "../db/db.ts";
import { conflict, invalid, isUniqueViolation, notFound } from "./errors.ts";

/**
 * Storage locations: a compose bind mount (container path) plus a row. The
 * filesystem facts (mounted, free space) are read live; `used_bytes` is the
 * sum of the current media files the catalog places there.
 */

interface LocationDbRow {
  id: number;
  label: string;
  container_path: string;
  quota_bytes: number;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface FsFacts {
  mounted: boolean;
  fs_free_bytes: number | null;
  fs_total_bytes: number | null;
}

/** Directory exists and is writable by this process; statfs for space. Never throws. */
export function fsFacts(path: string): FsFacts {
  let mounted: boolean;
  try {
    mounted = statSync(path).isDirectory();
    if (mounted) {
      accessSync(path, constants.W_OK);
    }
  } catch {
    mounted = false;
  }
  try {
    const stats = statfsSync(path);
    return {
      mounted,
      fs_free_bytes: Number(stats.bavail) * Number(stats.bsize),
      fs_total_bytes: Number(stats.blocks) * Number(stats.bsize),
    };
  } catch {
    return { mounted, fs_free_bytes: null, fs_total_bytes: null };
  }
}

/** Bytes of current media per location id. */
function usedBytesByLocation(db: Db): Map<number, number> {
  const rows = db.all<{ location_id: number; used: number }>(
    `SELECT location_id, COALESCE(SUM(size_bytes), 0) AS used FROM media
     WHERE is_current = 1 AND location_id IS NOT NULL GROUP BY location_id`,
  );
  return new Map(rows.map((row) => [Number(row.location_id), Number(row.used)]));
}

function usedBytes(db: Db, id: number): number {
  const row = db.get<{ used: number }>(
    `SELECT COALESCE(SUM(size_bytes), 0) AS used FROM media
     WHERE is_current = 1 AND location_id = ?`,
    id,
  ) as { used: number };
  return Number(row.used);
}

function toRow(row: LocationDbRow, used: number): LocationRow {
  const facts = fsFacts(row.container_path);
  return {
    id: Number(row.id),
    label: row.label,
    container_path: row.container_path,
    quota_bytes: Number(row.quota_bytes),
    enabled: Number(row.enabled) === 1,
    used_bytes: used,
    fs_free_bytes: facts.fs_free_bytes,
    mounted: facts.mounted,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function dbRow(db: Db, id: number): LocationDbRow {
  const row = db.get<LocationDbRow>("SELECT * FROM locations WHERE id = ?", id);
  if (row === undefined) {
    throw notFound("Location", id);
  }
  return row;
}

export function listLocations(db: Db): LocationRow[] {
  const used = usedBytesByLocation(db);
  return db
    .all<LocationDbRow>("SELECT * FROM locations ORDER BY id")
    .map((row) => toRow(row, used.get(Number(row.id)) ?? 0));
}

export function getLocation(db: Db, id: number): LocationRow {
  return toRow(dbRow(db, id), usedBytes(db, id));
}

/** The default destination for the rules merge: the lowest-id enabled location. */
export function firstEnabledLocation(
  db: Db,
): { id: number; label: string; container_path: string; quota_bytes: number } | null {
  const row = db.get<LocationDbRow>(
    "SELECT * FROM locations WHERE enabled = 1 ORDER BY id LIMIT 1",
  );
  return row === undefined
    ? null
    : {
        id: Number(row.id),
        label: row.label,
        container_path: row.container_path,
        quota_bytes: Number(row.quota_bytes),
      };
}

function isWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * An absolute, existing directory outside the data directory (which holds the
 * database and decrypted cookie jars). Returns the normalized path.
 */
export function validateContainerPath(config: Pick<Config, "dataDir">, raw: string): string {
  const trimmed = raw.trim();
  if (!isAbsolute(trimmed)) {
    throw invalid("The container path must be absolute.", {
      fields: { container_path: "Must be absolute" },
    });
  }
  const path = resolve(trimmed);
  for (const forbidden of new Set([resolve(config.dataDir), resolve("/data")])) {
    if (isWithin(path, forbidden) || isWithin(forbidden, path)) {
      throw invalid("A location cannot be inside or contain the data directory.", {
        fields: { container_path: "Must not overlap the data directory" },
      });
    }
  }
  let isDir: boolean;
  try {
    isDir = statSync(path).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    throw invalid("The container path is not an existing directory. Is the volume mounted?", {
      fields: { container_path: "Not an existing directory" },
    });
  }
  return path;
}

export interface LocationInput {
  label: string;
  container_path: string;
  quota_bytes: number;
  enabled: boolean;
}

function uniqueGuard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict("Another location already uses that label or path.");
    }
    throw error;
  }
}

export function createLocation(
  db: Db,
  config: Pick<Config, "dataDir">,
  input: LocationInput,
  now: number = Date.now(),
): LocationRow {
  const path = validateContainerPath(config, input.container_path);
  const { lastInsertRowid } = uniqueGuard(() =>
    db.run(
      `INSERT INTO locations (label, container_path, quota_bytes, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.label.trim(),
      path,
      input.quota_bytes,
      input.enabled ? 1 : 0,
      now,
      now,
    ),
  );
  return getLocation(db, lastInsertRowid);
}

function mediaCount(db: Db, id: number): number {
  const row = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM media WHERE location_id = ?",
    id,
  ) as { n: number };
  return Number(row.n);
}

/** Partial update. The path cannot move while media rows point at the old one. */
export function updateLocation(
  db: Db,
  config: Pick<Config, "dataDir">,
  id: number,
  patch: Partial<LocationInput>,
  now: number = Date.now(),
): LocationRow {
  const current = dbRow(db, id);
  let path = current.container_path;
  if (patch.container_path !== undefined) {
    path = validateContainerPath(config, patch.container_path);
    if (path !== current.container_path && mediaCount(db, id) > 0) {
      throw conflict("Files are stored at this location; its path cannot change.");
    }
  }
  uniqueGuard(() =>
    db.run(
      `UPDATE locations SET label = ?, container_path = ?, quota_bytes = ?, enabled = ?,
         updated_at = ? WHERE id = ?`,
      patch.label === undefined ? current.label : patch.label.trim(),
      path,
      patch.quota_bytes ?? Number(current.quota_bytes),
      patch.enabled === undefined ? Number(current.enabled) : patch.enabled ? 1 : 0,
      now,
      id,
    ),
  );
  return getLocation(db, id);
}

export function deleteLocation(db: Db, id: number): void {
  dbRow(db, id);
  if (mediaCount(db, id) > 0) {
    throw conflict("Files are stored at this location. Move or delete them first.");
  }
  db.run("DELETE FROM locations WHERE id = ?", id);
}

export interface LocationUsage {
  used_bytes: number;
  fs_free_bytes: number | null;
  fs_total_bytes: number | null;
  quota_bytes: number;
  mounted: boolean;
}

export function locationUsage(db: Db, id: number): LocationUsage {
  const row = dbRow(db, id);
  const facts = fsFacts(row.container_path);
  return {
    used_bytes: usedBytes(db, id),
    fs_free_bytes: facts.fs_free_bytes,
    fs_total_bytes: facts.fs_total_bytes,
    quota_bytes: Number(row.quota_bytes),
    mounted: facts.mounted,
  };
}
