import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.ts";
import { listActivity } from "../src/domain/activity.ts";
import {
  isWithin,
  mediaTarget,
  PRI0_SWEEP_JOB,
  registerPri0Sweep,
  sweepPri0,
} from "../src/jobs/handlers/pri0Sweep.ts";
import { JobRegistry, type JobContext } from "../src/jobs/types.ts";
import { createConsoleLogger } from "../src/logging.ts";
import { createTempDb, type TempDb } from "./helpers.ts";
import { addMedia, addVideo, harness, vid, type Harness } from "./rulesFixtures.ts";

let temp: TempDb;
let h: Harness;
let root: string;
let dataDir: string;

function setPri(db: Db, videoId: string, pri: number): void {
  db.run(
    `INSERT INTO video_effective (video_id, effective_json, provenance_json, matched_rule_ids,
                                  evaluated_at, reclaim_priority, location_id, include)
     VALUES (?, '{}', '{}', '[]', 1, ?, 1, 1)
     ON CONFLICT (video_id) DO UPDATE SET reclaim_priority = excluded.reclaim_priority`,
    videoId,
    pri,
  );
}

/** Write a file under the location root and register it as media. */
function mediaFile(
  videoId: string,
  rel: string,
  extra: Parameters<typeof addMedia>[2] = {},
): number {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x".repeat(10));
  return addMedia(temp.db, videoId, { rel_path: rel, size_bytes: 10, ...extra });
}

function mediaIds(videoId: string): number[] {
  return temp.db
    .all<{ id: number }>("SELECT id FROM media WHERE video_id = ? ORDER BY id", videoId)
    .map((r) => r.id);
}

beforeEach(() => {
  temp = createTempDb();
  dataDir = join(temp.dir, "data");
  mkdirSync(join(dataDir, "meta"), { recursive: true });
  root = mkdtempSync(join(tmpdir(), "cellar-loc-"));
  temp.db.run("UPDATE locations SET container_path = ? WHERE id = 1", root);
  h = harness(temp.db, dataDir);
});

afterEach(() => {
  temp.close();
  rmSync(root, { recursive: true, force: true });
});

describe("path guards", () => {
  it("isWithin and mediaTarget keep targets inside the location and outside DATA_DIR", () => {
    expect(isWithin("/a/b", "/a/b")).toBe(true);
    expect(isWithin("/a/b", "/a/b/c")).toBe(true);
    expect(isWithin("/a/b", "/a/bc")).toBe(false);
    expect(isWithin("/a/b", "/a")).toBe(false);
    expect(mediaTarget(root, "UC/x/y.mkv", dataDir)).toBe(join(root, "UC", "x", "y.mkv"));
    expect(mediaTarget(root, "", dataDir)).toBeNull();
    expect(mediaTarget(root, ".", dataDir)).toBeNull();
    expect(mediaTarget(root, "../escape.mkv", dataDir)).toBeNull();
    expect(mediaTarget(root, join(root, "abs.mkv"), dataDir)).toBeNull();
    expect(mediaTarget(join(dataDir, "media"), "a.mkv", dataDir)).toBeNull();
  });
});

describe("sweepPri0", () => {
  it("deletes every video/audio version of pri-0 videos and nothing else", async () => {
    const doomed = addVideo(temp.db, vid("doomed"));
    const kept = addVideo(temp.db, vid("kept"));
    setPri(temp.db, doomed, 0);
    setPri(temp.db, kept, -1);
    mediaFile(doomed, `UCchan/${doomed}/${doomed}.mkv`);
    mediaFile(doomed, `UCchan/${doomed}/versions/v1/${doomed}.mkv`, { version: 1, is_current: 0 });
    mediaFile(doomed, `UCchan/${doomed}/${doomed}.opus`, { kind: "audio" });
    const keptMedia = mediaFile(kept, `UCchan/${kept}/${kept}.mkv`);
    // Captions and info json live under /data/meta with a NULL location.
    const metaFile = join(dataDir, "meta", "UCchan", doomed, "en.vtt");
    mkdirSync(join(metaFile, ".."), { recursive: true });
    writeFileSync(metaFile, "WEBVTT");
    const captions = addMedia(temp.db, doomed, {
      kind: "captions",
      location_id: null,
      rel_path: `UCchan/${doomed}/en.vtt`,
    });
    const info = addMedia(temp.db, doomed, { kind: "info", location_id: null, rel_path: "i.json" });

    const result = await sweepPri0(h.deps);
    expect(result).toEqual({ videos: 1, files: 3, bytes: 30, errors: 0 });
    expect(mediaIds(doomed)).toEqual([captions, info]);
    expect(mediaIds(kept)).toEqual([keptMedia]);
    expect(existsSync(join(root, "UCchan", doomed))).toBe(false);
    expect(existsSync(join(root, "UCchan", kept, `${kept}.mkv`))).toBe(true);
    expect(existsSync(metaFile)).toBe(true);
    expect(existsSync(root)).toBe(true);

    const activity = listActivity(temp.db, { page: 1, perPage: 5 }).rows;
    expect(activity[0]).toMatchObject({
      kind: "media.deleted",
      video_id: doomed,
      data: { files: 3, bytes: 30, reason: "pri0" },
    });
    expect(h.seen.find((e) => e.type === "video.media")?.payload).toEqual({
      videoId: doomed,
      deleted: 3,
      bytes: 30,
    });
    expect(h.recordFsError).not.toHaveBeenCalled();

    // Nothing left to do on a second sweep.
    expect(await sweepPri0(h.deps)).toEqual({ videos: 0, files: 0, bytes: 0, errors: 0 });
  });

  it("prunes empty directories up to, never including, the location root", async () => {
    const a = addVideo(temp.db, vid("dirA"));
    const b = addVideo(temp.db, vid("dirB"));
    setPri(temp.db, a, 0);
    mediaFile(a, `UCchan/${a}/${a}.mkv`);
    mediaFile(b, `UCchan/${b}/${b}.mkv`);
    await sweepPri0(h.deps);
    expect(existsSync(join(root, "UCchan", a))).toBe(false);
    expect(existsSync(join(root, "UCchan", b))).toBe(true);

    setPri(temp.db, b, 0);
    await sweepPri0(h.deps);
    expect(existsSync(join(root, "UCchan"))).toBe(false);
    expect(existsSync(root)).toBe(true);
  });

  it("limits the sweep to the given ids", async () => {
    const a = addVideo(temp.db, vid("onlyA"));
    const b = addVideo(temp.db, vid("onlyB"));
    setPri(temp.db, a, 0);
    setPri(temp.db, b, 0);
    mediaFile(a, `UC/${a}.mkv`);
    mediaFile(b, `UC/${b}.mkv`);
    const result = await sweepPri0(h.deps, { videoIds: [a, vid("other")] });
    expect(result.videos).toBe(1);
    expect(mediaIds(a)).toEqual([]);
    expect(mediaIds(b)).toHaveLength(1);
  });

  it("treats a file that is already gone as deleted", async () => {
    const id = addVideo(temp.db, vid("ghostfile"));
    setPri(temp.db, id, 0);
    addMedia(temp.db, id, { rel_path: `UC/${id}/missing.mkv`, size_bytes: 77 });
    expect(await sweepPri0(h.deps)).toEqual({ videos: 1, files: 1, bytes: 77, errors: 0 });
    expect(mediaIds(id)).toEqual([]);
  });

  it("keeps the row and reports a filesystem error when unlink fails", async () => {
    const id = addVideo(temp.db, vid("stuck"));
    setPri(temp.db, id, 0);
    // A directory where the file should be: unlink fails with EISDIR / EPERM.
    mkdirSync(join(root, "UC", id, "file.mkv"), { recursive: true });
    const media = addMedia(temp.db, id, { rel_path: `UC/${id}/file.mkv` });
    h.recordFsError.mockRejectedValueOnce(new Error("notify failed"));
    const result = await sweepPri0(h.deps);
    expect(result).toEqual({ videos: 0, files: 0, bytes: 0, errors: 1 });
    expect(mediaIds(id)).toEqual([media]);
    expect(h.recordFsError).toHaveBeenCalledWith(
      expect.stringContaining(`could not delete media ${String(media)} of ${id}`),
    );
  });

  it("refuses paths that escape the location or land in DATA_DIR", async () => {
    const id = addVideo(temp.db, vid("escape"));
    setPri(temp.db, id, 0);
    const outside = join(root, "..", `outside-${id}.mkv`);
    writeFileSync(outside, "keep me");
    addMedia(temp.db, id, { rel_path: `../outside-${id}.mkv` });

    // A location configured inside DATA_DIR is never swept.
    const inData = join(dataDir, "media");
    mkdirSync(inData, { recursive: true });
    writeFileSync(join(inData, "x.mkv"), "keep me too");
    temp.db.run(
      `INSERT INTO locations (label, container_path, enabled, created_at, updated_at)
       VALUES ('bad', ?, 1, 1, 1)`,
      inData,
    );
    addMedia(temp.db, id, { location_id: 2, rel_path: "x.mkv" });

    const result = await sweepPri0(h.deps);
    expect(result.errors).toBe(2);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(join(inData, "x.mkv"))).toBe(true);
    expect(mediaIds(id)).toHaveLength(2);
    expect(h.recordFsError).toHaveBeenCalledWith(expect.stringContaining("outside its location"));
    rmSync(outside, { force: true });
  });

  it("refuses a target whose real directory is inside DATA_DIR (junction / symlink)", async () => {
    const id = addVideo(temp.db, vid("linked"));
    setPri(temp.db, id, 0);
    const metaDir = join(dataDir, "meta", "victim");
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(join(metaDir, "en.vtt"), "WEBVTT");
    mkdirSync(join(root, "UC"), { recursive: true });
    symlinkSync(metaDir, join(root, "UC", "link"), "junction");
    addMedia(temp.db, id, { rel_path: "UC/link/en.vtt" });
    const result = await sweepPri0(h.deps);
    expect(result.errors).toBe(1);
    expect(existsSync(join(metaDir, "en.vtt"))).toBe(true);
  });

  it("ignores pri-0 rows without a location", async () => {
    const id = addVideo(temp.db, vid("nolocvid"));
    setPri(temp.db, id, 0);
    addMedia(temp.db, id, { kind: "video", location_id: null, rel_path: "odd.mkv" });
    expect(await sweepPri0(h.deps)).toEqual({ videos: 0, files: 0, bytes: 0, errors: 0 });
    expect(mediaIds(id)).toHaveLength(1);
  });
});

describe("pri0_sweep job", () => {
  function ctxFor(payload: unknown): JobContext {
    return {
      job: {
        id: 1,
        type: PRI0_SWEEP_JOB,
        status: "running",
        priority: 0,
        payload,
        accountId: null,
        videoId: null,
        attempts: 1,
        maxAttempts: 2,
        runAfter: 0,
        startedAt: 0,
        finishedAt: null,
        error: null,
        logDir: null,
        createdAt: 0,
      },
      db: temp.db,
      log: createConsoleLogger("silent"),
      logDir: temp.dir,
      signal: new AbortController().signal,
      progress: () => {},
      checkpoint: () => {},
    };
  }

  it("registers a maintenance handler with a payload dedupe key", async () => {
    const registry = new JobRegistry();
    registerPri0Sweep(registry, h.deps);
    const reg = registry.get(PRI0_SWEEP_JOB);
    expect(reg?.class).toBe("maintenance");
    expect(reg?.dedupeKey?.({})).toBe("all");
    expect(reg?.dedupeKey?.(null)).toBe("all");
    expect(reg?.dedupeKey?.({ videoIds: ["b", "a"] })).toBe("ids:a,b");

    const a = addVideo(temp.db, vid("jobA"));
    const b = addVideo(temp.db, vid("jobB"));
    setPri(temp.db, a, 0);
    setPri(temp.db, b, 0);
    mediaFile(a, `UC/${a}.mkv`);
    mediaFile(b, `UC/${b}.mkv`);
    await reg?.handler(ctxFor({ videoIds: [a, 5] }));
    expect(mediaIds(a)).toEqual([]);
    expect(mediaIds(b)).toHaveLength(1);
    await reg?.handler(ctxFor(null));
    expect(mediaIds(b)).toEqual([]);
  });
});
