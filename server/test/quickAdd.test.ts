import { QuickAddResponseSchema } from "@cellar/shared";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listActivity } from "../src/domain/activity.ts";
import { DomainError } from "../src/domain/errors.ts";
import { QUICK_ADD_RULE_NAME, quickAddVideo } from "../src/domain/quickAdd.ts";
import { trashVideos } from "../src/domain/ruleEval.ts";
import { ensureDefaultRules, getVideoRuleRow } from "../src/domain/rules.ts";
import { createConsoleLogger } from "../src/logging.ts";
import { createTempApp, createTempDb, type TempApp, type TempDb } from "./helpers.ts";
import {
  addAccount,
  addMedia,
  addSource,
  addVideo,
  DAY,
  effectiveRow,
  harness,
  NOW,
  vid,
  type Harness,
} from "./rulesFixtures.ts";

const log = createConsoleLogger("silent");
const noop = async (): Promise<void> => {};
const NEW_ID = "dQw4w9WgXcQ";

let temp: TempDb;
let h: Harness;

interface JobDb {
  id: number;
  type: string;
  video_id: string | null;
  priority: number;
  payload_json: string;
}

function jobs(type: string): JobDb[] {
  return temp.db.all<JobDb>("SELECT * FROM jobs WHERE type = ? ORDER BY id", type);
}

function overrides(id: string): Record<string, unknown> {
  return JSON.parse(getVideoRuleRow(temp.db, id)?.effects_json ?? "{}") as Record<string, unknown>;
}

beforeEach(() => {
  temp = createTempDb();
  h = harness(temp.db, join(temp.dir, "data"));
  ensureDefaultRules(temp.db, log);
  h.registry.register("download", { class: "download", handler: noop });
  h.registry.register("recheck_batch", { class: "io", handler: noop });
});

afterEach(() => {
  temp.close();
});

describe("quickAddVideo", () => {
  it("catalogs an unknown video from a URL, pins it and queues the recheck and download", async () => {
    const result = await quickAddVideo(h.deps, `https://youtu.be/${NEW_ID}?t=42`);
    const download = jobs("download");
    expect(QuickAddResponseSchema.parse(result)).toEqual({
      video_id: NEW_ID,
      created: true,
      downloaded: false,
      title: null,
      channel_title: null,
      job_id: download[0]?.id,
    });
    expect(temp.db.get("SELECT 1 AS one FROM videos WHERE id = ?", NEW_ID)).toBeDefined();
    expect(getVideoRuleRow(temp.db, NEW_ID)?.name).toBe(QUICK_ADD_RULE_NAME);
    expect(overrides(NEW_ID)).toEqual({
      include: true,
      reclaim_priority: -1,
      download_accounts: "any",
    });
    // Evaluated at once, so the download job finds effective settings.
    expect(effectiveRow(temp.db, NEW_ID)).toMatchObject({ include: 1, reclaim_priority: -1 });
    expect(download).toHaveLength(1);
    expect(download[0]).toMatchObject({ video_id: NEW_ID, priority: 20 });
    const recheck = jobs("recheck_batch");
    expect(recheck).toHaveLength(1);
    expect(JSON.parse(recheck[0]?.payload_json ?? "{}")).toEqual({ video_ids: [NEW_ID] });
    expect(
      listActivity(temp.db, { page: 1, perPage: 5, kind: "rules.quick_added" }).rows,
    ).toHaveLength(1);
  });

  it("keeps other overrides, un-trashes, and overrides a rule that would expire the video", async () => {
    const account = addAccount(temp.db);
    const id = addVideo(temp.db, vid("expired"));
    // Watched three months ago: the default rules mark it pri 0.
    addSource(temp.db, id, "history", NOW - 90 * DAY, account);
    await trashVideos(h.deps, [id]);
    temp.db.run(
      "UPDATE rules SET effects_json = ? WHERE kind = 'video' AND video_id = ?",
      JSON.stringify({ reclaim_priority: 0, max_height: 480 }),
      id,
    );

    const result = await quickAddVideo(h.deps, id);
    expect(result).toMatchObject({ created: false, downloaded: false, title: `Video ${id}` });
    // Sourced by an account, so the accounts policy is left to the rules.
    expect(overrides(id)).toEqual({ max_height: 480, include: true, reclaim_priority: -1 });
    expect(getVideoRuleRow(temp.db, id)?.name).toBe(QUICK_ADD_RULE_NAME);
    expect(effectiveRow(temp.db, id)).toMatchObject({ include: 1, reclaim_priority: -1 });
    // A known video is not rechecked again.
    expect(jobs("recheck_batch")).toHaveLength(0);
  });

  it("is idempotent and queues no download for a video that already has media", async () => {
    const first = await quickAddVideo(h.deps, NEW_ID);
    const second = await quickAddVideo(h.deps, NEW_ID);
    expect(second).toMatchObject({ created: false, job_id: first.job_id });
    expect(jobs("download")).toHaveLength(1);
    expect(jobs("recheck_batch")).toHaveLength(1);
    expect(
      temp.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM rules WHERE kind = 'video'")?.n,
    ).toBe(1);

    const have = addVideo(temp.db, vid("haveit"));
    addMedia(temp.db, have, { rel_path: `UC/${have}/v.mkv`, size_bytes: 4 });
    const result = await quickAddVideo(h.deps, have);
    expect(result).toMatchObject({ downloaded: true, job_id: null });
    expect(jobs("download")).toHaveLength(1);
    expect(overrides(have)).toMatchObject({ include: true, reclaim_priority: -1 });
  });

  it("respects an accounts override and rejects what is not a video", async () => {
    const id = addVideo(temp.db, vid("accounts"));
    temp.db.run(
      `INSERT INTO rules (kind, video_id, position, name, enabled, effects_json, created_at,
                          updated_at) VALUES ('video', ?, 0, 'Video override', 1, ?, 1, 1)`,
      id,
      JSON.stringify({ download_accounts: "sourcing" }),
    );
    await quickAddVideo(h.deps, id);
    expect(overrides(id)).toMatchObject({ download_accounts: "sourcing" });

    await expect(
      quickAddVideo(h.deps, "https://www.youtube.com/playlist?list=PL123"),
    ).rejects.toBeInstanceOf(DomainError);
    expect(jobs("download")).toHaveLength(1);
  });

  it("queues nothing when the handlers are not registered", async () => {
    const bare = harness(temp.db, join(temp.dir, "data"));
    const result = await quickAddVideo(bare.deps, NEW_ID);
    expect(result).toMatchObject({ created: true, job_id: null });
    expect(jobs("download")).toHaveLength(0);
    expect(jobs("recheck_batch")).toHaveLength(0);
  });
});

describe("POST /api/videos/quick-add", () => {
  let app: TempApp;

  beforeEach(async () => {
    app = await createTempApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("is wired in the real app: 202 with the video, 400 for anything else", async () => {
    const res = await app.app.inject({
      method: "POST",
      url: "/api/videos/quick-add",
      payload: { input: `  https://www.youtube.com/watch?v=${NEW_ID}&list=PL1 ` },
    });
    expect(res.statusCode).toBe(202);
    expect(QuickAddResponseSchema.parse(res.json())).toMatchObject({
      video_id: NEW_ID,
      created: true,
    });
    const rule = app.db.get<{ name: string }>(
      "SELECT name FROM rules WHERE kind = 'video' AND video_id = ?",
      NEW_ID,
    );
    expect(rule?.name).toBe(QUICK_ADD_RULE_NAME);

    for (const payload of [{ input: "not a video" }, { input: "" }, {}]) {
      const bad = await app.app.inject({
        method: "POST",
        url: "/api/videos/quick-add",
        payload,
      });
      expect(bad.statusCode).toBe(400);
    }
  });
});
