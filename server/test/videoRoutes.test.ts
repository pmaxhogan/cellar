import {
  ApiErrorSchema,
  BulkDownloadEstimateSchema,
  TrashResponseSchema,
  VideoDetailSchema,
  VideoHistoryResponseSchema,
  VideoJobResponseSchema,
  VideosListResponseSchema,
  VideoStatsResponseSchema,
} from "@cellar/shared";
import AdmZip from "adm-zip";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyVideoDiff } from "../src/domain/videos.ts";
import { JobRegistry } from "../src/jobs/types.ts";
import { toApiError } from "../src/routes/validate.ts";
import {
  contentDisposition,
  readStoredSettings,
  videoRoutes,
  type VideoRoutesDeps,
} from "../src/routes/videos.ts";
import { invalidateSettingsCache } from "../src/domain/settings.ts";
import { createTempApp, type TempApp } from "./helpers.ts";
import {
  seedChannel,
  seedLocation,
  seedMedia,
  seedThumbnail,
  seedVideo,
  T0,
  vid,
} from "./videoSeed.ts";
import { readZip } from "./zipReader.ts";

const CAFE = `Caf${String.fromCodePoint(0xe9)} au lait`;
const A = vid("alpha");
const B = vid("beta");

let temp: TempApp;
let bare: FastifyInstance | undefined;
let ids: { video: number; audio: number; captions: number; escape: number; info: number };

const noop = async (): Promise<void> => {};

/** The routes on their own Fastify instance, with injectable deps. */
async function withDeps(deps: VideoRoutesDeps): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorate("cellar", temp.app.cellar);
  app.setErrorHandler((error, _request, reply) => {
    const { status, body } = toApiError(error);
    void reply.code(status).send(body);
  });
  await app.register(videoRoutes, { prefix: "/api", ...deps });
  await app.ready();
  bare = app;
  return app;
}

beforeEach(async () => {
  temp = await createTempApp();
  const { db, config } = temp;
  const media = join(temp.dir, "media");
  mkdirSync(join(media, "UCc", A), { recursive: true });
  mkdirSync(join(config.metaDir, "UCc", A, "thumbnails"), { recursive: true });
  writeFileSync(join(media, "UCc", A, `${A}.webm`), "0123456789");
  writeFileSync(join(media, "UCc", A, `${A}.m4a`), "audio");
  writeFileSync(join(config.metaDir, "UCc", A, "en.vtt"), "WEBVTT\n");
  writeFileSync(join(config.metaDir, "UCc", A, "info.json"), '{"stored":true}');
  writeFileSync(join(config.metaDir, "UCc", A, "thumbnails", "hq-1.jpg"), "JPEG-HQ");
  writeFileSync(join(config.metaDir, "UCc", A, "thumbnails", "max-1.jpg"), "JPEG-MAX");
  const loc = seedLocation(db, "disk", media);
  seedChannel(db, "UCc", "Chan");
  seedVideo(db, {
    id: A,
    channel_id: "UCc",
    title: CAFE,
    privacy: "public",
    upload_date: Date.UTC(2026, 1, 3),
    views: 10,
  });
  seedVideo(db, { id: B, title: "Second" });
  ids = {
    video: seedMedia(db, {
      video_id: A,
      kind: "video",
      rel_path: `UCc/${A}/${A}.webm`,
      location_id: loc,
      size_bytes: 10,
      height: 720,
    }),
    audio: seedMedia(db, {
      video_id: A,
      kind: "audio",
      rel_path: `UCc/${A}/${A}.m4a`,
      location_id: loc,
      size_bytes: 5,
    }),
    captions: seedMedia(db, {
      video_id: A,
      kind: "captions",
      rel_path: `UCc/${A}/en.vtt`,
      lang: "en",
    }),
    escape: seedMedia(db, {
      video_id: A,
      kind: "video",
      rel_path: "../../outside.webm",
      location_id: loc,
      is_current: 0,
      version: 0,
    }),
    info: seedMedia(db, { video_id: A, kind: "info", rel_path: `UCc/${A}/info.json` }),
  };
  seedThumbnail(db, A, "hqdefault", "h1", `UCc/${A}/thumbnails/hq-1.jpg`, T0);
  seedThumbnail(db, A, "maxresdefault", "m1", `UCc/${A}/thumbnails/max-1.jpg`, T0);
});

afterEach(async () => {
  await bare?.close();
  bare = undefined;
  await temp.close();
});

describe("GET /api/videos", () => {
  it("lists with filters and search", async () => {
    const res = await temp.app.inject({ method: "GET", url: "/api/videos?perPage=25" });
    expect(res.statusCode).toBe(200);
    const body = VideosListResponseSchema.parse(res.json());
    expect(body.rows.map((row) => row.id)).toEqual([A, B]);
    expect(body.rows[0]).toMatchObject({
      downloaded: true,
      media_size_bytes: 15,
      thumbnail_url: `/api/videos/${A}/thumbnail/maxresdefault?sha=m1`,
    });

    const search = await temp.app.inject({
      method: "GET",
      url: `/api/videos?q=${encodeURIComponent("cafe au")}&downloaded=true&status=public,unlisted`,
    });
    expect(VideosListResponseSchema.parse(search.json()).rows.map((row) => row.id)).toEqual([A]);
  });

  it("rejects a bad query with a 400 naming the field", async () => {
    const res = await temp.app.inject({ method: "GET", url: "/api/videos?perPage=7&sort=nope" });
    expect(res.statusCode).toBe(400);
    const body = ApiErrorSchema.parse(res.json());
    expect(body.code).toBe("invalid");
    expect(Object.keys((body.details as { fields: object }).fields).sort()).toEqual([
      "perPage",
      "sort",
    ]);
  });
});

describe("GET /api/videos/:id and history, stats", () => {
  it("returns the detail, 404 for unknown and 400 for a malformed id", async () => {
    const res = await temp.app.inject({ method: "GET", url: `/api/videos/${A}` });
    expect(res.statusCode).toBe(200);
    const detail = VideoDetailSchema.parse(res.json());
    expect(detail.captions).toEqual([{ lang: "en", media_id: ids.captions }]);
    expect(detail.channel_title).toBe("Chan");
    expect(
      (await temp.app.inject({ method: "GET", url: `/api/videos/${vid("zz")}` })).statusCode,
    ).toBe(404);
    expect((await temp.app.inject({ method: "GET", url: "/api/videos/short" })).statusCode).toBe(
      400,
    );
  });

  it("serves history and stats", async () => {
    applyVideoDiff(temp.db, A, { views: 20, title: "Renamed" }, { seenAt: T0 + 1, recheckId: 4 });
    const history = await temp.app.inject({
      method: "GET",
      url: `/api/videos/${A}/history?perPage=1`,
    });
    const page = VideoHistoryResponseSchema.parse(history.json());
    expect(page.total).toBe(2);
    expect(page.rows).toHaveLength(1);
    const stats = await temp.app.inject({
      method: "GET",
      url: `/api/videos/${A}/stats?from=2025-12-31&to=${String(T0 + 10)}`,
    });
    expect(VideoStatsResponseSchema.parse(stats.json()).points).toEqual([
      { at: T0 + 1, views: 20, likes: null, comments: null, ryd_dislikes: null },
    ]);
    const missing = await temp.app.inject({ method: "GET", url: `/api/videos/${vid("x")}/stats` });
    expect(missing.statusCode).toBe(404);
  });
});

describe("file routes", () => {
  it("streams media with Range support", async () => {
    const url = `/api/videos/${A}/media/${String(ids.video)}`;
    const full = await temp.app.inject({ method: "GET", url });
    expect(full.statusCode).toBe(200);
    expect(full.body).toBe("0123456789");
    expect(full.headers).toMatchObject({
      "content-type": "video/webm",
      "accept-ranges": "bytes",
      "content-length": "10",
      "cache-control": "private, no-cache",
      "x-content-type-options": "nosniff",
    });
    expect(full.headers["content-disposition"]).toBeUndefined();
    const inline = await temp.app.inject({ method: "GET", url: `${url}?download=0` });
    expect(inline.headers["content-disposition"]).toBeUndefined();

    const part = await temp.app.inject({ method: "GET", url, headers: { range: "bytes=3-5" } });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe("345");
    expect(part.headers["content-range"]).toBe("bytes 3-5/10");
    expect(part.headers["content-length"]).toBe("3");

    const tail = await temp.app.inject({ method: "GET", url, headers: { range: "bytes=-2" } });
    expect(tail.body).toBe("89");

    const bad = await temp.app.inject({ method: "GET", url, headers: { range: "bytes=99-" } });
    expect(bad.statusCode).toBe(416);
    expect(bad.headers["content-range"]).toBe("bytes */10");
  });

  it("answers HEAD with the headers only", async () => {
    const url = `/api/videos/${A}/media/${String(ids.video)}`;
    const head = await temp.app.inject({ method: "HEAD", url });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe("");
    expect(head.headers["content-length"]).toBe("10");
    expect(head.headers["accept-ranges"]).toBe("bytes");
    const ranged = await temp.app.inject({ method: "HEAD", url, headers: { range: "bytes=0-3" } });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers["content-length"]).toBe("4");
  });

  it("adds a template filename on ?download=1", async () => {
    const res = await temp.app.inject({
      method: "GET",
      url: `/api/videos/${A}/media/${String(ids.audio)}?download=1`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("audio/mp4");
    const name = `${CAFE} [${A}].m4a`;
    expect(res.headers["content-disposition"]).toBe(contentDisposition("attachment", name));
    expect(res.headers["content-disposition"]).toContain(`filename="Caf_ au lait [${A}].m4a"`);
    expect(res.headers["content-disposition"]).toContain("filename*=UTF-8''Caf%C3%A9%20au%20lait");
  });

  it("refuses media of another video, an escaping path and a missing file", async () => {
    const other = await temp.app.inject({
      method: "GET",
      url: `/api/videos/${B}/media/${String(ids.video)}`,
    });
    expect(other.statusCode).toBe(404);
    const escape = await temp.app.inject({
      method: "GET",
      url: `/api/videos/${A}/media/${String(ids.escape)}`,
    });
    expect(escape.statusCode).toBe(404);
    expect(escape.json()).toEqual({ error: "The file is not available.", code: "not_found" });
    const gone = seedMedia(temp.db, { video_id: B, kind: "video", rel_path: "missing.webm" });
    const missing = await temp.app.inject({
      method: "GET",
      url: `/api/videos/${B}/media/${String(gone)}`,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("serves captions as WebVTT", async () => {
    const res = await temp.app.inject({ method: "GET", url: `/api/videos/${A}/captions/en` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/vtt; charset=utf-8");
    expect(res.body).toBe("WEBVTT\n");
    expect(
      (await temp.app.inject({ method: "GET", url: `/api/videos/${A}/captions/fr` })).statusCode,
    ).toBe(404);
    expect(
      (await temp.app.inject({ method: "GET", url: `/api/videos/${A}/captions/e.n` })).statusCode,
    ).toBe(400);
  });

  it("serves thumbnails with fallback and cache headers", async () => {
    const best = await temp.app.inject({ method: "GET", url: `/api/videos/${A}/thumbnail/best` });
    expect(best.statusCode).toBe(200);
    expect(best.body).toBe("JPEG-MAX");
    expect(best.headers["content-type"]).toBe("image/jpeg");
    expect(best.headers["cache-control"]).toBe("private, max-age=86400");
    const fallback = await temp.app.inject({
      method: "GET",
      url: `/api/videos/${A}/thumbnail/sddefault`,
    });
    expect(fallback.body).toBe("JPEG-MAX");
    const pinned = await temp.app.inject({
      method: "GET",
      url: `/api/videos/${A}/thumbnail/hqdefault?sha=h1`,
    });
    expect(pinned.body).toBe("JPEG-HQ");
    expect(pinned.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(
      (await temp.app.inject({ method: "GET", url: `/api/videos/${B}/thumbnail/best` })).statusCode,
    ).toBe(404);
    expect(
      (await temp.app.inject({ method: "GET", url: `/api/videos/${A}/thumbnail/huge` })).statusCode,
    ).toBe(400);
  });

  it("serves the stored info.json, else the detail row", async () => {
    const stored = await temp.app.inject({ method: "GET", url: `/api/videos/${A}/metadata.json` });
    expect(stored.statusCode).toBe(200);
    expect(stored.json()).toEqual({ stored: true });
    const generated = await temp.app.inject({
      method: "GET",
      url: `/api/videos/${B}/metadata.json`,
    });
    expect(VideoDetailSchema.parse(generated.json()).id).toBe(B);
    // An info row whose file is gone falls back too.
    seedMedia(temp.db, { video_id: B, kind: "info", rel_path: "nope/info.json" });
    const fallback = await temp.app.inject({
      method: "GET",
      url: `/api/videos/${B}/metadata.json`,
    });
    expect(fallback.json()).toMatchObject({ id: B });
    expect(
      (await temp.app.inject({ method: "GET", url: `/api/videos/${vid("q")}/metadata.json` }))
        .statusCode,
    ).toBe(404);
  });
});

describe("job triggers", () => {
  it("answers 501 while no handler is registered", async () => {
    for (const action of ["download-now", "recheck"]) {
      const res = await temp.app.inject({ method: "POST", url: `/api/videos/${A}/${action}` });
      expect(res.statusCode).toBe(501);
      expect(res.json()).toMatchObject({ code: "not_implemented" });
    }
    const unknown = await temp.app.inject({
      method: "POST",
      url: `/api/videos/${vid("q")}/recheck`,
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("enqueues typed, deduped jobs when a handler exists", async () => {
    const registry = new JobRegistry();
    registry.register("download", { class: "download", handler: noop });
    registry.register("recheck", { class: "io", handler: noop });
    const app = await withDeps({ registry });
    const first = await app.inject({ method: "POST", url: `/api/videos/${A}/download-now` });
    expect(first.statusCode).toBe(202);
    const job = VideoJobResponseSchema.parse(first.json());
    expect(job.deduped).toBe(false);
    const again = await app.inject({ method: "POST", url: `/api/videos/${A}/download-now` });
    expect(VideoJobResponseSchema.parse(again.json())).toEqual({
      job_id: job.job_id,
      deduped: true,
    });
    const recheck = await app.inject({ method: "POST", url: `/api/videos/${A}/recheck` });
    expect(recheck.statusCode).toBe(202);
    expect(
      temp.db.all("SELECT type, video_id, priority, payload_json FROM jobs ORDER BY id"),
    ).toEqual([
      {
        type: "download",
        video_id: A,
        priority: 20,
        payload_json: JSON.stringify({ video_ids: [A], manual: true }),
      },
      {
        type: "recheck",
        video_id: A,
        priority: 20,
        payload_json: JSON.stringify({ video_ids: [A], manual: true }),
      },
    ]);
  });
});

describe("POST /api/videos/trash", () => {
  it("is wired to the rules domain in the real app and answers 202 with the count", async () => {
    const res = await temp.app.inject({
      method: "POST",
      url: "/api/videos/trash",
      payload: { ids: [A] },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ count: 1 });
    const rule = temp.db.get<{ effects_json: string }>(
      "SELECT effects_json FROM rules WHERE kind = 'video' AND video_id = ?",
      A,
    );
    expect(JSON.parse(rule?.effects_json ?? "{}")).toMatchObject({ reclaim_priority: 0 });
  });

  it("delegates the deduped ids and answers 202 with the count", async () => {
    const trashVideos = vi.fn(async (list: string[]) => list.length);
    const app = await withDeps({ trashVideos });
    const res = await app.inject({
      method: "POST",
      url: "/api/videos/trash",
      payload: { ids: [A, B, A] },
    });
    expect(res.statusCode).toBe(202);
    expect(TrashResponseSchema.parse(res.json())).toEqual({ count: 2 });
    expect(trashVideos).toHaveBeenCalledWith([A, B]);
    const bad = await app.inject({
      method: "POST",
      url: "/api/videos/trash",
      payload: { ids: [] },
    });
    expect(bad.statusCode).toBe(400);
    const wrong = await app.inject({
      method: "POST",
      url: "/api/videos/trash",
      payload: { ids: ["not-an-id"] },
    });
    expect(wrong.statusCode).toBe(400);
  });
});

describe("bulk download", () => {
  it("estimates against the stored warning threshold", async () => {
    const url = "/api/videos/bulk-download/estimate";
    const res = await temp.app.inject({
      method: "POST",
      url,
      payload: { ids: [A, B], kind: "all" },
    });
    expect(res.statusCode).toBe(200);
    // video 10 + audio 5 + captions 7 + stored info.json 15, plus B's generated metadata.
    const estimate = BulkDownloadEstimateSchema.parse(res.json());
    expect(estimate.files).toBe(5);
    expect(estimate.warn).toBe(false);
    temp.db.run(
      "INSERT INTO settings (key, value_json, updated_at) VALUES ('bulk.warn_gb', '0', 0)",
    );
    // The real app reads settings through the cached registry resolver.
    invalidateSettingsCache(temp.db);
    const warned = await temp.app.inject({ method: "POST", url, payload: { ids: [A] } });
    expect(BulkDownloadEstimateSchema.parse(warned.json())).toEqual({
      files: 1,
      bytes: 10,
      warn: true,
    });
  });

  it("streams a ZIP that unzips to the selected files", async () => {
    const res = await temp.app.inject({
      method: "POST",
      url: "/api/videos/bulk-download",
      payload: { ids: [A, B], kind: "all", template: "{channel} - {title}" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    expect(res.headers["content-disposition"]).toMatch(
      /^attachment; filename="cellar-\d{4}-\d{2}-\d{2}\.zip"/,
    );
    expect(Number(res.headers["content-length"])).toBe(res.rawPayload.length);

    const stem = `Chan - ${CAFE}`;
    const entries = readZip(res.rawPayload);
    expect(entries.map((e) => e.name)).toEqual([
      `${stem}.webm`,
      `${stem}.m4a`,
      `${stem}.en.vtt`,
      `${stem}.metadata.json`,
      // B has no channel; the template renders that field empty.
      "- Second.metadata.json",
    ]);
    const zip = new AdmZip(res.rawPayload);
    expect(zip.readAsText(`${stem}.webm`)).toBe("0123456789");
    expect(zip.readAsText(`${stem}.en.vtt`)).toBe("WEBVTT\n");
    expect(JSON.parse(zip.readAsText(`${stem}.metadata.json`))).toEqual({ stored: true });
    expect(JSON.parse(zip.readAsText("- Second.metadata.json"))).toMatchObject({ id: B });
  });

  it("accepts a plain form post", async () => {
    const res = await temp.app.inject({
      method: "POST",
      url: "/api/videos/bulk-download",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `ids=${A}&ids=${B}&ids=${A}&kind=video`,
    });
    expect(res.statusCode).toBe(200);
    expect(readZip(res.rawPayload).map((e) => e.name)).toEqual([`${CAFE} [${A}].webm`]);
    const csv = await temp.app.inject({
      method: "POST",
      url: "/api/videos/bulk-download/estimate",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `ids=${A},${B}&kind=audio`,
    });
    expect(BulkDownloadEstimateSchema.parse(csv.json()).files).toBe(1);
  });

  it("forces ZIP64 through the test seam and stays readable", async () => {
    const app = await withDeps({
      zipLimits: { u32: 8, u16: 2 },
      now: () => new Date(Date.UTC(2026, 9, 18)),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/videos/bulk-download",
      payload: { ids: [A], kind: "all" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain('filename="cellar-2026-10-18.zip"');
    const entries = readZip(res.rawPayload);
    expect(entries).toHaveLength(4);
    expect(entries.some((e) => e.zip64)).toBe(true);
    expect(entries[0]?.data.toString()).toBe("0123456789");
  });

  it("keeps a form parser registered further up instead of failing to boot", async () => {
    const app = Fastify();
    app.decorate("cellar", temp.app.cellar);
    app.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_request, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(String(body))));
      },
    );
    await app.register(videoRoutes, { prefix: "/api" });
    bare = app;
    const res = await app.inject({
      method: "POST",
      url: "/api/videos/bulk-download/estimate",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `ids=${A}`,
    });
    expect(BulkDownloadEstimateSchema.parse(res.json()).files).toBe(1);
  });

  it("is 404 when nothing selected has a file", async () => {
    const res = await temp.app.inject({
      method: "POST",
      url: "/api/videos/bulk-download",
      payload: { ids: [B], kind: "video" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("helpers", () => {
  it("builds RFC 6266 dispositions", () => {
    expect(contentDisposition("inline", 'a"b\\c.txt')).toBe(
      `inline; filename="a_b_c.txt"; filename*=UTF-8''a%22b%5Cc.txt`,
    );
    expect(contentDisposition("attachment", "it's (1)*.txt")).toBe(
      "attachment; filename=\"it's (1)*.txt\"; filename*=UTF-8''it%27s%20%281%29%2A.txt",
    );
  });

  it("reads stored settings and ignores malformed rows", () => {
    temp.db.run(
      `INSERT INTO settings (key, value_json, updated_at)
       VALUES ('bulk.warn_gb', '5', 0), ('bogus', '{', 0)`,
    );
    expect(readStoredSettings(temp.db)["bulk.warn_gb"]).toBe(5);
  });
});
