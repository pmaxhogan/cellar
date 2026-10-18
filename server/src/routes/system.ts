import {
  ChecksQuerySchema,
  ToolRollbackRequestSchema,
  ToolUpdateRequestSchema,
  type CheckRow,
  type ChecksListResponse,
  type LatestCheckResponse,
  type ToolsResponse,
  type ToolUpdateOutcome,
} from "@cellar/shared";
import type { FastifyPluginAsync } from "fastify";
import { lastCheck, listChecks, runSelfCheck } from "../domain/selfcheck.ts";
import { createSystemDeps, type SystemDeps } from "../domain/systemDeps.ts";
import { buildToolsResponse, checkToolUpdates, rollbackTool } from "../media/tools.ts";
import { parseBody, parseQuery } from "./validate.ts";

export interface SystemRoutesOptions {
  /** Injected in tests; built from app.cellar otherwise. */
  deps?: SystemDeps;
}

/**
 * /api/tools and /api/checks. Registered under the /api prefix by app.ts.
 *
 *   GET  /tools           -> ToolsResponse
 *   POST /tools/update    <- { tool?, force? } -> ToolsResponse with outcomes
 *   POST /tools/rollback  <- { tool }          -> ToolsResponse (412 without a .prev)
 *   GET  /checks?limit=N  -> { rows: CheckRow[] }
 *   GET  /checks/latest   -> { row: CheckRow | null }
 *   POST /checks/run      -> CheckRow
 */
export const systemRoutes: FastifyPluginAsync<SystemRoutesOptions> = async (app, options) => {
  const deps =
    options.deps ??
    createSystemDeps({
      config: app.cellar.config,
      log: app.cellar.log.child({ mod: "system" }),
      db: app.cellar.db,
    });

  const tools = (outcomes?: ToolUpdateOutcome[]): ToolsResponse =>
    buildToolsResponse(deps.db, deps.getSettings(), deps.config.potProviderUrl, outcomes);

  app.get("/tools", (): ToolsResponse => tools());

  app.post("/tools/update", async (request): Promise<ToolsResponse> => {
    const body = parseBody(ToolUpdateRequestSchema, request);
    const outcomes = await checkToolUpdates(deps, {
      ...(body.tool === undefined ? {} : { tool: body.tool }),
      ...(body.force === undefined ? {} : { force: body.force }),
    });
    return tools(outcomes);
  });

  app.post("/tools/rollback", async (request): Promise<ToolsResponse> => {
    const body = parseBody(ToolRollbackRequestSchema, request);
    await rollbackTool(deps, body.tool);
    return tools();
  });

  app.get("/checks", (request): ChecksListResponse => {
    const query = parseQuery(ChecksQuerySchema, request);
    return { rows: listChecks(deps.db, query.limit) };
  });

  app.get("/checks/latest", (): LatestCheckResponse => ({ row: lastCheck(deps.db) }));

  app.post("/checks/run", (): Promise<CheckRow> => runSelfCheck(deps, "manual"));
};
