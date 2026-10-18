import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.ts";

/**
 * The public share surface, mounted at /s (one of the two prefixes Cloudflare
 * Access bypasses; see security/publicPaths.ts). It owns:
 *
 *   GET /s/assets/*  the share bundle's own files from web/dist/assets (every
 *                    one is named share-*), so the share page can load without
 *                    an Access session. Admin chunks in the same directory
 *                    stay private: they 404 here and load only via /assets
 *                    behind Access.
 *   GET /s, /s/*     the share page. Share links arrive in a later wave; until
 *                    then every token is unknown, so every one gets the same
 *                    404 with web/dist/share.html as the body.
 *
 * Everything here is per-IP rate limited, marked noindex, and never lists a
 * directory. The 404 is uniform: an unknown token, a malformed one and a
 * missing asset all look the same to a caller.
 */

export interface ShareRateLimit {
  max: number;
  /** Milliseconds. */
  timeWindow: number;
}

/** Generous for a person opening a link, tight for a script walking tokens. */
export const SHARE_RATE_LIMIT: ShareRateLimit = { max: 120, timeWindow: 60_000 };

export const ROBOTS_HEADER_VALUE = "noindex, nofollow";

/** Served when web/dist/share.html is absent (tests, API-only dev runs). */
export const FALLBACK_SHARE_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="robots" content="noindex, nofollow"><title>Cellar</title></head>' +
  "<body><p>This link does not exist or has expired.</p></body></html>";

/**
 * True for a share bundle file directly inside web/dist/assets. The web build
 * names every file of the share entry share-* and no admin chunk that way.
 * @fastify/static hands over the path below /s/assets, already normalized.
 */
export function isShareAsset(pathname: string): boolean {
  return /^\/share-[^/\\]+$/.test(pathname);
}

export interface SharePluginOptions {
  config: Pick<Config, "webDistDir">;
  rateLimit?: ShareRateLimit;
}

/**
 * The rate limit key. Behind the Cloudflare tunnel request.ip comes from
 * X-Forwarded-For (trustProxy), whose leftmost entry the client controls, so
 * the edge-set CF-Connecting-IP is preferred. In production the container has
 * no published port and only cloudflared reaches it, and Cloudflare overwrites
 * that header on every request.
 */
export function clientKey(request: FastifyRequest): string {
  const header = request.headers["cf-connecting-ip"];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : request.ip;
}

export const sharePlugin: FastifyPluginAsync<SharePluginOptions> = async (app, options) => {
  const distDir = options.config.webDistDir;
  const sharePage = join(distDir, "share.html");
  // Read once: the bundle is baked into the image and never changes at runtime.
  const notFoundBody = existsSync(sharePage) ? readFileSync(sharePage) : FALLBACK_SHARE_HTML;
  const limit = options.rateLimit ?? SHARE_RATE_LIMIT;

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-robots-tag", ROBOTS_HEADER_VALUE);
    return payload;
  });

  // Registered before any route so its onRoute hook sees every route below.
  await app.register(fastifyRateLimit, {
    global: true,
    max: limit.max,
    timeWindow: limit.timeWindow,
    keyGenerator: clientKey,
    errorResponseBuilder: (_request, context) =>
      Object.assign(new Error(`Too many requests. Retry in ${context.after}.`), {
        statusCode: context.statusCode,
        code: "rate_limited",
      }),
  });

  const assetsDir = join(distDir, "assets");
  if (existsSync(assetsDir)) {
    await app.register(fastifyStatic, {
      root: assetsDir,
      prefix: "/assets/",
      // The SPA's registration owns reply.sendFile.
      decorateReply: false,
      index: false,
      list: false,
      dotfiles: "deny",
      // Anything else in the directory falls through to the uniform 404.
      allowedPath: (pathname) => isShareAsset(pathname),
      // Vite fingerprints every asset, so they are safe to cache hard.
      maxAge: "1y",
      immutable: true,
    });
  }

  const sendUnknown = (reply: FastifyReply): FastifyReply =>
    reply
      .code(404)
      .header("content-type", "text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .send(notFoundBody);

  /**
   * @fastify/static answers a directory, a dotfile and a traversal attempt
   * with a 403. Under /s those must be indistinguishable from an unknown
   * token, so every 4xx except the rate limit becomes the uniform 404 page.
   * Anything else is rethrown to the app's error handler, which owns the 429
   * body and the fixed 5xx message.
   */
  app.setErrorHandler((error, _request, reply) => {
    const status = (error as { statusCode?: unknown } | null)?.statusCode;
    if (typeof status === "number" && status >= 400 && status < 500 && status !== 429) {
      return sendUnknown(reply);
    }
    throw error;
  });

  app.get("/", (_request, reply) => sendUnknown(reply));
  app.get("/*", (_request, reply) => sendUnknown(reply));
  // A missing asset and any non-GET method land here: same page, same headers.
  app.setNotFoundHandler((_request, reply) => sendUnknown(reply));
};
