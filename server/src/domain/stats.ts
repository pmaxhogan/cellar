import {
  ALL_LOCATIONS_ID,
  STATS_DEFAULT_DAYS,
  STATS_MAX_DAYS,
  type StatsDailyPoint,
  type StatsLocationRef,
  type StatsSummary,
} from "@cellar/shared";
import type { Db } from "../db/db.ts";
import { invalid } from "./errors.ts";

/**
 * Daily statistics for the Charts page.
 *
 * stats_daily holds one row per UTC day and location, plus the location 0 row
 * for all locations. Every column except bytes_used can be rebuilt for any
 * past day from timestamps the catalog keeps (downloaded_at, created_at,
 * gone_since, the quota_usage day rows), so a rollup is idempotent and a
 * backfill may recompute old days. bytes_used cannot: the reaper deletes the
 * media rows it frees, so a past day's figure is a snapshot. A backfill keeps
 * an existing snapshot and only reconstructs one (from the files still on
 * disk) when the row is missing.
 */

export const DAY_MS = 86_400_000;

/** The media kinds that are downloads; captions and info rows ride along with them. */
const DOWNLOAD_KINDS = "('video', 'audio')";

/** `YYYY-MM-DD` (UTC) of an epoch-ms instant. */
export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Epoch ms of 00:00 UTC on `day`. */
export function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

export function addDays(day: string, days: number): string {
  return utcDay(dayStart(day) + days * DAY_MS);
}

/** Inclusive count of days from `from` to `to`. */
export function daySpan(from: string, to: string): number {
  return Math.round((dayStart(to) - dayStart(from)) / DAY_MS) + 1;
}

export interface StatsWindow {
  from: string;
  to: string;
}

/**
 * The window a daily read covers: `to` defaults to today, `from` to the
 * STATS_DEFAULT_DAYS days ending at `to`. Rejects an inverted or too wide window.
 */
export function resolveWindow(input: { from?: string; to?: string; now: number }): StatsWindow {
  const to = input.to ?? utcDay(input.now);
  const from = input.from ?? addDays(to, -(STATS_DEFAULT_DAYS - 1));
  if (from > to) {
    throw invalid("from must not be after to.", { from, to });
  }
  if (daySpan(from, to) > STATS_MAX_DAYS) {
    throw invalid(`The window may cover at most ${String(STATS_MAX_DAYS)} days.`, { from, to });
  }
  return { from, to };
}

interface LocationAggregate {
  location_id: number;
  value: number;
}

function byLocation(rows: LocationAggregate[]): Map<number, number> {
  return new Map(rows.map((row) => [row.location_id, row.value]));
}

function scalar(db: Db, sql: string, ...params: (number | string)[]): number {
  return db.get<{ value: number | null }>(sql, ...params)?.value ?? 0;
}

export interface RollupOptions {
  /** UTC day to roll up. Defaults to today. */
  day?: string;
  now: number;
}

/**
 * Compute `day`'s points (the all-locations row plus one per enabled
 * location) and upsert them into stats_daily. Returns the rows written.
 */
export function rollupDaily(db: Db, options: RollupOptions): StatsDailyPoint[] {
  const today = utcDay(options.now);
  const day = options.day ?? today;
  if (day > today) {
    throw invalid("Cannot roll up a day that has not started.", { day });
  }
  const start = dayStart(day);
  const end = start + DAY_MS;
  /** Today's bytes are always the live figure; a past day keeps its snapshot. */
  const liveBytes = day === today ? 1 : 0;

  const locations = db.all<{ id: number }>(
    "SELECT id FROM locations WHERE enabled = 1 ORDER BY id",
  );

  const bytes = byLocation(
    db.all<LocationAggregate>(
      `SELECT location_id, SUM(size_bytes) AS value FROM media
       WHERE location_id IS NOT NULL AND created_at < ?
       GROUP BY location_id`,
      end,
    ),
  );
  const downloads = byLocation(
    db.all<LocationAggregate>(
      `SELECT location_id, COUNT(*) AS value FROM media
       WHERE kind IN ${DOWNLOAD_KINDS} AND is_current = 1
         AND downloaded_at >= ? AND downloaded_at < ? AND location_id IS NOT NULL
       GROUP BY location_id`,
      start,
      end,
    ),
  );
  const held = byLocation(
    db.all<LocationAggregate>(
      `SELECT location_id, COUNT(DISTINCT video_id) AS value FROM media
       WHERE kind IN ${DOWNLOAD_KINDS} AND is_current = 1
         AND location_id IS NOT NULL AND created_at < ?
       GROUP BY location_id`,
      end,
    ),
  );

  const all: StatsDailyPoint = {
    day,
    location_id: ALL_LOCATIONS_ID,
    bytes_used: scalar(
      db,
      "SELECT SUM(size_bytes) AS value FROM media WHERE location_id IS NOT NULL AND created_at < ?",
      end,
    ),
    downloads: scalar(
      db,
      `SELECT COUNT(*) AS value FROM media
       WHERE kind IN ${DOWNLOAD_KINDS} AND is_current = 1
         AND downloaded_at >= ? AND downloaded_at < ?`,
      start,
      end,
    ),
    catalog: scalar(db, "SELECT COUNT(*) AS value FROM videos WHERE created_at < ?", end),
    gone: scalar(
      db,
      "SELECT COUNT(*) AS value FROM videos WHERE gone_since IS NOT NULL AND gone_since < ?",
      end,
    ),
    api_units: scalar(
      db,
      "SELECT api_units AS value FROM quota_usage WHERE account_id = 0 AND day = ?",
      day,
    ),
  };

  const points: StatsDailyPoint[] = [
    all,
    ...locations.map((location): StatsDailyPoint => ({
      day,
      location_id: location.id,
      bytes_used: bytes.get(location.id) ?? 0,
      downloads: downloads.get(location.id) ?? 0,
      catalog: held.get(location.id) ?? 0,
      gone: 0,
      api_units: 0,
    })),
  ];

  db.tx(() => {
    for (const point of points) {
      db.run(
        `INSERT INTO stats_daily (day, location_id, bytes_used, downloads, catalog, gone, api_units)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (day, location_id) DO UPDATE SET
           bytes_used = CASE WHEN ? = 1 THEN excluded.bytes_used ELSE stats_daily.bytes_used END,
           downloads = excluded.downloads,
           catalog = excluded.catalog,
           gone = excluded.gone,
           api_units = excluded.api_units`,
        point.day,
        point.location_id,
        point.bytes_used,
        point.downloads,
        point.catalog,
        point.gone,
        point.api_units,
        liveBytes,
      );
    }
  });
  return points;
}

export interface BackfillResult extends StatsWindow {
  points: number;
}

/**
 * Recompute the `days` whole UTC days before today (today itself is
 * rollupDaily's job). Safe to repeat: every run converges on the same rows.
 */
export function backfill(db: Db, options: { days: number; now: number }): BackfillResult {
  const days = Math.max(0, Math.floor(options.days));
  const today = utcDay(options.now);
  let points = 0;
  for (let back = days; back >= 1; back -= 1) {
    points += rollupDaily(db, { day: addDays(today, -back), now: options.now }).length;
  }
  return {
    points,
    from: days === 0 ? today : addDays(today, -days),
    to: days === 0 ? today : addDays(today, -1),
  };
}

/** Today's rollup plus a `days`-day backfill, as POST /api/stats/rollup runs it. */
export function rollupWithBackfill(db: Db, options: { days: number; now: number }): BackfillResult {
  const filled = backfill(db, options);
  const today = rollupDaily(db, { now: options.now });
  return { points: filled.points + today.length, from: filled.from, to: utcDay(options.now) };
}

/** True once `day` has its all-locations row. */
export function hasRollup(db: Db, day: string): boolean {
  return (
    db.get(
      "SELECT 1 AS one FROM stats_daily WHERE day = ? AND location_id = ?",
      day,
      ALL_LOCATIONS_ID,
    ) !== undefined
  );
}

export interface ReadDailyOptions extends StatsWindow {
  /** A location id (0 = all locations, the default) or "all" for every row. */
  location_id?: number | "all";
}

export function readDaily(db: Db, options: ReadDailyOptions): StatsDailyPoint[] {
  const location = options.location_id ?? ALL_LOCATIONS_ID;
  const columns = "day, location_id, bytes_used, downloads, catalog, gone, api_units";
  if (location === "all") {
    return db.all<StatsDailyPoint>(
      `SELECT ${columns} FROM stats_daily WHERE day >= ? AND day <= ?
       ORDER BY day, location_id`,
      options.from,
      options.to,
    );
  }
  return db.all<StatsDailyPoint>(
    `SELECT ${columns} FROM stats_daily WHERE day >= ? AND day <= ? AND location_id = ?
     ORDER BY day, location_id`,
    options.from,
    options.to,
    location,
  );
}

/** Every location, enabled or not, for labelling points. */
export function statsLocations(db: Db): StatsLocationRef[] {
  return db.all<StatsLocationRef>("SELECT id, label FROM locations ORDER BY id");
}

/** Live counts for the summary tiles; nothing here comes from stats_daily. */
export function readSummary(db: Db, options: { now: number; budget: number }): StatsSummary {
  const current = `kind IN ${DOWNLOAD_KINDS} AND is_current = 1`;
  const locations = db.all<{
    id: number;
    label: string;
    enabled: number;
    quota_bytes: number;
    bytes_used: number;
  }>(
    `SELECT l.id, l.label, l.enabled, l.quota_bytes, COALESCE(SUM(m.size_bytes), 0) AS bytes_used
     FROM locations l LEFT JOIN media m ON m.location_id = l.id
     GROUP BY l.id ORDER BY l.id`,
  );
  return {
    videos: scalar(db, "SELECT COUNT(*) AS value FROM videos"),
    downloaded: scalar(
      db,
      `SELECT COUNT(DISTINCT video_id) AS value FROM media
       WHERE ${current} AND location_id IS NOT NULL`,
    ),
    gone: scalar(db, "SELECT COUNT(*) AS value FROM videos WHERE gone_since IS NOT NULL"),
    bytes_by_location: locations.map((row) => ({
      id: row.id,
      label: row.label,
      enabled: row.enabled === 1,
      bytes_used: row.bytes_used,
      quota_bytes: row.quota_bytes,
    })),
    api_units_today: scalar(
      db,
      "SELECT api_units AS value FROM quota_usage WHERE account_id = 0 AND day = ?",
      utcDay(options.now),
    ),
    api_units_budget: options.budget,
    downloads_7d: scalar(
      db,
      `SELECT COUNT(*) AS value FROM media WHERE ${current} AND downloaded_at >= ?`,
      options.now - 7 * DAY_MS,
    ),
    downloads_30d: scalar(
      db,
      `SELECT COUNT(*) AS value FROM media WHERE ${current} AND downloaded_at >= ?`,
      options.now - 30 * DAY_MS,
    ),
  };
}
