import type { Config } from "../config.ts";
import type { Db } from "../db/db.ts";
import { decryptSecret, encryptSecret, IV_BYTES, TAG_BYTES } from "../security/secrets.ts";
import { requireSecretKey } from "./deps.ts";
import { notFound } from "./errors.ts";

/**
 * Low level account storage shared by the OAuth flow, the API client and the
 * accounts service: encrypted secrets and the status transitions. Kept apart
 * from domain/accounts.ts so those modules do not import each other.
 */

export type SecretKind = "oauth_refresh" | "cookies";

/** The value set of `accounts.status`, exactly the AccountRow enum. */
export const ACCOUNT_STATUSES = [
  "pending",
  "ok",
  "auth_lost",
  "cookies_invalid",
  "disabled",
] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/** Anything outside the enum (the migration default `new`) reads as pending. */
export function normalizeStatus(raw: unknown): AccountStatus {
  return typeof raw === "string" && (ACCOUNT_STATUSES as readonly string[]).includes(raw)
    ? (raw as AccountStatus)
    : "pending";
}

export function assertAccountExists(db: Db, accountId: number): void {
  if (db.get("SELECT 1 AS one FROM accounts WHERE id = ?", accountId) === undefined) {
    throw notFound("Account", accountId);
  }
}

/** Encrypt and upsert one secret. The blob is split into the iv/tag/ciphertext columns. */
export function storeSecret(
  config: Pick<Config, "secretKey">,
  db: Db,
  accountId: number,
  kind: SecretKind,
  plaintext: string,
  now: number,
): void {
  const blob = encryptSecret(requireSecretKey(config), plaintext);
  db.run(
    `INSERT INTO account_secrets (account_id, kind, ciphertext, iv, tag, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (account_id, kind) DO UPDATE SET ciphertext = excluded.ciphertext,
       iv = excluded.iv, tag = excluded.tag, updated_at = excluded.updated_at`,
    accountId,
    kind,
    blob.subarray(IV_BYTES + TAG_BYTES),
    blob.subarray(0, IV_BYTES),
    blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES),
    now,
  );
}

export interface StoredSecret {
  plaintext: string;
  updatedAt: number;
}

/** Decrypt one secret, or null when the account has none of that kind. */
export function readSecret(
  config: Pick<Config, "secretKey">,
  db: Db,
  accountId: number,
  kind: SecretKind,
): StoredSecret | null {
  const row = db.get<{
    ciphertext: Uint8Array;
    iv: Uint8Array;
    tag: Uint8Array;
    updated_at: number;
  }>(
    "SELECT ciphertext, iv, tag, updated_at FROM account_secrets WHERE account_id = ? AND kind = ?",
    accountId,
    kind,
  );
  if (row === undefined) {
    return null;
  }
  const blob = Buffer.concat([
    Buffer.from(row.iv),
    Buffer.from(row.tag),
    Buffer.from(row.ciphertext),
  ]);
  return {
    plaintext: decryptSecret(requireSecretKey(config), blob),
    updatedAt: Number(row.updated_at),
  };
}

export function hasSecret(db: Db, accountId: number, kind: SecretKind): boolean {
  return (
    db.get(
      "SELECT 1 AS one FROM account_secrets WHERE account_id = ? AND kind = ?",
      accountId,
      kind,
    ) !== undefined
  );
}

function currentStatus(db: Db, accountId: number): AccountStatus | null {
  const row = db.get<{ status: string }>("SELECT status FROM accounts WHERE id = ?", accountId);
  return row === undefined ? null : normalizeStatus(row.status);
}

function setStatus(db: Db, accountId: number, status: AccountStatus, now: number): void {
  db.run("UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?", status, now, accountId);
}

/** Both credentials present and the cookie jar has validated at least once. */
function credentialsHealthy(db: Db, accountId: number): boolean {
  const row = db.get<{ last_cookie_ok_at: number | null }>(
    "SELECT last_cookie_ok_at FROM accounts WHERE id = ?",
    accountId,
  );
  return (
    hasSecret(db, accountId, "oauth_refresh") &&
    hasSecret(db, accountId, "cookies") &&
    row?.last_cookie_ok_at != null
  );
}

/** ok when both credentials are healthy, pending otherwise. */
export function derivedStatus(db: Db, accountId: number): "ok" | "pending" {
  return credentialsHealthy(db, accountId) ? "ok" : "pending";
}

/** Google rejected the refresh token or the access token. Never overrides disabled. */
export function markAuthLost(db: Db, accountId: number, now: number): void {
  const status = currentStatus(db, accountId);
  if (status !== null && status !== "disabled") {
    setStatus(db, accountId, "auth_lost", now);
  }
}

/** The cookie jar failed validation. Never overrides disabled or auth_lost. */
export function markCookiesInvalid(db: Db, accountId: number, now: number): void {
  const status = currentStatus(db, accountId);
  if (status !== null && status !== "disabled" && status !== "auth_lost") {
    setStatus(db, accountId, "cookies_invalid", now);
  }
}

/** A fresh OAuth grant clears auth_lost; a bad jar or disabled stays as it is. */
export function settleAfterOAuth(db: Db, accountId: number, now: number): void {
  const status = currentStatus(db, accountId);
  if (status === null || status === "disabled" || status === "cookies_invalid") {
    return;
  }
  setStatus(db, accountId, derivedStatus(db, accountId), now);
}

/** A validated jar clears cookies_invalid; auth_lost or disabled stays as it is. */
export function settleAfterCookies(db: Db, accountId: number, now: number): void {
  const status = currentStatus(db, accountId);
  if (status === null || status === "disabled" || status === "auth_lost") {
    return;
  }
  setStatus(db, accountId, derivedStatus(db, accountId), now);
}
