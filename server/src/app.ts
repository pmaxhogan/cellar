import type { IncomingMessage, ServerResponse } from "node:http";
import Fastify, { type FastifyInstance, type RawServerDefault } from "fastify";
import type { Logger } from "pino";
import type { Config } from "./config.ts";
import type { Db } from "./db/db.ts";
import { EventBus } from "./events.ts";
import { sharePlugin, type ShareRateLimit } from "./public/share.ts";
import { apiRoutes } from "./routes/index.ts";
import { toApiError } from "./routes/validate.ts";
import { wave1bRoutes } from "./routes/wave1b.ts"; // wave1B
import { videoRoutes } from "./routes/videos.ts"; // wave2C
import { cfAccessPlugin, type CfAccessKeyGetter } from "./security/cfAccess.ts";
import { APP_VERSION } from "./version.ts";
import { webPlugin } from "./web.ts";

/** Everything a route plugin needs. Decorated onto the Fastify instance. */
export interface AppContext {
  config: Config;
  log: Logger;
  db: Db;
  events: EventBus;
  version: string;
  /** Epoch ms the process started, reported by /api/status. */
  startedAt: number;
}

export interface BuildAppDeps {
  config: Config;
  log: Logger;
  db: Db;
  events?: EventBus;
  version?: string;
  startedAt?: number;
  /** Test seam for the CF Access JWKS. Omitted in production. */
  cfAccessGetKey?: CfAccessKeyGetter;
  /** Test seam for the /s rate limit. Omitted in production. */
  shareRateLimit?: ShareRateLimit;
}

declare module "fastify" {
  interface FastifyInstance {
    cellar: AppContext;
  }
}

/** The Fastify instance shape once the pino logger instance is attached. */
export type CellarApp = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  Logger
>;

export const INSECURE_BANNER =
  "INSECURE_ALLOW_PUBLIC_ACCESS is set: authentication is disabled and the server " +
  "is bound to 127.0.0.1 only. Never expose this port.";

/**
 * Build the Fastify instance. Exported separately from index.ts so tests can
 * drive it with app.inject() without binding a port.
 */
export async function buildApp(deps: BuildAppDeps): Promise<CellarApp> {
  const ctx: AppContext = {
    config: deps.config,
    log: deps.log,
    db: deps.db,
    events: deps.events ?? new EventBus(),
    version: deps.version ?? APP_VERSION,
    startedAt: deps.startedAt ?? Date.now(),
  };

  const app = Fastify({
    loggerInstance: deps.log,
    trustProxy: true,
  });

  app.decorate("cellar", ctx);

  if (ctx.config.insecureMode) {
    deps.log.warn(INSECURE_BANNER);
  }

  /**
   * The one translation point from thrown errors to the shared ApiError shape,
   * for every route. A 5xx answers with a fixed message and the real error
   * goes to the log only.
   */
  app.setErrorHandler((error, request, reply) => {
    const { status, body } = toApiError(error);
    if (status >= 500) {
      request.log.error({ err: error }, "unhandled route error");
    } else {
      request.log.debug({ err: error, status }, "request rejected");
    }
    void reply.code(status).send(body);
  });

  // Unauthenticated by design: the docker healthcheck uses it.
  app.get("/healthz", () => ({ ok: true, version: ctx.version }));

  // No-op in insecure mode; otherwise guards everything except /healthz and /s/*.
  await app.register(cfAccessPlugin, {
    config: ctx.config,
    ...(deps.cfAccessGetKey === undefined ? {} : { getKey: deps.cfAccessGetKey }),
  });

  await app.register(apiRoutes, { prefix: "/api" });
  // --- wave1B routes ---
  await app.register(wave1bRoutes, { prefix: "/api" });
  // --- end wave1B routes ---
  // --- wave2C routes ---
  // trashVideos (rules domain) and the download/recheck handlers are wired in at merge.
  await app.register(videoRoutes, { prefix: "/api" });
  // --- end wave2C routes ---
  await app.register(sharePlugin, {
    prefix: "/s",
    config: ctx.config,
    ...(deps.shareRateLimit === undefined ? {} : { rateLimit: deps.shareRateLimit }),
  });
  // Last, so its catch-all fallback cannot shadow a real route.
  await app.register(webPlugin, { config: ctx.config });

  return app;
}
