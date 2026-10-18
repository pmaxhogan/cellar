import { ChannelSourceKindSchema, type ChannelsListResponse } from "@cellar/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  addManualChannel,
  listChannels,
  MAX_PER_PAGE,
  removeManualChannel,
} from "../domain/channels.ts";
import { routeDeps, type Wave1ARouteOptions } from "./routeDeps.ts";
import { parseBody, parseParams, parseQuery } from "./validate.ts";

const ListQuerySchema = z.object({
  q: z.string().max(200).optional(),
  kind: ChannelSourceKindSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(MAX_PER_PAGE).optional(),
  /** The rule builder's autocomplete asks with `limit`; an alias for perPage. */
  limit: z.coerce.number().int().min(1).max(MAX_PER_PAGE).optional(),
});

const AddSchema = z.strictObject({ ref: z.string().trim().min(1).max(500) });

const ChannelParamsSchema = z.object({ id: z.string().min(1).max(64) });

/** /api/channels: search, add a manual channel, stop following one manually. */
export const channelRoutes: FastifyPluginAsync<Wave1ARouteOptions> = async (app, options) => {
  const deps = routeDeps(app, options, "channels");

  app.get("/channels", (request): ChannelsListResponse => {
    const query = parseQuery(ListQuerySchema, request);
    return listChannels(deps.db, {
      q: query.q,
      kind: query.kind,
      page: query.page,
      perPage: query.perPage ?? query.limit ?? 50,
    });
  });

  app.post("/channels", async (request, reply) => {
    const { ref } = parseBody(AddSchema, request);
    const { channel, created } = await addManualChannel(deps, ref);
    return reply.code(created ? 201 : 200).send(channel);
  });

  app.delete("/channels/:id", async (request, reply) => {
    const { id } = parseParams(ChannelParamsSchema, request);
    removeManualChannel(deps.db, id);
    return reply.code(204).send();
  });
};
