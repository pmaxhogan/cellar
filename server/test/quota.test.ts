import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updateSettings } from "../src/domain/settings.ts";
import {
  accountApiUnits,
  apiUsage,
  chargeApiUnits,
  consumeScrape,
  markApiBudgetSpent,
  nextGoogleQuotaReset,
  PROJECT_ACCOUNT_ID,
  QuotaExhausted,
  recordScrape,
  scrapeBudget,
  scrapeUsage,
  utcDayKey,
  utcHourKey,
} from "../src/youtube/quota.ts";
import { toApiError } from "../src/routes/validate.ts";
import { createTempDb, type TempDb } from "./helpers.ts";

const NOON = Date.UTC(2026, 9, 18, 12, 30, 0);

let temp: TempDb;
let now = NOON;
const deps = () => ({ db: temp.db, now: () => now });

function account(budget: number | null = null): number {
  return temp.db.run(
    `INSERT INTO accounts (label, status, scrape_budget_per_hour, created_at, updated_at)
     VALUES ('a', 'ok', ?, 0, 0)`,
    budget,
  ).lastInsertRowid;
}

beforeEach(() => {
  temp = createTempDb();
  now = NOON;
});

afterEach(() => {
  temp.close();
});

describe("keys", () => {
  it("formats UTC day and hour keys", () => {
    expect(utcDayKey(NOON)).toBe("2026-10-18");
    expect(utcHourKey(NOON)).toBe("2026-10-18T12");
  });
});

describe("API units", () => {
  it("charges the account and the project row", () => {
    const id = account();
    const usage = chargeApiUnits(deps(), id, 3);
    expect(usage).toEqual({ day: "2026-10-18", used: 3, budget: 10000, remaining: 9997 });
    chargeApiUnits(deps(), id, 1);
    expect(accountApiUnits(deps(), id)).toBe(4);
    expect(accountApiUnits(deps(), PROJECT_ACCOUNT_ID)).toBe(4);
    expect(apiUsage(deps()).used).toBe(4);
  });

  it("charges project-only work once", () => {
    chargeApiUnits(deps(), PROJECT_ACCOUNT_ID, 2);
    expect(temp.db.all("SELECT * FROM quota_usage")).toHaveLength(1);
  });

  it("refuses with QuotaExhausted (429) when the project budget cannot cover the call", () => {
    updateSettings(temp.db, { "quota.api_units_per_day": 5 });
    const id = account();
    chargeApiUnits(deps(), id, 4);
    let caught: unknown;
    try {
      chargeApiUnits(deps(), id, 2);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(QuotaExhausted);
    expect((caught as QuotaExhausted).budget).toBe("api");
    expect(toApiError(caught).status).toBe(429);
    expect(toApiError(caught).body.code).toBe("quota_exhausted");
    // Nothing was charged by the refused call.
    expect(apiUsage(deps()).used).toBe(4);
    chargeApiUnits(deps(), id, 1);
    expect(apiUsage(deps()).remaining).toBe(0);
  });

  it("starts a fresh budget on the next UTC day", () => {
    updateSettings(temp.db, { "quota.api_units_per_day": 1 });
    chargeApiUnits(deps(), PROJECT_ACCOUNT_ID, 1);
    expect(() => chargeApiUnits(deps(), PROJECT_ACCOUNT_ID, 1)).toThrow(QuotaExhausted);
    now = Date.UTC(2026, 9, 19, 0, 0, 1);
    expect(chargeApiUnits(deps(), PROJECT_ACCOUNT_ID, 1).day).toBe("2026-10-19");
  });

  it("rejects nonsense unit costs", () => {
    expect(() => chargeApiUnits(deps(), PROJECT_ACCOUNT_ID, -1)).toThrow(/non-negative/);
    expect(() => chargeApiUnits(deps(), PROJECT_ACCOUNT_ID, 1.5)).toThrow(/non-negative/);
  });

  it("markApiBudgetSpent blocks the API until midnight Pacific, not the end of the UTC day", () => {
    // 06:30 UTC on 2026-10-26 is 23:30 PDT on the 25th: Google resets at 07:00 UTC.
    now = Date.UTC(2026, 9, 26, 6, 30);
    chargeApiUnits(deps(), PROJECT_ACCOUNT_ID, 10);
    markApiBudgetSpent(deps());
    expect(apiUsage(deps())).toMatchObject({ used: 10, remaining: 0 });
    expect(() => chargeApiUnits(deps(), PROJECT_ACCOUNT_ID, 1)).toThrow(/midnight Pacific/);
    now = Date.UTC(2026, 9, 26, 7, 0, 1);
    expect(apiUsage(deps()).remaining).toBe(9990);
    expect(chargeApiUnits(deps(), PROJECT_ACCOUNT_ID, 1).used).toBe(11);
  });

  it("finds the next Pacific midnight across daylight saving changes", () => {
    // PDT (UTC-7).
    expect(nextGoogleQuotaReset(Date.UTC(2026, 9, 26, 6, 30))).toBe(Date.UTC(2026, 9, 26, 7));
    expect(nextGoogleQuotaReset(Date.UTC(2026, 9, 26, 7, 0, 0))).toBe(Date.UTC(2026, 9, 27, 7));
    // PST (UTC-8) after 2026-11-01.
    expect(nextGoogleQuotaReset(Date.UTC(2026, 10, 5, 7, 55))).toBe(Date.UTC(2026, 10, 5, 8));
    // The night of the fall-back change: midnight PDT, before the 02:00 change.
    expect(nextGoogleQuotaReset(Date.UTC(2026, 10, 1, 6, 0))).toBe(Date.UTC(2026, 10, 1, 7));
    // Just after it: the next midnight is PST.
    expect(nextGoogleQuotaReset(Date.UTC(2026, 10, 1, 7, 30))).toBe(Date.UTC(2026, 10, 2, 8));
    // The spring-forward day: 00:30 PST on 2026-03-08, next midnight is PDT.
    expect(nextGoogleQuotaReset(Date.UTC(2026, 2, 8, 8, 30))).toBe(Date.UTC(2026, 2, 9, 7));
    // Late evening on the eve of spring-forward: midnight still PST.
    expect(nextGoogleQuotaReset(Date.UTC(2026, 2, 8, 7, 0))).toBe(Date.UTC(2026, 2, 8, 8));
  });
});

describe("scrape budget", () => {
  it("uses the global per-hour setting unless the account has its own", () => {
    const global = account();
    const own = account(2);
    expect(scrapeBudget(temp.db, global)).toBe(120);
    expect(scrapeBudget(temp.db, own)).toBe(2);
    updateSettings(temp.db, { "quota.scrape_requests_per_hour": 7 });
    expect(scrapeBudget(temp.db, global)).toBe(7);
  });

  it("consumes per hour and refuses at the budget", () => {
    const id = account(2);
    expect(consumeScrape(deps(), id)).toMatchObject({
      hour: "2026-10-18T12",
      used: 1,
      remaining: 1,
    });
    consumeScrape(deps(), id);
    expect(() => consumeScrape(deps(), id)).toThrow(QuotaExhausted);
    expect(scrapeUsage(deps(), id).used).toBe(2);
    // The next hour has a fresh budget, stored in its own row.
    now += 60 * 60 * 1000;
    expect(consumeScrape(deps(), id).used).toBe(1);
    const rows = temp.db.all<{ day: string }>(
      "SELECT day FROM quota_usage WHERE account_id = ? ORDER BY day",
      id,
    );
    expect(rows.map((row) => row.day)).toEqual(["2026-10-18T12", "2026-10-18T13"]);
  });

  it("recordScrape counts without enforcing", () => {
    const id = account(0);
    recordScrape(deps(), id);
    recordScrape(deps(), id);
    expect(scrapeUsage(deps(), id)).toMatchObject({ used: 2, budget: 0, remaining: 0 });
  });
});
