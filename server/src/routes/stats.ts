import {
  StatsDailyQuerySchema,
  StatsHourlyQuerySchema,
  type StatsDailyResponse,
  type StatsHourlyResponse,
  type StatsRollupResponse,
  type StatsSummary,
} from "@cellar/shared";
import type { FastifyPluginAsync } from "fastify";
import { getSettings } from "../domain/settings.ts";
import {
  readDaily,
  readSummary,
  resolveWindow,
  rollupWithBackfill,
  statsLocations,
} from "../domain/stats.ts";
import { readHourly } from "../domain/statsHourly.ts";
import { parseQuery } from "./validate.ts";

/** Days before today that POST /stats/rollup recomputes along with today. */
export const MANUAL_BACKFILL_DAYS = 7;

export interface StatsRoutesOptions {
  /** Test seam for the clock. */
  now?: () => number;
}

/**
 * /api/stats, registered under the /api prefix by app.ts.
 *
 *   GET  /stats/daily?from&to&location_id -> StatsDailyResponse
 *   GET  /stats/hourly?hours&location_id  -> StatsHourlyResponse (live, per UTC hour)
 *   GET  /stats/summary                   -> StatsSummary (live counts)
 *   POST /stats/rollup                    -> StatsRollupResponse
 */
export const statsRoutes: FastifyPluginAsync<StatsRoutesOptions> = async (app, options) => {
  const { db, config } = app.cellar;
  const now = options.now ?? Date.now;

  app.get("/stats/daily", (request): StatsDailyResponse => {
    const query = parseQuery(StatsDailyQuerySchema, request);
    const window = resolveWindow({
      ...(query.from === undefined ? {} : { from: query.from }),
      ...(query.to === undefined ? {} : { to: query.to }),
      now: now(),
    });
    return {
      ...window,
      points: readDaily(db, { ...window, location_id: query.location_id }),
      locations: statsLocations(db),
    };
  });

  app.get("/stats/hourly", (request): StatsHourlyResponse => {
    const query = parseQuery(StatsHourlyQuerySchema, request);
    return readHourly(db, { hours: query.hours, location_id: query.location_id, now: now() });
  });

  app.get("/stats/summary", (): StatsSummary =>
    readSummary(db, {
      now: now(),
      budget: getSettings(db, config)["quota.api_units_per_day"],
    }),
  );

  app.post("/stats/rollup", (): StatsRollupResponse =>
    rollupWithBackfill(db, { days: MANUAL_BACKFILL_DAYS, now: now() }),
  );

  await Promise.resolve();
};
