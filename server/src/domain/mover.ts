import { copyFile, mkdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { PipelineDeps } from "../jobs/pipelineDeps.ts";
import {
  atomicRename,
  fsyncFile,
  inflightDir,
  removeEmptyParents,
  resolveRel,
  sha256File,
} from "../media/paths.ts";
import { avMediaRows, findLocation, isLocationPaused, resolveLocation } from "../media/rows.ts";

/**
 * Moves (spec 1.2, docs/ARCHITECTURE.md "Move"): when a video's resolved
 * location differs from where its media lives, the media is MOVED, never
 * re-downloaded. Each file is copied into the target location's in-flight
 * dir, fsynced, verified (size and sha256 against the stored hash), renamed
 * into place, and only then is the row switched and the source unlinked. All
 * of a video's video/audio files (current and kept versions) move together.
 */

export const MOVE_JOB = "move";
export const MOVE_SCAN_SCHEDULE = "move_scan";
export const MOVE_SCAN_INTERVAL_MS = 10 * 60_000;

type MoverDeps = Pick<
  PipelineDeps,
  "db" | "log" | "now" | "locations" | "getEffective" | "logActivity" | "recordFsError" | "enqueue"
>;

export interface MoveResult {
  moved: number;
  bytes: number;
  targetLocationId: number | null;
  skipped?: string;
}

/** Move one video's media to its resolved location. */
export async function moveVideoMedia(
  deps: MoverDeps,
  videoId: string,
  jobId: number | null = null,
): Promise<MoveResult> {
  const effective = deps.getEffective(videoId);
  if (effective === null) {
    return { moved: 0, bytes: 0, targetLocationId: null, skipped: "not evaluated" };
  }
  const target = resolveLocation(deps, effective.location_id);
  if (target === undefined || !target.enabled) {
    deps.logActivity({
      level: "warn",
      kind: "media.move_skipped",
      message: `Not moving ${videoId}: its target location is missing or disabled.`,
      videoId,
      jobId,
    });
    return { moved: 0, bytes: 0, targetLocationId: null, skipped: "target unavailable" };
  }
  if (isLocationPaused(deps.db, target.id)) {
    deps.logActivity({
      level: "warn",
      kind: "media.move_skipped",
      message: `Not moving ${videoId}: location ${String(target.id)} is full and paused.`,
      videoId,
      jobId,
    });
    return { moved: 0, bytes: 0, targetLocationId: target.id, skipped: "target paused" };
  }

  const rows = avMediaRows(deps.db, videoId).filter(
    (row) => row.location_id !== null && row.location_id !== target.id,
  );
  let moved = 0;
  let bytes = 0;
  const from = new Set<number>();
  for (const row of rows) {
    const source = findLocation(deps, row.location_id as number);
    if (source === undefined) {
      deps.log.warn({ videoId, mediaId: row.id }, "media row points at an unknown location");
      continue;
    }
    const sourcePath = resolveRel(source.container_path, row.rel_path);
    const targetPath = resolveRel(target.container_path, row.rel_path);
    const staging = inflightDir(target.container_path, videoId);
    const stagingFile = join(staging, `move-${String(row.id)}-${basename(sourcePath)}`);
    if (!(await exists(sourcePath))) {
      deps.log.warn({ videoId, mediaId: row.id }, "media file to move is missing; skipped");
      continue;
    }
    try {
      const sourceStat = await stat(sourcePath);
      await mkdir(staging, { recursive: true });
      await copyFile(sourcePath, stagingFile);
      await fsyncFile(stagingFile);
      const copyStat = await stat(stagingFile);
      if (copyStat.size !== sourceStat.size) {
        throw new Error(
          `copy is ${String(copyStat.size)} bytes, the source ${String(sourceStat.size)}`,
        );
      }
      const expected = row.sha256 ?? (await sha256File(sourcePath));
      const actual = await sha256File(stagingFile);
      if (actual !== expected) {
        throw new Error("the copy's sha256 does not match the stored hash");
      }
      await mkdir(dirname(targetPath), { recursive: true });
      await atomicRename(stagingFile, targetPath);
    } catch (error) {
      await unlink(stagingFile).catch(() => undefined);
      await removeEmptyParents(staging, target.container_path);
      const message = error instanceof Error ? error.message : String(error);
      await deps.recordFsError(
        `Moving ${videoId} to location ${String(target.id)} failed: ${message}`,
      );
      throw error;
    }
    deps.db.run(
      "UPDATE media SET location_id = ?, rel_path = ? WHERE id = ?",
      target.id,
      row.rel_path,
      row.id,
    );
    await unlink(sourcePath).catch((error: unknown) => {
      deps.log.warn({ err: error, videoId }, "could not unlink the moved source file");
    });
    await removeEmptyParents(dirname(sourcePath), source.container_path);
    await removeEmptyParents(staging, target.container_path);
    moved += 1;
    bytes += Number(row.size_bytes);
    from.add(source.id);
  }
  if (moved > 0) {
    deps.logActivity({
      kind: "media.moved",
      message: `Moved ${videoId} to location ${String(target.id)}.`,
      videoId,
      jobId,
      data: { from: [...from], to: target.id, files: moved, bytes },
    });
  }
  return { moved, bytes, targetLocationId: target.id };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Queue a `move` for every video whose current media sits somewhere other
 * than its resolved location (an explicit location_id, or the first enabled
 * location when the effective value is null). Returns how many were queued.
 */
export function scheduleMovesForChangedLocations(
  deps: Pick<MoverDeps, "db" | "locations" | "enqueue">,
): number {
  const rows = deps.db.all<{
    video_id: string;
    media_location: number;
    target_location: number | null;
  }>(
    `SELECT DISTINCT m.video_id AS video_id, m.location_id AS media_location,
            ve.location_id AS target_location
       FROM media m JOIN video_effective ve ON ve.video_id = m.video_id
      WHERE m.kind IN ('video', 'audio') AND m.is_current = 1 AND m.location_id IS NOT NULL
      ORDER BY m.video_id`,
  );
  const queued = new Set<string>();
  for (const row of rows) {
    if (queued.has(row.video_id)) {
      continue;
    }
    const target = resolveLocation(deps, row.target_location);
    if (target === undefined || !target.enabled || target.id === Number(row.media_location)) {
      continue;
    }
    deps.enqueue({ type: MOVE_JOB, videoId: row.video_id, dedupe: true });
    queued.add(row.video_id);
  }
  return queued.size;
}
