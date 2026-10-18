import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempApp, type TempApp } from "./helpers.ts";

/**
 * Serving the built frontend. The image copies web/dist in and the server has
 * to hand it out, otherwise every deployment answers 404 at the root.
 */

const INDEX_HTML = "<!doctype html><title>Cellar</title><div id=app></div>";

let webDir: string;
let temp: TempApp | null = null;

beforeEach(() => {
  webDir = mkdtempSync(join(tmpdir(), "cellar-web-"));
});

afterEach(async () => {
  await temp?.close();
  temp = null;
  rmSync(webDir, { recursive: true, force: true });
});

async function build(withFrontend: boolean): Promise<TempApp> {
  if (withFrontend) {
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "index.html"), INDEX_HTML);
    writeFileSync(join(webDir, "assets", "app-abc123.js"), "export const cellar = 1;\n");
    writeFileSync(join(webDir, "favicon.svg"), "<svg>cellar</svg>");
  }
  temp = await createTempApp({ WEB_DIST_DIR: webDir });
  return temp;
}

describe("with a built frontend on disk", () => {
  it("serves index.html at the root without caching it", async () => {
    const { app } = await build(true);
    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toContain("<title>Cellar</title>");
  });

  it("serves a fingerprinted asset with a long lived cache header", async () => {
    const { app } = await build(true);
    const response = await app.inject({ method: "GET", url: "/assets/app-abc123.js" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toContain("max-age=31536000");
  });

  it("serves the favicon as a file rather than through the history fallback", async () => {
    const { app } = await build(true);
    const response = await app.inject({ method: "GET", url: "/favicon.svg" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/svg+xml");
    expect(response.body).toBe("<svg>cellar</svg>");
  });

  it("answers client side routes with index.html so deep links work", async () => {
    const { app } = await build(true);
    for (const url of ["/settings", "/videos", "/sx", "/videos/abc?tab=history"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(200);
      expect(response.body, url).toContain("<title>Cellar</title>");
    }
  });

  it("keeps server paths and non-GET methods as JSON 404s", async () => {
    const { app } = await build(true);
    for (const url of ["/api/nope", "/healthz/extra"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(404);
      expect(response.json(), url).toMatchObject({ code: "not_found" });
    }
    const post = await app.inject({ method: "POST", url: "/settings" });
    expect(post.statusCode).toBe(404);
    expect(post.json()).toEqual({ error: "Not found.", code: "not_found" });
  });
});

describe("without a built frontend", () => {
  it("serves the API only and answers the root with a 404", async () => {
    const { app } = await build(false);
    expect((await app.inject({ method: "GET", url: "/" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });
});
