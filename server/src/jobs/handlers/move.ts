import { moveVideoMedia } from "../../domain/mover.ts";
import { isVideoId } from "../../media/paths.ts";
import type { PipelineDeps } from "../pipelineDeps.ts";
import type { JobContext } from "../types.ts";

/** The `move` job (maintenance class, deduped per video). See domain/mover.ts. */
export async function runMove(deps: PipelineDeps, ctx: JobContext): Promise<void> {
  const videoId = ctx.job.videoId;
  if (videoId === null || !isVideoId(videoId)) {
    ctx.log.error({ videoId }, "move job without a valid video id");
    return;
  }
  const result = await moveVideoMedia(deps, videoId, ctx.job.id);
  ctx.log.info({ ...result }, "move finished");
}
