import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  StatsDailyResponseSchema,
  StatsHourlyResponseSchema,
  StatsRollupResponseSchema,
  StatsSummarySchema,
} from "@cellar/shared";
import { addDays, utcDay } from "../src/domain/stats.ts";
import { createTempApp, type TempApp } from "./helpers.ts";
import { seedLocation, seedMedia, seedVideo, vid } from "./videoSeed.ts";

let temp: TempApp;
let today: string;

function insertPoint(day: string, locationId: number, catalog: number): void {
  temp.db.run(
    `INSERT INTO stats_daily (day, location_id, bytes_used, downloads, catalog, gone, api_units)
     VALUES (?, ?, 0, 0, ?, 0, 0)`,
    day,
    locationId,
    catalog,
  );
}

async function get(url: string) {
  return temp.app.inject({ method: "GET", url });
}

beforeEach(async () => {
  temp = await createTempApp();
  today = utcDay(Date.now());
});

afterEach(async () => {
  await temp.close();
});

describe("GET /api/stats/daily", () => {
  it("defaults to the last 90 days of the all-locations row", async () => {
    const second = seedLocation(temp.db, "second", "/media2");
    insertPoint(today, 0, 10);
    insertPoint(today, second, 4);
    insertPoint(addDays(today, -89), 0, 1);
    insertPoint(addDays(today, -90), 0, 99);

    const response = await get("/api/stats/daily");
    expect(response.statusCode).toBe(200);
    const body = StatsDailyResponseSchema.parse(response.json());
    expect(body.from).toBe(addDays(today, -89));
    expect(body.to).toBe(today);
    expect(body.points.map((point) => [point.day, point.location_id, point.catalog])).toEqual([
      [addDays(today, -89), 0, 1],
      [today, 0, 10],
    ]);
    expect(body.locations).toEqual([
      { id: 1, label: "media" },
      { id: second, label: "second" },
    ]);
  });

  it("filters by location, or answers every row for location_id=all", async () => {
    const second = seedLocation(temp.db, "second", "/media2");
    insertPoint("2026-03-01", 0, 10);
    insertPoint("2026-03-01", second, 4);
    insertPoint("2026-03-02", second, 5);
    const range = "from=2026-03-01&to=2026-03-02";

    const one = StatsDailyResponseSchema.parse(
      (await get(`/api/stats/daily?${range}&location_id=${String(second)}`)).json(),
    );
    expect(one.points.map((point) => point.catalog)).toEqual([4, 5]);

    const all = StatsDailyResponseSchema.parse(
      (await get(`/api/stats/daily?${range}&location_id=all`)).json(),
    );
    expect(all.points.map((point) => [point.day, point.location_id])).toEqual([
      ["2026-03-01", 0],
      ["2026-03-01", second],
      ["2026-03-02", second],
    ]);
  });

  it.each([
    ["from=2026-3-1", "query string"],
    ["from=2026-02-30", "query string"],
    ["location_id=-1", "query string"],
    ["location_id=some", "query string"],
    ["from=2026-03-02&to=2026-03-01", "after"],
    ["from=2025-01-01&to=2026-03-01", "at most"],
  ])("rejects %s", async (query, message) => {
    const response = await get(`/api/stats/daily?${query}`);
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: string; code: string }>();
    expect(body.code).toBe("invalid");
    expect(body.error).toContain(message);
  });
});

describe("GET /api/stats/hourly", () => {
  const HOUR = 3_600_000;

  it("defaults to 24 zero-filled hours ending with the current one", async () => {
    const before = Date.now();
    const response = await get("/api/stats/hourly");
    expect(response.statusCode).toBe(200);
    const body = StatsHourlyResponseSchema.parse(response.json());
    expect(body.hours).toBe(24);
    expect(body.location_id).toBe(0);
    expect(body.points).toHaveLength(24);
    expect(body.to % HOUR).toBe(0);
    expect(body.to).toBeGreaterThan(before);
    expect(body.to - body.from).toBe(24 * HOUR);
    expect(body.points[0]?.hour).toBe(body.from);
    expect(body.locations).toEqual([{ id: 1, label: "media" }]);
  });

  it("counts downloads at one location and answers its live storage", async () => {
    const second = seedLocation(temp.db, "second", "/media2");
    seedVideo(temp.db, { id: vid("a") });
    seedVideo(temp.db, { id: vid("b") });
    const recent = Date.now() - 1000;
    seedMedia(temp.db, {
      video_id: vid("a"),
      kind: "video",
      rel_path: "a.mkv",
      location_id: 1,
      size_bytes: 10,
      downloaded_at: recent,
    });
    seedMedia(temp.db, {
      video_id: vid("b"),
      kind: "video",
      rel_path: "b.mkv",
      location_id: second,
      size_bytes: 20,
      downloaded_at: recent,
    });

    const all = StatsHourlyResponseSchema.parse((await get("/api/stats/hourly?hours=2")).json());
    // A second ago may sit in either bucket when the test straddles an hour.
    const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);
    expect(sum(all.points.map((point) => point.downloads))).toBe(2);
    expect(all.bytes_used).toBe(30);

    const one = StatsHourlyResponseSchema.parse(
      (await get(`/api/stats/hourly?hours=2&location_id=${String(second)}`)).json(),
    );
    expect(one.location_id).toBe(second);
    expect(sum(one.points.map((point) => point.download_bytes))).toBe(20);
    expect(one.bytes_used).toBe(20);
  });

  it.each(["hours=0", "hours=169", "hours=1.5", "hours=day", "location_id=all", "location_id=-1"])(
    "rejects %s",
    async (query) => {
      const response = await get(`/api/stats/hourly?${query}`);
      expect(response.statusCode).toBe(400);
      const body = response.json<{ error: string; code: string }>();
      expect(body.code).toBe("invalid");
      expect(body.error).toContain("query string");
    },
  );
});

describe("GET /api/stats/summary", () => {
  it("answers live counts and the API budget", async () => {
    seedVideo(temp.db, { id: vid("a") });
    seedVideo(temp.db, { id: vid("b"), gone_since: Date.now() });
    seedMedia(temp.db, {
      video_id: vid("a"),
      kind: "video",
      rel_path: "a.mkv",
      location_id: 1,
      size_bytes: 2048,
      downloaded_at: Date.now() - 1000,
    });
    temp.db.run("UPDATE locations SET quota_bytes = 4096 WHERE id = 1");
    temp.db.run(
      "INSERT INTO quota_usage (account_id, day, api_units) VALUES (0, ?, 77)",
      utcDay(Date.now()),
    );

    const response = await get("/api/stats/summary");
    expect(response.statusCode).toBe(200);
    expect(StatsSummarySchema.parse(response.json())).toEqual({
      videos: 2,
      downloaded: 1,
      gone: 1,
      bytes_by_location: [
        { id: 1, label: "media", enabled: true, bytes_used: 2048, quota_bytes: 4096 },
      ],
      api_units_today: 77,
      api_units_budget: 10_000,
      downloads_7d: 1,
      downloads_30d: 1,
    });
  });
});

describe("POST /api/stats/rollup", () => {
  it("rolls up today plus a 7-day backfill", async () => {
    seedVideo(temp.db, { id: vid("a") });
    const response = await temp.app.inject({ method: "POST", url: "/api/stats/rollup" });
    expect(response.statusCode).toBe(200);
    // Eight days, each with the all-locations row and the seeded "media" location.
    expect(StatsRollupResponseSchema.parse(response.json())).toEqual({
      points: 16,
      from: addDays(today, -7),
      to: today,
    });

    const daily = StatsDailyResponseSchema.parse((await get("/api/stats/daily")).json());
    expect(daily.points).toHaveLength(8);
    expect(daily.points.at(-1)).toMatchObject({ day: today, catalog: 1 });
  });
});
