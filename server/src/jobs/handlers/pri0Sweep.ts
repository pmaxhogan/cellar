import { realpath, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { Logger } from "pino";
import type { Db } from "../../db/db.ts";
import { logActivity } from "../../domain/activity.ts";
import type { EventBus } from "../../events.ts";
import type { JobRegistry } from "../types.ts";

/**
 * The pri-0 sweep (spec 4.7 reap, first bullet): every video whose effective
 * reclaim_priority is 0 loses its video/audio files, all versions, and their
 * `media` rows. Rows with a NULL location (captions and info json under
 * /data/meta) are never touched, nothing under DATA_DIR is ever unlinked, and
 * metadata, history and thumbnails stay. Also the second half of the trash
 * action.
 */

export const PRI0_SWEEP_JOB = "pri0_sweep";

export interface SweepDeps {
  db: Db;
  log: Logger;
  events?: EventBus | undefined;
  now?: () => number;
  /** $DATA_DIR. Any target resolving inside it is refused. */
  dataDir: string;
  /** Report a filesystem failure (domain/notifications.ts recordFsError). */
  recordFsError(detail: string): Promise<unknown>;
}

export interface SweepOptions {
  /** Limit the sweep to these videos (they must still be pri 0). Default: every pri-0 video. */
  videoIds?: readonly string[];
}

export interface SweepResult {
  videos: number;
  files: number;
  bytes: number;
  errors: number;
}

interface SweepRow {
  id: number;
  video_id: string;
  rel_path: string;
  size_bytes: number;
  location_id: number;
  container_path: string;
}

/** True when `child` is `parent` itself or below it. */
export function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Absolute target of a media row, or null when it escapes its location or enters DATA_DIR. */
export function mediaTarget(root: string, relPath: string, dataDir: string): string | null {
  if (relPath === "" || isAbsolute(relPath)) {
    return null;
  }
  const target = resolve(root, relPath);
  if (target === resolve(root) || !isWithin(root, target)) {
    return null;
  }
  return isWithin(dataDir, target) ? null : target;
}

async function realOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The symlink-resolved check: the file's real parent directory must stay
 * inside the location's real root and outside the real DATA_DIR.
 */
async function realTargetOk(root: string, target: string, dataDir: string): Promise<boolean> {
  const [realRoot, realDir, realData] = await Promise.all([
    realOrSelf(root),
    realOrSelf(dirname(target)),
    realOrSelf(dataDir),
  ]);
  return isWithin(realRoot, realDir) && !isWithin(realData, realDir);
}

/** Remove now-empty directories from `start` up to, never including, `root`. */
async function pruneEmptyDirs(start: string, root: string): Promise<void> {
  const stop = resolve(root);
  for (let dir = resolve(start); dir !== stop && isWithin(stop, dir); dir = dirname(dir)) {
    try {
      await rmdir(dir);
    } catch {
      return;
    }
  }
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function placeholders(count: number): string {
  return new Array<string>(count).fill("?").join(", ");
}

/** Media rows of pri-0 videos, located, ordered per video. */
function pri0Rows(db: Db, videoIds: readonly string[] | undefined): SweepRow[] {
  const base = `SELECT m.id, m.video_id, m.rel_path, m.size_bytes, m.location_id, l.container_path
       FROM media m
       JOIN video_effective e ON e.video_id = m.video_id
       JOIN locations l ON l.id = m.location_id
      WHERE e.reclaim_priority = 0 AND m.kind IN ('video', 'audio')
        AND m.location_id IS NOT NULL`;
  if (videoIds === undefined) {
    return db.all<SweepRow>(`${base} ORDER BY m.video_id, m.id`);
  }
  const out: SweepRow[] = [];
  for (let i = 0; i < videoIds.length; i += 500) {
    const chunk = videoIds.slice(i, i + 500);
    out.push(
      ...db.all<SweepRow>(
        `${base} AND m.video_id IN (${placeholders(chunk.length)}) ORDER BY m.video_id, m.id`,
        ...chunk,
      ),
    );
  }
  return out;
}

/**
 * Delete the video/audio media of pri-0 videos. A file that is already gone
 * counts as deleted; any other filesystem error keeps the row (the next sweep
 * retries it) and is reported through `recordFsError`.
 */
export async function sweepPri0(deps: SweepDeps, options: SweepOptions = {}): Promise<SweepResult> {
  const log = deps.log.child({ mod: "pri0Sweep" });
  const rows = pri0Rows(deps.db, options.videoIds);
  const byVideo = new Map<string, SweepRow[]>();
  for (const row of rows) {
    const list = byVideo.get(row.video_id) ?? [];
    list.push(row);
    byVideo.set(row.video_id, list);
  }

  const result: SweepResult = { videos: 0, files: 0, bytes: 0, errors: 0 };
  const failures: string[] = [];
  for (const [videoId, list] of byVideo) {
    const deleted: number[] = [];
    let bytes = 0;
    for (const row of list) {
      const target = mediaTarget(row.container_path, row.rel_path, deps.dataDir);
      if (target === null || !(await realTargetOk(row.container_path, target, deps.dataDir))) {
        result.errors += 1;
        failures.push(`media ${String(row.id)} of ${videoId} points outside its location`);
        log.warn({ mediaId: row.id, videoId }, "refusing to delete media outside its location");
        continue;
      }
      try {
        await unlink(target);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          result.errors += 1;
          failures.push(
            `could not delete media ${String(row.id)} of ${videoId}: ${errorCode(error) ?? "error"}`,
          );
          log.warn({ err: error, mediaId: row.id, videoId }, "could not delete a media file");
          continue;
        }
      }
      await pruneEmptyDirs(dirname(target), row.container_path);
      deleted.push(row.id);
      bytes += row.size_bytes;
    }
    if (deleted.length === 0) {
      continue;
    }
    deps.db.tx(() => {
      for (const id of deleted) {
        deps.db.run("DELETE FROM media WHERE id = ?", id);
      }
    });
    result.videos += 1;
    result.files += deleted.length;
    result.bytes += bytes;
    logActivity(
      { db: deps.db, events: deps.events, ...(deps.now === undefined ? {} : { now: deps.now }) },
      {
        kind: "media.deleted",
        message: `Deleted ${String(deleted.length)} media file(s) (reclaim priority 0)`,
        videoId,
        data: { files: deleted.length, bytes, reason: "pri0" },
      },
    );
    deps.events?.publish("video.media", { videoId, deleted: deleted.length, bytes });
  }

  for (const detail of failures) {
    try {
      await deps.recordFsError(detail);
    } catch (error) {
      log.warn({ err: error }, "could not record a filesystem error");
    }
  }
  if (result.files > 0 || result.errors > 0) {
    log.info({ ...result }, "pri-0 sweep finished");
  }
  return result;
}

/** Register the `pri0_sweep` job (maintenance class; payload `{ videoIds? }`). */
export function registerPri0Sweep(registry: JobRegistry, deps: SweepDeps): void {
  registry.register(PRI0_SWEEP_JOB, {
    class: "maintenance",
    maxAttempts: 2,
    dedupeKey: (payload) => {
      const ids = (payload as { videoIds?: unknown } | null)?.videoIds;
      return Array.isArray(ids) ? `ids:${[...ids].map(String).sort().join(",")}` : "all";
    },
    handler: async (ctx) => {
      const ids = (ctx.job.payload as { videoIds?: unknown } | null)?.videoIds;
      const videoIds = Array.isArray(ids)
        ? ids.filter((id): id is string => typeof id === "string")
        : undefined;
      const result = await sweepPri0(
        { ...deps, db: ctx.db, log: ctx.log },
        videoIds === undefined ? {} : { videoIds },
      );
      ctx.log.info({ ...result }, "pri-0 sweep job finished");
    },
  });
}
