import { AccountRowSchema } from "@cellar/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getKv } from "../src/db/kv.ts";
import { readSecret, storeSecret } from "../src/domain/accountStore.ts";
import { OAUTH_ERROR_CODES, STATE_TTL_MS } from "../src/youtube/oauth.ts";
import { apiUsage } from "../src/youtube/quota.ts";
import type { TempApp } from "./helpers.ts";
import {
  CLIENT_ID,
  createWave1App,
  FakeGoogle,
  jsonResponse,
  seedLinkedAccount,
} from "./wave1aHelpers.ts";

let temp: TempApp;
let google: FakeGoogle;
let now: number;

async function createAccount(label = ""): Promise<number> {
  const res = await temp.app.inject({ method: "POST", url: "/api/accounts", payload: { label } });
  expect(res.statusCode).toBe(201);
  return AccountRowSchema.parse(res.json()).id;
}

async function start(accountId: number): Promise<string> {
  const res = await temp.app.inject({
    method: "GET",
    url: `/api/oauth/google/start?account=${String(accountId)}`,
  });
  expect(res.statusCode).toBe(302);
  return String(res.headers.location);
}

async function callback(query: Record<string, string>): Promise<string> {
  const res = await temp.app.inject({
    method: "GET",
    url: `/api/oauth/google/callback?${new URLSearchParams(query).toString()}`,
  });
  expect(res.statusCode).toBe(302);
  return String(res.headers.location);
}

async function link(accountId: number): Promise<string> {
  const { code, state } = google.approve(await start(accountId));
  return callback({ code, state });
}

function account(id: number) {
  return temp.db.get<Record<string, unknown>>("SELECT * FROM accounts WHERE id = ?", id) ?? {};
}

beforeEach(async () => {
  google = await new FakeGoogle().init();
  now = Date.now();
  temp = await createWave1App({}, { fetch: google.fetch, now: () => now });
});

afterEach(async () => {
  await temp.close();
});

describe("GET /api/oauth/google/start", () => {
  it("redirects to Google with PKCE, offline access and a stored single-use state", async () => {
    const id = await createAccount("main");
    const url = new URL(await start(id));
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const params = Object.fromEntries(url.searchParams);
    expect(params).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uri: "https://cellar.example.test/api/oauth/google/callback",
      response_type: "code",
      scope: "openid email https://www.googleapis.com/auth/youtube.readonly",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      code_challenge_method: "S256",
    });
    expect(params["code_challenge"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params["state"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = getKv<{ accountId: number; codeVerifier: string; expiresAt: number }>(
      temp.db,
      `oauth_state:${String(params["state"])}`,
    );
    expect(stored?.accountId).toBe(id);
    expect(stored?.expiresAt).toBe(now + STATE_TTL_MS);
    // The client secret never appears in the browser-facing URL.
    expect(url.toString()).not.toContain("test-client-secret");
  });

  it("purges expired states when a new flow starts", async () => {
    const id = await createAccount();
    const first = new URL(await start(id)).searchParams.get("state");
    now += STATE_TTL_MS + 1;
    await start(id);
    expect(getKv(temp.db, `oauth_state:${String(first)}`)).toBeUndefined();
  });

  it("answers 404 for an unknown account and 400 for a bad id", async () => {
    let res = await temp.app.inject({ method: "GET", url: "/api/oauth/google/start?account=42" });
    expect(res.statusCode).toBe(404);
    res = await temp.app.inject({ method: "GET", url: "/api/oauth/google/start?account=abc" });
    expect(res.statusCode).toBe(400);
  });

  it("answers 409 when the OAuth client is not configured", async () => {
    await temp.close();
    temp = await createWave1App({ GOOGLE_CLIENT_SECRET: "" }, { fetch: google.fetch });
    const id = await createAccount();
    const res = await temp.app.inject({
      method: "GET",
      url: `/api/oauth/google/start?account=${String(id)}`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/GOOGLE_CLIENT_ID/);
  });
});

describe("GET /api/oauth/google/callback", () => {
  it("links the account: refresh token encrypted, identity, channel, label", async () => {
    const id = await createAccount();
    expect(await link(id)).toBe(`/accounts?linked=${String(id)}`);

    const row = account(id);
    expect(row["google_sub"]).toBe("google-sub-1");
    expect(row["email"]).toBe("owner@example.com");
    expect(row["channel_id"]).toBe("UCFakeAccountChannel0001");
    expect(row["label"]).toBe("Fake Account");
    expect(row["status"]).toBe("pending"); // no cookie jar yet
    expect(row["last_api_ok_at"]).toBe(now);

    const secret = temp.db.get<{ ciphertext: Uint8Array }>(
      "SELECT ciphertext FROM account_secrets WHERE account_id = ? AND kind = 'oauth_refresh'",
      id,
    );
    expect(Buffer.from(secret?.ciphertext ?? []).toString("utf8")).not.toContain(
      "refresh-from-exchange",
    );
    expect(readSecret(temp.config, temp.db, id, "oauth_refresh")?.plaintext).toBe(
      "refresh-from-exchange",
    );
    // channels.list with the freshly issued token, charged to the quota.
    const apiCall = google.apiCalls()[0];
    expect(apiCall?.url.searchParams.get("mine")).toBe("true");
    expect(apiCall?.url.searchParams.get("part")).toBe("snippet");
    expect(apiUsage({ db: temp.db }).used).toBe(1);
    expect(google.calls.filter((c) => c.url.pathname === "/token")).toHaveLength(1);

    const list = await temp.app.inject({ method: "GET", url: "/api/accounts" });
    expect(AccountRowSchema.parse(list.json().rows[0])).toMatchObject({ id, status: "pending" });
  });

  it("keeps an owner-chosen label and becomes ok when a validated jar exists", async () => {
    const id = await createAccount("Mine");
    storeSecret(temp.config, temp.db, id, "cookies", "# Netscape HTTP Cookie File\n", now);
    temp.db.run("UPDATE accounts SET last_cookie_ok_at = 1, status = 'auth_lost' WHERE id = ?", id);
    await link(id);
    expect(account(id)).toMatchObject({ label: "Mine", status: "ok" });
  });

  it("does not resurrect a disabled account", async () => {
    const disabled = await createAccount("d");
    temp.db.run("UPDATE accounts SET status = 'disabled' WHERE id = ?", disabled);
    await link(disabled);
    expect(account(disabled)["status"]).toBe("disabled");
  });

  it("uses the email as the label when the account has no channel", async () => {
    google.api["channels"] = () => jsonResponse(200, { items: [] });
    const id = await createAccount();
    await link(id);
    expect(account(id)).toMatchObject({ label: "owner@example.com", channel_id: null });
  });

  it("still links when the channel lookup fails", async () => {
    google.api["channels"] = () => jsonResponse(500, { error: { code: 500 } });
    const id = await createAccount();
    expect(await link(id)).toBe(`/accounts?linked=${String(id)}`);
    expect(account(id)).toMatchObject({ label: "owner@example.com", channel_id: null });
  });

  it("is single use: replaying the state fails", async () => {
    const id = await createAccount();
    const { code, state } = google.approve(await start(id));
    expect(await callback({ code, state })).toBe(`/accounts?linked=${String(id)}`);
    expect(await callback({ code, state })).toBe("/accounts?error=state");
  });

  it("rejects unknown, missing and expired states", async () => {
    expect(await callback({ code: "x", state: "nope" })).toBe("/accounts?error=state");
    expect(await callback({ code: "x" })).toBe("/accounts?error=state");
    const id = await createAccount();
    const { code, state } = google.approve(await start(id));
    now += STATE_TTL_MS + 1;
    expect(await callback({ code, state })).toBe("/accounts?error=state");
  });

  it("maps Google's error parameter to a code and never echoes its text", async () => {
    const id = await createAccount();
    let { state } = google.approve(await start(id));
    expect(await callback({ state, error: "access_denied", error_description: "<b>no</b>" })).toBe(
      "/accounts?error=denied",
    );
    ({ state } = google.approve(await start(id)));
    const location = await callback({ state, error: "server_error<script>" });
    expect(location).toBe("/accounts?error=google_error");
  });

  it("fails cleanly on a missing code or a refused exchange", async () => {
    const id = await createAccount();
    let { state } = google.approve(await start(id));
    expect(await callback({ state })).toBe("/accounts?error=missing_code");

    ({ state } = google.approve(await start(id)));
    expect(await callback({ code: "not-issued", state })).toBe("/accounts?error=token_exchange");

    google.exchange = { status: 500 };
    const approved = google.approve(await start(id));
    expect(await callback(approved)).toBe("/accounts?error=token_exchange");
  });

  it("requires a refresh token, the YouTube scope and an id_token", async () => {
    const id = await createAccount();
    google.exchange = { refreshToken: null };
    expect(await link(id)).toBe("/accounts?error=no_refresh_token");
    google.exchange = { scope: "openid email" };
    expect(await link(id)).toBe("/accounts?error=scope");
    google.exchange = { idToken: null };
    expect(await link(id)).toBe("/accounts?error=token_exchange");
    expect(account(id)["google_sub"]).toBeNull();
    expect(readSecret(temp.config, temp.db, id, "oauth_refresh")).toBeNull();
  });

  it("rejects an id_token for another audience, issuer or key", async () => {
    const id = await createAccount();
    google.exchange = { idToken: () => google.idToken({ aud: "someone-else" }) };
    expect(await link(id)).toBe("/accounts?error=id_token");
    google.exchange = { idToken: () => google.idToken({ iss: "https://evil.example" }) };
    expect(await link(id)).toBe("/accounts?error=id_token");
    const other = await new FakeGoogle().init();
    google.exchange = { idToken: () => other.idToken() };
    expect(await link(id)).toBe("/accounts?error=id_token");
    google.exchange = { idToken: async () => "not.a.jwt" };
    expect(await link(id)).toBe("/accounts?error=id_token");
  });

  it("refuses to link one Google account to two Cellar accounts", async () => {
    const first = await createAccount("a");
    const second = await createAccount("b");
    await link(first);
    expect(await link(second)).toBe("/accounts?error=already_linked");
    expect(readSecret(temp.config, temp.db, second, "oauth_refresh")).toBeNull();
  });

  it("re-linking the same account replaces the grant", async () => {
    const id = await createAccount();
    await link(id);
    google.exchange = { refreshToken: "refresh-second" };
    expect(await link(id)).toBe(`/accounts?linked=${String(id)}`);
    expect(readSecret(temp.config, temp.db, id, "oauth_refresh")?.plaintext).toBe("refresh-second");
  });

  it("reports an account deleted mid-flow", async () => {
    const id = await createAccount();
    const approved = google.approve(await start(id));
    await temp.app.inject({ method: "DELETE", url: `/api/accounts/${String(id)}` });
    expect(await callback(approved)).toBe("/accounts?error=account_missing");
  });

  it("reports a missing secret key or OAuth client at callback time", async () => {
    const id = seedLinkedAccount(temp.db);
    const approved = google.approve(await start(id));
    (temp.config as { secretKey: Buffer | null }).secretKey = null;
    expect(await callback(approved)).toBe("/accounts?error=secret_key");
    const again = google.approve(await start(id));
    (temp.config as { google: unknown }).google = null;
    expect(await callback(again)).toBe("/accounts?error=not_configured");
  });

  it("fetches Google's signing keys through the injected fetch", async () => {
    const id = await createAccount();
    await link(id);
    expect(google.calls.some((call) => call.url.pathname === "/oauth2/v3/certs")).toBe(true);
  });

  it("tolerates a token response without expires_in, but not without the scope", async () => {
    const id = await createAccount();
    google.exchange = { omitExpiry: true };
    expect(await link(id)).toBe(`/accounts?linked=${String(id)}`);
    google.exchange = { scope: null };
    expect(await link(id)).toBe("/accounts?error=scope");
  });

  it("rejects an id_token without a subject", async () => {
    const id = await createAccount();
    google.exchange = { idToken: () => google.idToken({ sub: "" }) };
    expect(await link(id)).toBe("/accounts?error=id_token");
  });

  it("leaves the label empty when there is neither a channel title nor an email", async () => {
    google.exchange = { email: null };
    google.api["channels"] = () => jsonResponse(200, { items: [{ id: "UCx", snippet: {} }] });
    const a = await createAccount();
    await link(a);
    expect(account(a)).toMatchObject({ label: "", email: null, channel_id: "UCx" });

    google.exchange = { email: null, sub: "google-sub-2" };
    google.api["channels"] = () => jsonResponse(500, {});
    const b = await createAccount();
    await link(b);
    expect(account(b)).toMatchObject({ label: "", email: null });
  });

  it("redirects with error=internal on an unexpected failure", async () => {
    const id = await createAccount();
    const approved = google.approve(await start(id));
    Object.defineProperty(temp.config, "google", {
      get() {
        throw new Error("boom");
      },
    });
    expect(await callback(approved)).toBe("/accounts?error=internal");
  });

  it("rejects malformed query strings as a state failure", async () => {
    const res = await temp.app.inject({
      method: "GET",
      url: `/api/oauth/google/callback?state=${"x".repeat(600)}`,
    });
    expect(res.headers.location).toBe("/accounts?error=state");
  });

  it("only ever redirects with codes from the closed list", () => {
    expect(OAUTH_ERROR_CODES).toContain("state");
    for (const code of OAUTH_ERROR_CODES) {
      expect(code).toMatch(/^[a-z_]+$/);
    }
  });
});
