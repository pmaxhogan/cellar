import type { Db } from "../db/db.ts";
import {
  assertAccountExists,
  markAuthLost,
  readSecret,
  storeSecret,
} from "../domain/accountStore.ts";
import { fetchOf, nowOf, type ServiceDeps } from "../domain/deps.ts";
import { DomainError } from "../domain/errors.ts";
import { chargeApiUnits, markApiBudgetSpent, QuotaExhausted } from "./quota.ts";

/**
 * Authenticated YouTube Data API v3 client. One OAuth client for the whole
 * install; each account has its own refresh token (encrypted in
 * account_secrets). Access tokens live in memory only, per database, until a
 * minute before they expire.
 *
 * Every call is charged to the quota table before it is made, and
 * `search.list` (100 units) is refused outright.
 */

export const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3/";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Google's quota cost table for the calls Cellar makes. Every list call is 1 unit. */
export const API_UNIT_COSTS: Readonly<Record<string, number>> = {
  channels: 1,
  playlistItems: 1,
  playlists: 1,
  subscriptions: 1,
  videos: 1,
  videoCategories: 1,
};

/** Refresh this long before Google's stated expiry. */
const EXPIRY_MARGIN_MS = 60_000;

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new WeakMap<Db, Map<number, CachedToken>>();
const inflight = new WeakMap<Db, Map<number, Promise<string>>>();

function cacheFor<T>(store: WeakMap<Db, Map<number, T>>, db: Db): Map<number, T> {
  let map = store.get(db);
  if (map === undefined) {
    map = new Map();
    store.set(db, map);
  }
  return map;
}

/** Remember an access token Google just issued (the OAuth callback primes this). */
export function cacheAccessToken(
  db: Db,
  accountId: number,
  token: string,
  expiresInSeconds: number,
  now: number,
): void {
  cacheFor(tokenCache, db).set(accountId, { token, expiresAt: now + expiresInSeconds * 1000 });
}

/** Forget cached access tokens: one account, or every account of this database. */
export function clearAccessToken(db: Db, accountId?: number): void {
  if (accountId === undefined) {
    tokenCache.delete(db);
    return;
  }
  tokenCache.get(db)?.delete(accountId);
}

/** A non-2xx answer from Google that is not a quota or auth problem. Never carries a token. */
export class YoutubeApiError extends Error {
  override readonly name = "YoutubeApiError";
  readonly status: number;
  readonly reason: string | null;

  constructor(what: string, status: number, reason: string | null) {
    super(`${what} failed with HTTP ${String(status)}${reason === null ? "" : ` (${reason})`}.`);
    this.status = status;
    this.reason = reason;
  }
}

function authLostError(accountId: number): DomainError {
  return new DomainError(
    "precondition_failed",
    `Google access for account ${String(accountId)} was revoked or has expired. Link it again.`,
    { reason: "auth_lost" },
  );
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

/** The first `errors[].reason` of a Google API error body, or the OAuth `error` string. */
export function googleErrorReason(body: unknown): string | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const error = (body as { error?: unknown }).error;
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && error !== null) {
    const errors = (error as { errors?: unknown }).errors;
    if (Array.isArray(errors) && errors.length > 0) {
      const reason = (errors[0] as { reason?: unknown }).reason;
      if (typeof reason === "string") {
        return reason;
      }
    }
    const status = (error as { status?: unknown }).status;
    if (typeof status === "string") {
      return status;
    }
  }
  return null;
}

function requireGoogle(deps: Pick<ServiceDeps, "config">): {
  clientId: string;
  clientSecret: string;
} {
  const google = deps.config.google;
  if (google === null || google.clientSecret === null) {
    throw new DomainError(
      "precondition_failed",
      "Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
    );
  }
  return { clientId: google.clientId, clientSecret: google.clientSecret };
}

async function refreshAccessToken(deps: ServiceDeps, accountId: number): Promise<string> {
  const { clientId, clientSecret } = requireGoogle(deps);
  assertAccountExists(deps.db, accountId);
  const stored = readSecret(deps.config, deps.db, accountId, "oauth_refresh");
  if (stored === null) {
    throw new DomainError(
      "precondition_failed",
      `Account ${String(accountId)} is not linked to Google yet.`,
      { reason: "not_linked" },
    );
  }
  const response = await fetchOf(deps)(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: stored.plaintext,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });
  const body = await readJson(response);
  const now = nowOf(deps);
  if (!response.ok) {
    const reason = googleErrorReason(body);
    if (reason === "invalid_grant" || reason === "unauthorized_client") {
      markAuthLost(deps.db, accountId, now);
      clearAccessToken(deps.db, accountId);
      deps.log.warn(
        { accountId, reason },
        "google refresh token rejected; account marked auth_lost",
      );
      throw authLostError(accountId);
    }
    throw new YoutubeApiError("Google token refresh", response.status, reason);
  }
  const token = (body as { access_token?: unknown } | null)?.access_token;
  const expiresIn = (body as { expires_in?: unknown } | null)?.expires_in;
  if (typeof token !== "string" || token === "") {
    throw new YoutubeApiError("Google token refresh", response.status, "no_access_token");
  }
  const rotated = (body as { refresh_token?: unknown }).refresh_token;
  if (typeof rotated === "string" && rotated !== "") {
    storeSecret(deps.config, deps.db, accountId, "oauth_refresh", rotated, now);
  }
  cacheAccessToken(
    deps.db,
    accountId,
    token,
    typeof expiresIn === "number" ? expiresIn : 3600,
    now,
  );
  return token;
}

/**
 * A valid access token for the account: the cached one while it has more than
 * a minute left, else a fresh one from the stored refresh token. Concurrent
 * callers share one refresh. `force` skips the cache.
 */
export async function getAccessToken(
  deps: ServiceDeps,
  accountId: number,
  options: { force?: boolean } = {},
): Promise<string> {
  const cached = tokenCache.get(deps.db)?.get(accountId);
  if (
    options.force !== true &&
    cached !== undefined &&
    cached.expiresAt - EXPIRY_MARGIN_MS > nowOf(deps)
  ) {
    return cached.token;
  }
  const pending = cacheFor(inflight, deps.db);
  const running = pending.get(accountId);
  if (running !== undefined) {
    return running;
  }
  const promise = refreshAccessToken(deps, accountId).finally(() => {
    pending.delete(accountId);
  });
  pending.set(accountId, promise);
  return promise;
}

export type ApiParamValue = string | number | boolean | readonly string[] | undefined;
export type ApiParams = Readonly<Record<string, ApiParamValue>>;

export interface YoutubeApi {
  readonly accountId: number;
  /**
   * GET `<base>/<path>` with the params, charging `units` (default from
   * API_UNIT_COSTS, else 1). Resolves the parsed JSON body.
   */
  get<T = unknown>(path: string, params: ApiParams, units?: number): Promise<T>;
}

function buildUrl(path: string, params: ApiParams): URL {
  const url = new URL(path, YOUTUBE_API_BASE);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }
    url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  return url;
}

function normalizePath(path: string): string {
  const trimmed = path.replace(/^\/+/, "");
  if (trimmed === "" || !/^[A-Za-z]+(\/[A-Za-z]+)*$/.test(trimmed)) {
    throw new DomainError("invalid", "Unknown YouTube API path.");
  }
  if (trimmed.split("/")[0]?.toLowerCase() === "search") {
    // 100 units a call; Cellar never spends that.
    throw new DomainError("unsupported", "search.list is never called.");
  }
  return trimmed;
}

/** An API client bound to one account. */
export function youtubeApi(deps: ServiceDeps, accountId: number): YoutubeApi {
  return {
    accountId,
    async get<T = unknown>(path: string, params: ApiParams, units?: number): Promise<T> {
      const clean = normalizePath(path);
      assertAccountExists(deps.db, accountId);
      chargeApiUnits(deps, accountId, units ?? API_UNIT_COSTS[clean] ?? 1);

      const url = buildUrl(clean, params);
      const call = async (token: string): Promise<Response> =>
        fetchOf(deps)(url, {
          headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        });

      let response = await call(await getAccessToken(deps, accountId));
      if (response.status === 401) {
        // The cached token may have been revoked early: one retry with a fresh one.
        clearAccessToken(deps.db, accountId);
        response = await call(await getAccessToken(deps, accountId, { force: true }));
      }
      const body = await readJson(response);
      const now = nowOf(deps);
      if (response.status === 401) {
        markAuthLost(deps.db, accountId, now);
        clearAccessToken(deps.db, accountId);
        deps.log.warn({ accountId, path: clean }, "youtube api rejected credentials; auth_lost");
        throw authLostError(accountId);
      }
      if (!response.ok) {
        const reason = googleErrorReason(body);
        if (
          response.status === 403 &&
          (reason === "quotaExceeded" || reason === "dailyLimitExceeded")
        ) {
          markApiBudgetSpent(deps);
          throw new QuotaExhausted("api", "Google reports the daily YouTube API quota is spent.");
        }
        throw new YoutubeApiError(`YouTube ${clean}.list`, response.status, reason);
      }
      deps.db.run(
        "UPDATE accounts SET last_api_ok_at = ?, updated_at = ? WHERE id = ?",
        now,
        now,
        accountId,
      );
      return body as T;
    },
  };
}
