import type { ResolvedSettings } from "@cellar/shared";
import type { FastifyPluginAsync } from "fastify";
import type { JobRegistry } from "../jobs/types.ts";
import { jobRoutes } from "./jobs.ts";
import { notificationRoutes } from "./notifications.ts";

export interface Wave1bRoutesOptions {
  /** Defaults to the process-wide jobRegistry. */
  registry?: JobRegistry;
  /** Defaults to the registry defaults until the settings domain is wired in. */
  getSettings?: () => ResolvedSettings;
}

/** Jobs, activity, actions and notifications, mounted under /api by app.ts. */
export const wave1bRoutes: FastifyPluginAsync<Wave1bRoutesOptions> = async (app, options) => {
  await app.register(jobRoutes, {
    ...(options.registry === undefined ? {} : { registry: options.registry }),
  });
  await app.register(notificationRoutes, {
    ...(options.getSettings === undefined ? {} : { getSettings: options.getSettings }),
  });
};
