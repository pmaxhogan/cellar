import { describe, expect, it } from "vitest";
import {
  STATS_DEFAULT_HOURS,
  STATS_HOUR_MS,
  STATS_MAX_HOURS,
  StatsHourlyQuerySchema,
  StatsHourlyResponseSchema,
} from "../src/index.ts";

describe("StatsHourlyQuerySchema", () => {
  it("defaults to the last 24 hours of every location", () => {
    expect(StatsHourlyQuerySchema.parse({})).toEqual({
      hours: STATS_DEFAULT_HOURS,
      location_id: 0,
    });
    expect(STATS_DEFAULT_HOURS).toBe(24);
  });

  it("coerces the query string values", () => {
    expect(StatsHourlyQuerySchema.parse({ hours: "6", location_id: "2" })).toEqual({
      hours: 6,
      location_id: 2,
    });
    expect(StatsHourlyQuerySchema.parse({ hours: String(STATS_MAX_HOURS) }).hours).toBe(
      STATS_MAX_HOURS,
    );
  });

  it.each([
    ["zero hours", { hours: "0" }],
    ["a fraction", { hours: "1.5" }],
    ["too many hours", { hours: String(STATS_MAX_HOURS + 1) }],
    ["not a number", { hours: "day" }],
    ["a negative location", { location_id: "-1" }],
    ["every location row", { location_id: "all" }],
  ])("rejects %s", (_name, query) => {
    expect(StatsHourlyQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe("StatsHourlyResponseSchema", () => {
  const from = Date.UTC(2026, 9, 18, 0);
  const point = {
    hour: from,
    downloads: 1,
    download_bytes: 2048,
    jobs_done: 3,
    jobs_failed: 1,
    videos_added: 4,
    videos_gone: 0,
    scrape_requests: 9,
  };

  it("accepts a window of hourly points", () => {
    const body = {
      hours: 1,
      from,
      to: from + STATS_HOUR_MS,
      location_id: 0,
      points: [point],
      bytes_used: 10,
      api_units_today: 5,
      locations: [{ id: 1, label: "media" }],
    };
    expect(StatsHourlyResponseSchema.parse(body)).toEqual(body);
  });

  it("rejects a negative count", () => {
    const body = {
      hours: 1,
      from,
      to: from + STATS_HOUR_MS,
      location_id: 0,
      points: [{ ...point, downloads: -1 }],
      bytes_used: 0,
      api_units_today: 0,
      locations: [],
    };
    expect(StatsHourlyResponseSchema.safeParse(body).success).toBe(false);
  });
});
