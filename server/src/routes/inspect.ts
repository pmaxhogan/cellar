import type { InspectResponse } from "@cellar/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { invalid } from "../domain/errors.ts";
import { inspectVideo, setVideoOverrides, type RulesDeps } from "../domain/ruleEval.ts";
import { parseParams, parseQuery } from "./validate.ts";

export { trashVideos, type TrashResult } from "../domain/ruleEval.ts";

/**
 * GET /api/inspect?id=<identifier> and PUT /api/videos/:id/overrides.
 * `trashVideos` (re-exported above) backs POST /api/videos/trash, which the
 * videos routes own.
 */

export interface InspectRoutesOptions {
  deps: RulesDeps;
}

const InspectQuery = z.object({ id: z.string().min(1).max(2000) });
const VideoParams = z.object({ id: z.string().min(1).max(2000) });

export const inspectRoutes: FastifyPluginAsync<InspectRoutesOptions> = async (app, options) => {
  const { deps } = options;

  app.get("/inspect", (request): InspectResponse => {
    const { id } = parseQuery(InspectQuery, request);
    return inspectVideo(deps, id);
  });

  app.put("/videos/:id/overrides", async (request): Promise<InspectResponse> => {
    const { id } = parseParams(VideoParams, request);
    const body = request.body;
    if (body === null || typeof body !== "object" || !("effects" in body)) {
      throw invalid("The body must be { effects: { ... } | null }.");
    }
    return setVideoOverrides(deps, id, (body as { effects: unknown }).effects);
  });
};
