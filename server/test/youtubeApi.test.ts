import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.ts";
import { readSecret } from "../src/domain/accountStore.ts";
import type { ServiceDeps } from "../src/domain/deps.ts";
import { DomainError } from "../src/domain/errors.ts";
import { updateSettings } from "../src/domain/settings.ts";
import { createConsoleLogger } from "../src/logging.ts";
import {
  clearAccessToken,
  getAccessToken,
  googleErrorReason,
  youtubeApi,
  YoutubeApiError,
} from "../src/youtube/api.ts";
import { apiUsage, accountApiUnits, QuotaExhausted } from "../src/youtube/quota.ts";
import { createTempDb, TEST_SECRET_KEY, type TempDb } from "./helpers.ts";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  FakeGoogle,
  fixture,
  jsonResponse,
  seedLinkedAccount,
} from "./wave1aHelpers.ts";

const log = createConsoleLogger("silent");

let temp: TempDb;
let google: FakeGoogle;
let now: number;
let config: Config;

function deps(overrides: Partial<ServiceDeps> = {}): ServiceDeps {
  return { config, db: temp.db, log, fetch: google.fetch, now: () => now, ...overrides };
}

function status(id: number): string {
  return (
    temp.db.get<{ status: string }>("SELECT status FROM accounts WHERE id = ?", id)?.status ?? ""
  );
}

beforeEach(async () => {
  temp = createTempDb();
  google = await new FakeGoogle().init();
  now = Date.UTC(2026, 9, 18, 12);
  config = loadConfig({
    INSECURE_ALLOW_PUBLIC_ACCESS: "1",
    DATA_DIR: temp.dir,
    CELLAR_SECRET_KEY: TEST_SECRET_KEY,
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
  });
});

afterEach(() => {
  temp.close();
});

describe("getAccessToken", () => {
  it("refreshes once and caches until a minute before expiry", async () => {
    const id = seedLinkedAccount(temp.db);
    const first = await getAccessToken(deps(), id);
    expect(await getAccessToken(deps(), id)).toBe(first);
    expect(google.calls).toHaveLength(1);
    const form = new URLSearchParams(google.calls[0]?.body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("refresh-good");
    // The refresh token travels in the POST body, never in the URL.
    expect(google.calls[0]?.url.search).toBe("");

    now += 3599_000 - 60_000 + 1;
    const second = await getAccessToken(deps(), id);
    expect(second).not.toBe(first);
    expect(google.calls).toHaveLength(2);
  });

  it("shares one refresh between concurrent callers and honours force", async () => {
    const id = seedLinkedAccount(temp.db);
    const [a, b] = await Promise.all([getAccessToken(deps(), id), getAccessToken(deps(), id)]);
    expect(a).toBe(b);
    expect(google.calls).toHaveLength(1);
    expect(await getAccessToken(deps(), id, { force: true })).not.toBe(a);
  });

  it("marks the account auth_lost on invalid_grant", async () => {
    const id = seedLinkedAccount(temp.db, { refreshToken: "refresh-revoked" });
    google.revokedRefreshTokens.add("refresh-revoked");
    const error = await getAccessToken(deps(), id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).status).toBe(412);
    expect((error as DomainError).message).not.toContain("refresh-revoked");
    expect(status(id)).toBe("auth_lost");
  });

  it("does not override a disabled account", async () => {
    const id = seedLinkedAccount(temp.db, { status: "disabled", refreshToken: "r" });
    google.revokedRefreshTokens.add("r");
    await expect(getAccessToken(deps(), id)).rejects.toThrow(DomainError);
    expect(status(id)).toBe("disabled");
  });

  it("reports other token endpoint failures without touching the status", async () => {
    const id = seedLinkedAccount(temp.db);
    google.refreshStatus = 503;
    await expect(getAccessToken(deps(), id)).rejects.toThrow(YoutubeApiError);
    expect(status(id)).toBe("ok");
  });

  it("stores a rotated refresh token and copes with a missing expiry", async () => {
    const id = seedLinkedAccount(temp.db);
    const fetch: ServiceDeps["fetch"] = async () =>
      jsonResponse(200, { access_token: "tok", refresh_token: "rotated" });
    expect(await getAccessToken(deps({ fetch }), id)).toBe("tok");
    expect(readSecret(config, temp.db, id, "oauth_refresh")?.plaintext).toBe("rotated");
  });

  it("rejects a success body without an access token", async () => {
    const id = seedLinkedAccount(temp.db);
    const fetch: ServiceDeps["fetch"] = async () => new Response("not json", { status: 200 });
    await expect(getAccessToken(deps({ fetch }), id)).rejects.toThrow(/no_access_token/);
  });

  it("needs the OAuth client, an account and a stored grant", async () => {
    const id = seedLinkedAccount(temp.db);
    const unconfigured = loadConfig({ INSECURE_ALLOW_PUBLIC_ACCESS: "1", DATA_DIR: temp.dir });
    await expect(getAccessToken(deps({ config: unconfigured }), id)).rejects.toThrow(
      /not configured/,
    );
    const noSecret = loadConfig({
      INSECURE_ALLOW_PUBLIC_ACCESS: "1",
      DATA_DIR: temp.dir,
      GOOGLE_CLIENT_ID: CLIENT_ID,
    });
    await expect(getAccessToken(deps({ config: noSecret }), id)).rejects.toThrow(/not configured/);
    await expect(getAccessToken(deps(), 999)).rejects.toThrow(/does not exist/);
    const bare = temp.db.run(
      "INSERT INTO accounts (label, status, created_at, updated_at) VALUES ('x', 'pending', 0, 0)",
    ).lastInsertRowid;
    await expect(getAccessToken(deps(), bare)).rejects.toThrow(/not linked/);
  });
});

describe("youtubeApi", () => {
  it("calls the API with a bearer token, charges quota and stamps last_api_ok_at", async () => {
    const id = seedLinkedAccount(temp.db);
    const body = await youtubeApi(deps(), id).get<{ items: { id: string }[] }>("channels", {
      part: ["id", "snippet"],
      mine: true,
      skipped: undefined,
    });
    expect(body.items[0]?.id).toBe("UCFakeAccountChannel0001");
    const call = google.apiCalls()[0];
    expect(call?.url.pathname).toBe("/youtube/v3/channels");
    expect(call?.url.searchParams.get("part")).toBe("id,snippet");
    expect(call?.url.searchParams.get("mine")).toBe("true");
    expect(call?.url.searchParams.has("skipped")).toBe(false);
    expect(call?.url.searchParams.has("access_token")).toBe(false);
    expect(call?.headers.get("authorization")).toMatch(/^Bearer access-/);
    expect(accountApiUnits(deps(), id)).toBe(1);
    expect(apiUsage(deps()).used).toBe(1);
    expect(
      temp.db.get<{ last_api_ok_at: number }>(
        "SELECT last_api_ok_at FROM accounts WHERE id = ?",
        id,
      )?.last_api_ok_at,
    ).toBe(now);
  });

  it("charges explicit unit costs, else the table, else 1", async () => {
    const id = seedLinkedAccount(temp.db);
    await youtubeApi(deps(), id).get("/channels", { part: "id" }, 3);
    expect(apiUsage(deps()).used).toBe(3);
    await expect(youtubeApi(deps(), id).get("activities", { mine: true })).rejects.toThrow(
      YoutubeApiError,
    );
    expect(apiUsage(deps()).used).toBe(4);
  });

  it("never calls search.list and rejects malformed paths", async () => {
    const id = seedLinkedAccount(temp.db);
    const api = youtubeApi(deps(), id);
    await expect(api.get("search", { q: "x" })).rejects.toThrow(/search\.list is never called/);
    await expect(api.get("Search/list", {})).rejects.toThrow(/never called/);
    await expect(api.get("../oauth2/v3/userinfo", {})).rejects.toThrow(/Unknown YouTube API path/);
    await expect(api.get("", {})).rejects.toThrow(/Unknown/);
    expect(google.calls).toHaveLength(0);
    expect(apiUsage(deps()).used).toBe(0);
  });

  it("refuses when the project budget is spent, before any network call", async () => {
    const id = seedLinkedAccount(temp.db);
    updateSettings(temp.db, { "quota.api_units_per_day": 1 });
    await youtubeApi(deps(), id).get("channels", { part: "id" });
    await expect(youtubeApi(deps(), id).get("channels", { part: "id" })).rejects.toThrow(
      QuotaExhausted,
    );
    expect(google.apiCalls()).toHaveLength(1);
  });

  it("retries a 401 once with a fresh token", async () => {
    const id = seedLinkedAccount(temp.db);
    const stale = await getAccessToken(deps(), id);
    google.validAccessTokens.delete(stale);
    await youtubeApi(deps(), id).get("channels", { part: "id", mine: true });
    expect(google.apiCalls()).toHaveLength(2);
    expect(status(id)).toBe("ok");
  });

  it("marks auth_lost when the API keeps rejecting the credentials", async () => {
    const id = seedLinkedAccount(temp.db);
    google.api["channels"] = () => jsonResponse(401, fixture("error.invalidCredentials.json"));
    const error = await youtubeApi(deps(), id)
      .get("channels", { part: "id", mine: true })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect(status(id)).toBe("auth_lost");
    expect(google.apiCalls()).toHaveLength(2);
  });

  it("treats Google's quotaExceeded as exhaustion for the rest of the day", async () => {
    const id = seedLinkedAccount(temp.db);
    google.api["videos"] = () => jsonResponse(403, fixture("error.quotaExceeded.json"));
    await expect(youtubeApi(deps(), id).get("videos", { id: "x" })).rejects.toThrow(QuotaExhausted);
    expect(apiUsage(deps()).remaining).toBe(0);
    temp.db.run("DELETE FROM quota_usage");
    google.api["videos"] = () =>
      jsonResponse(403, { error: { code: 403, errors: [{ reason: "dailyLimitExceeded" }] } });
    await expect(youtubeApi(deps(), id).get("videos", { id: "x" })).rejects.toThrow(QuotaExhausted);
  });

  it("surfaces other API errors with the status and reason only", async () => {
    const id = seedLinkedAccount(temp.db);
    google.api["playlistItems"] = () =>
      jsonResponse(404, { error: { code: 404, errors: [{ reason: "playlistNotFound" }] } });
    const error = await youtubeApi(deps(), id)
      .get("playlistItems", { playlistId: "UUx" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(YoutubeApiError);
    expect((error as YoutubeApiError).status).toBe(404);
    expect((error as YoutubeApiError).reason).toBe("playlistNotFound");
    expect((error as Error).message).not.toMatch(/access-/);
  });

  it("clearAccessToken drops one account or the whole database cache", async () => {
    const a = seedLinkedAccount(temp.db);
    const b = seedLinkedAccount(temp.db);
    await getAccessToken(deps(), a);
    await getAccessToken(deps(), b);
    clearAccessToken(temp.db, a);
    await getAccessToken(deps(), a);
    await getAccessToken(deps(), b);
    expect(google.calls).toHaveLength(3);
    clearAccessToken(temp.db);
    await getAccessToken(deps(), b);
    expect(google.calls).toHaveLength(4);
  });
});

describe("googleErrorReason", () => {
  it("reads OAuth and API error shapes", () => {
    expect(googleErrorReason({ error: "invalid_grant" })).toBe("invalid_grant");
    expect(googleErrorReason(fixture("error.quotaExceeded.json"))).toBe("quotaExceeded");
    expect(googleErrorReason({ error: { status: "PERMISSION_DENIED" } })).toBe("PERMISSION_DENIED");
    expect(googleErrorReason({ error: { errors: [{}] } })).toBeNull();
    expect(googleErrorReason(null)).toBeNull();
    expect(googleErrorReason("x")).toBeNull();
  });
});
