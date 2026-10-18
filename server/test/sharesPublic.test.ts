import { SharePublicDataSchema, type SharePublicData } from "@cellar/shared";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createShare, generateShareToken, getShare, revokeShare } from "../src/domain/shares.ts";
import { injectShareData, scriptJson, SHARE_DATA_ID } from "../src/public/share.ts";
import { createTempApp, type TempApp } from "./helpers.ts";
import {
  seedAccount,
  seedChannel,
  seedEffective,
  seedLocation,
  seedMedia,
  seedSource,
  seedThumbnail,
  seedVideo,
  T0,
  vid,
} from "./videoSeed.ts";

/**
 * The public /s/:token surface: the injected page, the media sub-routes, and
 * the uniform 404 for every state that is not a live link.
 */

const SHARE_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>Cellar</title></head>' +
  '<body><div id="app"></div></body></html>';
const CAFE = `Caf${String.fromCodePoint(0xe9)} </script><!-- x`;
const A = vid("alpha");
const B = vid("beta");
const C = vid("gamma");

let temp: TempApp;
let webDir: string;
const tokens: Record<"active" | "expired" | "revoked" | "audio" | "bare" | "unknown", string> = {
  active: "",
  expired: "",
  revoked: "",
  audio: "",
  bare: "",
  unknown: "",
};

function ctx() {
  return { db: temp.db, publicOrigin: "https://cellar.example" };
}

beforeEach(async () => {
  webDir = mkdtempSync(join(tmpdir(), "cellar-web-dist-"));
  mkdirSync(join(webDir, "assets"), { recursive: true });
  writeFileSync(join(webDir, "share.html"), SHARE_HTML);
  writeFileSync(join(webDir, "assets", "share-abc.js"), "export {};\n");
  temp = await createTempApp({ WEB_DIST_DIR: webDir });
  const { db, config } = temp;

  const media = join(temp.dir, "media");
  mkdirSync(join(media, A), { recursive: true });
  mkdirSync(join(config.metaDir, A, "thumbnails"), { recursive: true });
  mkdirSync(join(media, B), { recursive: true });
  writeFileSync(join(media, A, `${A}.webm`), "0123456789");
  writeFileSync(join(media, A, `${A}.m4a`), "audio");
  writeFileSync(join(media, B, `${B}.m4a`), "only-audio");
  writeFileSync(join(config.metaDir, A, "en.vtt"), "WEBVTT\n\nen");
  writeFileSync(join(config.metaDir, A, "de.vtt"), "WEBVTT\n\nde");
  writeFileSync(
    join(config.metaDir, A, "info.json"),
    JSON.stringify({
      id: A,
      title: "stored title",
      view_count: 7,
      _filename: "/media/secret/path.webm",
      filepath: "/media/secret/path.webm",
      requested_downloads: [{ filepath: "/media/secret" }],
      formats: [{ url: "https://signed.example/?ip=203.0.113.9" }],
      http_headers: { Cookie: "SID=x" },
      playlist_title: "Watch later",
    }),
  );
  writeFileSync(join(config.metaDir, A, "thumbnails", "max.jpg"), "JPEG-MAX");

  const loc = seedLocation(db, "disk", media);
  const account = seedAccount(db, "owner");
  seedChannel(db, "UCc", "Chan");
  seedVideo(db, {
    id: A,
    channel_id: "UCc",
    title: CAFE,
    description: "d".repeat(2500),
    upload_date: Date.UTC(2026, 1, 3),
    duration_s: 125,
    views: 10,
    likes: 3,
    privacy: "public",
  });
  seedVideo(db, { id: B, title: "Audio only" });
  seedVideo(db, { id: C, title: null });
  seedSource(db, A, "watch_later", account, T0);
  seedEffective(db, A, { reclaim_priority: 5, location_id: loc });
  seedMedia(db, {
    video_id: A,
    kind: "video",
    rel_path: `${A}/${A}.webm`,
    location_id: loc,
    size_bytes: 10,
    height: 1080,
    is_current: 1,
  });
  seedMedia(db, {
    video_id: A,
    kind: "audio",
    rel_path: `${A}/${A}.m4a`,
    location_id: loc,
    size_bytes: 5,
    is_current: 1,
  });
  for (const lang of ["en", "de"]) {
    seedMedia(db, {
      video_id: A,
      kind: "captions",
      rel_path: `${A}/${lang}.vtt`,
      lang,
      size_bytes: 9,
      is_current: 1,
    });
  }
  seedMedia(db, {
    video_id: A,
    kind: "info",
    rel_path: `${A}/info.json`,
    size_bytes: 100,
    is_current: 1,
  });
  seedMedia(db, {
    video_id: B,
    kind: "audio",
    rel_path: `${B}/${B}.m4a`,
    location_id: loc,
    size_bytes: 10,
    is_current: 1,
  });
  seedThumbnail(db, A, "maxresdefault", "sha-max", `${A}/thumbnails/max.jpg`, T0);

  const now = Date.now();
  tokens.active = createShare(ctx(), { video_id: A, expires_at: null }).token;
  tokens.expired = createShare(ctx(), { video_id: A, expires_at: now + 60_000 }).token;
  db.run("UPDATE share_links SET expires_at = ? WHERE token = ?", now - 1, tokens.expired);
  tokens.revoked = createShare(ctx(), { video_id: A, expires_at: null }).token;
  revokeShare(ctx(), tokens.revoked);
  tokens.audio = createShare(ctx(), { video_id: B, expires_at: now + 3_600_000 }).token;
  tokens.bare = createShare(ctx(), { video_id: C, expires_at: null }).token;
  tokens.unknown = generateShareToken();
});

afterEach(async () => {
  await temp.close();
  rmSync(webDir, { recursive: true, force: true });
});

type Method = "GET" | "HEAD" | "POST";

function hit(url: string, method: Method = "GET", headers: Record<string, string> = {}) {
  return temp.app.inject({ method, url, headers });
}

/** The parts of a response that could tell one invalid state from another. */
function fingerprint(response: Awaited<ReturnType<typeof hit>>) {
  const headers = { ...response.headers };
  for (const volatile of ["date", "x-ratelimit-remaining", "x-ratelimit-reset"]) {
    delete headers[volatile];
  }
  return { status: response.statusCode, headers, body: response.body };
}

function payloadOf(html: string): SharePublicData {
  const match = new RegExp(
    `<script id="${SHARE_DATA_ID}" type="application/json">(.*?)</script>`,
  ).exec(html);
  if (match === null) throw new Error("no share-data script");
  return SharePublicDataSchema.parse(JSON.parse(match[1]!));
}

describe("the share page", () => {
  it("injects the payload before </head> and counts the view", async () => {
    const response = await hit(`/s/${tokens.active}`);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.body.startsWith(SHARE_HTML.slice(0, SHARE_HTML.indexOf("</head>")))).toBe(true);
    expect(response.body).toMatch(/<\/script><\/head><body>/);
    // The title holds "</script><!--"; neither may survive unescaped inside the script.
    const inner = response.body.slice(
      response.body.indexOf('application/json">') + 18,
      response.body.indexOf("</script></head>"),
    );
    expect(inner).not.toContain("</");
    expect(inner).not.toContain("<!--");

    const data = payloadOf(response.body);
    expect(data).toEqual({
      token: tokens.active,
      video: {
        id: A,
        title: CAFE,
        channel_title: "Chan",
        upload_date: Date.UTC(2026, 1, 3),
        duration_s: 125,
        description: "d".repeat(2000),
        views: 10,
        likes: 3,
      },
      media: {
        kind: "video",
        mime: "video/webm",
        size_bytes: 10,
        height: 1080,
        has_audio_only: true,
      },
      captions: [
        { lang: "de", label: "German" },
        { lang: "en", label: "English" },
      ],
      thumbnail: true,
      downloads: {
        video: `/s/${tokens.active}/video`,
        audio: `/s/${tokens.active}/audio`,
        captions: {
          de: `/s/${tokens.active}/captions/de`,
          en: `/s/${tokens.active}/captions/en`,
        },
        metadata: `/s/${tokens.active}/metadata.json`,
      },
    });
    expect(getShare(ctx(), tokens.active)).toMatchObject({ access_count: 1 });
    expect(getShare(ctx(), tokens.active).last_access_at).not.toBeNull();
  });

  it("serves an audio-only and an undownloaded video", async () => {
    const audio = payloadOf((await hit(`/s/${tokens.audio}`)).body);
    expect(audio.media).toEqual({
      kind: "audio",
      mime: "audio/mp4",
      size_bytes: 10,
      height: null,
      has_audio_only: true,
    });
    expect(audio.downloads.video).toBeUndefined();
    expect(audio.downloads.audio).toBe(`/s/${tokens.audio}/audio`);
    expect(audio.thumbnail).toBe(false);

    const bare = payloadOf((await hit(`/s/${tokens.bare}`)).body);
    expect(bare.media).toBeNull();
    expect(bare.captions).toEqual([]);
    expect(bare.video.title).toBeNull();
  });

  it("counts only HTML GETs: not HEAD, meta, media or assets", async () => {
    const t = tokens.active;
    for (const url of [
      `/s/${t}/meta`,
      `/s/${t}/video`,
      `/s/${t}/audio`,
      `/s/${t}/captions/en`,
      `/s/${t}/thumbnail`,
      `/s/${t}/metadata.json`,
      "/s/assets/share-abc.js",
    ]) {
      expect((await hit(url)).statusCode, url).toBe(200);
    }
    expect((await hit(`/s/${t}`, "HEAD")).statusCode).toBe(200);
    expect(getShare(ctx(), t).access_count).toBe(0);
    await hit(`/s/${t}`);
    await hit(`/s/${t}`);
    expect(getShare(ctx(), t).access_count).toBe(2);
  });

  it("answers /meta with the same payload", async () => {
    const page = payloadOf((await hit(`/s/${tokens.active}`)).body);
    const meta = await hit(`/s/${tokens.active}/meta`);
    expect(meta.headers["content-type"]).toContain("application/json");
    expect(meta.headers["cache-control"]).toBe("no-store");
    expect(SharePublicDataSchema.parse(meta.json())).toEqual(page);
  });
});

describe("media through the public routes", () => {
  it("streams the video with Range and HEAD", async () => {
    const t = tokens.active;
    const full = await hit(`/s/${t}/video`);
    expect(full.statusCode).toBe(200);
    expect(full.body).toBe("0123456789");
    expect(full.headers["content-type"]).toBe("video/webm");
    expect(full.headers["accept-ranges"]).toBe("bytes");
    expect(full.headers["content-disposition"]).toBeUndefined();
    expect(full.headers["x-robots-tag"]).toBe("noindex, nofollow");

    const part = await hit(`/s/${t}/video`, "GET", { range: "bytes=2-5" });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe("2345");
    expect(part.headers["content-range"]).toBe("bytes 2-5/10");

    expect((await hit(`/s/${t}/video`, "GET", { range: "bytes=50-" })).statusCode).toBe(416);

    const head = await hit(`/s/${t}/video`, "HEAD");
    expect(head.statusCode).toBe(200);
    expect(head.headers["content-length"]).toBe("10");
    expect(head.body).toBe("");
  });

  it("names downloads from the title and id only", async () => {
    const video = await hit(`/s/${tokens.active}/video?download=1`);
    const disposition = String(video.headers["content-disposition"]);
    expect(disposition).toMatch(/^attachment; filename="/);
    expect(disposition).toContain(`[${A}].webm`);
    expect(disposition).toContain("filename*=UTF-8''Caf%C3%A9");
    expect(disposition).not.toContain("watch_later");

    const audio = await hit(`/s/${tokens.audio}/audio?download=true`);
    expect(audio.body).toBe("only-audio");
    expect(String(audio.headers["content-disposition"])).toContain(`Audio only [${B}].m4a`);

    const captions = await hit(`/s/${tokens.active}/captions/en?download=1`);
    expect(String(captions.headers["content-disposition"])).toContain(".en.vtt");
    const metadata = await hit(`/s/${tokens.active}/metadata.json?download=1`);
    expect(String(metadata.headers["content-disposition"])).toContain(".info.json");
  });

  it("serves captions as vtt and the best thumbnail", async () => {
    const en = await hit(`/s/${tokens.active}/captions/en`);
    expect(en.headers["content-type"]).toBe("text/vtt; charset=utf-8");
    expect(en.body).toBe("WEBVTT\n\nen");
    const thumb = await hit(`/s/${tokens.active}/thumbnail`);
    expect(thumb.headers["content-type"]).toBe("image/jpeg");
    expect(thumb.body).toBe("JPEG-MAX");
  });

  it("never leaks private fields in metadata.json", async () => {
    const stored = await hit(`/s/${tokens.active}/metadata.json`);
    expect(stored.headers["content-type"]).toContain("application/json");
    expect(stored.headers["cache-control"]).toBe("no-store");
    const body = stored.json<Record<string, unknown>>();
    expect(body).toEqual({ id: A, title: "stored title", view_count: 7, share: true });
    for (const secret of ["/media/secret", "203.0.113.9", "SID=x", "Watch later"]) {
      expect(stored.body).not.toContain(secret);
    }

    const fallback = await hit(`/s/${tokens.audio}/metadata.json`);
    const row = fallback.json<Record<string, unknown>>();
    expect(row).toMatchObject({ id: B, title: "Audio only", share: true, tags: [] });
    for (const key of [
      "sources",
      "media",
      "share_links",
      "effective",
      "overrides",
      "rel_path",
      "location_id",
      "reclaim_priority",
      "thumbnails",
      "_filename",
      "filepath",
      "http_headers",
      "privacy",
    ]) {
      expect(row, key).not.toHaveProperty(key);
    }

    // An unreadable stored file falls back to the row too.
    writeFileSync(join(temp.config.metaDir, A, "info.json"), "{not json");
    const broken = (await hit(`/s/${tokens.active}/metadata.json`)).json<Record<string, unknown>>();
    expect(broken).toMatchObject({ id: A, share: true, views: 10 });
    expect(broken).not.toHaveProperty("sources");
  });

  it("never names another link, a source or a path in the page payload", async () => {
    const html = (await hit(`/s/${tokens.active}`)).body;
    for (const secret of [
      tokens.revoked,
      tokens.expired,
      "watch_later",
      "owner",
      String(temp.dir).replace(/\\/g, "/"),
      "rel_path",
      "/api/",
    ]) {
      expect(html).not.toContain(secret);
    }
  });
});

describe("the uniform 404", () => {
  const SUBS = [
    "",
    "/meta",
    "/video",
    "/audio",
    "/captions/en",
    "/thumbnail",
    "/metadata.json",
    "/video?download=1",
  ];

  it("is byte and header identical for unknown, malformed, expired and revoked tokens", async () => {
    const reference = fingerprint(await hit("/s/x"));
    expect(reference.status).toBe(404);
    expect(reference.body).toBe(SHARE_HTML);
    expect(reference.headers["cache-control"]).toBe("no-store");
    expect(reference.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(reference.headers["x-robots-tag"]).toBe("noindex, nofollow");

    const invalid = [
      tokens.unknown,
      tokens.expired,
      tokens.revoked,
      "short",
      `${tokens.active}x`,
      tokens.active.slice(1),
      `${tokens.active.slice(0, 21)}=`,
      `${tokens.active.slice(0, 21)}.`,
    ];
    for (const [index, token] of invalid.entries()) {
      // One client per token keeps the walk under the per-IP rate limit.
      const ip = { "cf-connecting-ip": `198.51.100.${String(index + 10)}` };
      for (const sub of SUBS) {
        const url = `/s/${token}${sub}`;
        expect(fingerprint(await hit(url, "GET", ip)), url).toEqual(reference);
        // app.inject hands back a HEAD body that Node never writes to the
        // socket (see the real socket test below), so HEAD compares headers.
        const head = fingerprint(await hit(url, "HEAD", ip));
        expect({ ...head, body: "" }, `HEAD ${token}${sub}`).toEqual({ ...reference, body: "" });
      }
    }
  });

  it("answers HEAD with headers only over a real socket, on every route kind", async () => {
    await temp.app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = temp.app.server.address() as AddressInfo;
    const raw = (path: string) =>
      new Promise<string>((resolve, reject) => {
        const socket = connect(port, "127.0.0.1", () => {
          socket.end(`HEAD ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
        });
        let text = "";
        socket.setEncoding("latin1");
        socket.on("data", (chunk: string) => (text += chunk));
        socket.on("end", () => resolve(text));
        socket.on("error", reject);
      });
    const normalise = (text: string) =>
      text
        .split("\r\n")
        .filter((line) => !/^(date|x-ratelimit-(remaining|reset)):/i.test(line))
        .join("\r\n");
    const reference = normalise(await raw("/s/x"));
    expect(reference.endsWith("\r\n\r\n")).toBe(true);
    expect(reference).toContain(`content-length: ${String(SHARE_HTML.length)}`);
    for (const path of [
      `/s/${tokens.revoked}`,
      `/s/${tokens.expired}/video`,
      `/s/${tokens.unknown}/captions/en`,
      `/s/${tokens.audio}/video`,
    ]) {
      expect(normalise(await raw(path)), path).toBe(reference);
    }
  });

  it("is the same for a live token's missing file, unknown sub-path or bad language", async () => {
    const reference = fingerprint(await hit("/s/x"));
    for (const url of [
      `/s/${tokens.audio}/video`,
      `/s/${tokens.bare}/audio`,
      `/s/${tokens.bare}/thumbnail`,
      `/s/${tokens.active}/captions/fr`,
      `/s/${tokens.active}/captions/${"x".repeat(40)}`,
      `/s/${tokens.active}/captions/e.n`,
      `/s/${tokens.active}/other`,
      `/s/${tokens.active}/video/extra`,
    ]) {
      expect(fingerprint(await hit(url)), url).toEqual(reference);
    }
    // A media row whose file is gone from disk.
    rmSync(join(temp.dir, "media", A, `${A}.webm`));
    expect(fingerprint(await hit(`/s/${tokens.active}/video`))).toEqual(reference);
    // POST to a live token looks like POST to an unknown one.
    expect(fingerprint(await hit(`/s/${tokens.active}`, "POST"))).toEqual(
      fingerprint(await hit(`/s/${tokens.unknown}`, "POST")),
    );
    expect((await hit(`/s/${tokens.active}`, "POST")).body).toBe(SHARE_HTML);
  });

  it("never counts an invalid view", async () => {
    await hit(`/s/${tokens.revoked}`);
    await hit(`/s/${tokens.expired}`);
    expect(getShare(ctx(), tokens.revoked).access_count).toBe(0);
    expect(getShare(ctx(), tokens.expired).access_count).toBe(0);
  });

  it("keeps privacy, tos and assets working", async () => {
    expect((await hit("/s/privacy")).statusCode).toBe(200);
    expect((await hit("/s/tos")).statusCode).toBe(200);
    expect((await hit("/s/assets/share-abc.js")).statusCode).toBe(200);
  });
});

describe("rate limiting on token routes", () => {
  it("still applies to live links and their media", async () => {
    const limited = await createTempApp(
      { WEB_DIST_DIR: webDir },
      { shareRateLimit: { max: 2, timeWindow: 60_000 } },
    );
    try {
      const token = createShare(
        { db: limited.db, publicOrigin: "https://x" },
        { video_id: (seedVideo(limited.db, { id: A }), A), expires_at: null },
      ).token;
      const ip = { "cf-connecting-ip": "198.51.100.1" };
      const get = (url: string) => limited.app.inject({ method: "GET", url, headers: ip });
      expect((await get(`/s/${token}`)).statusCode).toBe(200);
      expect((await get(`/s/${token}/meta`)).statusCode).toBe(200);
      const blocked = await get(`/s/${token}`);
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toMatchObject({ code: "rate_limited" });
      expect(getShare({ db: limited.db, publicOrigin: "https://x" }, token).access_count).toBe(1);
    } finally {
      await limited.close();
    }
  });
});

describe("script injection helpers", () => {
  it("keeps the JSON parseable while defusing </ and <!--", () => {
    const value = { a: "</script><!--<script>", b: "x" };
    const text = scriptJson(value);
    expect(text).not.toContain("</");
    expect(text).not.toContain("<!--");
    expect(JSON.parse(text)).toEqual(value);
  });

  it("prepends when the page has no head", () => {
    expect(injectShareData("<p>x</p>", { a: 1 })).toBe(
      `<script id="${SHARE_DATA_ID}" type="application/json">{"a":1}</script><p>x</p>`,
    );
  });
});
