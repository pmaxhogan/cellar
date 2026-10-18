import {
  ShareCreateRequestSchema,
  ShareRevokeBulkRequestSchema,
  SharesListQuerySchema,
  ShareTokenSchema,
  type ShareLinkRow,
  type ShareRevokeBulkResponse,
  type SharesListResponse,
} from "@cellar/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  createShare,
  deleteShare,
  getShare,
  listShares,
  revokeShare,
  revokeShares,
  type ShareCtx,
} from "../domain/shares.ts";
import { parseBody, parseParams, parseQuery } from "./validate.ts";

/**
 * /api/shares: the admin side of share links (behind Access like all of /api).
 * The public side is public/share.ts.
 */

export interface ShareRoutesOptions {
  /** Test seam for the clock. */
  now?: () => number;
  /** Test seam for the token RNG. */
  random?: (size: number) => Buffer;
}

const TokenParams = z.object({ token: ShareTokenSchema });

export const shareRoutes: FastifyPluginAsync<ShareRoutesOptions> = async (app, options) => {
  const { db, events, config } = app.cellar;
  const ctx: ShareCtx = {
    db,
    events,
    publicOrigin: config.publicOrigin,
    ...(options.now === undefined ? {} : { now: options.now }),
  };

  app.get("/shares", (request): SharesListResponse => {
    return listShares(ctx, parseQuery(SharesListQuerySchema, request));
  });

  app.post("/shares", (request, reply) => {
    const input = parseBody(ShareCreateRequestSchema, request);
    const row: ShareLinkRow = createShare(ctx, input, options.random);
    return reply.code(201).send(row);
  });

  // Registered before /shares/:token/revoke; find-my-way prefers the static segment anyway.
  app.post("/shares/revoke", (request): ShareRevokeBulkResponse => {
    return { count: revokeShares(ctx, parseBody(ShareRevokeBulkRequestSchema, request)) };
  });

  app.get("/shares/:token", (request): ShareLinkRow => {
    return getShare(ctx, parseParams(TokenParams, request).token);
  });

  app.post("/shares/:token/revoke", (request): ShareLinkRow => {
    return revokeShare(ctx, parseParams(TokenParams, request).token);
  });

  app.delete("/shares/:token", (request, reply) => {
    deleteShare(ctx, parseParams(TokenParams, request).token);
    return reply.code(204).send();
  });
};
