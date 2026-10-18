import { resolveSettings } from "@cellar/shared";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getKv } from "../../src/db/kv.ts";
import {
  deleteVideoMedia,
  maybeEnqueueReap,
  reapAll,
  reapLocation,
} from "../../src/domain/reaper.ts";
import { reapLocationOf, runReap } from "../../src/jobs/handlers/reap.ts";
import { isLocationPaused, setLocationPaused } from "../../src/media/rows.ts";
import {
  activityKinds,
  addMediaFile,
  addVideo,
  CHANNEL_ID,
  createHarness,
  makeCtx,
  mediaRows,
  setEffective,
  type Harness,
} from "./harness.ts";

let h: Harness;
const GIB = 1024 ** 3;

const ids = ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "ddddddddddd", "eeeeeeeeeee"];

beforeEach(() => {
  h = createHarness();
  h.settings = resolveSettings({ "reaper.min_free_gb": 0 });
});

afterEach(() => {
  h.close();
});

function seed(id: string, pri: number, size: number, downloadedAt: number): string {
  addVideo(h.db, id);
  setEffective(h, id, { reclaim_priority: pri });
  return addMediaFile(h, {
    videoId: id,
    rel: `${CHANNEL_ID}/${id}/${id}.webm`,
    size,
    downloadedAt,
  }).path;
}

function quota(bytes: number, id = 1): void {
  h.db.run("UPDATE locations SET quota_bytes = ? WHERE id = ?", bytes, id);
}

function remaining(): string[] {
  return h.db
    .all<{ video_id: string }>("SELECT DISTINCT video_id FROM media ORDER BY video_id")
    .map((row) => row.video_id);
}

describe("reapLocation", () => {
  it("does nothing under the high-water mark", async () => {
    seed(ids[0] as string, 5, 100, 1);
    quota(1000);
    const result = await reapLocation(h.deps, 1);
    expect(result).toMatchObject({ over: false, stillOver: false, deletedVideos: [] });
    expect(
      h.db.get<{ used_bytes: number }>("SELECT used_bytes FROM locations WHERE id = 1")?.used_bytes,
    ).toBe(100);
  });

  it("deletes lowest priority, then oldest, down to the low-water mark; never -1", async () => {
    const keep = seed(ids[0] as string, -1, 400, 1);
    const oldHigh = seed(ids[1] as string, 9, 200, 1);
    const newLow = seed(ids[2] as string, 1, 200, 50);
    const oldLow = seed(ids[3] as string, 1, 200, 10);
    // A kept version counts and goes with its video.
    addMediaFile(h, {
      videoId: ids[3] as string,
      rel: `${CHANNEL_ID}/${ids[3] as string}/versions/v1/${ids[3] as string}.webm`,
      size: 50,
      isCurrent: false,
    });
    quota(1100); // used 1050 >= 95% (1045); low water 990
    const result = await reapLocation(h.deps, 1);
    expect(result.over).toBe(true);
    expect(result.deletedVideos).toEqual([ids[3]]);
    expect(result.usedAfter).toBe(800);
    expect(existsSync(oldLow)).toBe(false);
    expect(existsSync(join(h.loc1, CHANNEL_ID, ids[3] as string))).toBe(false);
    expect(existsSync(newLow)).toBe(true);
    expect(existsSync(oldHigh)).toBe(true);
    expect(existsSync(keep)).toBe(true);
    expect(activityKinds(h.db)).toContain("media.reaped");

    quota(500);
    const second = await reapLocation(h.deps, 1);
    expect(second.deletedVideos).toEqual([ids[2], ids[1]]);
    expect(second.stillOver).toBe(false);
    expect(remaining()).toEqual([ids[0]]);
  });

  it("pauses the location and notifies when nothing reclaimable is left", async () => {
    seed(ids[0] as string, -1, 950, 1);
    seed(ids[1] as string, 2, 50, 1);
    quota(1000);
    const result = await reapLocation(h.deps, 1);
    expect(result).toMatchObject({ stillOver: true, paused: true, deletedVideos: [ids[1]] });
    expect(isLocationPaused(h.db, 1)).toBe(true);
    expect(getKv(h.db, "location_paused:1")).toBe(true);
    expect(h.db.get("SELECT id FROM notifications WHERE type = 'storage_pressure'")).toBeDefined();
    expect(activityKinds(h.db)).toContain("location.paused");

    quota(10_000);
    await reapLocation(h.deps, 1);
    expect(isLocationPaused(h.db, 1)).toBe(false);
    expect(activityKinds(h.db)).toContain("location.resumed");
  });

  it("reaps on low free space even without a quota", async () => {
    h.settings = resolveSettings({ "reaper.min_free_gb": 10 });
    seed(ids[0] as string, 3, 1000, 1);
    seed(ids[1] as string, 3, 1000, 2);
    h.db.run("UPDATE media SET size_bytes = ? WHERE video_id = ?", GIB, ids[0] as string);
    h.freeBytes = 9.5 * GIB;
    const result = await reapLocation(h.deps, 1);
    expect(result.over).toBe(true);
    expect(result.deletedVideos).toEqual([ids[0]]);
    expect(result.stillOver).toBe(false);
    expect(
      h.db.get<{ fs_free_bytes: number }>("SELECT fs_free_bytes FROM locations WHERE id = 1")
        ?.fs_free_bytes,
    ).toBe(Math.floor(9.5 * GIB));
  });

  it("sweeps pri 0 unconditionally and never touches meta or unevaluated videos", async () => {
    const zero = seed(ids[0] as string, 0, 10, 1);
    addVideo(h.db, ids[1] as string);
    const unevaluated = addMediaFile(h, {
      videoId: ids[1] as string,
      rel: `${CHANNEL_ID}/${ids[1] as string}/x.webm`,
    });
    const metaFile = join(h.metaDir, CHANNEL_ID, ids[0] as string, "info.json");
    mkdirSync(join(metaFile, ".."), { recursive: true });
    writeFileSync(metaFile, "{}");
    h.db.run(
      `INSERT INTO media (video_id, kind, location_id, rel_path, created_at)
       VALUES (?, 'info', NULL, ?, 1)`,
      ids[0] as string,
      `${CHANNEL_ID}/${ids[0] as string}/info.json`,
    );
    quota(1);
    const result = await reapLocation(h.deps, 1);
    expect(result.sweptPri0).toEqual([ids[0]]);
    expect(existsSync(zero)).toBe(false);
    expect(existsSync(metaFile)).toBe(true);
    expect(mediaRows(h.db, ids[0] as string).map((row) => row.kind)).toEqual(["info"]);
    expect(existsSync(unevaluated.path)).toBe(true);
    expect(result.stillOver).toBe(true);
  });

  it("refuses to delete anything that resolves under DATA_DIR", async () => {
    addVideo(h.db, ids[0] as string);
    setEffective(h, ids[0] as string, { reclaim_priority: 0 });
    h.db.run("UPDATE locations SET container_path = ? WHERE id = 2", h.dataDir);
    const file = addMediaFile(h, { videoId: ids[0] as string, locationId: 2, rel: "meta/x.webm" });
    // addMediaFile wrote under loc2's old path; put a real file at the DATA_DIR path too.
    const inData = join(h.dataDir, "meta", "x.webm");
    writeFileSync(inData, "x");
    await deleteVideoMedia(h.deps, ids[0] as string, "test");
    expect(existsSync(inData)).toBe(true);
    expect(mediaRows(h.db, ids[0] as string)).toHaveLength(1);
    expect(file.id).toBeGreaterThan(0);
  });

  it("drops rows whose file is already gone and skips disabled locations", async () => {
    const path = seed(ids[0] as string, 0, 10, 1);
    rmSync(path);
    expect(await deleteVideoMedia(h.deps, ids[0] as string, "test")).toBe(10);
    expect(mediaRows(h.db, ids[0] as string)).toEqual([]);
    h.db.run("UPDATE locations SET enabled = 0 WHERE id = 1");
    expect((await reapLocation(h.deps, 1)).over).toBe(false);
    expect((await reapLocation(h.deps, 42)).over).toBe(false);
  });
});

describe("reap job and helpers", () => {
  it("reaps every enabled location or one from the payload", async () => {
    seed(ids[0] as string, 1, 100, 1);
    quota(100);
    h.db.run("UPDATE locations SET enabled = 0 WHERE id = 2");
    expect((await reapAll(h.deps)).map((result) => result.locationId)).toEqual([1]);
    const test = makeCtx(h, { type: "reap", payload: { location_id: 1 } });
    await runReap(h.deps, test.ctx);
    expect(reapLocationOf({ location_id: 3 })).toBe(3);
    expect(reapLocationOf({ location_id: "x" })).toBeNull();
    expect(reapLocationOf(null)).toBeNull();
  });

  it("queues a reap when a location reaches its high-water mark", () => {
    seed(ids[0] as string, 1, 100, 1);
    expect(maybeEnqueueReap(h.deps, 1)).toBe(false);
    quota(1000);
    expect(maybeEnqueueReap(h.deps, 1)).toBe(false);
    quota(100);
    expect(maybeEnqueueReap(h.deps, 1)).toBe(true);
    expect(maybeEnqueueReap(h.deps, 77)).toBe(false);
    setLocationPaused(h.db, 1, false, 1);
  });
});
