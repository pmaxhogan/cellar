import type { SQLInputValue } from "node:sqlite";
import type { Db } from "../src/db/db.ts";

/**
 * Synthetic catalog rows for the video tests. Column names come from the
 * object keys, which is fine in test code and keeps each fixture short.
 */

export const T0 = Date.UTC(2026, 0, 1);
export const DAY = 86_400_000;

function insert(db: Db, table: string, row: Record<string, SQLInputValue>): number {
  const keys = Object.keys(row);
  return db.run(
    `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
    ...keys.map((key) => row[key] ?? null),
  ).lastInsertRowid;
}

export function seedAccount(db: Db, label: string): number {
  return insert(db, "accounts", { label, created_at: T0, updated_at: T0 });
}

export function seedChannel(db: Db, id: string, title: string | null): void {
  insert(db, "channels", { id, title, first_seen_at: T0, created_at: T0, updated_at: T0 });
}

export function seedVideo(db: Db, row: { id: string } & Record<string, SQLInputValue>): void {
  insert(db, "videos", { created_at: T0, updated_at: T0, ...row });
}

export function seedSource(
  db: Db,
  videoId: string,
  source: string,
  accountId: number | null,
  firstSeenAt: number,
): void {
  insert(db, "video_sources", {
    video_id: videoId,
    account_id: accountId,
    source,
    first_seen_at: firstSeenAt,
    last_seen_at: firstSeenAt,
  });
}

export function seedMedia(
  db: Db,
  row: { video_id: string; kind: string; rel_path: string } & Record<string, SQLInputValue>,
): number {
  return insert(db, "media", { created_at: T0, ...row });
}

export function seedLocation(db: Db, label: string, containerPath: string): number {
  return insert(db, "locations", {
    label,
    container_path: containerPath,
    created_at: T0,
    updated_at: T0,
  });
}

export function seedEffective(
  db: Db,
  videoId: string,
  values: { reclaim_priority: number; location_id?: number | null; include?: boolean },
): void {
  insert(db, "video_effective", {
    video_id: videoId,
    effective_json: JSON.stringify({ reclaim_priority: values.reclaim_priority }),
    provenance_json: JSON.stringify({ reclaim_priority: "default" }),
    matched_rule_ids: "[1]",
    evaluated_at: T0,
    next_eval_at: null,
    reclaim_priority: values.reclaim_priority,
    location_id: values.location_id ?? null,
    include: values.include === false ? 0 : 1,
  });
}

export function seedThumbnail(
  db: Db,
  videoId: string,
  variant: string,
  sha256: string,
  path: string,
  firstSeenAt: number,
): void {
  insert(db, "thumbnails", {
    video_id: videoId,
    variant,
    url: `https://i.ytimg.com/vi/${videoId}/${variant}.jpg`,
    sha256,
    path,
    first_seen_at: firstSeenAt,
  });
}

/** An 11 character video id from a short tag, padded with `_`. */
export function vid(tag: string): string {
  return tag.padEnd(11, "_").slice(0, 11);
}
