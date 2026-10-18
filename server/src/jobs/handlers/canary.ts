import { canaryBudgetOk, runCanary } from "../../domain/canary.ts";
import type { PipelineDeps } from "../pipelineDeps.ts";
import type { JobContext } from "../types.ts";

/** The `canary` job (maintenance class, one attempt). See domain/canary.ts. */
export async function runCanaryJob(deps: PipelineDeps, ctx: JobContext): Promise<void> {
  if (!canaryBudgetOk(deps)) {
    ctx.log.info("canary budget spent for this hour; skipped");
    return;
  }
  const outcome = await runCanary(deps, { signal: ctx.signal, jobId: ctx.job.id });
  ctx.checkpoint();
  ctx.log.info({ verdict: outcome.verdict }, "canary job finished");
}
