import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { downloadableVideoIds, runDownloadScan } from "../../src/jobs/handlers/downloadScan.ts";
import { addVideo, createHarness, setEffective, type Harness } from "./harness.ts";

const KEEP = "dQw4w9WgXcQ";
const TRASHED = "jNQXAC9IVRw";
const GONE = "9bZkp7q19f0";
const EXCLUDED = "aircAruvnKk";
const ON_DISK = "WUvTyaaNkzM";

describe("download scan", () => {
  let h: Harness;

  beforeEach(() => {
    h = createHarness();
    for (const id of [KEEP, TRASHED, GONE, EXCLUDED, ON_DISK]) {
      addVideo(h.db, id);
    }
    setEffective(h, KEEP, { reclaim_priority: -1 });
    setEffective(h, TRASHED, { reclaim_priority: 0 });
    setEffective(h, GONE, { reclaim_priority: -1 });
    h.db.run("UPDATE videos SET gone_since = 5 WHERE id = ?", GONE);
    setEffective(h, EXCLUDED, { reclaim_priority: -1, include: false });
    setEffective(h, ON_DISK, { reclaim_priority: 1, location_id: 1 });
    h.db.run(
      `INSERT INTO media (video_id, kind, version, is_current, location_id, rel_path, size_bytes, created_at)
       VALUES (?, 'video', 1, 1, 1, 'x/y.webm', 10, 1)`,
      ON_DISK,
    );
  });

  afterEach(() => {
    h.close();
  });

  it("selects included, kept, present videos without current media", () => {
    expect(downloadableVideoIds(h.db)).toEqual([KEEP]);
  });

  it("skips videos with a download already queued", () => {
    h.queue.enqueue({ type: "download", videoId: KEEP, payload: {} });
    expect(downloadableVideoIds(h.db)).toEqual([]);
  });

  it("queues a download per candidate once and logs an activity", () => {
    expect(runDownloadScan(h.deps)).toBe(1);
    const jobs = h.db.all<{ video_id: string; status: string }>(
      "SELECT video_id, status FROM jobs WHERE type = 'download'",
    );
    expect(jobs).toEqual([{ video_id: KEEP, status: "queued" }]);
    // A second scan finds the queued job and adds nothing.
    expect(runDownloadScan(h.deps)).toBe(0);
    const activity = h.db.all<{ kind: string }>(
      "SELECT kind FROM activity WHERE kind = ?",
      "download.scan",
    );
    expect(activity.length).toBe(1);
  });
});
