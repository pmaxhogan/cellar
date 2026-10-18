import type { FastifyPluginAsync } from "fastify";
import { createRulesDeps, type RulesDeps } from "../domain/ruleEval.ts";
import { JobQueue } from "../jobs/queue.ts";
import { jobRegistry, type JobRegistry } from "../jobs/types.ts";
import { inspectRoutes } from "./inspect.ts";
import { rulesRoutes } from "./rules.ts";

export interface Wave2bRoutesOptions {
  /** Fully wired deps (the orchestrator's). Default: built from app.cellar. */
  deps?: RulesDeps;
  /** Defaults to the process-wide jobRegistry. */
  registry?: JobRegistry;
}

/** Rules, preview, Inspect and per-video overrides, mounted under /api by app.ts. */
export const wave2bRoutes: FastifyPluginAsync<Wave2bRoutesOptions> = async (app, options) => {
  const { db, log, events, config } = app.cellar;
  const registry = options.registry ?? jobRegistry;
  const queue = new JobQueue(db, { registry, events });
  const deps =
    options.deps ??
    createRulesDeps({
      db,
      log: log.child({ mod: "rules" }),
      events,
      dataDir: config.dataDir,
      registry,
      enqueue: (input) => queue.enqueue(input),
    });
  await app.register(rulesRoutes, { deps });
  await app.register(inspectRoutes, { deps });
};
