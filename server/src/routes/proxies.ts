import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  createProxy,
  deleteProxy,
  listProxies,
  testProxy,
  updateProxy,
} from "../domain/proxies.ts";
import { IntIdParamsSchema, routeDeps, type Wave1ARouteOptions } from "./routeDeps.ts";
import { parseBody, parseParams } from "./validate.ts";

// The URL is validated by parseProxyUrl, whose messages never echo the input.
const ProxySchema = z.strictObject({
  label: z.string().trim().min(1).max(100),
  url: z.string().min(1).max(2048),
  enabled: z.boolean().default(true),
});

const ProxyPatchSchema = z.strictObject({
  label: z.string().trim().min(1).max(100).optional(),
  url: z.string().min(1).max(2048).optional(),
  enabled: z.boolean().optional(),
});

/** /api/proxies: CRUD and an on-demand reachability test. URLs are write-only. */
export const proxyRoutes: FastifyPluginAsync<Wave1ARouteOptions> = async (app, options) => {
  const deps = routeDeps(app, options, "proxies");

  app.get("/proxies", () => ({ rows: listProxies(deps.db) }));

  app.post("/proxies", async (request, reply) => {
    const body = parseBody(ProxySchema, request);
    return reply.code(201).send(createProxy(deps, body));
  });

  const update = (request: Parameters<typeof parseBody>[1]) => {
    const { id } = parseParams(IntIdParamsSchema, request);
    const patch = parseBody(ProxyPatchSchema, request);
    return updateProxy(deps, id, {
      ...(patch.label === undefined ? {} : { label: patch.label }),
      ...(patch.url === undefined ? {} : { url: patch.url }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    });
  };
  app.put("/proxies/:id", (request) => update(request));
  app.patch("/proxies/:id", (request) => update(request));

  app.delete("/proxies/:id", async (request, reply) => {
    const { id } = parseParams(IntIdParamsSchema, request);
    deleteProxy(deps.db, id);
    return reply.code(204).send();
  });

  app.post("/proxies/:id/test", async (request) => {
    const { id } = parseParams(IntIdParamsSchema, request);
    return testProxy(deps, id);
  });
};
