import {
  importTakeout,
  parsePayload,
  removeStagingDir,
  TAKEOUT_JOB,
  type TakeoutImportDeps,
} from "../../domain/takeout.ts";
import { JobAbortedError, type JobContext, type JobRegistry } from "../types.ts";

/**
 * `takeout_import` (io class): the second half of POST /api/takeout. The
 * staging dir is deleted once the import succeeds, and also when the last
 * attempt fails or the job is cancelled; a shutdown keeps it for the requeue.
 */

export const TAKEOUT_MAX_ATTEMPTS = 2;

/** The deps the handler needs; db and log come from the job context. */
export type TakeoutHandlerDeps = Omit<TakeoutImportDeps, "db" | "log">;

function dedupeKey(payload: unknown): string {
  const dir = (payload as { dir?: unknown } | null)?.dir;
  return typeof dir === "string" ? dir : "";
}

export async function runTakeoutJob(deps: TakeoutHandlerDeps, ctx: JobContext): Promise<void> {
  try {
    const counts = await importTakeout({ ...deps, db: ctx.db, log: ctx.log }, ctx.job.payload, {
      jobId: ctx.job.id,
      progress: (pct, message) => {
        ctx.progress(pct, message);
      },
      checkpoint: () => {
        ctx.checkpoint();
      },
    });
    ctx.log.info({ counts }, "takeout import done");
  } catch (error) {
    const shuttingDown = error instanceof JobAbortedError && error.reason === "shutdown";
    const lastAttempt = ctx.job.attempts >= ctx.job.maxAttempts;
    const cancelled = error instanceof JobAbortedError && error.reason === "cancel";
    if (!shuttingDown && (lastAttempt || cancelled)) {
      let dir: string | null;
      try {
        dir = parsePayload(ctx.job.payload).dir;
      } catch {
        dir = null;
      }
      if (dir !== null) {
        await removeStagingDir(deps.tmpDir, dir);
      }
    }
    throw error;
  }
}

export function registerTakeoutHandler(registry: JobRegistry, deps: TakeoutHandlerDeps): void {
  registry.register(TAKEOUT_JOB, {
    class: "io",
    maxAttempts: TAKEOUT_MAX_ATTEMPTS,
    dedupeKey,
    handler: (ctx) => runTakeoutJob(deps, ctx),
  });
}
