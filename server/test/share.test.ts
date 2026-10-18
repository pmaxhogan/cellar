import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clientKey,
  FALLBACK_SHARE_HTML,
  isShareAsset,
  SHARE_RATE_LIMIT,
} from "../src/public/share.ts";
import { createTempApp, type TempApp } from "./helpers.ts";

/**
 * The public /s surface without share links: every token is unknown
 * and must get the same 404 page with the same headers.
 */

const SHARE_HTML = "<!doctype html><title>Cellar share</title><div id=app></div>";

let temp: TempApp | null = null;
let webDir: string | null = null;

afterEach(async () => {
  await temp?.close();
  temp = null;
  if (webDir !== null) {
    rmSync(webDir, { recursive: true, force: true });
    webDir = null;
  }
});

/** An app with a fake web/dist holding share.html and one share asset. */
async function withBundle(): Promise<TempApp> {
  webDir = mkdtempSync(join(tmpdir(), "cellar-web-dist-"));
  mkdirSync(join(webDir, "assets"), { recursive: true });
  writeFileSync(join(webDir, "share.html"), SHARE_HTML);
  writeFileSync(join(webDir, "index.html"), "<!doctype html><title>Cellar</title>");
  writeFileSync(join(webDir, "assets", "share-abc123.js"), "export const s = 1;\n");
  writeFileSync(join(webDir, "assets", "share-favicon-abc123.svg"), "<svg></svg>");
  writeFileSync(join(webDir, "assets", "index-abc123.js"), "export const admin = 1;\n");
  mkdirSync(join(webDir, "assets", "share-dir"), { recursive: true });
  writeFileSync(join(webDir, "assets", "share-dir", "x.js"), "nested");
  writeFileSync(join(webDir, "assets", ".hidden"), "nope");
  temp = await createTempApp({ WEB_DIST_DIR: webDir });
  return temp;
}

function expectUnknownTokenPage(
  response: Awaited<ReturnType<TempApp["app"]["inject"]>>,
  body: string,
): void {
  expect(response.statusCode).toBe(404);
  expect(response.headers["content-type"]).toContain("text/html");
  expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.body).toBe(body);
}

describe("/s with the built bundle", () => {
  it("answers every token with share.html as a 404", async () => {
    const app = (await withBundle()).app;
    for (const url of ["/s", "/s/", "/s/x", "/s/abc", "/s/abc/def", "/s/abc?x=1"]) {
      expectUnknownTokenPage(await app.inject({ method: "GET", url }), SHARE_HTML);
    }
  });

  it("serves the static privacy and terms pages with 200", async () => {
    const app = (await withBundle()).app;
    for (const url of ["/s/privacy", "/s/tos"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.body).toContain("Cellar");
    }
    expectUnknownTokenPage(await app.inject({ method: "GET", url: "/s/privacy/x" }), SHARE_HTML);
  });

  it("answers HEAD the same way", async () => {
    const app = (await withBundle()).app;
    const response = await app.inject({ method: "HEAD", url: "/s/abc" });
    expect(response.statusCode).toBe(404);
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
  });

  it("serves bundle assets under /s/assets with noindex and long caching", async () => {
    const app = (await withBundle()).app;
    const response = await app.inject({ method: "GET", url: "/s/assets/share-abc123.js" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("export const s = 1;");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(response.headers["cache-control"]).toContain("max-age=31536000");
  });

  it("serves only share-* files, so admin chunks stay behind Access", async () => {
    const app = (await withBundle()).app;
    const svg = await app.inject({ method: "GET", url: "/s/assets/share-favicon-abc123.svg" });
    expect(svg.statusCode).toBe(200);
    for (const url of [
      "/s/assets/index-abc123.js",
      "/s/assets/share-dir/x.js",
      "/s/assets/share-abc123.js/../index-abc123.js",
    ]) {
      expectUnknownTokenPage(await app.inject({ method: "GET", url }), SHARE_HTML);
    }
    // The admin chunk is still served on its own path, which Access guards.
    expect((await app.inject({ method: "GET", url: "/assets/index-abc123.js" })).statusCode).toBe(
      200,
    );
  });

  it("never lists a directory, serves no dotfile, and 404s a missing asset uniformly", async () => {
    const app = (await withBundle()).app;
    for (const url of [
      "/s/assets",
      "/s/assets/",
      "/s/assets/missing.js",
      "/s/assets/.hidden",
      "/s/assets/../share.html",
      "/s/assets/%2e%2e/index.html",
    ]) {
      expectUnknownTokenPage(await app.inject({ method: "GET", url }), SHARE_HTML);
    }
  });

  it("keeps dot segments inside /s over a real socket", async () => {
    // app.inject parses the url with WHATWG URL, which resolves "%2e%2e" before
    // routing, so traversal has to be checked against a listening server.
    const { app } = await withBundle();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const get = (path: string) =>
      new Promise<{ status: number; body: string; robots: unknown }>((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (body += chunk));
          res.on("end", () => {
            resolve({ status: res.statusCode ?? 0, body, robots: res.headers["x-robots-tag"] });
          });
        });
        req.on("error", reject);
        req.end();
      });
    for (const path of [
      "/s/..",
      "/s/%2e%2e",
      "/s/%2e%2e/api/status",
      "/s/../api/status",
      "/s/%2e%2e/healthz",
      "/s/%2e%2e/index.html",
      "/s/assets/../share.html",
      "/s/assets/%2e%2e/index.html",
      "/s/assets/..%2f..%2findex.html",
      "/s/assets/index-abc123.js",
      "/s/assets/share-abc123.js/../index-abc123.js",
      "/s/assets/share-abc123.js/%2e%2e/index-abc123.js",
      "/s//api/status",
    ]) {
      expect(await get(path), path).toEqual({
        status: 404,
        body: SHARE_HTML,
        robots: "noindex, nofollow",
      });
    }
  });

  it("answers other methods with the same page", async () => {
    const app = (await withBundle()).app;
    for (const method of ["POST", "PUT", "DELETE"] as const) {
      expectUnknownTokenPage(await app.inject({ method, url: "/s/abc" }), SHARE_HTML);
    }
  });

  it("keeps /s out of the SPA fallback while deep links still get the app", async () => {
    const app = (await withBundle()).app;
    const deep = await app.inject({ method: "GET", url: "/settings" });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain("<title>Cellar</title>");
    expect(deep.headers["x-robots-tag"]).toBeUndefined();
  });
});

describe("/s without a built bundle", () => {
  it("still answers 404 html with the noindex and no-store headers", async () => {
    temp = await createTempApp();
    for (const url of ["/s", "/s/abc", "/s/assets/share-abc123.js"]) {
      expectUnknownTokenPage(await temp.app.inject({ method: "GET", url }), FALLBACK_SHARE_HTML);
    }
  });
});

describe("rate limiting", () => {
  it("limits each client per window and answers 429 in the ApiError shape", async () => {
    temp = await createTempApp({}, { shareRateLimit: { max: 3, timeWindow: 60_000 } });
    const hit = (ip: string) =>
      temp!.app.inject({ method: "GET", url: "/s/abc", headers: { "cf-connecting-ip": ip } });

    for (let i = 0; i < 3; i += 1) {
      expect((await hit("203.0.113.1")).statusCode).toBe(404);
    }
    const limited = await hit("203.0.113.1");
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: "rate_limited" });
    expect(limited.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(limited.headers["retry-after"]).toBeDefined();

    // Another client is unaffected.
    expect((await hit("203.0.113.2")).statusCode).toBe(404);
  });

  it("does not apply outside /s", async () => {
    temp = await createTempApp({}, { shareRateLimit: { max: 1, timeWindow: 60_000 } });
    for (let i = 0; i < 3; i += 1) {
      expect((await temp.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    }
  });

  it("ships a per-minute default", () => {
    expect(SHARE_RATE_LIMIT).toEqual({ max: 120, timeWindow: 60_000 });
  });
});

describe("isShareAsset", () => {
  it("accepts a flat share-* file and nothing else", () => {
    expect(isShareAsset("/share-abc.js")).toBe(true);
    expect(isShareAsset("/share-favicon-abc.svg")).toBe(true);
    expect(isShareAsset("/index-abc.js")).toBe(false);
    expect(isShareAsset("/share-")).toBe(false);
    expect(isShareAsset("share-abc.js")).toBe(false);
    expect(isShareAsset("/share-dir/x.js")).toBe(false);
    expect(isShareAsset("/x/share-abc.js")).toBe(false);
    expect(isShareAsset("/share-a\\b.js")).toBe(false);
  });
});

describe("clientKey", () => {
  const req = (headers: Record<string, string | string[]>, ip = "10.0.0.1") =>
    ({ headers, ip }) as unknown as Parameters<typeof clientKey>[0];

  it("prefers the edge-set CF-Connecting-IP over the socket or forwarded address", () => {
    expect(clientKey(req({ "cf-connecting-ip": " 198.51.100.7 " }))).toBe("198.51.100.7");
    expect(clientKey(req({ "cf-connecting-ip": ["198.51.100.8", "x"] }))).toBe("198.51.100.8");
    expect(clientKey(req({}))).toBe("10.0.0.1");
    expect(clientKey(req({ "cf-connecting-ip": "" }))).toBe("10.0.0.1");
  });
});
