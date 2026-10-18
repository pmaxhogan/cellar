import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { buildApp, type BuildAppDeps } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { Db } from "../src/db/db.ts";
import { ensureInstalledAt } from "../src/db/kv.ts";
import { migrate } from "../src/db/migrate.ts";
import { storeSecret } from "../src/domain/accountStore.ts";
import type { FetchLike } from "../src/domain/deps.ts";
import { EventBus } from "../src/events.ts";
import { createConsoleLogger } from "../src/logging.ts";
import type { Wave1ABuildDeps, Wave1ARouteOptions } from "../src/routes/wave1a.ts";
import { openDb } from "../src/db/db.ts";
import { TEST_SECRET_KEY, type TempApp } from "./helpers.ts";

/** Repository root, for the fake yt-dlp shim. */
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const FAKE_YTDLP = join(REPO_ROOT, "scripts", "fake-bin", "yt-dlp.mjs");
/** CELLAR_TOOL_YT_DLP value that runs the shim through this node binary. */
export const FAKE_YTDLP_ENV = JSON.stringify([process.execPath, FAKE_YTDLP]);

export const CLIENT_ID = "test-client.apps.googleusercontent.com";
export const CLIENT_SECRET = "test-client-secret";

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, "server", "test", "fixtures", "youtube", name), "utf8"),
  ) as T;
}

/**
 * Like createTempApp, plus the wave1A seams (fake fetch, local JWKS, proxy
 * probe). Defaults to a configured Google OAuth client and the fake yt-dlp.
 */
export async function createWave1App(
  env: Record<string, string> = {},
  seams: Wave1ARouteOptions = {},
): Promise<TempApp> {
  const dir = mkdtempSync(join(tmpdir(), "cellar-w1a-"));
  const config = loadConfig({
    INSECURE_ALLOW_PUBLIC_ACCESS: "1",
    DATA_DIR: dir,
    CELLAR_SECRET_KEY: TEST_SECRET_KEY,
    WEB_DIST_DIR: join(dir, "no-frontend-here"),
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    PUBLIC_ORIGIN: "https://cellar.example.test",
    CELLAR_TOOL_YT_DLP: FAKE_YTDLP_ENV,
    ...env,
  });
  const log = createConsoleLogger("silent");
  const db = openDb(config.dbPath);
  migrate(db, log);
  ensureInstalledAt(db);
  const events = new EventBus();
  const deps: BuildAppDeps & Wave1ABuildDeps = {
    config,
    log,
    db,
    events,
    version: "9.9.9-test",
    wave1A: seams,
  };
  const app = await buildApp(deps);
  return {
    app,
    db,
    config,
    events,
    dir,
    async close(): Promise<void> {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Insert an account that already holds a Google grant. */
export function seedLinkedAccount(
  db: Db,
  options: {
    label?: string;
    status?: string;
    refreshToken?: string;
    lastApiOkAt?: number | null;
  } = {},
): number {
  const now = Date.now();
  const { lastInsertRowid } = db.run(
    `INSERT INTO accounts (label, status, last_api_ok_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    options.label ?? "seeded",
    options.status ?? "ok",
    options.lastApiOkAt ?? null,
    now,
    now,
  );
  storeSecret(
    { secretKey: Buffer.from(TEST_SECRET_KEY, "hex") },
    db,
    lastInsertRowid,
    "oauth_refresh",
    options.refreshToken ?? "refresh-good",
    now,
  );
  return lastInsertRowid;
}

export interface RecordedCall {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
}

export type ApiHandler = (url: URL, call: RecordedCall) => Response | undefined;

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A fake of the Google endpoints Cellar talks to: the token endpoint (code
 * exchange and refresh) and the YouTube Data API. Access tokens are minted
 * per call and checked on API requests.
 */
export class FakeGoogle {
  readonly calls: RecordedCall[] = [];
  readonly revokedRefreshTokens = new Set<string>();
  readonly validAccessTokens = new Set<string>();
  /** Codes the authorization endpoint "issued", with the PKCE challenge they must match. */
  readonly codes = new Map<string, { challenge: string }>();
  /** Overrides for the code exchange response. */
  exchange: {
    status?: number;
    refreshToken?: string | null;
    /** null omits the field. */
    scope?: string | null;
    omitExpiry?: boolean;
    idToken?: (() => Promise<string>) | null;
    sub?: string;
    email?: string | null;
  } = {};
  /** YouTube API responses by path (`channels`, ...). Default: the fixtures. */
  api: Record<string, ApiHandler> = {};
  refreshStatus: number | null = null;
  private counter = 0;
  private privateKey: CryptoKey | null = null;
  private jwk: JWK | null = null;

  async init(): Promise<this> {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    this.privateKey = privateKey;
    this.jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
    return this;
  }

  /** `sub: ""` omits the subject, `email: null` the email claim. */
  async idToken(
    claims: { sub?: string; email?: string | null; aud?: string; iss?: string } = {},
  ): Promise<string> {
    if (this.privateKey === null) {
      throw new Error("FakeGoogle.init() first");
    }
    const email = claims.email === undefined ? "owner@example.com" : claims.email;
    let jwt = new SignJWT(email === null ? {} : { email })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(claims.iss ?? "https://accounts.google.com")
      .setAudience(claims.aud ?? CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime("1h");
    const sub = claims.sub ?? "google-sub-1";
    if (sub !== "") {
      jwt = jwt.setSubject(sub);
    }
    return jwt.sign(this.privateKey);
  }

  /** Simulate the user consenting at Google for the authorization URL. */
  approve(authUrl: string, code = "auth-code-1"): { code: string; state: string } {
    const url = new URL(authUrl);
    this.codes.set(code, { challenge: url.searchParams.get("code_challenge") ?? "" });
    return { code, state: url.searchParams.get("state") ?? "" };
  }

  private mintAccessToken(): string {
    this.counter += 1;
    const token = `access-${String(this.counter)}`;
    this.validAccessTokens.add(token);
    return token;
  }

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const call: RecordedCall = {
      method: init?.method ?? "GET",
      url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    };
    this.calls.push(call);
    if (url.host === "www.googleapis.com" && url.pathname === "/oauth2/v3/certs") {
      return jsonResponse(200, { keys: [this.jwk] });
    }
    if (url.host === "oauth2.googleapis.com" && url.pathname === "/token") {
      return this.token(new URLSearchParams(call.body));
    }
    if (url.host === "www.googleapis.com" && url.pathname.startsWith("/youtube/v3/")) {
      const auth = call.headers.get("authorization") ?? "";
      if (!this.validAccessTokens.has(auth.replace(/^Bearer /, ""))) {
        return jsonResponse(401, fixture("error.invalidCredentials.json"));
      }
      const path = url.pathname.slice("/youtube/v3/".length);
      const handled = this.api[path]?.(url, call);
      if (handled !== undefined) {
        return handled;
      }
      if (path === "channels") {
        return jsonResponse(200, fixture("channels.list.mine.json"));
      }
      return jsonResponse(404, { error: { code: 404, errors: [{ reason: "notFound" }] } });
    }
    throw new Error(`FakeGoogle: unexpected request to ${url.host}${url.pathname}`);
  };

  private async token(form: URLSearchParams): Promise<Response> {
    if (form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== CLIENT_SECRET) {
      return jsonResponse(401, { error: "invalid_client" });
    }
    if (form.get("grant_type") === "refresh_token") {
      if (this.refreshStatus !== null) {
        return jsonResponse(this.refreshStatus, { error: "server_error" });
      }
      const refresh = form.get("refresh_token") ?? "";
      if (this.revokedRefreshTokens.has(refresh)) {
        return jsonResponse(400, {
          error: "invalid_grant",
          error_description: "Token has been expired or revoked.",
        });
      }
      return jsonResponse(200, {
        access_token: this.mintAccessToken(),
        expires_in: 3599,
        token_type: "Bearer",
      });
    }
    if (form.get("grant_type") === "authorization_code") {
      const issued = this.codes.get(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (
        issued === undefined ||
        issued.challenge !== challenge ||
        form.get("redirect_uri") !== "https://cellar.example.test/api/oauth/google/callback"
      ) {
        return jsonResponse(400, { error: "invalid_grant" });
      }
      if (this.exchange.status !== undefined) {
        return jsonResponse(this.exchange.status, { error: "server_error" });
      }
      const body: Record<string, unknown> = {
        access_token: this.mintAccessToken(),
        token_type: "Bearer",
      };
      if (this.exchange.omitExpiry !== true) {
        body["expires_in"] = 3599;
      }
      if (this.exchange.scope !== null) {
        body["scope"] =
          this.exchange.scope ??
          "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/youtube.readonly";
      }
      if (this.exchange.refreshToken !== null) {
        body["refresh_token"] = this.exchange.refreshToken ?? "refresh-from-exchange";
      }
      if (this.exchange.idToken !== null) {
        body["id_token"] =
          this.exchange.idToken === undefined
            ? await this.idToken({
                ...(this.exchange.sub === undefined ? {} : { sub: this.exchange.sub }),
                ...(this.exchange.email === undefined ? {} : { email: this.exchange.email }),
              })
            : await this.exchange.idToken();
      }
      return jsonResponse(200, body);
    }
    return jsonResponse(400, { error: "unsupported_grant_type" });
  }

  /** Calls to the YouTube API (not the token endpoint). */
  apiCalls(): RecordedCall[] {
    return this.calls.filter((call) => call.url.pathname.startsWith("/youtube/v3/"));
  }
}
