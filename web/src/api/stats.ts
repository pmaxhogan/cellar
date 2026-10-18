import {
  StatsDailyResponseSchema,
  StatsRollupResponseSchema,
  StatsSummarySchema,
  type StatsDailyResponse,
  type StatsRollupResponse,
  type StatsSummary,
} from "@cellar/shared";
import { buildQuery, type ApiClient } from "./client.ts";

/**
 * Charts API (/api/stats). Shapes are pinned in shared/src/apiTypes.ts.
 *
 *   GET  /api/stats/daily?from&to&location_id -> StatsDailyResponse
 *   GET  /api/stats/summary                   -> StatsSummary
 *   POST /api/stats/rollup                    -> StatsRollupResponse
 */

export const RANGE_DAYS = [30, 90, 365] as const;
export type RangeDays = (typeof RANGE_DAYS)[number];

/** The location filter: a location id, or "all" for the all-locations view. */
export type LocationFilter = number | "all";

export interface DailyRequest {
  from: string;
  to: string;
  location: LocationFilter;
}

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` (UTC) of an epoch-ms instant. */
export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** The `days` UTC days ending today, inclusive. */
export function rangeWindow(days: number, now = Date.now()): { from: string; to: string } {
  return { from: utcDay(now - (days - 1) * DAY_MS), to: utcDay(now) };
}

/** Every day from `from` to `to`, inclusive, so missing points show as gaps. */
export function dayRange(from: string, to: string): string[] {
  const days: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= end; at += DAY_MS) {
    days.push(utcDay(at));
  }
  return days;
}

export function getDailyStats(
  api: ApiClient,
  request: DailyRequest,
  signal?: AbortSignal,
): Promise<StatsDailyResponse> {
  const query = buildQuery({
    from: request.from,
    to: request.to,
    location_id: request.location,
  });
  return api.request(`/api/stats/daily${query}`, { schema: StatsDailyResponseSchema, signal });
}

export function getStatsSummary(api: ApiClient, signal?: AbortSignal): Promise<StatsSummary> {
  return api.request("/api/stats/summary", { schema: StatsSummarySchema, signal });
}

export function runStatsRollup(api: ApiClient): Promise<StatsRollupResponse> {
  return api.request("/api/stats/rollup", { method: "POST", schema: StatsRollupResponseSchema });
}
