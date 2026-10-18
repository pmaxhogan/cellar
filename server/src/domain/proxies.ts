import type { ProxyRow } from "@cellar/shared";
import { fetch as undiciFetch, ProxyAgent, Socks5ProxyAgent, type Dispatcher } from "undici";
import { getKv, setKv } from "../db/kv.ts";
import type { Db } from "../db/db.ts";
import { decryptSecret, encryptSecret } from "../security/secrets.ts";
import { nowOf, requireSecretKey, type ServiceDeps } from "./deps.ts";
import { conflict, invalid, isUniqueViolation, notFound } from "./errors.ts";

/**
 * The proxy pool. A proxy URL can carry a username and password, so it is
 * stored as one AES-256-GCM blob (IV || tag || ciphertext) and only the
 * `scheme://host:port` form is ever shown. Nothing here puts the URL into an
 * error message or a log line.
 */

export const PROXY_PROTOCOLS = ["http:", "https:", "socks4:", "socks4a:", "socks5:", "socks5h:"];
const DEFAULT_PORTS: Record<string, string> = {
  "http:": "80",
  "https:": "443",
  "socks4:": "1080",
  "socks4a:": "1080",
  "socks5:": "1080",
  "socks5h:": "1080",
};
export const PROXY_FAILURES_BEFORE_SKIP = 3;
export const PROXY_SKIP_MS = 10 * 60 * 1000;
export const PROXY_TEST_URL = "https://youtube.com/favicon.ico";
export const PROXY_TEST_TIMEOUT_MS = 10_000;

/** Fetches PROXY_TEST_URL through the proxy and resolves the HTTP status. */
export type ProxyProbe = (proxyUrl: string, signal: AbortSignal) => Promise<number>;

export interface ProxyDeps extends ServiceDeps {
  proxyProbe?: ProxyProbe;
}

interface ProxyDbRow {
  id: number;
  label: string;
  url_blob: Uint8Array;
  url_redacted: string;
  enabled: number;
  fail_count: number;
  skipped_until: number | null;
}

function toRow(row: ProxyDbRow): ProxyRow {
  return {
    id: Number(row.id),
    label: row.label,
    url_redacted: row.url_redacted,
    enabled: Number(row.enabled) === 1,
    fail_count: Number(row.fail_count),
    skipped_until: row.skipped_until === null ? null : Number(row.skipped_until),
  };
}

/**
 * Parse and check a proxy URL. The returned `redacted` form drops userinfo,
 * path and query. Errors never include the input.
 */
export function parseProxyUrl(raw: string): { url: string; redacted: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw invalid("The proxy URL is not a valid URL.", { fields: { url: "Invalid URL" } });
  }
  if (!PROXY_PROTOCOLS.includes(parsed.protocol)) {
    throw invalid("Proxy URLs must use http, https, socks4, socks4a, socks5 or socks5h.", {
      fields: { url: "Unsupported scheme" },
    });
  }
  if (parsed.hostname === "") {
    throw invalid("The proxy URL has no host.", { fields: { url: "Missing host" } });
  }
  const port = parsed.port === "" ? DEFAULT_PORTS[parsed.protocol] : parsed.port;
  return {
    url: parsed.toString(),
    redacted: `${parsed.protocol}//${parsed.hostname}:${String(port)}`,
  };
}

function dbRow(db: Db, id: number): ProxyDbRow {
  const row = db.get<ProxyDbRow>("SELECT * FROM proxies WHERE id = ?", id);
  if (row === undefined) {
    throw notFound("Proxy", id);
  }
  return row;
}

function decryptUrl(deps: Pick<ServiceDeps, "config">, row: ProxyDbRow): string {
  return decryptSecret(requireSecretKey(deps.config), Buffer.from(row.url_blob));
}

export function listProxies(db: Db): ProxyRow[] {
  return db.all<ProxyDbRow>("SELECT * FROM proxies ORDER BY id").map(toRow);
}

export function getProxy(db: Db, id: number): ProxyRow {
  return toRow(dbRow(db, id));
}

export interface DecryptedProxy extends ProxyRow {
  /** The full URL including any credentials. Never log or return it. */
  url: string;
}

/** Every proxy with its decrypted URL, for the yt-dlp runner and the self-check. */
export function listProxiesDecrypted(deps: Pick<ServiceDeps, "config" | "db">): DecryptedProxy[] {
  return deps.db
    .all<ProxyDbRow>("SELECT * FROM proxies ORDER BY id")
    .map((row) => ({ ...toRow(row), url: decryptUrl(deps, row) }));
}

function uniqueGuard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict("Another proxy already uses that label.");
    }
    throw error;
  }
}

export interface ProxyInput {
  label: string;
  url: string;
  enabled: boolean;
}

export function createProxy(
  deps: Pick<ServiceDeps, "config" | "db" | "now">,
  input: ProxyInput,
): ProxyRow {
  const key = requireSecretKey(deps.config);
  const { url, redacted } = parseProxyUrl(input.url);
  const now = nowOf(deps);
  const { lastInsertRowid } = uniqueGuard(() =>
    deps.db.run(
      `INSERT INTO proxies (label, url_blob, url_redacted, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.label.trim(),
      encryptSecret(key, url),
      redacted,
      input.enabled ? 1 : 0,
      now,
      now,
    ),
  );
  return getProxy(deps.db, lastInsertRowid);
}

/** Partial update. A new URL resets the failure state. */
export function updateProxy(
  deps: Pick<ServiceDeps, "config" | "db" | "now">,
  id: number,
  patch: Partial<ProxyInput>,
): ProxyRow {
  const current = dbRow(deps.db, id);
  const now = nowOf(deps);
  deps.db.tx(() => {
    if (patch.url !== undefined) {
      const key = requireSecretKey(deps.config);
      const { url, redacted } = parseProxyUrl(patch.url);
      deps.db.run(
        `UPDATE proxies SET url_blob = ?, url_redacted = ?, fail_count = 0, skipped_until = NULL,
           updated_at = ? WHERE id = ?`,
        encryptSecret(key, url),
        redacted,
        now,
        id,
      );
    }
    uniqueGuard(() =>
      deps.db.run(
        "UPDATE proxies SET label = ?, enabled = ?, updated_at = ? WHERE id = ?",
        patch.label === undefined ? current.label : patch.label.trim(),
        patch.enabled === undefined ? Number(current.enabled) : patch.enabled ? 1 : 0,
        now,
        id,
      ),
    );
  });
  return getProxy(deps.db, id);
}

export function deleteProxy(db: Db, id: number): void {
  if (db.run("DELETE FROM proxies WHERE id = ?", id).changes === 0) {
    throw notFound("Proxy", id);
  }
}

/**
 * Count a failure. After PROXY_FAILURES_BEFORE_SKIP consecutive failures the
 * proxy is skipped for ten minutes. Returns the new consecutive count, so the
 * caller can raise the notification at the threshold.
 */
export function markProxyFailure(db: Db, id: number, now: number = Date.now()): number {
  const row = db.get<{ fail_count: number }>(
    `UPDATE proxies SET fail_count = fail_count + 1, updated_at = ? WHERE id = ?
     RETURNING fail_count`,
    now,
    id,
  );
  if (row === undefined) {
    throw notFound("Proxy", id);
  }
  const count = Number(row.fail_count);
  if (count >= PROXY_FAILURES_BEFORE_SKIP) {
    db.run("UPDATE proxies SET skipped_until = ? WHERE id = ?", now + PROXY_SKIP_MS, id);
  }
  return count;
}

export function markProxyOk(db: Db, id: number, now: number = Date.now()): void {
  db.run(
    "UPDATE proxies SET fail_count = 0, skipped_until = NULL, updated_at = ? WHERE id = ?",
    now,
    id,
  );
}

export type ProxyPolicy = "none" | "pool" | readonly number[];

function policyKey(policy: "pool" | readonly number[]): string {
  return policy === "pool"
    ? "proxy_rr:pool"
    : `proxy_rr:${[...policy].sort((a, b) => a - b).join(",")}`;
}

/**
 * Pick a proxy for one run. `none` never proxies; `pool` round-robins every
 * enabled proxy; a list round-robins those entries. Proxies inside their skip
 * window are passed over. Resolves null when nothing is usable, and the caller
 * decides whether to run unproxied. The cursor lives in kv, so the rotation
 * survives restarts.
 */
export function pickProxy(
  deps: Pick<ServiceDeps, "config" | "db" | "now">,
  policy: ProxyPolicy,
): DecryptedProxy | null {
  if (policy === "none") {
    return null;
  }
  if (policy !== "pool" && policy.length === 0) {
    return null;
  }
  const now = nowOf(deps);
  const allowed = policy === "pool" ? null : new Set(policy);
  const candidates = deps.db
    .all<ProxyDbRow>(
      `SELECT * FROM proxies WHERE enabled = 1 AND (skipped_until IS NULL OR skipped_until <= ?)
       ORDER BY id`,
      now,
    )
    .filter((row) => allowed === null || allowed.has(Number(row.id)));
  if (candidates.length === 0) {
    return null;
  }
  const key = policyKey(policy);
  const last = getKv<number>(deps.db, key) ?? 0;
  const next = candidates.find((row) => Number(row.id) > last) ?? (candidates[0] as ProxyDbRow);
  setKv(deps.db, key, Number(next.id), now);
  return { ...toRow(next), url: decryptUrl(deps, next) };
}

/** undici's own fetch with a proxy dispatcher (http(s) or socks5). */
export const defaultProxyProbe: ProxyProbe = async (proxyUrl, signal) => {
  const protocol = new URL(proxyUrl).protocol;
  let dispatcher: Dispatcher;
  if (protocol === "http:" || protocol === "https:") {
    dispatcher = new ProxyAgent(proxyUrl);
  } else if (protocol === "socks5:" || protocol === "socks5h:") {
    dispatcher = new Socks5ProxyAgent(proxyUrl);
  } else {
    throw new UnsupportedProxyTest();
  }
  try {
    const response = await undiciFetch(PROXY_TEST_URL, { dispatcher, signal, method: "GET" });
    await response.body?.cancel();
    return response.status;
  } finally {
    await dispatcher.close().catch(() => undefined);
  }
};

class UnsupportedProxyTest extends Error {
  override readonly name = "UnsupportedProxyTest";
}

export interface ProxyTestResult {
  ok: boolean;
  latency_ms: number;
  error?: string;
}

/** A short category for a failed probe. Never the raw message, which could echo the URL. */
function failureCategory(error: unknown, signal: AbortSignal): string {
  if (error instanceof UnsupportedProxyTest) {
    return "unsupported_scheme";
  }
  if (signal.aborted) {
    return "timeout";
  }
  let cursor: unknown = error;
  for (let depth = 0; depth < 4 && cursor !== null && typeof cursor === "object"; depth += 1) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code)) {
      return code;
    }
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return "connect_failed";
}

/**
 * Fetch YouTube's favicon through the proxy (10 s budget) and record the
 * outcome on the proxy's failure counter.
 */
export async function testProxy(deps: ProxyDeps, id: number): Promise<ProxyTestResult> {
  const row = dbRow(deps.db, id);
  const url = decryptUrl(deps, row);
  const probe = deps.proxyProbe ?? defaultProxyProbe;
  const signal = AbortSignal.timeout(PROXY_TEST_TIMEOUT_MS);
  const startedAt = performance.now();
  let result: ProxyTestResult;
  try {
    const status = await probe(url, signal);
    const latency = Math.round(performance.now() - startedAt);
    result =
      status >= 200 && status < 400
        ? { ok: true, latency_ms: latency }
        : { ok: false, latency_ms: latency, error: `http_${String(status)}` };
  } catch (error) {
    result = {
      ok: false,
      latency_ms: Math.round(performance.now() - startedAt),
      error: failureCategory(error, signal),
    };
  }
  const now = nowOf(deps);
  if (result.ok) {
    markProxyOk(deps.db, id, now);
  } else if (result.error !== "unsupported_scheme") {
    markProxyFailure(deps.db, id, now);
  }
  deps.log.info({ proxyId: id, ok: result.ok, error: result.error }, "proxy test finished");
  return result;
}
