import { z } from "zod";
import { AccountRowSchema, AccountsListResponseSchema, type AccountRow } from "@cellar/shared";
import type { ApiClient } from "./client.ts";

/**
 * Accounts API. Functions take the client rather than living on it, so this
 * page's endpoints do not have to be threaded through the shared client.
 *
 * `scrape_budget_per_hour` is read leniently: the shared AccountRow does not
 * carry it yet, and the edit dialog only prefills it when the server sends it.
 */
export const AccountViewSchema = AccountRowSchema.extend({
  scrape_budget_per_hour: z.number().int().positive().nullable().optional(),
});
export type AccountView = z.infer<typeof AccountViewSchema>;

const ListSchema = AccountsListResponseSchema.extend({ rows: z.array(AccountViewSchema) });

export const CookieValidationSchema = z.object({
  ok: z.boolean(),
  detail: z.string().nullish(),
});
export type CookieValidation = z.infer<typeof CookieValidationSchema>;

export const CookieUploadResponseSchema = z.object({
  account: AccountViewSchema,
  validation: CookieValidationSchema,
});
export type CookieUploadResponse = z.infer<typeof CookieUploadResponseSchema>;

export interface AccountUpdate {
  label?: string;
  status?: "disabled" | "pending";
  /** Null clears the per-account budget back to the global default. */
  scrape_budget_per_hour?: number | null;
}

export async function listAccounts(api: ApiClient, signal?: AbortSignal): Promise<AccountView[]> {
  const result = await api.request("/api/accounts", { schema: ListSchema, signal });
  return result.rows;
}

export function createAccount(api: ApiClient, label: string): Promise<AccountView> {
  return api.request("/api/accounts", {
    method: "POST",
    body: { label },
    schema: AccountViewSchema,
  });
}

export function updateAccount(
  api: ApiClient,
  id: number,
  patch: AccountUpdate,
): Promise<AccountView> {
  return api.request(`/api/accounts/${id}`, {
    method: "PUT",
    body: patch,
    schema: AccountViewSchema,
  });
}

export function deleteAccount(api: ApiClient, id: number): Promise<void> {
  return api.request(`/api/accounts/${id}`, { method: "DELETE" });
}

export function uploadCookies(
  api: ApiClient,
  id: number,
  cookies: string,
): Promise<CookieUploadResponse> {
  return api.request(`/api/accounts/${id}/cookies`, {
    method: "POST",
    body: { cookies },
    schema: CookieUploadResponseSchema,
  });
}

/** Where the Google consent flow starts for one account. */
export function oauthStartUrl(api: ApiClient, id: number): string {
  return `${api.baseUrl}/api/oauth/google/start?account=${encodeURIComponent(String(id))}`;
}

/**
 * Full-page navigation, not fetch: the server answers with a redirect to
 * Google's consent screen, and the callback redirects back to /accounts.
 */
export function startGoogleLink(api: ApiClient, id: number): void {
  window.location.assign(oauthStartUrl(api, id));
}

/** Toast copy for each `?error=` code the OAuth callback can send back. */
export const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  config_missing:
    "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set. Add them to the .env and redeploy.",
  state_invalid: "The sign-in link expired or was already used. Start linking again.",
  exchange_failed: "Google did not accept the sign-in code. Try linking again.",
  denied: "Access was not granted on the Google consent screen.",
  token_invalid: "Google returned a token cellar could not use. Try linking again.",
  api_failed:
    "Signed in, but the YouTube Data API call failed. Check that the API is enabled for the project.",
};

export function oauthErrorMessage(code: string): string {
  return OAUTH_ERROR_MESSAGES[code] ?? `Linking failed (${code}).`;
}

export type AccountStatus = AccountRow["status"];

export const ACCOUNT_STATUS: Record<
  AccountStatus,
  { label: string; severity: "success" | "info" | "warn" | "danger" | "secondary"; hint: string }
> = {
  ok: { label: "OK", severity: "success", hint: "API and cookies both work." },
  pending: {
    label: "Pending",
    severity: "info",
    hint: "Needs both a Google link and a validated cookie jar.",
  },
  auth_lost: {
    label: "Google link lost",
    severity: "danger",
    hint: "Google rejected the stored grant. Re-link the account.",
  },
  cookies_invalid: {
    label: "Cookies invalid",
    severity: "warn",
    hint: "YouTube rejected the cookie jar. Export fresh cookies.",
  },
  disabled: { label: "Disabled", severity: "secondary", hint: "Not used for any work." },
};
