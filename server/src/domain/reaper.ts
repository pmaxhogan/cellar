import { statfs as fsStatfs, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { PipelineDeps, PipelineLocation } from "../jobs/pipelineDeps.ts";
import { isInside, removeEmptyParents, resolveRel } from "../media/paths.ts";
import {
  avMediaRows,
  findLocation,
  isLocationPaused,
  locationUsedBytes,
  setLocationPaused,
} from "../media/rows.ts";

/**
 * The quota reaper (spec 3.3, docs/ARCHITECTURE.md "Reap"). Per location:
 *
 * - Pri-0 media is swept unconditionally (the pri-0 sweep normally got there
 *   first; this is the safety net).
 * - The location is over when used >= `reaper.high_water_pct` of its quota
 *   (quota 0 = unlimited: only the free-space rule applies) or the underlying
 *   filesystem has less than `reaper.min_free_gb` free.
 * - While over, whole videos are deleted lowest reclaim_priority first, then
 *   oldest downloaded_at, until used <= `reaper.low_water_pct` of the quota
 *   AND free >= min_free_gb. Pri -1 (and videos never evaluated) is never
 *   touched.
 * - Deleting a video's media removes all its video/audio rows (current and
 *   versions) and their files. Captions, info json and thumbnails under
 *   /data/meta stay, and nothing under DATA_DIR is ever deleted.
 * - Still over with nothing left to reclaim: storage-pressure notification
 *   (rate limited) and `kv.location_paused:<id>` = true, which makes the
 *   download handler refuse that location. The flag clears once a pass finds
 *   the location under its thresholds.
 */

export const REAP_JOB = "reap";
export const REAP_NOW_ACTION = "action:reap-now";
const GIB = 1024 ** 3;

type ReaperDeps = Pick<
  PipelineDeps,
  | "db"
  | "log"
  | "config"
  | "now"
  | "getSettings"
  | "locations"
  | "logActivity"
  | "recordStoragePressure"
  | "recordFsError"
  | "statfs"
  | "enqueue"
>;

export interface ReapResult {
  locationId: number;
  usedBefore: number;
  usedAfter: number;
  /** Free bytes on the filesystem before the pass; null when unknown. */
  freeBefore: number | null;
  over: boolean;
  /** Still over after every candidate was considered. */
  stillOver: boolean;
  paused: boolean;
  deletedVideos: string[];
  freedBytes: number;
  sweptPri0: string[];
}

async function freeBytes(deps: ReaperDeps, path: string): Promise<number | null> {
  try {
    if (deps.statfs !== undefined) {
      return (await deps.statfs(path)).free;
    }
    const stats = await fsStatfs(path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch (error) {
    deps.log.warn({ err: error, locationPath: path }, "could not read free space");
    return null;
  }
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Delete every video/audio file and row of a video. Returns the bytes freed.
 * A row whose file cannot be removed (other than already missing) is kept.
 */
export async function deleteVideoMedia(
  deps: ReaperDeps,
  videoId: string,
  reason: string,
  jobId: number | null = null,
): Promise<number> {
  let freed = 0;
  let removed = 0;
  for (const row of avMediaRows(deps.db, videoId)) {
    const location = row.location_id === null ? undefined : findLocation(deps, row.location_id);
    if (location === undefined) {
      deps.log.warn({ videoId, mediaId: row.id }, "media row points at an unknown location");
      deps.db.run("DELETE FROM media WHERE id = ?", row.id);
      removed += 1;
      continue;
    }
    let path: string;
    try {
      path = resolveRel(location.container_path, row.rel_path);
    } catch {
      deps.log.error({ videoId, mediaId: row.id }, "media rel_path escapes its location; skipped");
      continue;
    }
    if (isInside(deps.config.dataDir, path)) {
      deps.log.error({ videoId, mediaId: row.id }, "refusing to delete a file under DATA_DIR");
      continue;
    }
    try {
      await unlink(path);
    } catch (error) {
      if (codeOf(error) !== "ENOENT") {
        deps.log.error({ err: error, videoId, mediaId: row.id }, "could not delete a media file");
        await deps.recordFsError(
          `Could not delete media of ${videoId}: ${codeOf(error) ?? "error"}`,
        );
        continue;
      }
    }
    deps.db.run("DELETE FROM media WHERE id = ?", row.id);
    freed += Number(row.size_bytes);
    removed += 1;
    await removeEmptyParents(dirname(path), location.container_path);
  }
  if (removed > 0) {
    deps.logActivity({
      kind: "media.reaped",
      message: `Deleted the media of ${videoId} (${reason}).`,
      videoId,
      jobId,
      data: { bytes: freed, files: removed, reason },
    });
  }
  return freed;
}

function videosAt(deps: ReaperDeps, locationId: number, where: string): string[] {
  return deps.db
    .all<{ video_id: string }>(
      `SELECT m.video_id AS video_id, ve.reclaim_priority AS pri,
              MIN(COALESCE(m.downloaded_at, m.created_at)) AS oldest
         FROM media m JOIN video_effective ve ON ve.video_id = m.video_id
        WHERE m.location_id = ? AND m.kind IN ('video', 'audio') AND ${where}
        GROUP BY m.video_id
        ORDER BY pri ASC, oldest ASC, m.video_id ASC`,
      locationId,
    )
    .map((row) => row.video_id);
}

function summary(location: PipelineLocation, used: number, free: number | null): string {
  const gb = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GB`;
  const quota = location.quota_bytes > 0 ? ` of ${gb(location.quota_bytes)}` : "";
  const freeText = free === null ? "" : `, ${gb(free)} free on disk`;
  return `${gb(used)} used${quota}${freeText}`;
}

/** One reaper pass over one location. */
export async function reapLocation(
  deps: ReaperDeps,
  locationId: number,
  jobId: number | null = null,
): Promise<ReapResult> {
  const location = findLocation(deps, locationId);
  const usedBefore = locationUsedBytes(deps.db, locationId);
  const empty: ReapResult = {
    locationId,
    usedBefore,
    usedAfter: usedBefore,
    freeBefore: null,
    over: false,
    stillOver: false,
    paused: isLocationPaused(deps.db, locationId),
    deletedVideos: [],
    freedBytes: 0,
    sweptPri0: [],
  };
  if (location === undefined || !location.enabled) {
    return empty;
  }
  const settings = deps.getSettings();
  const sweptPri0: string[] = [];
  let freed = 0;
  for (const videoId of videosAt(deps, locationId, "ve.reclaim_priority = 0")) {
    freed += await deleteVideoMedia(deps, videoId, "reclaim priority 0", jobId);
    sweptPri0.push(videoId);
  }

  const quota = location.quota_bytes;
  const high = (quota * settings["reaper.high_water_pct"]) / 100;
  const low = (quota * settings["reaper.low_water_pct"]) / 100;
  const minFree = settings["reaper.min_free_gb"] * GIB;
  const freeBefore = await freeBytes(deps, location.container_path);
  // statfs is read once: the cached figure plus what this pass freed.
  const freeNow = (): number | null => (freeBefore === null ? null : freeBefore + freed);
  let used = locationUsedBytes(deps.db, locationId);

  const over = (quota > 0 && used >= high) || (freeBefore !== null && freeBefore < minFree);
  const done = (): boolean => {
    const free = freeNow();
    return (quota === 0 || used <= low) && (free === null || free >= minFree);
  };

  const deletedVideos: string[] = [];
  if (over) {
    for (const videoId of videosAt(deps, locationId, "ve.reclaim_priority > 0")) {
      if (done()) {
        break;
      }
      freed += await deleteVideoMedia(deps, videoId, "storage quota", jobId);
      deletedVideos.push(videoId);
      used = locationUsedBytes(deps.db, locationId);
    }
  }
  const stillOver = over && !done();
  const now = deps.now();
  const wasPaused = isLocationPaused(deps.db, locationId);
  if (stillOver) {
    setLocationPaused(deps.db, locationId, true, now);
    const detail = `Location ${String(locationId)} is over its threshold and nothing more can be reclaimed (${summary(location, used, freeNow())}). Downloads to it are paused.`;
    if (!wasPaused) {
      deps.logActivity({ level: "error", kind: "location.paused", message: detail, jobId });
    }
    await deps.recordStoragePressure(locationId, detail);
  } else if (wasPaused) {
    setLocationPaused(deps.db, locationId, false, now);
    deps.logActivity({
      kind: "location.resumed",
      message: `Location ${String(locationId)} is under its threshold again; downloads resume.`,
      jobId,
    });
  }

  const freeAfter = await freeBytes(deps, location.container_path);
  deps.db.run(
    "UPDATE locations SET used_bytes = ?, fs_free_bytes = ?, updated_at = ? WHERE id = ?",
    Math.max(0, used),
    freeAfter === null ? null : Math.max(0, Math.floor(freeAfter)),
    now,
    locationId,
  );
  return {
    locationId,
    usedBefore,
    usedAfter: used,
    freeBefore,
    over,
    stillOver,
    paused: stillOver,
    deletedVideos,
    freedBytes: freed,
    sweptPri0,
  };
}

/** Reap one location, or every enabled one. */
export async function reapAll(
  deps: ReaperDeps,
  locationId?: number | null,
  jobId: number | null = null,
): Promise<ReapResult[]> {
  const ids =
    locationId === undefined || locationId === null
      ? deps
          .locations()
          .filter((location) => location.enabled)
          .map((location) => location.id)
      : [locationId];
  const out: ReapResult[] = [];
  for (const id of ids) {
    out.push(await reapLocation(deps, id, jobId));
  }
  return out;
}

/** Queue a reap of `locationId` when its usage reached the high-water mark. */
export function maybeEnqueueReap(deps: ReaperDeps, locationId: number): boolean {
  const location = findLocation(deps, locationId);
  if (location === undefined || location.quota_bytes <= 0) {
    return false;
  }
  const high = (location.quota_bytes * deps.getSettings()["reaper.high_water_pct"]) / 100;
  if (locationUsedBytes(deps.db, locationId) < high) {
    return false;
  }
  deps.enqueue({ type: REAP_JOB, payload: { location_id: locationId }, dedupe: true });
  return true;
}
