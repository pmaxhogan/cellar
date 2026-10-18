import type { Db } from "../db/db.ts";
import { getKv, setKv } from "../db/kv.ts";
import type { PipelineDeps, PipelineLocation } from "../jobs/pipelineDeps.ts";

/**
 * `media` table and location helpers shared by the pipeline jobs. Video and
 * audio rows live in a location (`rel_path` relative to its root); captions
 * and info rows have location_id NULL and live under metaDir.
 */

export interface MediaRow {
  id: number;
  video_id: string;
  kind: "video" | "audio" | "captions" | "info";
  version: number;
  is_current: number;
  location_id: number | null;
  rel_path: string;
  size_bytes: number;
  sha256: string | null;
  vcodec: string | null;
  acodec: string | null;
  height: number | null;
  fps: number | null;
  bitrate: number | null;
  lang: string | null;
  downloaded_at: number | null;
  transcoded_from: string | null;
  created_at: number;
}

/** Every video/audio row of a video (current and kept versions). */
export function avMediaRows(db: Db, videoId: string): MediaRow[] {
  return db.all<MediaRow>(
    `SELECT * FROM media WHERE video_id = ? AND kind IN ('video', 'audio')
      ORDER BY is_current DESC, version DESC, id`,
    videoId,
  );
}

/** The current video/audio rows of a video. */
export function currentAvMedia(db: Db, videoId: string): MediaRow[] {
  return avMediaRows(db, videoId).filter((row) => Number(row.is_current) === 1);
}

/** Next version number for a video's media: highest so far plus one. */
export function nextVersion(db: Db, videoId: string): number {
  const row = db.get<{ v: number | null }>(
    "SELECT MAX(version) AS v FROM media WHERE video_id = ? AND kind IN ('video', 'audio')",
    videoId,
  );
  return Number(row?.v ?? 0) + 1;
}

export function findLocation(
  deps: Pick<PipelineDeps, "locations">,
  id: number,
): PipelineLocation | undefined {
  return deps.locations().find((location) => location.id === id);
}

/** The location a video resolves to: its effective location_id, else the first enabled one. */
export function resolveLocation(
  deps: Pick<PipelineDeps, "locations">,
  locationId: number | null,
): PipelineLocation | undefined {
  const all = deps.locations();
  if (locationId !== null) {
    return all.find((location) => location.id === locationId);
  }
  return [...all].sort((a, b) => a.id - b.id).find((location) => location.enabled);
}

export const LOCATION_PAUSED_PREFIX = "location_paused:";

/** Set by the reaper when a location is over its threshold and nothing is reclaimable. */
export function isLocationPaused(db: Db, locationId: number): boolean {
  return getKv<boolean>(db, `${LOCATION_PAUSED_PREFIX}${String(locationId)}`) === true;
}

export function setLocationPaused(db: Db, locationId: number, paused: boolean, now: number): void {
  const key = `${LOCATION_PAUSED_PREFIX}${String(locationId)}`;
  if (paused) {
    setKv(db, key, true, now);
  } else {
    db.run("DELETE FROM kv WHERE key = ?", key);
  }
}

/** Bytes of video/audio media (current and versions) stored at a location. */
export function locationUsedBytes(db: Db, locationId: number): number {
  const row = db.get<{ n: number | null }>(
    `SELECT SUM(size_bytes) AS n FROM media
      WHERE location_id = ? AND kind IN ('video', 'audio')`,
    locationId,
  );
  return Math.max(0, Number(row?.n ?? 0));
}
