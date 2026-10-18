import type { FastifyInstance } from "fastify";
import type { FetchLike } from "../domain/deps.ts";
import type { ProxyDeps, ProxyProbe } from "../domain/proxies.ts";
import type { OAuthDeps } from "../youtube/oauth.ts";
import { z } from "zod";

/**
 * Test seams for the account, OAuth, proxy and channel routes. Production
 * passes nothing: the global fetch (also used for Google's JWKS) and
 * undici's proxy agents are used.
 */
export interface Wave1ARouteOptions {
  fetch?: FetchLike;
  proxyProbe?: ProxyProbe;
  now?: () => number;
}

export type RouteDeps = OAuthDeps & ProxyDeps;

export function routeDeps(
  app: FastifyInstance,
  options: Wave1ARouteOptions,
  mod: string,
): RouteDeps {
  const { config, db, log } = app.cellar;
  return {
    config,
    db,
    log: log.child({ mod }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.proxyProbe === undefined ? {} : { proxyProbe: options.proxyProbe }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
}

/** `/:id` for integer-keyed resources. */
export const IntIdParamsSchema = z.object({ id: z.coerce.number().int().positive() });
