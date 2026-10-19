import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.ts";
import { HOURLY_SQL, hourlyWindow, readHourly } from "../src/domain/statsHourly.ts";
import { createTempDb, type TempDb } from "./helpers.ts";
import { seedLocation, seedMedia, seedVideo, vid } from "./videoSeed.ts";

const HOUR = 3_600_000;
/** 12:34:56.789 UTC: the current, partial hour is 12:00 to 13:00. */
const NOW = Date.UTC(2026, 9, 18, 12, 34, 56, 789);
/** Start of the first bucket of the 24-hour window ending with the current hour. */
const FROM = Date.UTC(2026, 9, 17, 13);
const TO = Date.UTC(2026, 9, 18, 13);
/** The migration seeds location 1 ("media"). */
const MEDIA = 1;

let temp: TempDb;
let db: Db;
let second: number;
let mediaSeq = 0;

function download(at: number | null, options: Record<string, number | string | null> = {}): void {
  mediaSeq += 1;
  const id = vid(`m${String(mediaSeq)}`);
  seedVideo(db, { id, created_at: FROM - 10 * HOUR });
  seedMedia(db, {
    video_id: id,
    kind: "video",
    rel_path: `${id}.mkv`,
    location_id: MEDIA,
    size_bytes: 100,
    downloaded_at: at,
    created_at: at ?? FROM,
    ...options,
  });
}

let jobSeq = 0;
function job(status: string, finishedAt: number | null): void {
  jobSeq += 1;
  db.run(
    "INSERT INTO jobs (type, status, finished_at, created_at) VALUES (?, ?, ?, ?)",
    `type${String(jobSeq % 3)}`,
    status,
    finishedAt,
    FROM - HOUR,
  );
}

function scrape(accountId: number, key: string, requests: number): void {
  db.run(
    "INSERT INTO quota_usage (account_id, day, scrape_requests) VALUES (?, ?, ?)",
    accountId,
    key,
    requests,
  );
}

beforeEach(() => {
  temp = createTempDb();
  db = temp.db;
  second = seedLocation(db, "second", "/media2");
  mediaSeq = 0;
  jobSeq = 0;
});

afterEach(() => {
  temp.close();
});

describe("hourlyWindow", () => {
  it("ends with the current hour, aligned to UTC hours", () => {
    expect(hourlyWindow(24, NOW)).toEqual({ hours: 24, from: FROM, to: TO });
    expect(hourlyWindow(1, NOW)).toEqual({ hours: 1, from: TO - HOUR, to: TO });
  });

  it("treats an instant exactly on the hour as the start of a new bucket", () => {
    const onTheHour = Date.UTC(2026, 9, 18, 12);
    expect(hourlyWindow(24, onTheHour).to).toBe(TO);
    expect(hourlyWindow(24, onTheHour - 1).to).toBe(TO - HOUR);
  });
});

describe("readHourly", () => {
  it("answers one zero-filled point per hour when nothing happened", () => {
    const result = readHourly(db, { hours: 24, now: NOW, location_id: 0 });
    expect(result.from).toBe(FROM);
    expect(result.to).toBe(TO);
    expect(result.points).toHaveLength(24);
    expect(result.points.map((point) => point.hour)).toEqual(
      Array.from({ length: 24 }, (_, index) => FROM + index * HOUR),
    );
    for (const point of result.points) {
      expect(point).toMatchObject({
        downloads: 0,
        download_bytes: 0,
        jobs_done: 0,
        jobs_failed: 0,
        videos_added: 0,
        videos_gone: 0,
        scrape_requests: 0,
      });
    }
    expect(result.bytes_used).toBe(0);
    expect(result.api_units_today).toBe(0);
  });

  it("buckets downloads on the hour edges and leaves out the rest", () => {
    download(FROM - 1); // before the window
    download(FROM); // first bucket, on its boundary
    download(FROM + HOUR - 1); // still the first bucket
    download(FROM + HOUR); // second bucket
    download(NOW, { size_bytes: 500 }); // current hour
    download(TO); // the next hour has not started
    download(null); // never downloaded
    download(FROM + 5 * HOUR, { kind: "captions", location_id: null });
    download(FROM + 5 * HOUR, { kind: "info", location_id: null });
    // A superseded version still counts in the hour it was fetched.
    download(FROM + 6 * HOUR, { is_current: 0, version: 1 });
    download(FROM + 6 * HOUR, { kind: "audio" });

    const points = readHourly(db, { hours: 24, now: NOW, location_id: 0 }).points;
    const downloads = points.map((point) => point.downloads);
    expect(downloads[0]).toBe(2);
    expect(downloads[1]).toBe(1);
    expect(downloads[5]).toBe(0);
    expect(downloads[6]).toBe(2);
    expect(downloads[23]).toBe(1);
    expect(downloads.reduce((sum, value) => sum + value, 0)).toBe(6);
    expect(points[0]?.download_bytes).toBe(200);
    expect(points[23]?.download_bytes).toBe(500);
  });

  it("filters the download series by location and keeps the rest catalog wide", () => {
    download(FROM + HOUR, { size_bytes: 10 });
    download(FROM + HOUR, { location_id: second, size_bytes: 20 });
    download(FROM + 2 * HOUR, { location_id: second, size_bytes: 40 });
    job("done", FROM + HOUR);
    seedVideo(db, { id: vid("added"), created_at: FROM + HOUR });

    const all = readHourly(db, { hours: 24, now: NOW, location_id: 0 });
    expect(all.location_id).toBe(0);
    expect(all.points[1]).toMatchObject({ downloads: 2, download_bytes: 30, jobs_done: 1 });
    expect(all.bytes_used).toBe(70);

    const here = readHourly(db, { hours: 24, now: NOW, location_id: second });
    expect(here.location_id).toBe(second);
    expect(here.points[1]).toMatchObject({ downloads: 1, download_bytes: 20, jobs_done: 1 });
    expect(here.points[2]).toMatchObject({ downloads: 1, download_bytes: 40 });
    // The download videos were catalogued before the window; "added" was not.
    expect(here.points[1]?.videos_added).toBe(1);
    expect(here.bytes_used).toBe(60);
  });

  it("counts finished jobs by outcome and ignores cancelled and unfinished ones", () => {
    job("done", FROM);
    job("done", FROM + 3 * HOUR + 1);
    job("failed", FROM + 3 * HOUR + 2);
    job("cancelled", FROM + 3 * HOUR);
    job("queued", null);
    job("running", null);
    job("done", FROM - 1);
    job("failed", TO);

    const points = readHourly(db, { hours: 24, now: NOW, location_id: 0 }).points;
    expect(points[0]).toMatchObject({ jobs_done: 1, jobs_failed: 0 });
    expect(points[3]).toMatchObject({ jobs_done: 1, jobs_failed: 1 });
    expect(points.reduce((sum, point) => sum + point.jobs_done + point.jobs_failed, 0)).toBe(3);
  });

  it("counts videos added and gone per hour", () => {
    seedVideo(db, { id: vid("old"), created_at: FROM - 1, gone_since: FROM + 2 * HOUR });
    seedVideo(db, { id: vid("new1"), created_at: FROM + 2 * HOUR });
    seedVideo(db, { id: vid("new2"), created_at: TO - 1, gone_since: TO - 1 });
    seedVideo(db, { id: vid("gone0"), created_at: FROM - HOUR, gone_since: FROM - 1 });

    const points = readHourly(db, { hours: 24, now: NOW, location_id: 0 }).points;
    expect(points[2]).toMatchObject({ videos_added: 1, videos_gone: 1 });
    expect(points[23]).toMatchObject({ videos_added: 1, videos_gone: 1 });
    expect(points.reduce((sum, point) => sum + point.videos_added, 0)).toBe(2);
    expect(points.reduce((sum, point) => sum + point.videos_gone, 0)).toBe(2);
  });

  it("sums scrape requests across accounts from the hourly quota rows only", () => {
    scrape(1, "2026-10-17T13", 3);
    scrape(2, "2026-10-17T13", 4);
    scrape(1, "2026-10-18T12", 5);
    scrape(1, "2026-10-17T12", 99); // before the window
    scrape(1, "2026-10-18T13", 99); // after it
    // A day row sorts between the hour keys and must not leak in.
    db.run("INSERT INTO quota_usage (account_id, day, api_units) VALUES (0, '2026-10-18', 77)");

    const result = readHourly(db, { hours: 24, now: NOW, location_id: 0 });
    expect(result.points[0]?.scrape_requests).toBe(7);
    expect(result.points[23]?.scrape_requests).toBe(5);
    expect(result.points.reduce((sum, point) => sum + point.scrape_requests, 0)).toBe(12);
    expect(result.api_units_today).toBe(77);
  });

  it("crosses UTC midnight without a gap or a repeated hour", () => {
    const justAfterMidnight = Date.UTC(2026, 9, 18, 0, 5);
    download(Date.UTC(2026, 9, 17, 23, 59, 59, 999));
    download(Date.UTC(2026, 9, 18, 0));
    const result = readHourly(db, { hours: 3, now: justAfterMidnight, location_id: 0 });
    expect(result.points.map((point) => new Date(point.hour).toISOString())).toEqual([
      "2026-10-17T22:00:00.000Z",
      "2026-10-17T23:00:00.000Z",
      "2026-10-18T00:00:00.000Z",
    ]);
    expect(result.points.map((point) => point.downloads)).toEqual([0, 1, 1]);
  });
});

describe("hourly query plans", () => {
  const plan = (sql: string, params: number): string =>
    db
      .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...Array<number>(params).fill(0))
      .map((row) => row.detail)
      .join("\n");

  it.each([
    ["downloads", HOURLY_SQL.downloads, 2, "media_downloaded_at"],
    ["downloads at a location", HOURLY_SQL.downloadsAt, 3, "media_downloaded_at"],
    ["jobs", HOURLY_SQL.jobs, 2, "jobs_finished_at"],
    ["videos added", HOURLY_SQL.videosAdded, 2, "videos_created_at"],
    ["videos gone", HOURLY_SQL.videosGone, 2, "videos_gone_since"],
    ["scrape requests", HOURLY_SQL.scrape, 2, "quota_usage_day"],
  ])("reads %s through an index on its timestamp", (_name, sql, params, index) => {
    expect(plan(sql, params)).toContain(index);
  });
});
