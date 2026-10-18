import type { Db } from "../../db/db.ts";
import type { JobContext } from "../types.ts";
import type { PipelineDeps } from "../pipelineDeps.ts";
import { enqueueDownload } from "../pipelineBoot.ts";

export const DOWNLOAD_SCAN_JOB = "download_scan";
export const DOWNLOAD_SCAN_INTERVAL_MS = 5 * 60_000;
/** Videos queued per scan; the next scan picks up the rest. */
export const DOWNLOAD_SCAN_BATCH = 500;

/**
 * Videos the rules want on disk but that have no current media and no download
 * in flight: included, not priority 0, not gone, and not already queued.
 * Rechecked metadata is not required; yt-dlp fetches what it needs.
 */
export function downloadableVideoIds(db: Db, limit: number = DOWNLOAD_SCAN_BATCH): string[] {
  return db
    .all<{ video_id: string }>(
      `SELECT ve.video_id
         FROM video_effective ve
         JOIN videos v ON v.id = ve.video_id
        WHERE ve.include = 1
          AND ve.reclaim_priority != 0
          AND v.gone_since IS NULL
          AND (v.privacy IS NULL OR v.privacy NOT IN ('private', 'removed', 'unavailable'))
          AND NOT EXISTS (
            SELECT 1 FROM media m
             WHERE m.video_id = ve.video_id AND m.kind IN ('video', 'audio') AND m.is_current = 1
          )
          AND NOT EXISTS (
            SELECT 1 FROM jobs j
             WHERE j.type = 'download' AND j.video_id = ve.video_id
               AND j.status IN ('queued', 'running')
          )
        ORDER BY ve.evaluated_at DESC, ve.video_id
        LIMIT ?`,
      limit,
    )
    .map((row) => row.video_id);
}

/** Queue a download for every downloadable video; returns how many were queued. */
export function runDownloadScan(deps: PipelineDeps, ctx?: JobContext): number {
  const ids = downloadableVideoIds(deps.db);
  let queued = 0;
  for (const id of ids) {
    ctx?.checkpoint();
    const result = enqueueDownload(deps, id);
    if (!result.deduped) {
      queued += 1;
    }
  }
  if (queued > 0) {
    deps.logActivity({
      level: "info",
      kind: "download.scan",
      message: `Queued ${String(queued)} download(s) for videos the rules keep.`,
      data: { queued, candidates: ids.length },
    });
  }
  deps.log.debug({ queued, candidates: ids.length }, "download scan finished");
  return queued;
}
