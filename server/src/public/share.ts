import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { DEFAULT_FILENAME_TEMPLATE, renderFilename } from "@cellar/shared";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.ts";
import { DomainError } from "../domain/errors.ts";
import {
  resolveActiveShare,
  recordShareAccess,
  sharePublicData,
  sharePublicMetadata,
  type ActiveShare,
} from "../domain/shares.ts";
import {
  BEST_THUMBNAIL,
  currentMedia,
  openRangeStream,
  resolveMediaPath,
  thumbnailPath,
  type MediaRecord,
} from "../domain/videoFiles.ts";
import { contentDisposition } from "../routes/videos.ts";
import { PRIVACY_HTML, TOS_HTML } from "./legalPages.ts";

/**
 * The public share surface, mounted at /s (one of the two prefixes Cloudflare
 * Access bypasses; see security/publicPaths.ts). It owns:
 *
 *   GET /s/assets/*  the share bundle's own files from web/dist/assets (every
 *                    one is named share-*), so the share page can load without
 *                    an Access session. Admin chunks in the same directory
 *                    stay private: they 404 here and load only via /assets
 *                    behind Access.
 *   GET /s/:token    share.html with the link's payload injected as
 *                    <script id="share-data" type="application/json">. Each
 *                    GET (not HEAD) counts one access.
 *   GET /s/:token/meta, /video, /audio, /captions/:lang, /thumbnail,
 *                    /metadata.json: that one video's data and files.
 *   GET /s, /s/*     everything else: the uniform 404 (web/dist/share.html).
 *
 * A token is valid iff it is 22 base64url characters, exists, is not revoked
 * and has not expired. Every other case, on the page and on every sub-route,
 * gets the same 404 page with the same headers: an unknown, a malformed, an
 * expired and a revoked token, a valid token's missing file, and a missing
 * asset all look the same to a caller. Everything here is per-IP rate
 * limited, marked noindex, and never lists a directory.
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

export const SHARE_DATA_ID = "share-data";

/** Media of a live link: revalidate each time, so a revoked link stops serving at once. */
const CACHE_MEDIA = "private, no-cache";

/**
 * True for a share bundle file directly inside web/dist/assets. The web build
 * names every file of the share entry share-* and no admin chunk that way.
 * @fastify/static hands over the path below /s/assets, already normalized.
 */
export function isShareAsset(pathname: string): boolean {
  return /^\/share-[^/\\]+$/.test(pathname);
}

/**
 * JSON safe to place inside a <script> element: `</` cannot close it and
 * `<!--` cannot open an HTML comment state. Both stay valid JSON.
 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("</", "<\\/").replaceAll("<!--", "<\\u0021--");
}

/** `html` with the payload script inserted before </head> (or prepended without one). */
export function injectShareData(html: string, data: unknown): string {
  const script = `<script id="${SHARE_DATA_ID}" type="application/json">${scriptJson(data)}</script>`;
  const at = html.indexOf("</head>");
  return at === -1 ? script + html : `${html.slice(0, at)}${script}${html.slice(at)}`;
}

export interface SharePluginOptions {
  config: Pick<Config, "webDistDir">;
  rateLimit?: ShareRateLimit;
  /** Test seam for the clock that decides expiry. */
  now?: () => number;
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

/** Thrown inside a token route to answer with the uniform 404. */
class ShareNotFound extends Error {
  readonly statusCode = 404;
}

const LANG_RE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * The URL holds a bearer token, so token routes log only warnings and errors:
 * no "incoming request" line carries a live link into the log files.
 */
const QUIET = { logLevel: "warn" as const };

export const sharePlugin: FastifyPluginAsync<SharePluginOptions> = async (app, options) => {
  const distDir = options.config.webDistDir;
  const sharePage = join(distDir, "share.html");
  // Read once: the bundle is baked into the image and never changes at runtime.
  const notFoundBody = existsSync(sharePage) ? readFileSync(sharePage) : FALLBACK_SHARE_HTML;
  const pageTemplate = typeof notFoundBody === "string" ? notFoundBody : notFoundBody.toString();
  const limit = options.rateLimit ?? SHARE_RATE_LIMIT;
  const now = options.now ?? Date.now;
  const { db, config } = app.cellar;
  const metaDir = config.metaDir;

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

  /**
   * Always with the body, so content-length is the same for every route. For
   * HEAD, Node's HTTP server never writes a body to the socket, whether
   * Fastify derived the HEAD route from a GET or the route lists HEAD itself.
   */
  const sendUnknown = (reply: FastifyReply): FastifyReply =>
    reply
      .code(404)
      .header("content-type", "text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .send(notFoundBody);

  /**
   * @fastify/static answers a directory, a dotfile and a traversal attempt
   * with a 403, and the domain throws not_found for a missing file. Under /s
   * those must be indistinguishable from an unknown token, so every 4xx
   * except the rate limit becomes the uniform 404 page. Anything else is
   * rethrown to the app's error handler, which owns the 429 body and the
   * fixed 5xx message.
   */
  app.setErrorHandler((error, _request, reply) => {
    const status =
      error instanceof DomainError
        ? error.status
        : (error as { statusCode?: unknown } | null)?.statusCode;
    if (typeof status === "number" && status >= 400 && status < 500 && status !== 429) {
      return sendUnknown(reply);
    }
    throw error;
  });

  // Static legal pages the Google OAuth consent screen links to. They are the
  // only /s paths that answer 200 without a token; they carry no data.
  const sendLegal = (reply: FastifyReply, body: string): FastifyReply =>
    reply
      .code(200)
      .header("content-type", "text/html; charset=utf-8")
      .header("cache-control", "public, max-age=3600")
      .send(body);
  app.get("/privacy", (_request, reply) => sendLegal(reply, PRIVACY_HTML));
  app.get("/tos", (_request, reply) => sendLegal(reply, TOS_HTML));

  /** The live link behind :token, or the uniform 404. */
  const activeShare = (request: FastifyRequest): ActiveShare => {
    const share = resolveActiveShare(db, (request.params as { token?: unknown }).token, now());
    if (share === null) {
      throw new ShareNotFound();
    }
    return share;
  };

  const wantsDownload = (request: FastifyRequest): boolean => {
    const value = (request.query as { download?: unknown } | undefined)?.download;
    return value === "1" || value === "true";
  };

  /**
   * The download name of a shared file, from the title and id only (never the
   * source, which names the owner's lists). `infix` goes before the extension,
   * e.g. the caption language in "Title [id].en.vtt"; it is already safe.
   */
  const downloadName = (
    share: ActiveShare,
    ext: string,
    options: { height?: number | null; infix?: string } = {},
  ): string => {
    const video = db.get<{ title: string | null }>(
      "SELECT title FROM videos WHERE id = ?",
      share.video_id,
    );
    const name = renderFilename(DEFAULT_FILENAME_TEMPLATE, {
      title: video?.title ?? null,
      id: share.video_id,
      ext,
      resolution: options.height ?? null,
    });
    const suffix = `.${ext}`;
    return options.infix === undefined || !name.endsWith(suffix)
      ? name
      : `${name.slice(0, -suffix.length)}.${options.infix}${suffix}`;
  };

  /** A file with Range support; HEAD gets the headers only. */
  const sendFile = (
    request: FastifyRequest,
    reply: FastifyReply,
    path: string,
    headers: Record<string, string>,
  ): FastifyReply => {
    const result = openRangeStream(path, request.headers.range, {
      head: request.method === "HEAD",
    });
    void reply.code(result.status).headers({
      ...result.headers,
      ...headers,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    return result.stream === null ? reply.send() : reply.send(result.stream);
  };

  const sendMedia = (
    request: FastifyRequest,
    reply: FastifyReply,
    share: ActiveShare,
    media: MediaRecord | undefined,
  ): FastifyReply => {
    if (media === undefined) {
      throw new ShareNotFound();
    }
    const path = resolveMediaPath(db, metaDir, media);
    const headers: Record<string, string> = { "cache-control": CACHE_MEDIA };
    if (wantsDownload(request)) {
      const name = downloadName(share, extname(media.rel_path).slice(1), {
        height: media.height,
      });
      headers["content-disposition"] = contentDisposition("attachment", name);
    }
    return sendFile(request, reply, path, headers);
  };

  app.get("/:token", QUIET, (request, reply) => {
    const share = activeShare(request);
    const html = injectShareData(pageTemplate, sharePublicData(db, metaDir, share));
    // A page view is a GET; HEAD (served by the same handler) does not count.
    if (request.method === "GET") {
      recordShareAccess(db, share.token, now());
    }
    return reply
      .code(200)
      .header("content-type", "text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .header("referrer-policy", "no-referrer")
      .send(html);
  });

  app.get("/:token/meta", QUIET, (request, reply) => {
    const share = activeShare(request);
    return reply.header("cache-control", "no-store").send(sharePublicData(db, metaDir, share));
  });

  app.route({
    ...QUIET,
    method: ["GET", "HEAD"],
    url: "/:token/video",
    handler: (request, reply) => {
      const share = activeShare(request);
      return sendMedia(request, reply, share, currentMedia(db, share.video_id, "video"));
    },
  });

  app.route({
    ...QUIET,
    method: ["GET", "HEAD"],
    url: "/:token/audio",
    handler: (request, reply) => {
      const share = activeShare(request);
      return sendMedia(request, reply, share, currentMedia(db, share.video_id, "audio"));
    },
  });

  app.route({
    ...QUIET,
    method: ["GET", "HEAD"],
    url: "/:token/captions/:lang",
    handler: (request, reply) => {
      const share = activeShare(request);
      const { lang } = request.params as { lang: string };
      if (!LANG_RE.test(lang)) {
        throw new ShareNotFound();
      }
      const media = currentMedia(db, share.video_id, "captions", lang);
      if (media === undefined) {
        throw new ShareNotFound();
      }
      const headers: Record<string, string> = {
        "content-type": "text/vtt; charset=utf-8",
        "cache-control": CACHE_MEDIA,
      };
      if (wantsDownload(request)) {
        headers["content-disposition"] = contentDisposition(
          "attachment",
          downloadName(share, "vtt", { infix: lang }),
        );
      }
      return sendFile(request, reply, resolveMediaPath(db, metaDir, media), headers);
    },
  });

  app.route({
    ...QUIET,
    method: ["GET", "HEAD"],
    url: "/:token/thumbnail",
    handler: (request, reply) => {
      const share = activeShare(request);
      const thumb = thumbnailPath(db, metaDir, share.video_id, BEST_THUMBNAIL);
      if (thumb === undefined) {
        throw new ShareNotFound();
      }
      return sendFile(request, reply, thumb.path, {
        "content-type": "image/jpeg",
        "cache-control": CACHE_MEDIA,
      });
    },
  });

  app.get("/:token/metadata.json", QUIET, (request, reply) => {
    const share = activeShare(request);
    const body = `${JSON.stringify(sharePublicMetadata(db, metaDir, share.video_id), null, 2)}\n`;
    void reply
      .code(200)
      .header("content-type", "application/json; charset=utf-8")
      .header("cache-control", "no-store")
      .header("x-content-type-options", "nosniff");
    if (wantsDownload(request)) {
      void reply.header(
        "content-disposition",
        contentDisposition("attachment", downloadName(share, "json", { infix: "info" })),
      );
    }
    return reply.send(body);
  });

  app.get("/", QUIET, (_request, reply) => sendUnknown(reply));
  app.get("/*", QUIET, (_request, reply) => sendUnknown(reply));
  // A missing asset and any non-GET method land here: same page, same headers.
  app.setNotFoundHandler((_request, reply) => sendUnknown(reply));
};
