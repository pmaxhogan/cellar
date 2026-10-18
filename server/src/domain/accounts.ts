import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AccountRow } from "@cellar/shared";
import type { Db } from "../db/db.ts";
import { runTool, ToolRunError } from "../media/exec.ts";
import { clearAccessToken, youtubeApi } from "../youtube/api.ts";
import { recordScrape } from "../youtube/quota.ts";
import {
  assertAccountExists,
  derivedStatus,
  markCookiesInvalid,
  normalizeStatus,
  readSecret,
  settleAfterCookies,
  storeSecret,
} from "./accountStore.ts";
import { nowOf, requireSecretKey, type ServiceDeps } from "./deps.ts";
import { DomainError, invalid, notFound } from "./errors.ts";

/**
 * Linked Google accounts: the records, their cookie jars and the two health
 * probes the self-check runs (API token, cookie jar).
 */

export const HISTORY_FEED_URL = "https://www.youtube.com/feed/history";
export const NETSCAPE_HEADER = "# Netscape HTTP Cookie File";
/** The cookie probe walks one page of a feed; a minute is generous. */
export const COOKIE_PROBE_TIMEOUT_MS = 60_000;
const MAX_DETAIL_CHARS = 300;

interface AccountDbRow {
  id: number;
  label: string;
  email: string | null;
  channel_id: string | null;
  status: string;
  has_cookies: number;
  scrape_budget_per_hour: number | null;
  last_api_ok_at: number | null;
  last_cookie_ok_at: number | null;
  created_at: number;
}

const SELECT_ACCOUNT = `
  SELECT a.id, a.label, a.email, a.channel_id, a.status, a.scrape_budget_per_hour,
         a.last_api_ok_at,
         a.last_cookie_ok_at, a.created_at,
         EXISTS (SELECT 1 FROM account_secrets s
                 WHERE s.account_id = a.id AND s.kind = 'cookies') AS has_cookies
  FROM accounts a`;

function toRow(row: AccountDbRow): AccountRow {
  return {
    id: Number(row.id),
    label: row.label,
    email: row.email,
    channel_id: row.channel_id,
    status: normalizeStatus(row.status),
    has_cookies: Number(row.has_cookies) === 1,
    scrape_budget_per_hour:
      row.scrape_budget_per_hour === null ? null : Number(row.scrape_budget_per_hour),
    last_api_ok_at: row.last_api_ok_at === null ? null : Number(row.last_api_ok_at),
    last_cookie_ok_at: row.last_cookie_ok_at === null ? null : Number(row.last_cookie_ok_at),
    created_at: Number(row.created_at),
  };
}

export function listAccounts(db: Db): AccountRow[] {
  return db.all<AccountDbRow>(`${SELECT_ACCOUNT} ORDER BY a.id`).map(toRow);
}

export function getAccount(db: Db, id: number): AccountRow {
  const row = db.get<AccountDbRow>(`${SELECT_ACCOUNT} WHERE a.id = ?`, id);
  if (row === undefined) {
    throw notFound("Account", id);
  }
  return toRow(row);
}

/** A new, unlinked account. The label may be empty; linking fills it from the channel. */
export function createAccount(db: Db, label: string, now: number = Date.now()): AccountRow {
  const { lastInsertRowid } = db.run(
    `INSERT INTO accounts (label, status, created_at, updated_at) VALUES (?, 'pending', ?, ?)`,
    label.trim(),
    now,
    now,
  );
  return getAccount(db, lastInsertRowid);
}

export interface AccountUpdate {
  label?: string | undefined;
  /** Only `disabled` (pause) and `pending` (resume) are owner-settable. */
  status?: "disabled" | "pending" | undefined;
  scrape_budget_per_hour?: number | null | undefined;
}

/**
 * Edit an account. Resuming (`pending`) recomputes the status from the stored
 * credentials, so an account with a valid grant and jar comes back as `ok`;
 * `auth_lost` and `cookies_invalid` stay until the credential is replaced.
 */
export function updateAccount(
  db: Db,
  id: number,
  patch: AccountUpdate,
  now: number = Date.now(),
): AccountRow {
  assertAccountExists(db, id);
  db.tx(() => {
    if (patch.label !== undefined) {
      db.run(
        "UPDATE accounts SET label = ?, updated_at = ? WHERE id = ?",
        patch.label.trim(),
        now,
        id,
      );
    }
    if (patch.scrape_budget_per_hour !== undefined) {
      db.run(
        "UPDATE accounts SET scrape_budget_per_hour = ?, updated_at = ? WHERE id = ?",
        patch.scrape_budget_per_hour,
        now,
        id,
      );
    }
    if (patch.status !== undefined) {
      const current = getAccount(db, id).status;
      // Resuming never clears a credential failure; only a new grant or jar does.
      const status =
        patch.status === "disabled"
          ? "disabled"
          : current === "auth_lost" || current === "cookies_invalid"
            ? current
            : derivedStatus(db, id);
      db.run("UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?", status, now, id);
    }
  });
  return getAccount(db, id);
}

/** Remove an account and, by cascade, its secrets and per-account sources. */
export function deleteAccount(db: Db, id: number): void {
  const { changes } = db.run("DELETE FROM accounts WHERE id = ?", id);
  if (changes === 0) {
    throw notFound("Account", id);
  }
  clearAccessToken(db, id);
}

/** A tab separated cookie line: 7 fields, the first being the domain. */
function cookieLineDomain(line: string): string | null {
  const fields = line.split("\t");
  if (fields.length !== 7) {
    return null;
  }
  const domain = String(fields[0])
    .replace(/^#HttpOnly_/, "")
    .toLowerCase();
  return domain === "" ? null : domain;
}

function isYoutubeDomain(domain: string): boolean {
  const bare = domain.replace(/^\./, "");
  return bare === "youtube.com" || bare.endsWith(".youtube.com");
}

/**
 * Whether the text is a Netscape cookies.txt: the magic header, or at least
 * one 7-field cookie line for youtube.com. Never echoes the text.
 */
export function looksLikeNetscapeCookies(text: string): boolean {
  const lines = text.split(/\r?\n/);
  if (/^#( Netscape)? HTTP Cookie File/.test(String(lines[0]).trim())) {
    return true;
  }
  return lines.some((line) => {
    const domain = cookieLineDomain(line);
    return domain !== null && isYoutubeDomain(domain);
  });
}

/**
 * LF line endings, trailing newline, and the magic header yt-dlp's cookie jar
 * loader insists on (it rejects a file whose first line is not the header).
 */
export function normalizeCookies(text: string): string {
  let body = text.replace(/\r\n?/g, "\n");
  if (body.charCodeAt(0) === 0xfeff) {
    body = body.slice(1);
  }
  if (!/^#( Netscape)? HTTP Cookie File/.test(body.trimStart())) {
    body = `${NETSCAPE_HEADER}\n${body}`;
  }
  return body.endsWith("\n") ? body : `${body}\n`;
}

/**
 * Decrypt the account's jar to a fresh 0600 file under $DATA_DIR/tmp, run
 * `fn` with its path, then read the file back and re-encrypt it if yt-dlp
 * rotated anything. The file is always deleted. Neither the path's contents
 * nor the jar ever reach a log.
 */
export async function withCookiesFile<T>(
  deps: ServiceDeps,
  accountId: number,
  fn: (path: string) => Promise<T>,
): Promise<T> {
  requireSecretKey(deps.config);
  const stored = readSecret(deps.config, deps.db, accountId, "cookies");
  if (stored === null) {
    throw new DomainError(
      "precondition_failed",
      `Account ${String(accountId)} has no cookie jar.`,
      { reason: "no_cookies" },
    );
  }
  mkdirSync(deps.config.tmpDir, { recursive: true, mode: 0o700 });
  const path = join(deps.config.tmpDir, `cookies-${randomBytes(16).toString("hex")}.txt`);
  await writeFile(path, stored.plaintext, { mode: 0o600, flag: "wx" });
  try {
    return await fn(path);
  } finally {
    try {
      await writeBack(deps, accountId, path, stored);
    } finally {
      await unlink(path).catch((error: unknown) => {
        deps.log.error({ err: error, accountId }, "could not delete a decrypted cookie jar");
      });
    }
  }
}

async function writeBack(
  deps: ServiceDeps,
  accountId: number,
  path: string,
  original: { plaintext: string; updatedAt: number },
): Promise<void> {
  let current: string;
  try {
    current = await readFile(path, "utf8");
  } catch {
    return;
  }
  if (
    current === original.plaintext ||
    current.trim() === "" ||
    !looksLikeNetscapeCookies(current)
  ) {
    return;
  }
  const row = deps.db.get<{ updated_at: number }>(
    "SELECT updated_at FROM account_secrets WHERE account_id = ? AND kind = 'cookies'",
    accountId,
  );
  if (row === undefined || Number(row.updated_at) !== original.updatedAt) {
    // The owner uploaded a new jar (or removed the account) while this ran.
    return;
  }
  storeSecret(deps.config, deps.db, accountId, "cookies", current, nowOf(deps));
  deps.log.debug({ accountId }, "stored the refreshed cookie jar");
}

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

/** The last `ERROR:` line of yt-dlp's stderr, with the jar path masked and length capped. */
function errorDetail(stderr: string, path: string): string {
  const lines = stderr.split(/\r?\n/).filter((line) => line.trim() !== "");
  const line = [...lines].reverse().find((l) => l.startsWith("ERROR")) ?? lines.at(-1) ?? "";
  const masked = line.split(path).join("<cookies>").trim();
  const text = masked === "" ? "yt-dlp failed without an error message" : masked;
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}...` : text;
}

/**
 * The cookie health probe: one flat page of the watch history feed through
 * yt-dlp. Success stamps `last_cookie_ok_at`; a failing jar marks the account
 * `cookies_invalid`. A yt-dlp that cannot start is reported without blaming
 * the jar.
 */
export async function checkAccountCookies(
  deps: ServiceDeps,
  id: number,
  options: { timeoutMs?: number } = {},
): Promise<ProbeResult> {
  assertAccountExists(deps.db, id);
  if (readSecret(deps.config, deps.db, id, "cookies") === null) {
    return { ok: false, detail: "No cookie jar is stored for this account." };
  }
  recordScrape(deps, id);
  let outcome: ProbeResult;
  try {
    outcome = await withCookiesFile(deps, id, async (path) => {
      const result = await runTool(
        { config: deps.config, log: deps.log, db: deps.db },
        {
          tool: "yt-dlp",
          args: [
            HISTORY_FEED_URL,
            "--flat-playlist",
            "--playlist-end",
            "1",
            "-J",
            "--cookies",
            path,
          ],
          timeoutMs: options.timeoutMs ?? COOKIE_PROBE_TIMEOUT_MS,
        },
      );
      if (result.timedOut) {
        return { ok: false, detail: "yt-dlp timed out reading the history feed." };
      }
      if (result.code !== 0) {
        return { ok: false, detail: errorDetail(result.stderr, path) };
      }
      try {
        JSON.parse(result.stdout);
      } catch {
        return { ok: false, detail: "yt-dlp returned output that is not JSON." };
      }
      return { ok: true, detail: "The history feed is readable with this jar." };
    });
  } catch (error) {
    if (error instanceof ToolRunError) {
      return { ok: false, detail: error.message };
    }
    throw error;
  }
  const now = nowOf(deps);
  if (outcome.ok) {
    deps.db.run(
      "UPDATE accounts SET last_cookie_ok_at = ?, updated_at = ? WHERE id = ?",
      now,
      now,
      id,
    );
    settleAfterCookies(deps.db, id, now);
  } else if (!outcome.detail.startsWith("yt-dlp timed out")) {
    markCookiesInvalid(deps.db, id, now);
  }
  return outcome;
}

/**
 * Store a pasted cookies.txt (encrypted) and validate it against the history
 * feed. The jar is kept even when validation fails, so the owner can retry
 * after fixing whatever yt-dlp complained about.
 */
export async function setCookies(
  deps: ServiceDeps,
  id: number,
  netscapeText: string,
): Promise<{ account: AccountRow; validation: ProbeResult }> {
  assertAccountExists(deps.db, id);
  requireSecretKey(deps.config);
  if (!looksLikeNetscapeCookies(netscapeText)) {
    throw invalid(
      "That is not a Netscape cookies.txt: expected the header line or tab separated " +
        "youtube.com cookie lines.",
    );
  }
  const now = nowOf(deps);
  deps.db.tx(() => {
    storeSecret(deps.config, deps.db, id, "cookies", normalizeCookies(netscapeText), now);
    // A new jar has not validated yet.
    deps.db.run(
      "UPDATE accounts SET last_cookie_ok_at = NULL, updated_at = ? WHERE id = ?",
      now,
      id,
    );
  });
  const validation = await checkAccountCookies(deps, id);
  return { account: getAccount(deps.db, id), validation };
}

interface ChannelsMineResponse {
  items?: { id?: string }[];
}

/** The API health probe: a 1 unit `channels.list mine=true`. */
export async function checkAccountApi(deps: ServiceDeps, id: number): Promise<ProbeResult> {
  assertAccountExists(deps.db, id);
  try {
    const body = await youtubeApi(deps, id).get<ChannelsMineResponse>("channels", {
      part: "id",
      mine: true,
    });
    const channelId = body.items?.[0]?.id;
    return {
      ok: true,
      detail:
        typeof channelId === "string"
          ? `Token valid; channel ${channelId}.`
          : "Token valid; the Google account has no YouTube channel.",
    };
  } catch (error) {
    if (error instanceof DomainError) {
      return { ok: false, detail: error.message };
    }
    deps.log.warn({ err: error, accountId: id }, "api health probe failed");
    return {
      ok: false,
      detail: error instanceof Error ? error.message : "The YouTube API call failed.",
    };
  }
}
