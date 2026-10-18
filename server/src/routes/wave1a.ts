import type { FastifyPluginAsync } from "fastify";
import type { BuildAppDeps } from "../app.ts";
import { accountRoutes } from "./accounts.ts";
import { channelRoutes } from "./channels.ts";
import { locationRoutes } from "./locations.ts";
import { proxyRoutes } from "./proxies.ts";
import type { Wave1ARouteOptions } from "./routeDeps.ts";
import { settingsRoutes } from "./settings.ts";

export type { Wave1ARouteOptions };

/** buildApp deps plus the optional test seams these routes accept. */
export interface Wave1ABuildDeps {
  wave1A?: Wave1ARouteOptions;
}

/** The seams from buildApp's deps, if a test passed any. */
export function wave1AOptions(deps: BuildAppDeps): Wave1ARouteOptions {
  return (deps as BuildAppDeps & Wave1ABuildDeps).wave1A ?? {};
}

/**
 * Accounts and OAuth, locations, proxies, settings and channels, registered
 * under /api by app.ts.
 */
export const wave1ARoutes: FastifyPluginAsync<Wave1ARouteOptions> = async (app, options) => {
  const seams: Wave1ARouteOptions = {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.proxyProbe === undefined ? {} : { proxyProbe: options.proxyProbe }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  await app.register(accountRoutes, seams);
  await app.register(channelRoutes, seams);
  await app.register(locationRoutes);
  await app.register(proxyRoutes, seams);
  await app.register(settingsRoutes);
};
