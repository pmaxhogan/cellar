import {
  ALL_LOCATIONS_ID,
  STATS_HOUR_MS,
  type StatsHourlyPoint,
  type StatsHourlyResponse,
} from "@cellar/shared";
import type { Db } from "../db/db.ts";
import { statsLocations, utcDay } from "./stats.ts";

/**
 * Live hourly statistics for the Charts page's "24 hours" view.
 *
 * stats_daily has no hourly grain, so every series is counted from its source
 * table on each request, one GROUP BY per series over an indexed timestamp
 * (migration 005). Buckets are whole UTC hours, `(ts / 3600000) * 3600000` in
 * integer arithmetic; the window ends with the current, partial hour.
 *
 * Deliberately absent: a storage curve (there are no hourly snapshots and the
 * reaper deletes the rows it frees, so past levels cannot be rebuilt; the
 * response carries the live figure instead) and API units per hour
 * (quota_usage keeps them per UTC day only; the response carries today's
 * total). See the field comments on StatsHourlyPointSchema for what each
 * series counts.
 */

const H = String(STATS_HOUR_MS);
const BUCKET = (column: string): string => `(${column} / ${H}) * ${H}`;

const DOWNLOADS = `SELECT ${BUCKET("downloaded_at")} AS hour, COUNT(*) AS downloads,
       COALESCE(SUM(size_bytes), 0) AS download_bytes
  FROM media
 WHERE downloaded_at >= ? AND downloaded_at < ?
   AND kind IN ('video', 'audio') AND location_id IS NOT NULL`;

/**
 * The SQL behind each series, exported so a test can check the query plans.
 * The unary `+` on location_id and status stops the planner from preferring
 * the equality indexes on those columns (media_location, jobs_status_*),
 * which would walk every row at a location or every finished job instead of
 * one hour window of the timestamp index.
 */
export const HOURLY_SQL = {
  downloads: `${DOWNLOADS} GROUP BY hour`,
  downloadsAt: `${DOWNLOADS} AND +location_id = ? GROUP BY hour`,
  jobs: `SELECT ${BUCKET("finished_at")} AS hour,
         SUM(status = 'done') AS jobs_done, SUM(status = 'failed') AS jobs_failed
    FROM jobs
   WHERE finished_at >= ? AND finished_at < ? AND +status IN ('done', 'failed')
   GROUP BY hour`,
  videosAdded: `SELECT ${BUCKET("created_at")} AS hour, COUNT(*) AS value
    FROM videos WHERE created_at >= ? AND created_at < ? GROUP BY hour`,
  videosGone: `SELECT ${BUCKET("gone_since")} AS hour, COUNT(*) AS value
    FROM videos WHERE gone_since >= ? AND gone_since < ? GROUP BY hour`,
  // Hour rows are keyed YYYY-MM-DDTHH (13 chars); a YYYY-MM-DD day row sorts
  // between two hour keys, so the length check keeps it out. Scrape requests
  // are charged to the account row only, so summing every account is exact.
  scrape: `SELECT day AS key, SUM(scrape_requests) AS value
    FROM quota_usage WHERE day >= ? AND day < ? AND length(day) = 13
   GROUP BY day`,
} as const;

export interface HourlyWindow {
  hours: number;
  /** Epoch ms of the first bucket's start. */
  from: number;
  /** Epoch ms of the last bucket's end, exclusive: the next hour boundary after `now`. */
  to: number;
}

export function hourlyWindow(hours: number, now: number): HourlyWindow {
  const to = Math.floor(now / STATS_HOUR_MS) * STATS_HOUR_MS + STATS_HOUR_MS;
  return { hours, from: to - hours * STATS_HOUR_MS, to };
}

/** `YYYY-MM-DDTHH` in UTC, the quota_usage hour key. */
function hourKey(at: number): string {
  return new Date(at).toISOString().slice(0, 13);
}

export interface ReadHourlyOptions {
  hours: number;
  now: number;
  /** 0 = all locations. Filters the download series and bytes_used only. */
  location_id: number;
}

export function readHourly(db: Db, options: ReadHourlyOptions): StatsHourlyResponse {
  const window = hourlyWindow(options.hours, options.now);
  const { from, to } = window;
  const points: StatsHourlyPoint[] = Array.from({ length: options.hours }, (_, index) => ({
    hour: from + index * STATS_HOUR_MS,
    downloads: 0,
    download_bytes: 0,
    jobs_done: 0,
    jobs_failed: 0,
    videos_added: 0,
    videos_gone: 0,
    scrape_requests: 0,
  }));
  const at = (hour: number): StatsHourlyPoint | undefined =>
    points[Math.round((hour - from) / STATS_HOUR_MS)];

  const filtered = options.location_id !== ALL_LOCATIONS_ID;
  const downloads = filtered
    ? db.all<{ hour: number; downloads: number; download_bytes: number }>(
        HOURLY_SQL.downloadsAt,
        from,
        to,
        options.location_id,
      )
    : db.all<{ hour: number; downloads: number; download_bytes: number }>(
        HOURLY_SQL.downloads,
        from,
        to,
      );
  for (const row of downloads) {
    const point = at(row.hour);
    if (point === undefined) continue;
    point.downloads = Number(row.downloads);
    point.download_bytes = Number(row.download_bytes);
  }

  for (const row of db.all<{ hour: number; jobs_done: number; jobs_failed: number }>(
    HOURLY_SQL.jobs,
    from,
    to,
  )) {
    const point = at(row.hour);
    if (point === undefined) continue;
    point.jobs_done = Number(row.jobs_done);
    point.jobs_failed = Number(row.jobs_failed);
  }

  const counts: [string, "videos_added" | "videos_gone"][] = [
    [HOURLY_SQL.videosAdded, "videos_added"],
    [HOURLY_SQL.videosGone, "videos_gone"],
  ];
  for (const [sql, field] of counts) {
    for (const row of db.all<{ hour: number; value: number }>(sql, from, to)) {
      const point = at(row.hour);
      if (point !== undefined) point[field] = Number(row.value);
    }
  }

  for (const row of db.all<{ key: string; value: number }>(
    HOURLY_SQL.scrape,
    hourKey(from),
    hourKey(to),
  )) {
    const point = at(Date.parse(`${row.key}:00:00Z`));
    if (point !== undefined) point.scrape_requests = Number(row.value);
  }

  const bytes = filtered
    ? db.get<{ value: number | null }>(
        "SELECT SUM(size_bytes) AS value FROM media WHERE location_id = ?",
        options.location_id,
      )
    : db.get<{ value: number | null }>(
        "SELECT SUM(size_bytes) AS value FROM media WHERE location_id IS NOT NULL",
      );
  const apiUnits = db.get<{ value: number | null }>(
    "SELECT api_units AS value FROM quota_usage WHERE account_id = 0 AND day = ?",
    utcDay(options.now),
  );

  return {
    ...window,
    location_id: options.location_id,
    points,
    bytes_used: Number(bytes?.value ?? 0),
    api_units_today: Number(apiUnits?.value ?? 0),
    locations: statsLocations(db),
  };
}
