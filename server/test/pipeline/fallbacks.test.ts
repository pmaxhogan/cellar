import { effectDefaults } from "@cellar/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../../src/events.ts";
import { bootPipeline } from "../../src/jobs/pipelineBoot.ts";
import {
  createFallbackPipelineDeps,
  readEffectiveFallback,
  sourcingAccountsFallback,
} from "../../src/jobs/pipelineFallbacks.ts";
import { JobRegistry } from "../../src/jobs/types.ts";
import { createConsoleLogger } from "../../src/logging.ts";
import { createTempDb, type TempDb } from "../helpers.ts";
import { addVideo, VIDEO_ID, CHANNEL_ID } from "./harness.ts";

let temp: TempDb;
let dir: string;

beforeEach(() => {
  temp = createTempDb();
  dir = mkdtempSync(join(tmpdir(), "cellar-fallback-"));
});

afterEach(() => {
  vi.useRealTimers();
  temp.close();
  rmSync(dir, { recursive: true, force: true });
});

function build(): ReturnType<typeof createFallbackPipelineDeps> {
  return createFallbackPipelineDeps({
    config: {
      dataDir: dir,
      metaDir: join(dir, "meta"),
      tmpDir: join(dir, "tmp"),
      potProviderUrl: "http://bgutil:4416",
      binDir: join(dir, "bin"),
    },
    db: temp.db,
    log: createConsoleLogger("silent"),
    events: new EventBus(),
  });
}

describe("fallback pipeline deps", () => {
  it("boots the pipeline on a fresh registry", () => {
    vi.useFakeTimers();
    const deps = build();
    deps.registry = new JobRegistry();
    bootPipeline(deps);
    expect(deps.registry.has("download")).toBe(true);
    expect(deps.registry.has("action:reap-now")).toBe(true);
    vi.advanceTimersByTime(60 * 60_000);
    expect(temp.db.all("SELECT id FROM jobs WHERE type = 'reap'")).toHaveLength(1);
  });

  it("logs failing schedule callbacks instead of throwing", async () => {
    vi.useFakeTimers();
    const deps = build();
    deps.every("a", 1000, () => {
      throw new Error("sync");
    });
    deps.every("b", 1000, () => Promise.reject(new Error("async")));
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
  });

  it("reads effective settings, sources and locations from the database", async () => {
    const deps = build();
    addVideo(temp.db);
    expect(readEffectiveFallback(temp.db, VIDEO_ID)).toBeNull();
    const insert = (json: string): void => {
      temp.db.run(
        `INSERT INTO video_effective (video_id, effective_json, provenance_json, matched_rule_ids,
                                      evaluated_at, reclaim_priority, location_id, include)
         VALUES (?, ?, '{}', '[]', 1, 3, 1, 1)
         ON CONFLICT (video_id) DO UPDATE SET effective_json = excluded.effective_json`,
        VIDEO_ID,
        json,
      );
    };
    insert("not json");
    expect(deps.getEffective(VIDEO_ID)).toBeNull();
    insert('{"media_mode":"nope"}');
    expect(deps.getEffective(VIDEO_ID)).toBeNull();
    insert(JSON.stringify(effectDefaults()));
    expect(deps.getEffective(VIDEO_ID)).toMatchObject({
      reclaim_priority: 3,
      location_id: 1,
      include: true,
    });

    temp.db.run(
      "INSERT INTO accounts (id, label, created_at, updated_at) VALUES (4, 'a', 1, 1), (9, 'b', 1, 1)",
    );
    temp.db.run(
      "INSERT INTO video_sources (video_id, account_id, source, first_seen_at, last_seen_at) VALUES (?, 9, 'liked', 1, 1)",
      VIDEO_ID,
    );
    temp.db.run(
      "INSERT INTO channel_sources (channel_id, account_id, kind, created_at) VALUES (?, 4, 'subscription', 1)",
      CHANNEL_ID,
    );
    expect(sourcingAccountsFallback(temp.db, VIDEO_ID)).toEqual([4, 9]);
    expect(deps.sourcingAccountIds(VIDEO_ID)).toEqual([4, 9]);
    expect(deps.locations()).toEqual([
      { id: 1, container_path: "/media", quota_bytes: 0, enabled: true },
    ]);
    expect(deps.accountsWithCookies()).toEqual([]);
    expect(deps.pickProxy("pool")).toBeNull();
    expect(deps.markProxyFailure(1)).toBeUndefined();
    deps.markProxyOk(1);
    await expect(deps.withCookiesFile(1, () => Promise.resolve(1))).rejects.toThrow(/not wired/);
    expect(deps.getSettings()["reaper.high_water_pct"]).toBe(95);
    expect(deps.config.ytdlpPluginDirs).toBe("/opt/cellar/yt-dlp-plugins");
    expect(deps.now()).toBeGreaterThan(0);
  });

  it("writes activity, jobs and notifications", async () => {
    const deps = build();
    deps.logActivity({ kind: "x", message: "y" });
    expect(temp.db.get("SELECT kind FROM activity")).toEqual({ kind: "x" });
    expect(deps.enqueue({ type: "reap", dedupe: true }).deduped).toBe(false);
    await deps.notify({ type: "t", title: "t", body: "b" });
    await deps.recordStoragePressure(1, "full");
    await deps.recordFsError("disk");
    expect(await deps.recordDownloadFailure(VIDEO_ID)).toBeNull();
    deps.recordDownloadSuccess();
    expect(
      temp.db.all("SELECT type FROM notifications ORDER BY id").map((row) => row.type),
    ).toEqual(["t", "storage_pressure", "fs_error"]);
  });
});
