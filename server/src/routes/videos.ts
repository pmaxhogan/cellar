import {
  BulkDownloadEstimateRequestSchema,
  BulkDownloadRequestSchema,
  DEFAULT_FILENAME_TEMPLATE,
  renderFilename,
  resolveSettings,
  THUMBNAIL_VARIANTS,
  TitleChangesQuerySchema,
  TrashRequestSchema,
  VIDEO_ID_RE,
  VideoHistoryQuerySchema,
  VideosListQuerySchema,
  VideoStatsQuerySchema,
  type ApiError,
  type BulkDownloadEstimate,
  type ResolvedSettings,
  type TitleChangesResponse,
  type TrashResponse,
  type VideoDetail,
  type VideoHistoryResponse,
  type VideoJobResponse,
  type VideosListResponse,
  type VideoStatsResponse,
} from "@cellar/shared";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { extname } from "node:path";
import { z } from "zod";
import type { Db } from "../db/db.ts";
import {
  bulkArchiveName,
  bulkZipPlan,
  estimateBulk,
  loadVideos,
  planBulkFiles,
  videoFilenameFields,
  zipStream,
  ZIP_LIMITS,
  type ZipLimits,
} from "../domain/bulk.ts";
import { notFound } from "../domain/errors.ts";
import {
  BEST_THUMBNAIL,
  currentMedia,
  getMediaRecord,
  openRangeStream,
  resolveMediaPath,
  thumbnailPath,
} from "../domain/videoFiles.ts";
import {
  getVideo,
  listTitleChanges,
  listVideos,
  videoExists,
  videoHistory,
  videoStats,
} from "../domain/videos.ts";
import { JobQueue } from "../jobs/queue.ts";
import { jobRegistry, type JobRegistry } from "../jobs/types.ts";
import { parseBody, parseParams, parseQuery } from "./validate.ts";

/**
 * /api/videos: the catalog list and detail, history and stats, file streaming
 * (media with HTTP Range, captions, thumbnails, metadata), the per-video job
 * triggers, trash and bulk download, plus /api/title-changes (title history
 * across every video). Everything here sits behind Access.
 */

/** Job types this module enqueues. Their handlers live with the media and recheck code. */
export const DOWNLOAD_JOB = "download";
export const RECHECK_JOB = "recheck_batch";

/** What the routes need from modules that are wired in at boot. */
export interface VideoRoutesDeps {
  /**
   * Trash a selection: per-video override rule with reclaim priority 0 plus an
   * immediate pri-0 sweep (owned by the rules domain). Resolves to the number
   * of videos trashed. Absent: POST /videos/trash answers 501.
   */
  trashVideos?: (ids: string[]) => number | Promise<number>;
  /** Defaults to the process-wide jobRegistry. */
  registry?: JobRegistry;
  /** Defaults to the stored settings overlaid on the registry defaults. */
  getSettings?: () => ResolvedSettings;
  /** Test seam for the ZIP64 thresholds. */
  zipLimits?: ZipLimits;
  /** Test seam for the archive name and entry times. */
  now?: () => Date;
}

const IdParams = z.object({ id: z.string().regex(VIDEO_ID_RE, "Not a video id.") });
const MediaParams = IdParams.extend({ mediaId: z.coerce.number().int().positive() });
const CaptionParams = IdParams.extend({
  lang: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, "Not a language code."),
});
const ThumbnailParams = IdParams.extend({
  variant: z.enum([...THUMBNAIL_VARIANTS, BEST_THUMBNAIL]),
});
const ThumbnailQuery = z.object({
  sha: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .optional(),
});
const DownloadQuery = z.object({
  download: z
    .enum(["1", "0", "true", "false"])
    .transform((value) => value === "1" || value === "true")
    .optional(),
});

/** Year-long cache for content addressed URLs, a day for the moving "latest" ones. */
const CACHE_IMMUTABLE = "private, max-age=31536000, immutable";
const CACHE_DAY = "private, max-age=86400";
const CACHE_MEDIA = "private, no-cache";

/** RFC 6266 / 8187: an ASCII fallback plus the exact UTF-8 name. */
export function contentDisposition(type: "attachment" | "inline", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** The stored sparse settings overlaid on the defaults; a malformed row is ignored. */
export function readStoredSettings(db: Db): ResolvedSettings {
  const sparse: Record<string, unknown> = {};
  for (const row of db.all<{ key: string; value_json: string }>(
    "SELECT key, value_json FROM settings",
  )) {
    try {
      sparse[row.key] = JSON.parse(row.value_json) as unknown;
    } catch {
      // resolveSettings falls back to the default for a key it cannot read.
    }
  }
  return resolveSettings(sparse);
}

function notImplemented(reply: FastifyReply, what: string): FastifyReply {
  const body: ApiError = { error: `${what} is not available yet.`, code: "not_implemented" };
  return reply.code(501).send(body);
}

/** Parse application/x-www-form-urlencoded into a record; repeated keys become arrays. */
function parseForm(body: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of new URLSearchParams(body)) {
    const previous = out[key];
    out[key] =
      previous === undefined
        ? value
        : Array.isArray(previous)
          ? [...previous, value]
          : [previous, value];
  }
  return out;
}

export const videoRoutes: FastifyPluginAsync<VideoRoutesDeps> = async (app, options) => {
  const { db, events, config } = app.cellar;
  const registry = options.registry ?? jobRegistry;
  const queue = new JobQueue(db, { registry, events });
  const getSettings = options.getSettings ?? (() => readStoredSettings(db));
  const zipLimits = options.zipLimits ?? ZIP_LIMITS;
  const now = options.now ?? (() => new Date());
  const metaDir = config.metaDir;

  // A plain HTML form post is the one way a browser can stream a large ZIP
  // straight to disk, so bulk download accepts form bodies as well as JSON.
  // A root level parser (e.g. @fastify/formbody) is inherited and kept.
  const FORM = "application/x-www-form-urlencoded";
  if (!app.hasContentTypeParser(FORM)) {
    app.addContentTypeParser(
      FORM,
      { parseAs: "string", bodyLimit: 1024 * 1024 },
      (_request, body, done) => {
        done(null, parseForm(String(body)));
      },
    );
  }

  const requireVideo = (id: string): void => {
    if (!videoExists(db, id)) {
      throw notFound("Video", id);
    }
  };

  /** Send a file with Range support; HEAD gets the headers only. */
  const sendFile = (
    request: FastifyRequest,
    reply: FastifyReply,
    path: string,
    headers: Record<string, string>,
  ): FastifyReply => {
    const result = openRangeStream(path, request.headers.range, {
      head: request.method === "HEAD",
    });
    void reply
      .code(result.status)
      .headers({ ...result.headers, ...headers, "x-content-type-options": "nosniff" });
    return result.stream === null ? reply.send() : reply.send(result.stream);
  };

  app.get("/videos", (request): VideosListResponse => {
    return listVideos(db, parseQuery(VideosListQuerySchema, request));
  });

  app.get("/title-changes", (request): TitleChangesResponse => {
    return listTitleChanges(db, parseQuery(TitleChangesQuerySchema, request));
  });

  app.post("/videos/trash", async (request, reply) => {
    const { ids } = parseBody(TrashRequestSchema, request);
    if (options.trashVideos === undefined) {
      return notImplemented(reply, "Trash");
    }
    const count = await options.trashVideos(ids);
    const body: TrashResponse = { count };
    return reply.code(202).send(body);
  });

  app.post("/videos/bulk-download/estimate", (request): BulkDownloadEstimate => {
    const input = parseBody(BulkDownloadEstimateRequestSchema, request);
    const files = planBulkFiles(db, metaDir, input);
    return estimateBulk(files, getSettings()["bulk.warn_gb"]);
  });

  app.post("/videos/bulk-download", (request, reply) => {
    const input = parseBody(BulkDownloadRequestSchema, request);
    const files = planBulkFiles(db, metaDir, input);
    const plan = bulkZipPlan(files, zipLimits);
    const at = now();
    request.log.info(
      { videos: input.ids.length, files: files.length, bytes: plan.total, kind: input.kind },
      "bulk download",
    );
    void reply.code(200).headers({
      "content-type": "application/zip",
      "content-length": String(plan.total),
      "content-disposition": contentDisposition("attachment", bulkArchiveName(at)),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    return reply.send(zipStream(plan, at));
  });

  app.get("/videos/:id", (request): VideoDetail => {
    const { id } = parseParams(IdParams, request);
    return getVideo(db, id);
  });

  app.get("/videos/:id/history", (request): VideoHistoryResponse => {
    const { id } = parseParams(IdParams, request);
    return videoHistory(db, id, parseQuery(VideoHistoryQuerySchema, request));
  });

  app.get("/videos/:id/stats", (request): VideoStatsResponse => {
    const { id } = parseParams(IdParams, request);
    return { points: videoStats(db, id, parseQuery(VideoStatsQuerySchema, request)) };
  });

  app.route({
    method: ["GET", "HEAD"],
    url: "/videos/:id/media/:mediaId",
    handler: (request, reply) => {
      const { id, mediaId } = parseParams(MediaParams, request);
      const { download } = parseQuery(DownloadQuery, request);
      const media = getMediaRecord(db, id, mediaId);
      const path = resolveMediaPath(db, metaDir, media);
      const headers: Record<string, string> = { "cache-control": CACHE_MEDIA };
      if (download === true) {
        const video = loadVideos(db, [id]).get(id);
        const ext = extname(media.rel_path).slice(1);
        const name = renderFilename(DEFAULT_FILENAME_TEMPLATE, {
          ...(video === undefined ? { id } : videoFilenameFields(video)),
          ext,
          resolution: media.height,
        });
        headers["content-disposition"] = contentDisposition("attachment", name);
      }
      return sendFile(request, reply, path, headers);
    },
  });

  app.route({
    method: ["GET", "HEAD"],
    url: "/videos/:id/captions/:lang",
    handler: (request, reply) => {
      const { id, lang } = parseParams(CaptionParams, request);
      const media = currentMedia(db, id, "captions", lang);
      if (media === undefined) {
        throw notFound("Captions", lang);
      }
      return sendFile(request, reply, resolveMediaPath(db, metaDir, media), {
        "content-type": "text/vtt; charset=utf-8",
        "cache-control": CACHE_MEDIA,
      });
    },
  });

  app.route({
    method: ["GET", "HEAD"],
    url: "/videos/:id/thumbnail/:variant",
    handler: (request, reply) => {
      const { id, variant } = parseParams(ThumbnailParams, request);
      const { sha } = parseQuery(ThumbnailQuery, request);
      const thumb = thumbnailPath(db, metaDir, id, variant, sha);
      if (thumb === undefined) {
        throw notFound("Thumbnail", variant);
      }
      return sendFile(request, reply, thumb.path, {
        "content-type": "image/jpeg",
        "cache-control": sha === undefined ? CACHE_DAY : CACHE_IMMUTABLE,
      });
    },
  });

  app.get("/videos/:id/metadata.json", (request, reply) => {
    const { id } = parseParams(IdParams, request);
    requireVideo(id);
    const info = currentMedia(db, id, "info");
    if (info !== undefined) {
      try {
        return sendFile(request, reply, resolveMediaPath(db, metaDir, info), {
          "content-type": "application/json; charset=utf-8",
          "cache-control": CACHE_MEDIA,
        });
      } catch (error) {
        request.log.warn({ err: error, videoId: id }, "stored info.json unreadable");
      }
    }
    return reply.header("cache-control", CACHE_MEDIA).send(getVideo(db, id));
  });

  const enqueue =
    (type: string, what: string) => (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = parseParams(IdParams, request);
      requireVideo(id);
      if (!registry.has(type)) {
        return notImplemented(reply, what);
      }
      const job = queue.enqueue({
        type,
        videoId: id,
        payload: { video_ids: [id], manual: true },
        priority: 20,
        dedupe: true,
      });
      const body: VideoJobResponse = { job_id: job.id, deduped: job.deduped };
      return reply.code(202).send(body);
    };

  app.post("/videos/:id/download-now", enqueue(DOWNLOAD_JOB, "Download"));
  app.post("/videos/:id/recheck", enqueue(RECHECK_JOB, "Recheck"));
};
