import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConsoleLogger } from "../../src/logging.ts";
import { bootPipeline, enqueueDownload } from "../../src/jobs/pipelineBoot.ts";
import { Scheduler } from "../../src/jobs/scheduler.ts";
import { resolveThumbnail, variantFromUrl } from "../../src/media/thumbnails.ts";
import {
  addMediaFile,
  addVideo,
  createHarness,
  mediaRows,
  setEffective,
  VIDEO_ID,
  type Harness,
} from "./harness.ts";

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

afterEach(() => {
  h.close();
});

describe("bootPipeline", () => {
  it("registers every handler once and the two schedules", () => {
    bootPipeline(h.deps);
    bootPipeline(h.deps);
    expect(h.registry.classOf("download")).toBe("download");
    expect(h.registry.classOf("transcode")).toBe("transcode");
    for (const type of ["move", "reap", "action:reap-now", "canary"]) {
      expect(h.registry.classOf(type)).toBe("maintenance");
    }
    expect(h.registry.get("download")?.maxAttempts).toBe(5);
    expect(h.registry.get("reap")?.dedupeKey?.({ location_id: 2 })).toBe("2");
    expect(h.registry.get("reap")?.dedupeKey?.({})).toBe("all");
    expect(h.schedules.map((s) => [s.name, s.intervalMs])).toEqual([
      ["reap_hourly", 3_600_000],
      ["move_scan", 600_000],
      ["reap_hourly", 3_600_000],
      ["move_scan", 600_000],
    ]);
  });

  it("schedules reaps and moves", () => {
    bootPipeline(h.deps);
    const [reap, move] = h.schedules;
    reap?.fn();
    reap?.fn();
    expect(h.db.all("SELECT id FROM jobs WHERE type = 'reap'")).toHaveLength(1);
    addVideo(h.db);
    setEffective(h, VIDEO_ID, { location_id: 2 });
    addMediaFile(h);
    move?.fn();
    expect(h.db.all("SELECT id FROM jobs WHERE type = 'move'")).toHaveLength(1);
    move?.fn();
    expect(h.db.all("SELECT id FROM jobs WHERE type = 'move'")).toHaveLength(1);
  });

  it("enqueues downloads with a preselected account, deduped per video", () => {
    addVideo(h.db);
    setEffective(h, VIDEO_ID);
    h.db.run("INSERT INTO accounts (id, label, created_at, updated_at) VALUES (3, 'a', 1, 1)");
    h.sourcing.set(VIDEO_ID, [3]);
    h.withCookies = [3];
    const first = enqueueDownload(h.deps, VIDEO_ID, {
      reason: "version",
      priority: 5,
      runAfter: 1,
    });
    expect(first.deduped).toBe(false);
    const job = h.queue.get(first.id);
    expect(job).toMatchObject({ accountId: 3, priority: 5, payload: { reason: "version" } });
    expect(enqueueDownload(h.deps, VIDEO_ID).deduped).toBe(true);
    expect(enqueueDownload(h.deps, "aaaaaaaaaaa").deduped).toBe(false);
  });

  it("runs a download end to end through the real scheduler", async () => {
    bootPipeline(h.deps);
    addVideo(h.db);
    setEffective(h, VIDEO_ID, {
      effective: {
        transcode: {
          mode: "none",
          codec: "hevc_nvenc",
          quality: 28,
          preset: "p5",
          audio_codec: "copy",
        },
      },
    });
    const scheduler = new Scheduler({
      db: h.db,
      log: createConsoleLogger("silent"),
      events: h.bus,
      logsDir: join(h.dataDir, "logs"),
      registry: h.registry,
      getSettings: () => h.settings,
      now: () => h.clock.now,
      tickMs: 0,
    });
    scheduler.start();
    const { id } = enqueueDownload(h.deps, VIDEO_ID);
    scheduler.tick();
    await scheduler.waitForIdle();
    await scheduler.stop();
    expect(h.queue.get(id)?.status).toBe("done");
    expect(mediaRows(h.db).some((row) => row.kind === "video")).toBe(true);
  });
});

describe("thumbnail mapping", () => {
  const info = {
    thumbnail: "https://i.ytimg.com/vi/x/maxresdefault.jpg",
    thumbnails: [
      { id: "0", url: "https://i.ytimg.com/vi/x/default.jpg" },
      { id: "7", url: "https://i.ytimg.com/vi_webp/x/hqdefault.webp" },
      { id: "9", url: "https://i.ytimg.com/vi/x/hq720.jpg?sqp=abc" },
    ],
  };

  it("maps numeric ids, URL names and the bare file to variants", () => {
    expect(resolveThumbnail({ path: "p", segment: "7", ext: "webp" }, info, "x")).toEqual({
      variant: "hqdefault",
      url: "https://i.ytimg.com/vi_webp/x/hqdefault.webp",
    });
    expect(resolveThumbnail({ path: "p", segment: "hq720", ext: "jpg" }, info, "x")?.variant).toBe(
      "hq720",
    );
    expect(resolveThumbnail({ path: "p", segment: null, ext: "jpg" }, info, "x")?.variant).toBe(
      "maxresdefault",
    );
    expect(resolveThumbnail({ path: "p", segment: "sddefault", ext: "jpg" }, null, "x")).toEqual({
      variant: "sddefault",
      url: "https://i.ytimg.com/vi/x/sddefault.jpg",
    });
    expect(resolveThumbnail({ path: "p", segment: null, ext: "jpg" }, null, "x")).toBeNull();
    expect(resolveThumbnail({ path: "p", segment: "a b", ext: "jpg" }, null, "x")).toBeNull();
    expect(variantFromUrl("not a url")).toBeNull();
  });
});
