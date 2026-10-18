import { reapAll } from "../../domain/reaper.ts";
import type { PipelineDeps } from "../pipelineDeps.ts";
import type { JobContext } from "../types.ts";

/** Payload `{ location_id }` reaps one location; anything else reaps every enabled one. */
export function reapLocationOf(payload: unknown): number | null {
  const id = (payload as { location_id?: unknown } | null)?.location_id;
  return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null;
}

/** The `reap` job and `action:reap-now` (maintenance class). See domain/reaper.ts. */
export async function runReap(deps: PipelineDeps, ctx: JobContext): Promise<void> {
  const results = await reapAll(deps, reapLocationOf(ctx.job.payload), ctx.job.id);
  for (const result of results) {
    ctx.log.info(
      {
        locationId: result.locationId,
        over: result.over,
        stillOver: result.stillOver,
        deleted: result.deletedVideos.length,
        sweptPri0: result.sweptPri0.length,
        freedBytes: result.freedBytes,
      },
      "reap pass finished",
    );
  }
}
