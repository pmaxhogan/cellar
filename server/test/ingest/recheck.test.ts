import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.ts";
import {
  classifyType,
  contentSignature,
  dueRecheckIds,
  effectiveRecheckInterval,
  enqueueRecheckAll,
  isNewVersion,
  liveStatusOf,
  mapVideoItem,
  parseDurationSeconds,
  RecheckOutageError,
  recheckSchedule,
  runRecheck,
  shortHintFromInfo,
  VIDEO_PARTS,
  type ApiVideo,
} from "../../src/domain/recheck.ts";
import { updateSettings } from "../../src/domain/settings.ts";
import { recheckIdsFor, registerRecheckHandlers } from "../../src/jobs/handlers/recheck.ts";
import {
  ensureChannel,
  RECHECK_BATCH_JOB,
  RECHECK_LEFTOVER_JOB,
  recordSighting,
} from "../../src/youtube/ingest.ts";
import { QuotaExhausted } from "../../src/youtube/quota.ts";
import { createRydClient } from "../../src/youtube/ryd.ts";
import {
  DAY,
  IngestEnv,
  jsonResponse,
  NOW,
  RICK,
  THREE_B1B,
  vid,
  youtubeFixture,
} from "./ingestHelpers.ts";

interface VideosBody {
  items: ApiVideo[];
}

let env: IngestEnv;
let body: VideosBody;
let thumbFetches: string[];

const IDS = ["dQw4w9WgXcQ", "jNQXAC9IVRw", "aircAruvnKk"];

function seed(id: string, channelId: string | null = null): void {
  if (channelId !== null) {
    ensureChannel(env.db, { id: channelId }, NOW);
  }
  recordSighting(env.db, { videoId: id, channelId, fill: {}, sources: [] }, NOW);
}

function serveVideos(): void {
  env.api("videos", (url) => {
    const wanted = new Set((url.searchParams.get("id") ?? "").split(","));
    return jsonResponse(200, {
      kind: "youtube#videoListResponse",
      items: body.items.filter((item) => wanted.has(item.id ?? "")),
    });
  });
}

function item(id: string): ApiVideo {
  return body.items.find((entry) => entry.id === id) as ApiVideo;
}

function notifications(type: string): number {
  return Number(
    env.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE type = ?", type)?.n,
  );
}

function setEffective(id: string, pri: number, effective: Record<string, unknown> = {}): void {
  env.db.run(
    `INSERT INTO video_effective (video_id, effective_json, provenance_json, matched_rule_ids,
                                  evaluated_at, reclaim_priority, include)
     VALUES (?, ?, '{}', '[]', ?, ?, 1)
     ON CONFLICT (video_id) DO UPDATE SET reclaim_priority = excluded.reclaim_priority,
       effective_json = excluded.effective_json`,
    id,
    JSON.stringify(effective),
    NOW,
    pri,
  );
}

beforeEach(async () => {
  env = await IngestEnv.create();
  body = youtubeFixture<VideosBody>("videos.list.json");
  thumbFetches = [];
  env.routes.set("i.ytimg.com", (url) => {
    thumbFetches.push(url.pathname);
    if (url.pathname.endsWith("/maxresdefault.jpg")) {
      return new Response("not found", { status: 404 });
    }
    return new Response(`bytes of ${url.pathname}`, { status: 200 });
  });
  updateSettings(env.db, { "recheck.ryd_enabled": false });
});

afterEach(() => {
  env.close();
});

describe("pure mapping", () => {
  it("parses YouTube ISO 8601 durations", () => {
    expect(parseDurationSeconds("PT3M33S")).toBe(213);
    expect(parseDurationSeconds("PT19S")).toBe(19);
    expect(parseDurationSeconds("P0D")).toBe(0);
    expect(parseDurationSeconds("PT1H")).toBe(3600);
    expect(parseDurationSeconds("P1DT2H3M4S")).toBe(93784);
    expect(parseDurationSeconds("P1W")).toBe(604800);
    expect(parseDurationSeconds("P1M")).toBeNull();
    expect(parseDurationSeconds("3:33")).toBeNull();
    expect(parseDurationSeconds(213)).toBeNull();
  });

  it("hashes the contentDetails signature without the duration", () => {
    const details = item("dQw4w9WgXcQ").contentDetails;
    const sig = contentSignature(details);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(contentSignature({ ...details, duration: "PT9M" })).toBe(sig);
    expect(contentSignature({ ...details, definition: "sd" })).not.toBe(sig);
    expect(contentSignature(undefined)).toBeNull();
  });

  it("reads the live status", () => {
    expect(liveStatusOf(item("dQw4w9WgXcQ"))).toBe("none");
    expect(liveStatusOf(item("aircAruvnKk"))).toBe("upcoming");
    expect(liveStatusOf({ snippet: { liveBroadcastContent: "live" } })).toBe("live");
    expect(liveStatusOf({ snippet: { liveBroadcastContent: "odd" } })).toBeNull();
    expect(liveStatusOf({})).toBeNull();
  });

  it("classifies the video type", () => {
    const base = {
      durationS: 45,
      hasLiveDetails: false,
      liveStatus: "none",
      storedType: null,
      shortHint: null,
    };
    expect(classifyType(base)).toBe("video");
    expect(classifyType({ ...base, shortHint: true })).toBe("short");
    expect(classifyType({ ...base, storedType: "short" })).toBe("short");
    expect(classifyType({ ...base, storedType: "short", shortHint: false })).toBe("video");
    expect(classifyType({ ...base, durationS: 181, shortHint: true })).toBe("video");
    expect(classifyType({ ...base, durationS: null, shortHint: true })).toBe("video");
    const live = { ...base, hasLiveDetails: true, liveStatus: "upcoming" };
    expect(classifyType({ ...live, durationS: 0 })).toBe("livestream");
    expect(classifyType({ ...live, durationS: 600 })).toBe("premiere");
    expect(classifyType({ ...live, liveStatus: "none", durationS: 600 })).toBe("livestream");
    expect(classifyType({ ...live, durationS: 600, storedType: "livestream" })).toBe("livestream");
    expect(classifyType({ ...live, durationS: 0, storedType: "premiere" })).toBe("premiere");
  });

  it("maps every field of a videos.list item", () => {
    const patch = mapVideoItem(item("dQw4w9WgXcQ"), { storedType: null, shortHint: null });
    expect(patch).toEqual({
      title: "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)",
      description:
        "Synthetic description for Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster).",
      tags_json: JSON.stringify(["rick astley", "never gonna give you up", "nggyu", "rickroll"]),
      category_id: "10",
      default_language: "en",
      upload_date: Date.parse("2009-10-25T06:57:33Z"),
      published_at: Date.parse("2009-10-25T06:57:33Z"),
      live_status: "none",
      duration_s: 213,
      caption_available: true,
      content_signature: contentSignature(item("dQw4w9WgXcQ").contentDetails),
      views: 1650000000,
      likes: 18700000,
      comments: 2400000,
      privacy: "public",
      type: "video",
    });
    expect(mapVideoItem(item("jNQXAC9IVRw"), { storedType: null, shortHint: null })).toMatchObject({
      privacy: "unlisted",
      duration_s: 19,
      type: "video",
    });
    expect(mapVideoItem(item("jNQXAC9IVRw"), { storedType: null, shortHint: true }).type).toBe(
      "short",
    );
    // Hidden likes read as null; the upcoming broadcast with no duration is a livestream.
    expect(mapVideoItem(item("aircAruvnKk"), { storedType: null, shortHint: null })).toMatchObject({
      likes: null,
      views: 0,
      comments: 0,
      live_status: "upcoming",
      duration_s: 0,
      type: "livestream",
      caption_available: false,
    });
  });

  it("leaves parts the response did not carry out of the patch", () => {
    expect(mapVideoItem({ id: "x" }, { storedType: null, shortHint: null })).toEqual({});
    expect(
      mapVideoItem(
        {
          snippet: { defaultAudioLanguage: "de", tags: ["a", 1 as unknown as string] },
          statistics: {},
          status: { privacyStatus: "weird" },
        },
        { storedType: null, shortHint: null },
      ),
    ).toEqual({
      description: null,
      tags_json: '["a"]',
      category_id: null,
      default_language: "de",
      views: null,
      likes: null,
      comments: null,
    });
  });

  it("schedules by tier, or by a rule's fixed interval", () => {
    const settings = { "recheck.daily_under_days": 30, "recheck.weekly_under_days": 365 };
    expect(recheckSchedule(NOW - 5 * DAY, NOW, settings)).toEqual({
      tier: "daily",
      nextAt: NOW + DAY,
    });
    expect(recheckSchedule(null, NOW, settings).tier).toBe("daily");
    expect(recheckSchedule(NOW + 5 * DAY, NOW, settings).tier).toBe("daily");
    expect(recheckSchedule(NOW - 100 * DAY, NOW, settings)).toEqual({
      tier: "weekly",
      nextAt: NOW + 7 * DAY,
    });
    expect(recheckSchedule(NOW - 400 * DAY, NOW, settings)).toEqual({
      tier: "monthly",
      nextAt: NOW + 30 * DAY,
    });
    expect(recheckSchedule(NOW - 400 * DAY, NOW, settings, "P3D")).toEqual({
      tier: "custom",
      nextAt: NOW + 3 * DAY,
    });
  });

  it("reads the recheck_interval effect", () => {
    seed("dQw4w9WgXcQ");
    expect(effectiveRecheckInterval(env.db, "dQw4w9WgXcQ")).toBe("tiered");
    setEffective("dQw4w9WgXcQ", 1, { recheck_interval: { days: 2 } });
    expect(effectiveRecheckInterval(env.db, "dQw4w9WgXcQ")).toEqual({ days: 2 });
    setEffective("dQw4w9WgXcQ", 1, { recheck_interval: "tiered" });
    expect(effectiveRecheckInterval(env.db, "dQw4w9WgXcQ")).toBe("tiered");
    setEffective("dQw4w9WgXcQ", 1, { recheck_interval: "nonsense" });
    expect(effectiveRecheckInterval(env.db, "dQw4w9WgXcQ")).toBe("tiered");
    env.db.run("UPDATE video_effective SET effective_json = '[1'");
    expect(effectiveRecheckInterval(env.db, "dQw4w9WgXcQ")).toBe("tiered");
  });

  it("reads yt-dlp's shorts hint from info.json", () => {
    const meta = env.config.metaDir;
    const dir = join(meta, RICK, "dQw4w9WgXcQ");
    mkdirSync(dir, { recursive: true });
    expect(shortHintFromInfo(meta, null, "dQw4w9WgXcQ")).toBeNull();
    expect(shortHintFromInfo(meta, RICK, "dQw4w9WgXcQ")).toBeNull();
    const write = (info: unknown): void => {
      writeFileSync(join(dir, "info.json"), JSON.stringify(info));
    };
    write({ media_type: "short" });
    expect(shortHintFromInfo(meta, RICK, "dQw4w9WgXcQ")).toBe(true);
    write({ media_type: "video" });
    expect(shortHintFromInfo(meta, RICK, "dQw4w9WgXcQ")).toBe(false);
    write({ webpage_url: "https://www.youtube.com/shorts/dQw4w9WgXcQ" });
    expect(shortHintFromInfo(meta, RICK, "dQw4w9WgXcQ")).toBe(true);
    write({ webpage_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    expect(shortHintFromInfo(meta, RICK, "dQw4w9WgXcQ")).toBeNull();
    writeFileSync(join(dir, "info.json"), "{");
    expect(shortHintFromInfo(meta, RICK, "dQw4w9WgXcQ")).toBeNull();
  });

  it("detects a new version from the diff", () => {
    const change = (field: string, old: unknown, next: unknown) => ({
      changes: [{ field, old, new: next, history: true }],
      statsPoint: false,
    });
    expect(isNewVersion(change("duration_s", 213, 216) as never)).toBe(true);
    expect(isNewVersion(change("duration_s", 213, 215) as never)).toBe(false);
    expect(isNewVersion(change("duration_s", null, 300) as never)).toBe(false);
    expect(isNewVersion(change("content_signature", "a", "b") as never)).toBe(true);
    expect(isNewVersion(change("content_signature", null, "b") as never)).toBe(false);
    expect(isNewVersion(change("title", "a", "b") as never)).toBe(false);
  });
});

describe("runRecheck", () => {
  it("writes every field, the schedule and the counters' first history rows", async () => {
    env.account();
    serveVideos();
    for (const id of IDS) {
      seed(id);
    }
    const result = await runRecheck(env.deps(), [...IDS, "notInDb0001"], { recheckId: 42 });
    expect(result).toMatchObject({ requested: 3, returned: 3, missing: 0, units: 1, gone: [] });
    const [call] = env.apiCalls("videos");
    expect(call?.searchParams.get("part")).toBe(VIDEO_PARTS);
    expect(call?.searchParams.get("id")).toBe(IDS.join(","));
    expect(call?.searchParams.get("maxResults")).toBe("50");

    expect(env.video("dQw4w9WgXcQ")).toMatchObject({
      channel_id: RICK,
      title: "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)",
      duration_s: 213,
      privacy: "public",
      type: "video",
      live_status: "none",
      views: 1650000000,
      likes: 18700000,
      comments: 2400000,
      category_id: "10",
      default_language: "en",
      caption_available: 1,
      upload_date: Date.parse("2009-10-25T06:57:33Z"),
      published_at: Date.parse("2009-10-25T06:57:33Z"),
      consecutive_recheck_failures: 0,
      gone_since: null,
      last_recheck_at: NOW,
      recheck_tier: "monthly",
      next_recheck_at: NOW + 30 * DAY,
      ryd_dislikes: null,
    });
    expect(env.video("aircAruvnKk")).toMatchObject({
      type: "livestream",
      live_status: "upcoming",
      likes: null,
      recheck_tier: "daily",
      channel_id: THREE_B1B,
    });
    expect(env.db.get("SELECT title FROM channels WHERE id = ?", RICK)).toEqual({
      title: "Rick Astley",
    });
    const history = env.db.all<{ field: string; recheck_id: number }>(
      "SELECT field, recheck_id FROM video_changes WHERE video_id = 'dQw4w9WgXcQ' ORDER BY field",
    );
    expect(history).toEqual([
      { field: "comments", recheck_id: 42 },
      { field: "likes", recheck_id: 42 },
      { field: "views", recheck_id: 42 },
    ]);
    expect(env.jobs("eval_pass")[0]?.payload).toMatchObject({ reason: "recheck" });
  });

  it("diffs a later recheck into video_changes and video_stats", async () => {
    env.account();
    serveVideos();
    seed("dQw4w9WgXcQ");
    await runRecheck(env.deps(), ["dQw4w9WgXcQ"], { recheckId: 1 });
    const video = item("dQw4w9WgXcQ");
    video.snippet = { ...video.snippet, title: "Renamed" };
    video.statistics = { ...video.statistics, viewCount: "1650000100" };
    env.now += DAY;
    const result = await runRecheck(env.deps(), ["dQw4w9WgXcQ"], { recheckId: 2 });
    expect(result.changes).toBe(2);
    expect(
      env.db.all(
        `SELECT field, old_json, new_json, seen_at FROM video_changes
          WHERE recheck_id = 2 ORDER BY field`,
      ),
    ).toEqual([
      {
        field: "title",
        old_json: JSON.stringify(
          "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)",
        ),
        new_json: JSON.stringify("Renamed"),
        seen_at: NOW + DAY,
      },
      { field: "views", old_json: "1650000000", new_json: "1650000100", seen_at: NOW + DAY },
    ]);
    expect(env.db.get("SELECT views, likes FROM video_stats WHERE at = ?", NOW + DAY)).toEqual({
      views: 1650000100,
      likes: 18700000,
    });
  });

  it("marks a video gone on the second consecutive miss while others succeed", async () => {
    env.account();
    body = youtubeFixture<VideosBody>("videos.list.missing.json");
    serveVideos();
    for (const id of IDS) {
      seed(id);
    }
    const first = await runRecheck(env.deps(), IDS);
    expect(first).toMatchObject({ returned: 2, missing: 1, gone: [] });
    expect(env.video("aircAruvnKk")).toMatchObject({
      consecutive_recheck_failures: 1,
      gone_since: null,
      privacy: null,
      next_recheck_at: NOW + 12 * 60 * 60_000,
    });

    env.now += DAY;
    const second = await runRecheck(env.deps(), IDS);
    expect(second.gone).toEqual(["aircAruvnKk"]);
    expect(env.video("aircAruvnKk")).toMatchObject({
      consecutive_recheck_failures: 2,
      gone_since: NOW + DAY,
      privacy: "removed",
      recheck_tier: null,
    });

    env.now += DAY;
    const third = await runRecheck(env.deps(), IDS);
    expect(third.gone).toEqual([]);
    expect(env.video("aircAruvnKk")).toMatchObject({
      consecutive_recheck_failures: 3,
      gone_since: NOW + DAY,
    });

    // It comes back: the counter and gone_since reset, privacy follows the API.
    body = youtubeFixture<VideosBody>("videos.list.json");
    await runRecheck(env.deps(), IDS);
    expect(env.video("aircAruvnKk")).toMatchObject({
      consecutive_recheck_failures: 0,
      gone_since: null,
      privacy: "public",
    });
  });

  it("keeps private when the API said so before, and never marks a lone miss gone", async () => {
    env.account();
    body = youtubeFixture<VideosBody>("videos.list.missing.json");
    serveVideos();
    for (const id of IDS) {
      seed(id);
    }
    env.db.run("UPDATE videos SET privacy = 'private' WHERE id = 'aircAruvnKk'");
    await runRecheck(env.deps(), IDS);
    await runRecheck(env.deps(), IDS);
    expect(env.video("aircAruvnKk")).toMatchObject({ privacy: "private", gone_since: NOW });

    seed("HeQX2HjkcNo");
    await runRecheck(env.deps(), ["HeQX2HjkcNo"]);
    await runRecheck(env.deps(), ["HeQX2HjkcNo"]);
    expect(env.video("HeQX2HjkcNo")).toMatchObject({
      consecutive_recheck_failures: 2,
      gone_since: null,
    });
  });

  it("treats a private video the API still returns as gone since first seen private", async () => {
    env.account();
    serveVideos();
    seed("dQw4w9WgXcQ");
    item("dQw4w9WgXcQ").status = { privacyStatus: "private" };
    await runRecheck(env.deps(), ["dQw4w9WgXcQ"]);
    env.now += DAY;
    await runRecheck(env.deps(), ["dQw4w9WgXcQ"]);
    expect(env.video("dQw4w9WgXcQ")).toMatchObject({ privacy: "private", gone_since: NOW });
  });

  it("reports a whole-call failure as an outage without touching per-video counters", async () => {
    env.account();
    env.api("videos", () =>
      jsonResponse(500, { error: { code: 500, errors: [{ reason: "backendError" }] } }),
    );
    for (const id of IDS) {
      seed(id);
    }
    await expect(runRecheck(env.deps(), IDS)).rejects.toBeInstanceOf(RecheckOutageError);
    await expect(runRecheck(env.deps(), IDS)).rejects.toBeInstanceOf(RecheckOutageError);
    expect(notifications("recheck_outage")).toBe(1);
    expect(env.db.get("SELECT MAX(consecutive_recheck_failures) AS n FROM videos")).toEqual({
      n: 0,
    });
    expect(env.jobs("eval_pass")).toEqual([]);
  });

  it("treats a 200 that returns none of several ids as an outage", async () => {
    env.account();
    env.api("videos", () => jsonResponse(200, { items: [] }));
    for (const id of IDS) {
      seed(id);
    }
    await expect(runRecheck(env.deps(), IDS)).rejects.toThrow(/returned none/);
    expect(notifications("recheck_outage")).toBe(1);
    expect(env.db.get("SELECT MAX(consecutive_recheck_failures) AS n FROM videos")).toEqual({
      n: 0,
    });
  });

  it("propagates a spent budget and lost auth without an outage", async () => {
    const account = env.account();
    serveVideos();
    seed("dQw4w9WgXcQ");
    env.db.run(
      "INSERT INTO quota_usage (account_id, day, api_units) VALUES (0, ?, 10000)",
      new Date(NOW).toISOString().slice(0, 10),
    );
    await expect(runRecheck(env.deps(), ["dQw4w9WgXcQ"])).rejects.toBeInstanceOf(QuotaExhausted);
    env.db.run("DELETE FROM quota_usage");

    env.google.revokedRefreshTokens.add("refresh-good");
    const error = await runRecheck(env.deps(), ["dQw4w9WgXcQ"]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).details).toEqual({ reason: "auth_lost" });
    expect(notifications("account_auth_lost")).toBe(1);
    expect(notifications("recheck_outage")).toBe(0);
    expect(env.db.get("SELECT status FROM accounts WHERE id = ?", account)).toEqual({
      status: "auth_lost",
    });
    await expect(runRecheck(env.deps(), ["dQw4w9WgXcQ"])).rejects.toMatchObject({
      code: "no_account",
    });
  });

  it("adds RYD estimates when enabled, and leaves them alone when the lookup fails", async () => {
    env.account();
    serveVideos();
    updateSettings(env.db, { "recheck.ryd_enabled": true });
    env.routes.set("returnyoutubedislikeapi.com", (url) => {
      const id = url.searchParams.get("videoId");
      return id === "dQw4w9WgXcQ"
        ? jsonResponse(200, youtubeFixture("ryd.votes.json"))
        : new Response("nope", { status: 500 });
    });
    env.ryd = createRydClient({ fetch: env.fetch, minIntervalMs: 0 });
    seed("dQw4w9WgXcQ");
    seed("jNQXAC9IVRw");
    await runRecheck(env.deps(), ["dQw4w9WgXcQ", "jNQXAC9IVRw"]);
    expect(env.video("dQw4w9WgXcQ")).toMatchObject({
      ryd_dislikes: 520000,
      ryd_ratio: 18700000 / (18700000 + 520000),
    });
    expect(env.video("jNQXAC9IVRw")).toMatchObject({ ryd_dislikes: null, ryd_ratio: null });
  });

  it("falls back to a shared RYD client on the deps' fetch", async () => {
    env.account();
    serveVideos();
    updateSettings(env.db, { "recheck.ryd_enabled": true });
    env.routes.set("returnyoutubedislikeapi.com", () =>
      jsonResponse(200, { likes: 10, dislikes: 30 }),
    );
    seed("aircAruvnKk");
    await runRecheck(env.deps(), ["aircAruvnKk"]);
    // No YouTube likes on this one, so the ratio uses RYD's own like count.
    expect(env.video("aircAruvnKk")).toMatchObject({ ryd_dislikes: 30, ryd_ratio: 0.25 });
  });

  it("fetches thumbnails on the first recheck and again only when a URL changes", async () => {
    env.account();
    serveVideos();
    seed("dQw4w9WgXcQ");
    const first = await runRecheck(env.deps(), ["dQw4w9WgXcQ"]);
    // Six variants; maxresdefault is a 404 here.
    expect(thumbFetches).toHaveLength(6);
    expect(first.thumbnailsStored).toBe(5);
    const rows = env.db.all<{ variant: string; url: string; path: string; sha256: string }>(
      "SELECT variant, url, path, sha256 FROM thumbnails ORDER BY variant",
    );
    expect(rows.map((row) => row.variant)).toEqual([
      "default",
      "hq720",
      "hqdefault",
      "mqdefault",
      "sddefault",
    ]);
    const hq = rows.find((row) => row.variant === "hqdefault");
    const sha = createHash("sha256").update("bytes of /vi/dQw4w9WgXcQ/hqdefault.jpg").digest("hex");
    expect(hq).toEqual({
      variant: "hqdefault",
      url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      path: `${RICK}/dQw4w9WgXcQ/thumbnails/hqdefault-${sha}.jpg`,
      sha256: sha,
    });
    expect(existsSync(join(env.config.metaDir, ...(hq?.path ?? "").split("/")))).toBe(true);

    await runRecheck(env.deps(), ["dQw4w9WgXcQ"]);
    expect(thumbFetches).toHaveLength(6);

    const video = item("dQw4w9WgXcQ");
    video.snippet = {
      ...video.snippet,
      thumbnails: {
        ...video.snippet?.thumbnails,
        high: { url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg?v=2" },
      },
    };
    await runRecheck(env.deps(), ["dQw4w9WgXcQ"]);
    expect(thumbFetches).toHaveLength(12);
  });

  it("queues a version re-download when the duration or signature changes and media exists", async () => {
    env.account();
    serveVideos();
    env.registry.register("download", { class: "download", handler: () => Promise.resolve() });
    seed("dQw4w9WgXcQ", RICK);
    seed("jNQXAC9IVRw");
    env.db.run(
      `INSERT INTO media (video_id, kind, rel_path, created_at)
       VALUES ('dQw4w9WgXcQ', 'video', 'x.webm', ?)`,
      NOW,
    );
    await runRecheck(env.deps(), ["dQw4w9WgXcQ", "jNQXAC9IVRw"]);
    item("dQw4w9WgXcQ").contentDetails = {
      ...item("dQw4w9WgXcQ").contentDetails,
      duration: "PT3M35S",
    };
    item("jNQXAC9IVRw").contentDetails = {
      ...item("jNQXAC9IVRw").contentDetails,
      duration: "PT5M",
    };
    await runRecheck(env.deps(), ["dQw4w9WgXcQ", "jNQXAC9IVRw"]);
    expect(env.jobs("download")).toEqual([]);

    item("dQw4w9WgXcQ").contentDetails = {
      ...item("dQw4w9WgXcQ").contentDetails,
      duration: "PT4M",
    };
    const result = await runRecheck(env.deps(), ["dQw4w9WgXcQ", "jNQXAC9IVRw"]);
    expect(result.versions).toEqual(["dQw4w9WgXcQ"]);
    expect(
      env.db.all("SELECT type, video_id, payload_json FROM jobs WHERE type = 'download'"),
    ).toEqual([
      { type: "download", video_id: "dQw4w9WgXcQ", payload_json: '{"reason":"version"}' },
    ]);

    item("dQw4w9WgXcQ").contentDetails = {
      ...item("dQw4w9WgXcQ").contentDetails,
      definition: "sd",
    };
    await runRecheck(env.deps({ registry: { has: () => false } }), ["dQw4w9WgXcQ"]);
    expect(env.jobs("download")).toHaveLength(1);
  });

  it("uses the shorts hint for short videos", async () => {
    env.account();
    serveVideos();
    seed("jNQXAC9IVRw");
    const asked: string[] = [];
    await runRecheck(
      env.deps({
        shortHint: (_channel, id) => {
          asked.push(id);
          return true;
        },
      }),
      ["jNQXAC9IVRw", "dQw4w9WgXcQ"],
    );
    expect(asked).toEqual(["jNQXAC9IVRw"]);
    expect(env.video("jNQXAC9IVRw")).toMatchObject({ type: "short" });
    await runRecheck(env.deps(), ["jNQXAC9IVRw"]);
    expect(env.video("jNQXAC9IVRw")).toMatchObject({ type: "short" });
  });

  it("uses a rule's fixed recheck interval", async () => {
    env.account();
    serveVideos();
    seed("dQw4w9WgXcQ");
    setEffective("dQw4w9WgXcQ", 1, { recheck_interval: "PT6H" });
    await runRecheck(env.deps(), ["dQw4w9WgXcQ"]);
    expect(env.video("dQw4w9WgXcQ")).toMatchObject({
      recheck_tier: "custom",
      next_recheck_at: NOW + 6 * 60 * 60_000,
    });
  });

  it("splits more than 50 ids into several calls", async () => {
    env.account();
    serveVideos();
    const ids = Array.from({ length: 51 }, (_, i) => vid(i));
    for (const id of ids) {
      seed(id);
    }
    body = { items: ids.map((id) => ({ ...item("dQw4w9WgXcQ"), id })) };
    const result = await runRecheck(env.deps(), ids);
    expect(result).toMatchObject({ requested: 51, returned: 51, units: 2 });
    expect(env.apiCalls("videos")).toHaveLength(2);
    expect(await runRecheck(env.deps(), [])).toMatchObject({ requested: 0, units: 0 });
  });
});

describe("selection and handlers", () => {
  it("splits due videos by pri 0, never-rechecked first, evaluated only", () => {
    for (const id of ["dQw4w9WgXcQ", "jNQXAC9IVRw", "aircAruvnKk", "HeQX2HjkcNo"]) {
      seed(id);
    }
    setEffective("dQw4w9WgXcQ", 1);
    setEffective("jNQXAC9IVRw", 1);
    setEffective("aircAruvnKk", 0);
    env.db.run("UPDATE videos SET next_recheck_at = ? WHERE id = 'dQw4w9WgXcQ'", NOW - 1);
    env.db.run("UPDATE videos SET next_recheck_at = ? WHERE id = 'aircAruvnKk'", NOW + DAY);
    expect(dueRecheckIds(env.db, NOW, 10, { pri0: false })).toEqual(["jNQXAC9IVRw", "dQw4w9WgXcQ"]);
    expect(dueRecheckIds(env.db, NOW, 1, { pri0: false })).toEqual(["jNQXAC9IVRw"]);
    expect(dueRecheckIds(env.db, NOW, 10, { pri0: true })).toEqual([]);
    expect(dueRecheckIds(env.db, NOW + DAY, 10, { pri0: true })).toEqual(["aircAruvnKk"]);

    expect(recheckIdsFor(env.deps(), { due: true, limit: 1 }, false)).toEqual(["jNQXAC9IVRw"]);
    expect(recheckIdsFor(env.deps(), { due: true, limit: -3 }, false)).toHaveLength(2);
    expect(recheckIdsFor(env.deps(), { video_ids: ["a", 3 as unknown as string] }, true)).toEqual([
      "a",
    ]);
    expect(recheckIdsFor(env.deps(), {}, false)).toEqual([]);

    expect(enqueueRecheckAll(env.deps())).toEqual({ normal: 3, leftover: 1 });
    expect(env.jobs(RECHECK_BATCH_JOB)[0]?.payload).toEqual({
      video_ids: ["HeQX2HjkcNo", "dQw4w9WgXcQ", "jNQXAC9IVRw"],
    });
    expect(env.jobs(RECHECK_LEFTOVER_JOB)[0]?.payload).toEqual({ video_ids: ["aircAruvnKk"] });
  });

  it("runs the recheck jobs and logs each run", async () => {
    registerRecheckHandlers(env.registry, env.deps());
    registerRecheckHandlers(env.registry, env.deps());
    expect(env.registry.classOf(RECHECK_BATCH_JOB)).toBe("io");
    expect(env.registry.classOf(RECHECK_LEFTOVER_JOB)).toBe("leftover");
    expect(env.registry.classOf("recheck_all")).toBe("maintenance");
    env.account();
    serveVideos();
    seed("dQw4w9WgXcQ");
    const batch = env.registry.get(RECHECK_BATCH_JOB)?.handler;
    await batch?.(env.ctx(RECHECK_BATCH_JOB, { id: 77, payload: { video_ids: ["dQw4w9WgXcQ"] } }));
    expect(env.activity("recheck.batch")[0]).toMatchObject({
      level: "info",
      message: "Recheck: 1 of 1 returned, 0 missing, 0 gone, 3 changes, 1 API units.",
    });
    expect(env.db.get("SELECT DISTINCT recheck_id FROM video_changes")).toEqual({
      recheck_id: 77,
    });

    await batch?.(env.ctx(RECHECK_BATCH_JOB, { payload: { due: true } }));
    expect(env.activity("recheck.batch")).toHaveLength(1);

    env.api("videos", () => jsonResponse(503, { error: { code: 503 } }));
    const leftover = env.registry.get(RECHECK_LEFTOVER_JOB)?.handler;
    await expect(
      leftover?.(env.ctx(RECHECK_LEFTOVER_JOB, { payload: { video_ids: ["dQw4w9WgXcQ"] } })),
    ).rejects.toBeInstanceOf(RecheckOutageError);
    expect(env.activity("recheck.batch")[1]).toMatchObject({ level: "warn" });
    expect(env.activity("recheck.batch")[1]?.data).toMatchObject({ leftover: true, units: 1 });

    const all = env.registry.get("recheck_all")?.handler;
    await all?.(env.ctx("recheck_all"));
    expect(env.activity("recheck.all")[0]?.message).toBe(
      "Queued a recheck of 1 videos (0 on leftover budget).",
    );
  });
});
