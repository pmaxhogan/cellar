import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type InjectOptions } from "fastify";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JSONWebKeySet,
  type JWK,
} from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type CellarApp } from "../src/app.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { openDb, type Db } from "../src/db/db.ts";
import { migrate } from "../src/db/migrate.ts";
import { createConsoleLogger } from "../src/logging.ts";
import {
  cfAccessPlugin,
  CF_ACCESS_COOKIE,
  CF_ACCESS_HEADER,
  DEFAULT_PUBLIC_PREFIXES,
  extractToken,
  isPublicPath,
  requestPathname,
  type CfAccessKeyGetter,
} from "../src/security/cfAccess.ts";
import * as publicPaths from "../src/security/publicPaths.ts";

type InjectMethod = NonNullable<InjectOptions["method"]>;

interface RegisteredRoute {
  method: InjectMethod;
  url: string;
}

/**
 * Turns `printRoutes({ commonPrefix: false })` output into injectable requests.
 *
 * The output is a TREE, not a flat list: a nested line carries only its own
 * segment, so "/:id" under "/api/videos" is the route /api/videos/:id. Reading
 * each line as a whole path would produce URLs that exist nowhere and get
 * their 401 from the catch-all rather than from the route being guarded, which
 * is a test that proves nothing. Indentation is four columns per level, so the
 * segments are reassembled through a stack keyed by depth.
 *
 * Path parameters and wildcards get concrete stand-ins; the guard runs before
 * any handler, so the values only need to route.
 */
function parseRegisteredRoutes(printed: string): RegisteredRoute[] {
  const routes: RegisteredRoute[] = [];
  const segments: string[] = [];

  for (const line of printed.split("\n")) {
    // Tree glyphs as escapes: the repo is ASCII only.
    const match = /^(.*?)(?:[├└]── )(\S+)\s+\(([^)]+)\)\s*$/.exec(line);
    const prefix = match?.[1];
    const segment = match?.[2];
    const rawMethods = match?.[3];
    if (prefix === undefined || segment === undefined || rawMethods === undefined) {
      continue;
    }

    const depth = Math.floor(prefix.length / 4);
    segments.length = depth;
    segments.push(segment);

    const url = segments
      .join("")
      .replace(/:[^/]+/g, "1")
      .replace(/^\*$/, "/x")
      .replace(/\*/g, "x");
    const methods = rawMethods.split(",").map((method) => method.trim());
    // HEAD is Fastify's automatic companion to GET, so testing GET covers it.
    const method = methods.find((candidate) => candidate !== "HEAD") ?? methods[0];
    if (method === undefined) {
      continue;
    }
    routes.push({ method: method as InjectMethod, url });
  }
  return routes;
}

const TEAM_DOMAIN = "cellar-test.cloudflareaccess.com";
const ISSUER = `https://${TEAM_DOMAIN}`;
const AUD = "aud-0123456789abcdef";
const ALLOWED = "max@unbroker.com";

let privateKey: CryptoKey;
let getKey: CfAccessKeyGetter;
/** A second, unrelated keypair: tokens signed with it must never verify. */
let foreignKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "RS256" };
  const jwks: JSONWebKeySet = { keys: [jwk] };
  getKey = createLocalJWKSet(jwks);

  const other = await generateKeyPair("RS256", { extractable: true });
  foreignKey = other.privateKey;
});

interface TokenOptions {
  issuer?: string;
  audience?: string;
  email?: string | null;
  expiresIn?: string;
  notBefore?: string;
  key?: CryptoKey;
}

async function makeToken(options: TokenOptions = {}): Promise<string> {
  const claims: Record<string, unknown> = { sub: "user-1" };
  const email = options.email === undefined ? ALLOWED : options.email;
  if (email !== null) {
    claims["email"] = email;
  }

  let jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuedAt()
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUD)
    .setExpirationTime(options.expiresIn ?? "5m");

  if (options.notBefore !== undefined) {
    jwt = jwt.setNotBefore(options.notBefore);
  }
  return jwt.sign(options.key ?? privateKey);
}

function secureConfig(): Config {
  return loadConfig({
    DATA_DIR: "/tmp/cellar-cfaccess-test",
    CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    CF_ACCESS_AUD: AUD,
    CF_ACCESS_ALLOWED_EMAILS: `${ALLOWED}, someone-else@unbroker.com`,
  });
}

/** A minimal server carrying the plugin plus one route per public prefix. */
async function buildGuarded(overrides: { config?: Config; getKey?: CfAccessKeyGetter } = {}) {
  const app = Fastify({ loggerInstance: createConsoleLogger("silent") });
  await app.register(cfAccessPlugin, {
    config: overrides.config ?? secureConfig(),
    ...("getKey" in overrides ? { getKey: overrides.getKey } : { getKey }),
  });
  app.get("/api/videos", () => ({ ok: true }));
  app.get("/healthz", () => ({ ok: true }));
  app.get("/healthzz", () => ({ ok: true }));
  app.get("/s", () => ({ ok: true }));
  app.get("/s/abc", () => ({ ok: true }));
  app.get("/s/assets/x.js", () => ({ ok: true }));
  app.get("/sx", () => ({ ok: true }));
  app.get("/settings", () => ({ ok: true }));
  app.get("/S/abc", () => ({ ok: true }));
  app.get("/api/s", () => ({ ok: true }));
  await app.ready();
  return app;
}

describe("requestPathname", () => {
  it("drops the query string and the fragment", () => {
    expect(requestPathname("/api/videos")).toBe("/api/videos");
    expect(requestPathname("/api/videos?q=/healthz")).toBe("/api/videos");
    expect(requestPathname("/api/videos#/healthz")).toBe("/api/videos");
    expect(requestPathname("")).toBe("/");
  });
});

describe("isPublicPath", () => {
  // The production list, so these assertions describe what actually ships.
  const prefixes = DEFAULT_PUBLIC_PREFIXES;

  it("ships exactly /healthz and /s", () => {
    expect([...DEFAULT_PUBLIC_PREFIXES]).toEqual(["/healthz", "/s"]);
  });

  it("is the same list and function cfAccess re-exports from publicPaths", () => {
    expect(DEFAULT_PUBLIC_PREFIXES).toBe(publicPaths.DEFAULT_PUBLIC_PREFIXES);
    expect(isPublicPath).toBe(publicPaths.isPublicPath);
    expect(requestPathname).toBe(publicPaths.requestPathname);
  });

  it("matches the exact public paths", () => {
    expect(isPublicPath("/healthz", prefixes)).toBe(true);
    expect(isPublicPath("/healthz/", prefixes)).toBe(true);
    expect(isPublicPath("/s/abc", prefixes)).toBe(true);
    expect(isPublicPath("/s/assets/x.js", prefixes)).toBe(true);
    expect(isPublicPath("/s/abc/video.mp4", prefixes)).toBe(true);
  });

  it("exempts bare /s, which is inside the Cloudflare bypass scope", () => {
    // Cloudflare's bypass on destination path "/s" waves through "/s" itself,
    // so demanding a JWT there asks for something that cannot arrive.
    expect(isPublicPath("/s", prefixes)).toBe(true);
    expect(isPublicPath("/s/", prefixes)).toBe(true);
  });

  it("does not let a longer path borrow a public prefix", () => {
    expect(isPublicPath("/healthzz", prefixes)).toBe(false);
    expect(isPublicPath("/healthz-admin", prefixes)).toBe(false);
    expect(isPublicPath("/healthzfoo", prefixes)).toBe(false);
  });

  it("stops at a path separator, so no prefix bleeds into a sibling", () => {
    expect(isPublicPath("/sx", prefixes)).toBe(false);
    expect(isPublicPath("/sx/abc", prefixes)).toBe(false);
    expect(isPublicPath("/s-admin", prefixes)).toBe(false);
    expect(isPublicPath("/settings", prefixes)).toBe(false);
    expect(isPublicPath("/share", prefixes)).toBe(false);
    expect(isPublicPath("/share.html", prefixes)).toBe(false);
  });

  it("is case sensitive", () => {
    expect(isPublicPath("/S/abc", prefixes)).toBe(false);
    expect(isPublicPath("/S", prefixes)).toBe(false);
    expect(isPublicPath("/Healthz", prefixes)).toBe(false);
  });

  it("does not treat an api path as public just because it mentions one", () => {
    expect(isPublicPath("/api/healthz", prefixes)).toBe(false);
    expect(isPublicPath("/api/videos", prefixes)).toBe(false);
    expect(isPublicPath("/api/s", prefixes)).toBe(false);
    expect(isPublicPath("/api/s/abc", prefixes)).toBe(false);
    expect(isPublicPath("/", prefixes)).toBe(false);
  });

  it("is applied to the pathname, so a query never counts", () => {
    expect(isPublicPath(requestPathname("/healthz?x=1"), prefixes)).toBe(true);
    expect(isPublicPath(requestPathname("/s/abc?t=1"), prefixes)).toBe(true);
    expect(isPublicPath(requestPathname("/api/videos?next=/s/abc"), prefixes)).toBe(false);
    expect(isPublicPath(requestPathname("/api/videos#/s"), prefixes)).toBe(false);
  });
});

describe("extractToken", () => {
  const req = (headers: Record<string, string | string[]>) =>
    ({ headers }) as unknown as Parameters<typeof extractToken>[0];

  it("prefers the header", () => {
    expect(
      extractToken(req({ [CF_ACCESS_HEADER]: "header-token", cookie: `${CF_ACCESS_COOKIE}=ck` })),
    ).toBe("header-token");
  });

  it("falls back to the cookie", () => {
    expect(extractToken(req({ cookie: `${CF_ACCESS_COOKIE}=cookie-token` }))).toBe("cookie-token");
  });

  it("finds the cookie among others and ignores similarly named ones", () => {
    expect(
      extractToken(req({ cookie: `a=1; ${CF_ACCESS_COOKIE}=wanted; NOT_${CF_ACCESS_COOKIE}=no` })),
    ).toBe("wanted");
    expect(extractToken(req({ cookie: `cf_authorization=lowercase` }))).toBeNull();
  });

  it("returns null when there is nothing usable", () => {
    expect(extractToken(req({}))).toBeNull();
    expect(extractToken(req({ [CF_ACCESS_HEADER]: "   " }))).toBeNull();
    expect(extractToken(req({ cookie: `${CF_ACCESS_COOKIE}=` }))).toBeNull();
    expect(extractToken(req({ cookie: "novalue" }))).toBeNull();
  });

  it("takes the first value when the header arrives more than once", () => {
    expect(extractToken(req({ [CF_ACCESS_HEADER]: ["first", "second"] }))).toBe("first");
  });
});

describe("cfAccessPlugin request guarding", () => {
  it("accepts a valid token in the header", async () => {
    const app = await buildGuarded();
    const response = await app.inject({
      method: "GET",
      url: "/api/videos",
      headers: { [CF_ACCESS_HEADER]: await makeToken() },
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("accepts a valid token from the CF_Authorization cookie", async () => {
    const app = await buildGuarded();
    const response = await app.inject({
      method: "GET",
      url: "/api/videos",
      headers: { cookie: `${CF_ACCESS_COOKIE}=${await makeToken()}` },
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("rejects a request with no token at all", async () => {
    const app = await buildGuarded();
    const response = await app.inject({ method: "GET", url: "/api/videos" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "unauthorized" });
    await app.close();
  });

  it("rejects an expired token", async () => {
    const app = await buildGuarded();
    const response = await app.inject({
      method: "GET",
      url: "/api/videos",
      headers: { [CF_ACCESS_HEADER]: await makeToken({ expiresIn: "-10m" }) },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a token that is not valid yet", async () => {
    const app = await buildGuarded();
    const response = await app.inject({
      method: "GET",
      url: "/api/videos",
      headers: { [CF_ACCESS_HEADER]: await makeToken({ notBefore: "10m" }) },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects the wrong audience", async () => {
    const app = await buildGuarded();
    const response = await app.inject({
      method: "GET",
      url: "/api/videos",
      headers: { [CF_ACCESS_HEADER]: await makeToken({ audience: "some-other-aud" }) },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects the wrong issuer", async () => {
    const app = await buildGuarded();
    const response = await app.inject({
      method: "GET",
      url: "/api/videos",
      headers: {
        [CF_ACCESS_HEADER]: await makeToken({ issuer: "https://evil.cloudflareaccess.com" }),
      },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects an email that is not on the allow list", async () => {
    const app = await buildGuarded();
    const response = await app.inject({
      method: "GET",
      url: "/api/videos",
      headers: { [CF_ACCESS_HEADER]: await makeToken({ email: "intruder@example.com" }) },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a token with no email claim", async () => {
    const app = await buildGuarded();
    const response = await app.inject({
      method: "GET",
      url: "/api/videos",
      headers: { [CF_ACCESS_HEADER]: await makeToken({ email: null }) },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("compares the allow list case insensitively", async () => {
    const app = await buildGuarded();
    const response = await app.inject({
      method: "GET",
      url: "/api/videos",
      headers: { [CF_ACCESS_HEADER]: await makeToken({ email: "MAX@Unbroker.COM" }) },
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("rejects a token signed by an unknown key", async () => {
    const app = await buildGuarded();
    const response = await app.inject({
      method: "GET",
      url: "/api/videos",
      headers: { [CF_ACCESS_HEADER]: await makeToken({ key: foreignKey }) },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects malformed tokens without crashing", async () => {
    const app = await buildGuarded();
    for (const token of ["not-a-jwt", "a.b", "a.b.c", "...", "eyJhbGciOiJub25lIn0..", " "]) {
      const response = await app.inject({
        method: "GET",
        url: "/api/videos",
        headers: { [CF_ACCESS_HEADER]: token },
      });
      expect(response.statusCode).toBe(401);
    }
    await app.close();
  });

  it("rejects an unsigned alg:none token", async () => {
    const app = await buildGuarded();
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ iss: ISSUER, aud: AUD, email: ALLOWED, exp: Date.now() / 1000 + 600 }),
    ).toString("base64url");
    const response = await app.inject({
      method: "GET",
      url: "/api/videos",
      headers: { [CF_ACCESS_HEADER]: `${header}.${payload}.` },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("never echoes the rejected token in the response body", async () => {
    const app = await buildGuarded();
    const token = await makeToken({ email: "intruder@example.com" });
    const response = await app.inject({
      method: "GET",
      url: "/api/videos",
      headers: { [CF_ACCESS_HEADER]: token },
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain(token);
    expect(response.body).not.toContain("intruder@example.com");
    await app.close();
  });
});

describe("public prefixes", () => {
  it("lets /healthz, bare /s and /s/* through with no token", async () => {
    const app = await buildGuarded();
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/healthz?x=1" })).statusCode).toBe(200);
    // Bare /s is inside the Cloudflare bypass scope, so it must not be met
    // with a demand for authentication that the bypass guarantees never comes.
    expect((await app.inject({ method: "GET", url: "/s" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/s/abc" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/s/assets/x.js" })).statusCode).toBe(200);
    await app.close();
  });

  it("still guards paths that merely start like a public one", async () => {
    const app = await buildGuarded();
    expect((await app.inject({ method: "GET", url: "/healthzz" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/sx" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/settings" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/S/abc" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/s" })).statusCode).toBe(401);
    await app.close();
  });

  it("does not let a query string smuggle a public path", async () => {
    const app = await buildGuarded();
    const response = await app.inject({ method: "GET", url: "/api/videos?next=/healthz" });
    expect(response.statusCode).toBe(401);
    const viaShare = await app.inject({ method: "GET", url: "/api/videos?next=/s/abc" });
    expect(viaShare.statusCode).toBe(401);
    await app.close();
  });

  it("guards unrouted paths too, so a 404 cannot confirm what exists", async () => {
    const app = await buildGuarded();
    const response = await app.inject({ method: "GET", url: "/api/does-not-exist" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("guards every method, not just GET", async () => {
    const app = await buildGuarded();
    for (const method of ["POST", "PATCH", "DELETE", "PUT"] as const) {
      const response = await app.inject({ method, url: "/api/videos" });
      expect(response.statusCode).toBe(401);
    }
    await app.close();
  });
});

describe("fail closed configuration", () => {
  it("verifies against the remote JWKS when no key getter is injected", async () => {
    // No network is available for cellar-test.cloudflareaccess.com, so a real
    // verification attempt must fail. What matters is that the absent option
    // does not silently skip validation.
    const app = Fastify({ loggerInstance: createConsoleLogger("silent") });
    await app.register(cfAccessPlugin, { config: secureConfig() });
    app.get("/api/videos", () => ({ ok: true }));
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/api/videos",
      headers: { [CF_ACCESS_HEADER]: await makeToken() },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("refuses to register when Access is unconfigured and insecure mode is off", async () => {
    const app = Fastify({ loggerInstance: createConsoleLogger("silent") });
    const config: Config = { ...secureConfig(), cfAccess: null, insecureMode: false };
    await expect(app.register(cfAccessPlugin, { config, getKey }).ready()).rejects.toThrow(
      /Refusing to serve/,
    );
    await app.close();
  });

  it("installs no hook at all in insecure mode", async () => {
    const config = loadConfig({ INSECURE_ALLOW_PUBLIC_ACCESS: "1", DATA_DIR: "/tmp/cellar-ins" });
    const app = await buildGuarded({ config });
    expect((await app.inject({ method: "GET", url: "/api/videos" })).statusCode).toBe(200);
    await app.close();
  });
});

/**
 * The plugin is wrapped in fastify-plugin so its hook escapes the encapsulated
 * scope it is registered in. Registered plainly, the hook would never see the
 * sibling apiRoutes and every /api route would be wide open, so this exercises
 * the real buildApp rather than a hand rolled instance.
 */
describe("the real app guards every /api route", () => {
  let dir: string;
  let db: Db;
  let app: CellarApp;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cellar-guarded-"));
    const config = loadConfig({
      DATA_DIR: dir,
      CELLAR_SECRET_KEY: "a".repeat(64),
      CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
      CF_ACCESS_AUD: AUD,
      CF_ACCESS_ALLOWED_EMAILS: ALLOWED,
    });
    const log = createConsoleLogger("silent");
    db = openDb(config.dbPath);
    migrate(db, log);
    app = await buildApp({ config, log, db, version: "9.9.9-test", cfAccessGetKey: getKey });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects every API route without a token", async () => {
    for (const url of ["/", "/api/status", "/api/events", "/api/does-not-exist", "/settings"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(401);
      expect(response.json(), url).toMatchObject({ code: "unauthorized" });
    }
    expect((await app.inject({ method: "POST", url: "/api/status", payload: {} })).statusCode).toBe(
      401,
    );
  });

  it("answers the public share surface without a token, and never with a 401", async () => {
    for (const url of ["/s", "/s/", "/s/abc", "/s/assets/x.js", "/s/abc?t=1"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(404);
      expect(response.headers["content-type"], url).toContain("text/html");
    }
    // Case sensitive, like the router: /S is not the public surface.
    expect((await app.inject({ method: "GET", url: "/S/abc" })).statusCode).toBe(401);
  });

  /**
   * The list above is readable but goes stale the moment a route module is
   * added. This walks what Fastify actually registered instead, so a new route
   * that forgets the guard fails here rather than shipping unauthenticated.
   */
  it("rejects every registered route except /healthz and /s", async () => {
    const routes = parseRegisteredRoutes(app.printRoutes({ commonPrefix: false }));
    const urls = routes.map((route) => route.url);

    // Nested routes must come back as full paths. If the tree were read one
    // line at a time these would be bare "/status" and "/events" and would 401
    // only by way of the catch-all, which would prove nothing about the guard.
    expect(urls).toContain("/api/status");
    expect(urls).toContain("/api/events");
    expect(urls).toContain("/healthz");
    expect(urls).toContain("/s");
    expect(urls.some((url) => url.startsWith("/s/"))).toBe(true);

    // The exempt set, spelled out independently of the implementation: the
    // health check, and the share namespace the Cloudflare bypass covers, which
    // is the bare path as well as everything under it.
    const exempt = (url: string): boolean =>
      url === "/healthz" || url === "/s" || url.startsWith("/s/");
    const guarded = routes.filter((route) => !exempt(route.url));
    // If the parser ever silently stops matching, this floor fails rather than
    // letting an empty loop below report success.
    expect(guarded.length).toBeGreaterThanOrEqual(2);

    for (const route of guarded) {
      const response = await app.inject({
        method: route.method,
        url: route.url,
        payload: route.method === "GET" ? undefined : {},
      });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
    }
  });

  it("serves the same routes with a valid token", async () => {
    const headers = { [CF_ACCESS_HEADER]: await makeToken() };
    expect((await app.inject({ method: "GET", url: "/api/status", headers })).statusCode).toBe(200);
    // Authenticated but unrouted: the API's own JSON 404, not the guard's 401.
    const missing = await app.inject({ method: "GET", url: "/api/nope", headers });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "not_found" });
  });

  it("reports insecureMode false to an authenticated caller", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { [CF_ACCESS_HEADER]: await makeToken() },
    });
    expect(response.json()).toMatchObject({ insecureMode: false });
  });

  it("leaves /healthz open for the docker healthcheck", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true });
  });

  /**
   * The one path a real deployment hits on every page load, and the only one
   * where the auth hook meets a hijacked reply. EventSource cannot set request
   * headers, so the browser authenticates the stream with the CF_Authorization
   * cookie alone; both routes into the stream are checked here against a real
   * socket, since app.inject would buffer a response that never ends.
   */
  it("streams /api/events to an authenticated client, cookie included", async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const token = await makeToken();

    for (const headers of [
      { [CF_ACCESS_HEADER]: token },
      { cookie: `${CF_ACCESS_COOKIE}=${token}` },
    ]) {
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${String(port)}/api/events`, {
        headers,
        signal: controller.signal,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");

      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain(": connected");

      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
  });

  it("refuses the stream outright when the cookie carries a rejected token", async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const token = await makeToken({ email: "intruder@example.com" });

    const response = await fetch(`http://127.0.0.1:${String(port)}/api/events`, {
      headers: { cookie: `${CF_ACCESS_COOKIE}=${token}` },
    });
    expect(response.status).toBe(401);
    // Rejected before the handler ran, so no stream was ever opened.
    expect(response.headers.get("content-type")).toContain("application/json");
    await response.body?.cancel();
  });
});
