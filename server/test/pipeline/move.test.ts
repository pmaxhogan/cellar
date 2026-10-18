import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { moveVideoMedia, scheduleMovesForChangedLocations } from "../../src/domain/mover.ts";
import { runMove } from "../../src/jobs/handlers/move.ts";
import { setLocationPaused } from "../../src/media/rows.ts";
import {
  activityKinds,
  addMediaFile,
  addVideo,
  CHANNEL_ID,
  createHarness,
  makeCtx,
  mediaRows,
  setEffective,
  VIDEO_ID,
  type Harness,
} from "./harness.ts";

let h: Harness;

beforeEach(() => {
  h = createHarness();
  addVideo(h.db);
});

afterEach(() => {
  h.close();
});

const content = Buffer.from("media bytes for the move test");
const sha = createHash("sha256").update(content).digest("hex");

describe("move", () => {
  it("moves current and kept versions to the new location and verifies them", async () => {
    setEffective(h, VIDEO_ID, { location_id: 2 });
    const current = addMediaFile(h, { content, sha256: sha });
    const kept = addMediaFile(h, {
      content,
      rel: `${CHANNEL_ID}/${VIDEO_ID}/versions/v1/${VIDEO_ID}.webm`,
      isCurrent: false,
      sha256: null,
    });
    expect(scheduleMovesForChangedLocations(h.deps)).toBe(1);
    const job = h.db.get<{ id: number }>(
      "SELECT id FROM jobs WHERE type = 'move' AND video_id = ?",
      VIDEO_ID,
    );
    expect(job).toBeDefined();
    // A second scan dedupes onto the queued job.
    scheduleMovesForChangedLocations(h.deps);
    expect(h.db.all("SELECT id FROM jobs WHERE type = 'move'")).toHaveLength(1);

    const test = makeCtx(h, { type: "move", videoId: VIDEO_ID });
    await runMove(h.deps, test.ctx);

    expect(existsSync(current.path)).toBe(false);
    expect(existsSync(kept.path)).toBe(false);
    expect(existsSync(join(h.loc2, CHANNEL_ID, VIDEO_ID, `${VIDEO_ID}.webm`))).toBe(true);
    expect(
      existsSync(join(h.loc2, CHANNEL_ID, VIDEO_ID, "versions", "v1", `${VIDEO_ID}.webm`)),
    ).toBe(true);
    expect(readdirSync(h.loc1)).toEqual([]);
    expect(existsSync(join(h.loc2, ".tmp", VIDEO_ID))).toBe(false);
    expect(mediaRows(h.db).map((row) => row.location_id)).toEqual([2, 2]);
    expect(activityKinds(h.db)).toContain("media.moved");
    expect(scheduleMovesForChangedLocations(h.deps)).toBe(0);
  });

  it("resolves a null location to the first enabled one", async () => {
    setEffective(h, VIDEO_ID, { location_id: null });
    addMediaFile(h, { locationId: 2, content });
    const result = await moveVideoMedia(h.deps, VIDEO_ID);
    expect(result).toMatchObject({ moved: 1, targetLocationId: 1, bytes: content.length });
    expect(existsSync(join(h.loc1, CHANNEL_ID, VIDEO_ID, `${VIDEO_ID}.webm`))).toBe(true);
  });

  it("copies across filesystems when rename says EXDEV", async () => {
    setEffective(h, VIDEO_ID, { location_id: 2 });
    addMediaFile(h, { content, sha256: sha });
    h.deps.rename = () =>
      Promise.reject(Object.assign(new Error("cross-device"), { code: "EXDEV" }));
    const result = await moveVideoMedia(h.deps, VIDEO_ID);
    expect(result.moved).toBe(1);
    expect(existsSync(join(h.loc2, CHANNEL_ID, VIDEO_ID, `${VIDEO_ID}.webm`))).toBe(true);
  });

  it("refuses a copy whose sha256 does not match and keeps the source", async () => {
    setEffective(h, VIDEO_ID, { location_id: 2 });
    const source = addMediaFile(h, { content, sha256: "0".repeat(64) });
    await expect(moveVideoMedia(h.deps, VIDEO_ID)).rejects.toThrow(/sha256/);
    expect(existsSync(source.path)).toBe(true);
    expect(mediaRows(h.db)[0]?.location_id).toBe(1);
    expect(existsSync(join(h.loc2, CHANNEL_ID))).toBe(false);
    expect(h.db.get("SELECT id FROM notifications WHERE type = 'fs_error'")).toBeDefined();
  });

  it("skips paused, disabled and unevaluated targets and missing files", async () => {
    addMediaFile(h, { content });
    expect((await moveVideoMedia(h.deps, VIDEO_ID)).skipped).toBe("not evaluated");
    setEffective(h, VIDEO_ID, { location_id: 2 });
    setLocationPaused(h.db, 2, true, 1);
    expect((await moveVideoMedia(h.deps, VIDEO_ID)).skipped).toBe("target paused");
    setLocationPaused(h.db, 2, false, 1);
    h.db.run("UPDATE locations SET enabled = 0 WHERE id = 2");
    expect((await moveVideoMedia(h.deps, VIDEO_ID)).skipped).toBe("target unavailable");
    expect(scheduleMovesForChangedLocations(h.deps)).toBe(0);
    h.db.run("UPDATE locations SET enabled = 1 WHERE id = 2");
    rmSync(join(h.loc1, CHANNEL_ID), { recursive: true, force: true });
    expect((await moveVideoMedia(h.deps, VIDEO_ID)).moved).toBe(0);
    expect(mediaRows(h.db)[0]?.location_id).toBe(1);
  });

  it("ignores invalid job video ids", async () => {
    const test = makeCtx(h, { type: "move", videoId: null });
    await runMove(h.deps, test.ctx);
    expect(activityKinds(h.db)).toEqual([]);
  });
});
