import type { FastifyPluginAsync } from "fastify";
import { requestPathname } from "../security/publicPaths.ts";
import { eventRoutes } from "./events.ts";
import { statusRoutes } from "./status.ts";

/** Everything under /api. Each plugin is thin and calls into domain/*. */
export const apiRoutes: FastifyPluginAsync = async (app) => {
  // JSON, never the SPA: an unmatched API call must not come back as HTML.
  // The query string is not echoed back.
  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({
      error: `No API route matches ${request.method} ${requestPathname(request.url)}.`,
      code: "not_found",
    });
  });

  await app.register(statusRoutes);
  await app.register(eventRoutes, {});
};
