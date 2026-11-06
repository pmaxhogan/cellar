import type { Db } from "../db/db.ts";
import { getKv, setKv } from "../db/kv.ts";
import { nowOf, type ServiceDeps } from "../domain/deps.ts";
import { DomainError } from "../domain/errors.ts";
import { getSettings } from "../domain/settings.ts";

/**
 * Budgets, both tracked in `quota_usage`:
 *
 * - Google API units per UTC day. Every call is charged to its account row
 *   AND the project-wide row (account_id 0); the project row is what the
 *   daily budget (`quota.api_units_per_day`) is enforced against, because
 *   Google's quota is per Cloud project, not per user.
 *   Google's own quota day ends at midnight Pacific time instead; when Google
 *   says the quota is gone, every API call is refused until that midnight
 *   (kv `google_quota_blocked_until`), not until the end of the UTC day.
 * - yt-dlp scrape requests per account per UTC hour. Hour rows share the
 *   table, keyed `YYYY-MM-DDTHH` in the `day` column so they never collide
 *   with the `YYYY-MM-DD` day rows.
 */

export const PROJECT_ACCOUNT_ID = 0;

/** Raised when a budget is spent. Maps to HTTP 429. */
export class QuotaExhausted extends DomainError {
  readonly budget: "api" | "scrape";

  constructor(budget: "api" | "scrape", message: string, details?: Record<string, unknown>) {
    super("quota_exhausted", message, details);
    this.budget = budget;
  }
}

/** `YYYY-MM-DD` in UTC. */
export function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** `YYYY-MM-DDTHH` in UTC. */
export function utcHourKey(now: number): string {
  return new Date(now).toISOString().slice(0, 13);
}

function usageRow(
  db: Db,
  accountId: number,
  key: string,
): { api_units: number; scrape_requests: number } {
  const row = db.get<{ api_units: number; scrape_requests: number }>(
    "SELECT api_units, scrape_requests FROM quota_usage WHERE account_id = ? AND day = ?",
    accountId,
    key,
  );
  return {
    api_units: Number(row?.api_units ?? 0),
    scrape_requests: Number(row?.scrape_requests ?? 0),
  };
}

export interface ApiUsage {
  day: string;
  used: number;
  budget: number;
  remaining: number;
}

export const GOOGLE_QUOTA_BLOCK_KV = "google_quota_blocked_until";
/** Google resets the YouTube Data API quota at midnight in this zone. */
export const GOOGLE_QUOTA_TIME_ZONE = "America/Los_Angeles";

const zoneParts = new Intl.DateTimeFormat("en-US", {
  timeZone: GOOGLE_QUOTA_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Wall clock minus UTC in ms for the quota zone at `at` (negative for Pacific). */
function zoneOffsetMs(at: number): number {
  const parts = zoneParts.formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wall = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  return wall - (at - (((at % 1000) + 1000) % 1000));
}

/** The first midnight Pacific time after `now`: when Google's quota day starts over. */
export function nextGoogleQuotaReset(now: number): number {
  const offset = zoneOffsetMs(now);
  const wall = new Date(now + offset);
  const midnight = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + 1);
  // A daylight saving change before that midnight moves the offset by an hour.
  return midnight - zoneOffsetMs(midnight - offset);
}

function googleBlocked(deps: Pick<ServiceDeps, "db" | "now">): boolean {
  const until = getKv<number>(deps.db, GOOGLE_QUOTA_BLOCK_KV);
  return typeof until === "number" && until > nowOf(deps);
}

/**
 * Project-wide API units spent today against the daily budget. `remaining`
 * is 0 while Google has the quota blocked, whatever the local count says.
 */
export function apiUsage(deps: Pick<ServiceDeps, "db" | "now">): ApiUsage {
  const day = utcDayKey(nowOf(deps));
  const used = usageRow(deps.db, PROJECT_ACCOUNT_ID, day).api_units;
  const budget = getSettings(deps.db)["quota.api_units_per_day"];
  const remaining = googleBlocked(deps) ? 0 : Math.max(0, budget - used);
  return { day, used, budget, remaining };
}

/** API units one account spent today. */
export function accountApiUnits(deps: Pick<ServiceDeps, "db" | "now">, accountId: number): number {
  return usageRow(deps.db, accountId, utcDayKey(nowOf(deps))).api_units;
}

function addUsage(
  db: Db,
  accountId: number,
  key: string,
  column: "api_units" | "scrape_requests",
  amount: number,
): void {
  db.run(
    `INSERT INTO quota_usage (account_id, day, ${column}) VALUES (?, ?, ?)
     ON CONFLICT (account_id, day) DO UPDATE SET ${column} = ${column} + excluded.${column}`,
    accountId,
    key,
    amount,
  );
}

/**
 * Charge `units` to the account and the project for today, refusing with
 * QuotaExhausted when the project budget cannot cover it. Charged before the
 * call is made: Google bills failed calls too.
 */
export function chargeApiUnits(
  deps: Pick<ServiceDeps, "db" | "now">,
  accountId: number,
  units: number,
): ApiUsage {
  if (!Number.isInteger(units) || units < 0) {
    throw new DomainError("invalid", "API unit cost must be a non-negative integer.");
  }
  const { db } = deps;
  return db.tx(() => {
    if (googleBlocked(deps)) {
      throw new QuotaExhausted(
        "api",
        "Google reports the daily YouTube API quota is spent; it resets at midnight Pacific time.",
        { until: getKv<number>(db, GOOGLE_QUOTA_BLOCK_KV) },
      );
    }
    const usage = apiUsage(deps);
    if (usage.used + units > usage.budget) {
      throw new QuotaExhausted("api", "The daily YouTube API budget is spent.", {
        used: usage.used,
        budget: usage.budget,
      });
    }
    addUsage(db, PROJECT_ACCOUNT_ID, usage.day, "api_units", units);
    if (accountId !== PROJECT_ACCOUNT_ID) {
      addUsage(db, accountId, usage.day, "api_units", units);
    }
    const used = usage.used + units;
    return { ...usage, used, remaining: Math.max(0, usage.budget - used) };
  });
}

/**
 * Google said the project quota is gone (403 quotaExceeded), whatever our own
 * count says. Refuse every API call until Google's next reset at midnight
 * Pacific time. The usage rows stay true counts of what was spent.
 */
export function markApiBudgetSpent(deps: Pick<ServiceDeps, "db" | "now">): void {
  const now = nowOf(deps);
  setKv(deps.db, GOOGLE_QUOTA_BLOCK_KV, nextGoogleQuotaReset(now), now);
}

export interface ScrapeUsage {
  hour: string;
  used: number;
  budget: number;
  remaining: number;
}

/** The account's own budget, else the global `quota.scrape_requests_per_hour`. */
export function scrapeBudget(db: Db, accountId: number): number {
  const row = db.get<{ scrape_budget_per_hour: number | null }>(
    "SELECT scrape_budget_per_hour FROM accounts WHERE id = ?",
    accountId,
  );
  const own = row?.scrape_budget_per_hour;
  return own === null || own === undefined
    ? getSettings(db)["quota.scrape_requests_per_hour"]
    : Number(own);
}

export function scrapeUsage(deps: Pick<ServiceDeps, "db" | "now">, accountId: number): ScrapeUsage {
  const hour = utcHourKey(nowOf(deps));
  const used = usageRow(deps.db, accountId, hour).scrape_requests;
  const budget = scrapeBudget(deps.db, accountId);
  return { hour, used, budget, remaining: Math.max(0, budget - used) };
}

/** Count one scrape request without enforcing the budget (owner-triggered probes). */
export function recordScrape(deps: Pick<ServiceDeps, "db" | "now">, accountId: number): void {
  addUsage(deps.db, accountId, utcHourKey(nowOf(deps)), "scrape_requests", 1);
}

/**
 * Take one request from the account's hourly scrape budget, or throw
 * QuotaExhausted when this hour's budget is spent.
 */
export function consumeScrape(
  deps: Pick<ServiceDeps, "db" | "now">,
  accountId: number,
): ScrapeUsage {
  const { db } = deps;
  return db.tx(() => {
    const usage = scrapeUsage(deps, accountId);
    if (usage.used >= usage.budget) {
      throw new QuotaExhausted("scrape", "This account's hourly scrape budget is spent.", {
        used: usage.used,
        budget: usage.budget,
      });
    }
    addUsage(db, accountId, usage.hour, "scrape_requests", 1);
    const used = usage.used + 1;
    return { ...usage, used, remaining: Math.max(0, usage.budget - used) };
  });
}
