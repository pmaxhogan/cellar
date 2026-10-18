import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { getKv, setKv } from "../db/kv.ts";
import { assertAccountExists, settleAfterOAuth, storeSecret } from "../domain/accountStore.ts";
import { fetchOf, nowOf, type ServiceDeps } from "../domain/deps.ts";
import { conflict, isUniqueViolation } from "../domain/errors.ts";
import { isUsableSecretKey } from "../security/secrets.ts";
import { cacheAccessToken, GOOGLE_TOKEN_URL, youtubeApi } from "./api.ts";

/**
 * Google OAuth 2.0 web flow (authorization code + PKCE S256) that links a
 * Cellar account to a Google account. The refresh token is the only thing
 * kept, encrypted in account_secrets. The `state` row in kv is single use and
 * expires after ten minutes.
 */

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
export const YOUTUBE_READONLY_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
export const OAUTH_SCOPES = ["openid", "email", YOUTUBE_READONLY_SCOPE] as const;
export const OAUTH_CALLBACK_PATH = "/api/oauth/google/callback";
export const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_PREFIX = "oauth_state:";

/** Google's signing keys are fetched through `deps.fetch` too, so tests need one seam. */
export type OAuthDeps = ServiceDeps;

/**
 * The closed set of failure codes the callback may put in its redirect. Never
 * Google's own error text.
 */
export const OAUTH_ERROR_CODES = [
  "state",
  "denied",
  "google_error",
  "missing_code",
  "not_configured",
  "secret_key",
  "account_missing",
  "token_exchange",
  "no_refresh_token",
  "scope",
  "id_token",
  "already_linked",
] as const;
export type OAuthErrorCode = (typeof OAUTH_ERROR_CODES)[number];

export class OAuthFailure extends Error {
  override readonly name = "OAuthFailure";
  readonly code: OAuthErrorCode;

  constructor(code: OAuthErrorCode) {
    super(`Google account linking failed: ${code}.`);
    this.code = code;
  }
}

interface StoredState {
  accountId: number;
  codeVerifier: string;
  expiresAt: number;
}

export function redirectUri(deps: Pick<ServiceDeps, "config">): string {
  return `${deps.config.publicOrigin}${OAUTH_CALLBACK_PATH}`;
}

function googleClient(
  deps: Pick<ServiceDeps, "config">,
): { clientId: string; clientSecret: string } | null {
  const google = deps.config.google;
  return google === null || google.clientSecret === null
    ? null
    : { clientId: google.clientId, clientSecret: google.clientSecret };
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

/** Remove state rows past their expiry, so abandoned consent screens do not pile up. */
function purgeExpiredStates(deps: ServiceDeps, now: number): void {
  const rows = deps.db.all<{ key: string }>("SELECT key FROM kv WHERE key LIKE 'oauth_state:%'");
  for (const { key } of rows) {
    const state = getKv<StoredState>(deps.db, key);
    if (state === undefined || typeof state.expiresAt !== "number" || state.expiresAt <= now) {
      deps.db.run("DELETE FROM kv WHERE key = ?", key);
    }
  }
}

/**
 * Begin consent for an account: store a fresh state + PKCE verifier and
 * return Google's authorization URL. 409 when the OAuth client is not
 * configured, 404 for an unknown account.
 */
export function startOAuth(deps: ServiceDeps, accountId: number): string {
  const client = googleClient(deps);
  if (client === null) {
    throw conflict(
      "Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET and redeploy.",
    );
  }
  assertAccountExists(deps.db, accountId);
  const now = nowOf(deps);
  purgeExpiredStates(deps, now);

  const state = base64url(randomBytes(32));
  const codeVerifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(codeVerifier).digest());
  const stored: StoredState = { accountId, codeVerifier, expiresAt: now + STATE_TTL_MS };
  setKv(deps.db, `${STATE_PREFIX}${state}`, stored, now);

  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", redirectUri(deps));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", OAUTH_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** Look up and delete the state row. Single use: it is gone before any network call. */
function takeState(deps: ServiceDeps, state: string | undefined, now: number): StoredState {
  if (state === undefined || state === "" || state.length > 200) {
    throw new OAuthFailure("state");
  }
  const key = `${STATE_PREFIX}${state}`;
  const stored = getKv<StoredState>(deps.db, key);
  deps.db.run("DELETE FROM kv WHERE key = ?", key);
  if (
    stored === undefined ||
    typeof stored.accountId !== "number" ||
    typeof stored.codeVerifier !== "string" ||
    typeof stored.expiresAt !== "number" ||
    stored.expiresAt <= now
  ) {
    throw new OAuthFailure("state");
  }
  return stored;
}

interface TokenResponse {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  idToken: string;
  scopes: string[];
}

async function exchangeCode(
  deps: ServiceDeps,
  client: { clientId: string; clientSecret: string },
  code: string,
  codeVerifier: string,
): Promise<TokenResponse> {
  let body: Record<string, unknown>;
  try {
    const response = await fetchOf(deps)(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        redirect_uri: redirectUri(deps),
      }).toString(),
    });
    body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      deps.log.warn({ status: response.status }, "google token exchange refused");
      throw new OAuthFailure("token_exchange");
    }
  } catch (error) {
    if (error instanceof OAuthFailure) {
      throw error;
    }
    deps.log.warn({ err: error }, "google token exchange failed");
    throw new OAuthFailure("token_exchange");
  }
  const { access_token, expires_in, refresh_token, id_token, scope } = body;
  if (typeof access_token !== "string" || typeof id_token !== "string") {
    throw new OAuthFailure("token_exchange");
  }
  if (typeof refresh_token !== "string" || refresh_token === "") {
    throw new OAuthFailure("no_refresh_token");
  }
  return {
    accessToken: access_token,
    expiresIn: typeof expires_in === "number" ? expires_in : 3600,
    refreshToken: refresh_token,
    idToken: id_token,
    scopes: typeof scope === "string" ? scope.split(/\s+/) : [],
  };
}

async function verifyIdToken(
  deps: OAuthDeps,
  idToken: string,
  clientId: string,
): Promise<{ sub: string; email: string | null }> {
  const keys = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL), {
    [customFetch]: fetchOf(deps),
  });
  try {
    const { payload } = await jwtVerify(idToken, keys, {
      issuer: GOOGLE_ISSUERS,
      audience: clientId,
      algorithms: ["RS256"],
      clockTolerance: 30,
    });
    if (typeof payload.sub !== "string" || payload.sub === "") {
      throw new OAuthFailure("id_token");
    }
    const email = typeof payload["email"] === "string" ? payload["email"] : null;
    return { sub: payload.sub, email };
  } catch (error) {
    if (!(error instanceof OAuthFailure)) {
      deps.log.warn({ err: error }, "google id_token did not verify");
    }
    throw new OAuthFailure("id_token");
  }
}

interface ChannelsMineResponse {
  items?: { id?: string; snippet?: { title?: string } }[];
}

export interface OAuthCallbackQuery {
  code?: string | undefined;
  state?: string | undefined;
  error?: string | undefined;
}

/**
 * Complete the flow: validate state, exchange the code, verify the id_token,
 * store the refresh token, then look up the account's own channel (best
 * effort). Resolves the linked account id; every failure is an OAuthFailure.
 */
export async function completeOAuth(deps: OAuthDeps, query: OAuthCallbackQuery): Promise<number> {
  const now = nowOf(deps);
  const stored = takeState(deps, query.state, now);
  if (query.error !== undefined) {
    throw new OAuthFailure(query.error === "access_denied" ? "denied" : "google_error");
  }
  if (query.code === undefined || query.code === "") {
    throw new OAuthFailure("missing_code");
  }
  const client = googleClient(deps);
  if (client === null) {
    throw new OAuthFailure("not_configured");
  }
  if (!isUsableSecretKey(deps.config.secretKey)) {
    throw new OAuthFailure("secret_key");
  }
  const accountId = stored.accountId;
  if (deps.db.get("SELECT 1 AS one FROM accounts WHERE id = ?", accountId) === undefined) {
    throw new OAuthFailure("account_missing");
  }

  const tokens = await exchangeCode(deps, client, query.code, stored.codeVerifier);
  if (!tokens.scopes.includes(YOUTUBE_READONLY_SCOPE)) {
    // Granular consent lets the user untick the YouTube scope.
    throw new OAuthFailure("scope");
  }
  const identity = await verifyIdToken(deps, tokens.idToken, client.clientId);

  try {
    deps.db.tx(() => {
      deps.db.run(
        "UPDATE accounts SET google_sub = ?, email = ?, updated_at = ? WHERE id = ?",
        identity.sub,
        identity.email,
        now,
        accountId,
      );
      storeSecret(deps.config, deps.db, accountId, "oauth_refresh", tokens.refreshToken, now);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new OAuthFailure("already_linked");
    }
    throw error;
  }
  cacheAccessToken(deps.db, accountId, tokens.accessToken, tokens.expiresIn, now);

  try {
    const mine = await youtubeApi(deps, accountId).get<ChannelsMineResponse>("channels", {
      part: "snippet",
      mine: true,
    });
    const channel = mine.items?.[0];
    const channelId = typeof channel?.id === "string" ? channel.id : null;
    const title = channel?.snippet?.title;
    deps.db.run(
      `UPDATE accounts SET channel_id = ?,
         label = CASE WHEN trim(label) = '' THEN ? ELSE label END,
         updated_at = ? WHERE id = ?`,
      channelId,
      typeof title === "string" && title !== "" ? title : (identity.email ?? ""),
      now,
      accountId,
    );
  } catch (error) {
    // The grant is stored; the channel lookup can be retried by the self-check.
    deps.log.warn({ err: error, accountId }, "could not read the linked account's channel");
    deps.db.run(
      "UPDATE accounts SET label = CASE WHEN trim(label) = '' THEN ? ELSE label END WHERE id = ?",
      identity.email ?? "",
      accountId,
    );
  }

  settleAfterOAuth(deps.db, accountId, nowOf(deps));
  deps.log.info({ accountId }, "google account linked");
  return accountId;
}
