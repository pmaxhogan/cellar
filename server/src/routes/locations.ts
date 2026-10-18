import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  createLocation,
  deleteLocation,
  listLocations,
  locationUsage,
  updateLocation,
} from "../domain/locations.ts";
import { IntIdParamsSchema } from "./routeDeps.ts";
import { parseBody, parseParams } from "./validate.ts";

const LocationSchema = z.strictObject({
  label: z.string().trim().min(1).max(100),
  container_path: z.string().trim().min(1).max(1024),
  quota_bytes: z.number().int().min(0).default(0),
  enabled: z.boolean().default(true),
});

const LocationPatchSchema = z.strictObject({
  label: z.string().trim().min(1).max(100).optional(),
  container_path: z.string().trim().min(1).max(1024).optional(),
  quota_bytes: z.number().int().min(0).optional(),
  enabled: z.boolean().optional(),
});

/** /api/locations: CRUD plus live usage. */
export const locationRoutes: FastifyPluginAsync = async (app) => {
  const { db, config } = app.cellar;

  app.get("/locations", () => ({ rows: listLocations(db) }));

  app.post("/locations", async (request, reply) => {
    const body = parseBody(LocationSchema, request);
    return reply.code(201).send(createLocation(db, config, body));
  });

  const update = (request: Parameters<typeof parseBody>[1]) => {
    const { id } = parseParams(IntIdParamsSchema, request);
    const patch = parseBody(LocationPatchSchema, request);
    return updateLocation(db, config, id, {
      ...(patch.label === undefined ? {} : { label: patch.label }),
      ...(patch.container_path === undefined ? {} : { container_path: patch.container_path }),
      ...(patch.quota_bytes === undefined ? {} : { quota_bytes: patch.quota_bytes }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    });
  };
  app.put("/locations/:id", (request) => update(request));
  app.patch("/locations/:id", (request) => update(request));

  app.delete("/locations/:id", async (request, reply) => {
    const { id } = parseParams(IntIdParamsSchema, request);
    deleteLocation(db, id);
    return reply.code(204).send();
  });

  app.get("/locations/:id/usage", (request) => {
    const { id } = parseParams(IntIdParamsSchema, request);
    return locationUsage(db, id);
  });
};
