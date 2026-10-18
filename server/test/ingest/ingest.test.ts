import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKv } from "../../src/db/kv.ts";
import { DomainError } from "../../src/domain/errors.ts";
import { updateSettings } from "../../src/domain/settings.ts";
import { registerIngestHandlers } from "../../src/jobs/handlers/ingest.ts";
import {
  apiAccountIds,
  backfillState,
  channelsNeedingBackfill,
  cookieAccountIds,
  emptyResult,
  enqueueRecheck,
  ensureChannel,
  fillVideo,
  finishIngest,
  hasVideoSource,
  INGEST_CHANNEL_BACKFILL_JOB,
  INGEST_CHANNEL_UPLOADS_JOB,
  INGEST_HISTORY_JOB,
  INGEST_LIKED_JOB,
  INGEST_SUBSCRIPTIONS_JOB,
  INGEST_WATCH_LATER_JOB,
  ingestChannelBackfill,
  ingestChannelUploads,
  ingestHistory,
  ingestLiked,
  ingestSubscriptions,
  ingestWatchLater,
  parsePlaylistItem,
  pickApiAccount,
  RECHECK_BATCH_JOB,
  RECHECK_LEFTOVER_JOB,
  RECHECK_NEW_PRIORITY,
  recheckKey,
  recordSighting,
  upsertVideoSource,
} from "../../src/youtube/ingest.ts";
import { QuotaExhausted } from "../../src/youtube/quota.ts";
import {
  DAY,
  HISTORY_FIXTURE,
  IngestEnv,
  jsonResponse,
  NOW,
  pagedHandler,
  playlistItem,
  RICK,
  THREE_B1B,
  VERITASIUM,
  vid,
  WATCH_LATER_FIXTURE,
  youtubeFixture,
} from "./ingestHelpers.ts";

let env: IngestEnv;

beforeEach(async () => {
  env = await IngestEnv.create();
  vi.stubEnv("FAKE_YTDLP_PLAYLIST_FILE", HISTORY_FIXTURE);
});

afterEach(() => {
  vi.unstubAllEnvs();
  env.close();
});

function seedVideo(id: string, channelId: string | null = null): void {
  if (channelId !== null) {
    ensureChannel(env.db, { id: channelId }, NOW);
  }
  recordSighting(env.db, { videoId: id, channelId, fill: {}, sources: [] }, NOW);
}

describe("upsertVideoSource", () => {
  it("is idempotent for NULL account ids and keeps first_seen_at", () => {
    seedVideo("dQw4w9WgXcQ");
    const input = {
      videoId: "dQw4w9WgXcQ",
      accountId: null,
      source: "channel" as const,
      origin: "api" as const,
    };
    expect(upsertVideoSource(env.db, input, 1000)).toBe(true);
    expect(upsertVideoSource(env.db, input, 2000)).toBe(false);
    expect(upsertVideoSource(env.db, input, 1500)).toBe(false);
    expect(env.sources("dQw4w9WgXcQ")).toEqual([
      {
        account_id: null,
        source: "channel",
        first_seen_at: 1000,
        last_seen_at: 2000,
        source_ts: null,
        origin: "api",
      },
    ]);
  });

  it("keeps accounts apart, takes a newer source_ts and keeps the first origin", () => {
    seedVideo("dQw4w9WgXcQ");
    const account = env.account();
    const base = { videoId: "dQw4w9WgXcQ", source: "liked" as const };
    expect(upsertVideoSource(env.db, { ...base, accountId: null, origin: "takeout" }, 1)).toBe(
      true,
    );
    expect(
      upsertVideoSource(env.db, { ...base, accountId: account, origin: "takeout", sourceTs: 5 }, 1),
    ).toBe(true);
    upsertVideoSource(env.db, { ...base, accountId: account, origin: "api", sourceTs: 9 }, 2);
    upsertVideoSource(env.db, { ...base, accountId: account, origin: "api", sourceTs: null }, 3);
    expect(env.sources("dQw4w9WgXcQ")).toEqual([
      expect.objectContaining({ account_id: null, source_ts: null }),
      expect.objectContaining({
        account_id: account,
        first_seen_at: 1,
        last_seen_at: 3,
        source_ts: 9,
        origin: "takeout",
      }),
    ]);
    expect(hasVideoSource(env.db, "dQw4w9WgXcQ", account, "liked")).toBe(true);
    expect(hasVideoSource(env.db, "dQw4w9WgXcQ", account, "history")).toBe(false);
    expect(hasVideoSource(env.db, "dQw4w9WgXcQ", null, "liked")).toBe(true);
  });
});

describe("catalog helpers", () => {
  it("ensureChannel creates once and refreshes title and thumbnail but not the uploads id", () => {
    expect(ensureChannel(env.db, { id: RICK, uploadsPlaylistId: "UUfirst" }, 1)).toBe(true);
    expect(
      ensureChannel(
        env.db,
        { id: RICK, title: "Rick", thumbnailUrl: "t", uploadsPlaylistId: "UUx" },
        2,
      ),
    ).toBe(false);
    ensureChannel(env.db, { id: RICK, title: null }, 3);
    expect(
      env.db.get("SELECT title, thumbnail_url, uploads_playlist_id, updated_at FROM channels"),
    ).toEqual({ title: "Rick", thumbnail_url: "t", uploads_playlist_id: "UUfirst", updated_at: 2 });
  });

  it("fillVideo only fills empty columns", () => {
    seedVideo("dQw4w9WgXcQ");
    fillVideo(env.db, "dQw4w9WgXcQ", { title: "First", duration_s: 10, privacy: null }, 5);
    fillVideo(env.db, "dQw4w9WgXcQ", { title: "Second", duration_s: 20, type: "short" }, 6);
    fillVideo(env.db, "dQw4w9WgXcQ", {}, 7);
    expect(env.video("dQw4w9WgXcQ")).toMatchObject({
      title: "First",
      duration_s: 10,
      privacy: null,
      type: "short",
      updated_at: 6,
    });
    expect(env.db.get("SELECT COUNT(*) AS n FROM video_changes")).toEqual({ n: 0 });
  });

  it("parsePlaylistItem reads ids, placeholders and times", () => {
    expect(parsePlaylistItem({})).toBeNull();
    expect(parsePlaylistItem({ contentDetails: { videoId: "bad" } })).toBeNull();
    expect(
      parsePlaylistItem({
        snippet: {
          title: "Private video",
          resourceId: { videoId: "dQw4w9WgXcQ" },
          publishedAt: "nonsense",
          videoOwnerChannelId: "nope",
        },
      }),
    ).toEqual({
      videoId: "dQw4w9WgXcQ",
      title: null,
      privacy: "private",
      channelId: null,
      channelTitle: null,
      addedAt: null,
      publishedAt: null,
    });
  });
});

describe("accounts", () => {
  it("lists API and cookie accounts and round-robins the API ones", () => {
    const a = env.account();
    const b = env.account({ cookies: false });
    const c = env.cookieOnlyAccount();
    env.account({ status: "disabled" });
    const lost = env.account({ status: "auth_lost" });
    const badJar = env.account({ status: "cookies_invalid" });
    expect(apiAccountIds(env.db)).toEqual([a, b, badJar]);
    expect(cookieAccountIds(env.db)).toEqual([a, c, lost]);

    expect(pickApiAccount(env.db, [], "k", NOW)).toBe(a);
    expect(pickApiAccount(env.db, [], "k", NOW)).toBe(b);
    expect(pickApiAccount(env.db, [], "k", NOW)).toBe(badJar);
    expect(pickApiAccount(env.db, [], "k", NOW)).toBe(a);
    // Preferred accounts win when one qualifies; unknown preferences fall back to all.
    expect(pickApiAccount(env.db, [b], "other", NOW)).toBe(b);
    expect(pickApiAccount(env.db, [b], "other", NOW)).toBe(b);
    expect(pickApiAccount(env.db, [c], "third", NOW)).toBe(a);
  });

  it("returns null when no account has API access", () => {
    env.cookieOnlyAccount();
    expect(pickApiAccount(env.db, [], "k", NOW)).toBeNull();
  });
});

describe("enqueueRecheck", () => {
  it("fills queued batches up to 50 before creating new ones and bumps their priority", () => {
    const first = Array.from({ length: 30 }, (_, i) => vid(i));
    const second = Array.from({ length: 30 }, (_, i) => vid(i + 30));
    enqueueRecheck(env.deps(), first);
    enqueueRecheck(env.deps(), [...second, "not-an-id", first[0] as string], { priority: 5 });
    const jobs = env.jobs(RECHECK_BATCH_JOB);
    expect(jobs).toHaveLength(2);
    expect((jobs[0]?.payload as { video_ids: string[] }).video_ids).toHaveLength(50);
    expect(jobs[0]?.priority).toBe(5);
    expect((jobs[1]?.payload as { video_ids: string[] }).video_ids).toEqual(second.slice(20));
    expect(enqueueRecheck(env.deps(), [])).toEqual([]);
  });

  it("uses the leftover type when asked and ignores unparsable queued payloads", () => {
    env.db.run(
      `INSERT INTO jobs (type, status, payload_json, run_after, created_at)
       VALUES (?, 'queued', 'not json', 0, 0), (?, 'queued', '{"due":true}', 0, 0)`,
      RECHECK_LEFTOVER_JOB,
      RECHECK_LEFTOVER_JOB,
    );
    enqueueRecheck(env.deps(), [vid(1)], { leftover: true });
    expect(env.jobs(RECHECK_LEFTOVER_JOB).at(-1)?.payload).toEqual({ video_ids: [vid(1)] });
  });

  it("recheckKey identifies due and explicit batches", () => {
    expect(recheckKey({ video_ids: ["b", "a"] })).toBe("ids:a,b");
    expect(recheckKey({ due: true })).toBe("due");
    expect(recheckKey(null)).toBe("none");
  });
});

describe("cookie feeds", () => {
  it("ingests the history feed: videos, channels, sources, rechecks and an eval pass", async () => {
    const account = env.account();
    const result = await ingestHistory(env.deps(), account);
    expect(result).toMatchObject({ seen: 5, newVideos: 5, newSources: 5, pages: 1, scrapes: 1 });
    expect(env.video("dQw4w9WgXcQ")).toMatchObject({
      channel_id: RICK,
      title: "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)",
      duration_s: 213,
    });
    expect(env.video("pRiVaTe0001")).toMatchObject({
      channel_id: null,
      title: null,
      privacy: "private",
    });
    expect(env.db.get("SELECT title FROM channels WHERE id = ?", RICK)).toEqual({
      title: "Rick Astley",
    });
    expect(env.sources("dQw4w9WgXcQ")).toEqual([
      {
        account_id: account,
        source: "history",
        first_seen_at: NOW,
        last_seen_at: NOW,
        source_ts: null,
        origin: "live_feed",
      },
    ]);

    finishIngest(env.deps(), result, { jobId: 7 });
    const rechecks = env.jobs(RECHECK_BATCH_JOB);
    expect(rechecks).toHaveLength(1);
    expect(rechecks[0]?.priority).toBe(RECHECK_NEW_PRIORITY);
    expect((rechecks[0]?.payload as { video_ids: string[] }).video_ids).toHaveLength(5);
    const evals = env.jobs("eval_pass");
    expect(evals).toHaveLength(1);
    expect(evals[0]?.payload).toMatchObject({ reason: "ingest:history" });
    expect(env.activity("ingest.history")).toEqual([
      {
        level: "info",
        kind: "ingest.history",
        message: `Watch history for account ${String(account)}: 5 new videos, 5 new sources, 1 pages, 0 API units.`,
        data: expect.objectContaining({ newVideos: 5, newSources: 5, pages: 1, depth: 50 }),
      },
    ]);

    env.now += 60_000;
    const again = await ingestHistory(env.deps(), account);
    expect(again).toMatchObject({ newVideos: 0, newSources: 0, recheckIds: [] });
    expect(env.sources("dQw4w9WgXcQ")[0]).toMatchObject({
      first_seen_at: NOW,
      last_seen_at: NOW + 60_000,
    });
  });

  it("ingests Watch Later and counts entries that left the list", async () => {
    const account = env.account();
    vi.stubEnv("FAKE_YTDLP_PLAYLIST_FILE", WATCH_LATER_FIXTURE);
    seedVideo("dQw4w9WgXcQ");
    upsertVideoSource(
      env.db,
      { videoId: "dQw4w9WgXcQ", accountId: account, source: "watch_later", origin: "live_feed" },
      NOW - DAY,
    );
    const result = await ingestWatchLater(env.deps(), account);
    expect(result).toMatchObject({ seen: 3, newVideos: 3, newSources: 3 });
    expect(result.notes).toEqual({ notInList: 1 });
    // The old row stays; only its last_seen_at goes stale.
    expect(env.sources("dQw4w9WgXcQ")[0]).toMatchObject({ last_seen_at: NOW - DAY });
  });
});

describe("ingestLiked", () => {
  function serveLiked(): void {
    const pages = youtubeFixture<{ nextPageToken?: string }[]>("playlistItems.list.LL.json");
    env.api("playlistItems", (url) => {
      expect(url.searchParams.get("playlistId")).toBe("LL");
      expect(url.searchParams.get("maxResults")).toBe("50");
      const token = url.searchParams.get("pageToken");
      return jsonResponse(200, token === null ? pages[0] : pages[1]);
    });
  }

  it("walks both pages, records like times and stops on a known page next time", async () => {
    const account = env.account();
    serveLiked();
    const result = await ingestLiked(env.deps(), account);
    expect(result.pages).toBe(2);
    expect(result.units).toBe(2);
    expect(result.seen).toBe(5);
    expect(result.newVideos).toBe(5);
    expect(env.sources("dQw4w9WgXcQ")).toEqual([
      expect.objectContaining({
        account_id: account,
        source: "liked",
        source_ts: Date.parse("2026-10-17T21:14:05Z"),
        origin: "api",
      }),
    ]);
    expect(env.video("dQw4w9WgXcQ")).toMatchObject({
      channel_id: RICK,
      upload_date: Date.parse("2009-10-25T06:57:33Z"),
    });
    const deleted = env.db.get<{ privacy: string; title: string | null }>(
      "SELECT privacy, title FROM videos WHERE privacy = 'removed'",
    );
    expect(deleted).toEqual({ privacy: "removed", title: null });

    const again = await ingestLiked(env.deps(), account);
    expect(again.pages).toBe(1);
    expect(again.newSources).toBe(0);
    expect(env.apiCalls("playlistItems")).toHaveLength(3);
  });

  it("fails cleanly on a spent API budget, logging what it did", async () => {
    const account = env.account();
    serveLiked();
    updateSettings(env.db, { "quota.api_units_per_day": 1 });
    const registry = env.registry;
    registerIngestHandlers(registry, env.deps());
    const handler = registry.get(INGEST_LIKED_JOB)?.handler;
    const ctx = env.ctx(INGEST_LIKED_JOB, { payload: { account_id: account } });
    const error = await handler?.(ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QuotaExhausted);
    // Page one was stored; page two was refused before any request.
    expect(env.apiCalls("playlistItems")).toHaveLength(1);
    expect(env.db.get("SELECT COUNT(*) AS n FROM video_sources")).toEqual({ n: 3 });
    const [row] = env.activity("ingest.liked");
    expect(row?.level).toBe("warn");
    expect(row?.message).toMatch(/stopped early .*daily YouTube API budget is spent/);
    expect(row?.data).toMatchObject({ units: 1, pages: 1, newVideos: 3 });
    expect(env.jobs(RECHECK_BATCH_JOB)).toHaveLength(1);
  });
});

describe("ingestSubscriptions", () => {
  it("records channels and subscription sources, and reports channels no longer returned", async () => {
    const account = env.account();
    const body = youtubeFixture<{ items: unknown[] }>("subscriptions.list.json");
    let items = body.items;
    env.api("subscriptions", (url) => {
      expect(url.searchParams.get("mine")).toBe("true");
      expect(url.searchParams.get("part")).toBe("snippet");
      return jsonResponse(200, { ...body, items });
    });
    const first = await ingestSubscriptions(env.deps(), account);
    expect(first).toMatchObject({ seen: 2, pages: 1, units: 1 });
    expect(first.newChannels).toEqual([THREE_B1B, VERITASIUM]);
    expect(
      env.db.all(
        `SELECT channel_id, account_id, kind, subscribed_at FROM channel_sources
          ORDER BY channel_id`,
      ),
    ).toEqual([
      {
        channel_id: VERITASIUM,
        account_id: account,
        kind: "subscription",
        subscribed_at: Date.parse("2023-11-02T09:41:50Z"),
      },
      {
        channel_id: THREE_B1B,
        account_id: account,
        kind: "subscription",
        subscribed_at: Date.parse("2024-03-14T17:22:09Z"),
      },
    ]);
    expect(env.db.get("SELECT title, thumbnail_url FROM channels WHERE id = ?", THREE_B1B)).toEqual(
      {
        title: "3Blue1Brown",
        thumbnail_url: `https://yt3.ggpht.com/fake/${THREE_B1B}/s88-c-k-c0x00ffffff-no-rj`,
      },
    );

    items = [body.items[0]];
    const second = await ingestSubscriptions(env.deps(), account);
    expect(second.newChannels).toEqual([]);
    expect(second.missingChannels).toEqual([VERITASIUM]);
    expect(env.db.get("SELECT COUNT(*) AS n FROM channel_sources")).toEqual({ n: 2 });
    expect(env.activity("ingest.subscriptions_missing")[0]?.data).toEqual({
      accountId: account,
      channels: [VERITASIUM],
    });
  });
});

describe("ingestChannelUploads", () => {
  function track(channelId: string, kind: "subscription" | "manual", account: number | null): void {
    ensureChannel(env.db, { id: channelId }, NOW);
    env.db.run(
      `INSERT INTO channel_sources (channel_id, account_id, kind, created_at) VALUES (?, ?, ?, ?)`,
      channelId,
      account,
      kind,
      NOW,
    );
  }

  it("pages a brand-new channel until a page predates the guard window, recording every video", async () => {
    const account = env.account();
    track(THREE_B1B, "subscription", account);
    track(THREE_B1B, "manual", null);
    const recent = NOW - DAY;
    const old = NOW - 30 * DAY;
    const pages = [
      { items: [playlistItem(vid(1), recent), playlistItem(vid(2), old)] },
      { items: [playlistItem(vid(3), old), playlistItem(vid(4), old - DAY)] },
      { items: [playlistItem(vid(5), old - 2 * DAY)] },
    ];
    env.api("playlistItems", (url) => {
      expect(url.searchParams.get("playlistId")).toBe(`UU${THREE_B1B.slice(2)}`);
      return pagedHandler(pages)(url);
    });
    const result = await ingestChannelUploads(env.deps(), THREE_B1B);
    expect(result).toMatchObject({ accountId: account, pages: 2, seen: 4, newVideos: 4 });
    expect(result.notes).toMatchObject({ brandNew: true });
    // Only the upload inside the guard window is rechecked right away.
    expect(result.recheckIds).toEqual([vid(1)]);
    expect(env.video(vid(4))).toMatchObject({ channel_id: THREE_B1B, upload_date: old - DAY });
    expect(env.video(vid(5))).toBeUndefined();
    expect(env.sources(vid(3)).map((s) => [s.account_id, s.source])).toEqual([
      [account, "subscription"],
      [null, "channel"],
    ]);
    expect(env.db.get("SELECT last_checked_at, uploads_playlist_id FROM channels")).toEqual({
      last_checked_at: NOW,
      uploads_playlist_id: `UU${THREE_B1B.slice(2)}`,
    });
  });

  it("stops at the first known upload of a channel polled before, within newest_n", async () => {
    const account = env.account();
    track(THREE_B1B, "subscription", account);
    env.db.run("UPDATE channels SET last_checked_at = ?", NOW - DAY);
    seedVideo(vid(3), THREE_B1B);
    upsertVideoSource(
      env.db,
      { videoId: vid(3), accountId: account, source: "subscription", origin: "api" },
      NOW - DAY,
    );
    const pages = [
      { items: [playlistItem(vid(1), NOW), playlistItem(vid(2), NOW), playlistItem(vid(3), NOW)] },
      { items: [playlistItem(vid(4), NOW)] },
    ];
    env.api("playlistItems", pagedHandler(pages));
    const result = await ingestChannelUploads(env.deps(), THREE_B1B);
    expect(result).toMatchObject({ pages: 1, seen: 2, newVideos: 2, recheckIds: [vid(1), vid(2)] });

    updateSettings(env.db, { "ingest.channel_newest_n": 1 });
    env.db.run("DELETE FROM video_sources");
    const limited = await ingestChannelUploads(env.deps(), THREE_B1B);
    expect(limited.seen).toBe(1);
    expect(env.apiCalls("playlistItems").at(-1)?.searchParams.get("maxResults")).toBe("1");
  });

  it("treats a missing uploads playlist as empty and skips untracked channels", async () => {
    env.account();
    track(RICK, "manual", null);
    env.api("playlistItems", () =>
      jsonResponse(404, { error: { code: 404, errors: [{ reason: "playlistNotFound" }] } }),
    );
    const result = await ingestChannelUploads(env.deps(), RICK);
    expect(result.notes).toMatchObject({ noUploads: true });
    expect(env.db.get("SELECT last_checked_at FROM channels WHERE id = ?", RICK)).toEqual({
      last_checked_at: NOW,
    });

    ensureChannel(env.db, { id: VERITASIUM }, NOW);
    const untracked = await ingestChannelUploads(env.deps(), VERITASIUM);
    expect(untracked.notes).toEqual({ skipped: "not tracked" });
    await expect(ingestChannelUploads(env.deps(), "UCnope")).rejects.toBeInstanceOf(DomainError);
  });

  it("needs an account with API access and propagates other API errors", async () => {
    track(RICK, "manual", null);
    await expect(ingestChannelUploads(env.deps(), RICK)).rejects.toMatchObject({
      code: "no_account",
    });
    env.account();
    env.api("playlistItems", () =>
      jsonResponse(500, { error: { code: 500, errors: [{ reason: "backendError" }] } }),
    );
    await expect(ingestChannelUploads(env.deps(), RICK)).rejects.toThrow(/HTTP 500/);
  });
});

describe("ingestChannelBackfill", () => {
  it("walks a manual channel, resumes from the stored token and stops when caught up", async () => {
    env.account();
    ensureChannel(env.db, { id: RICK }, NOW);
    env.db.run(
      "INSERT INTO channel_sources (channel_id, account_id, kind, created_at) VALUES (?, NULL, 'manual', ?)",
      RICK,
      NOW,
    );
    const pages = [
      { items: [playlistItem(vid(1), NOW, RICK)] },
      { items: [playlistItem(vid(2), NOW, RICK)] },
      { items: [playlistItem(vid(3), NOW, RICK)] },
    ];
    env.api("playlistItems", pagedHandler(pages));
    expect(channelsNeedingBackfill(env.db)).toEqual([RICK]);

    let allowed = 1;
    const first = await ingestChannelBackfill(env.deps(), RICK, undefined, {
      budgetOk: () => allowed-- > 0,
    });
    expect(first).toMatchObject({ pages: 1, newVideos: 1 });
    expect(first.notes).toEqual({ paused: "leftover budget spent" });
    expect(backfillState(env.db, RICK)).toEqual({ done: false, pageToken: "p1", pages: 1 });

    const second = await ingestChannelBackfill(env.deps(), RICK);
    expect(second).toMatchObject({ pages: 2, newVideos: 2 });
    expect(second.notes).toEqual({ caughtUp: true });
    expect(backfillState(env.db, RICK)).toEqual({ done: true, pageToken: null, pages: 3 });
    expect(env.sources(vid(3))).toEqual([expect.objectContaining({ source: "channel" })]);
    expect(channelsNeedingBackfill(env.db)).toEqual([]);

    const third = await ingestChannelBackfill(env.deps(), RICK);
    expect(third.notes).toEqual({ skipped: "caught up" });
    expect(getKv(env.db, `channel_backfill:${RICK}`)).toMatchObject({ done: true });
  });

  it("skips channels that are not manual and treats a missing playlist as done", async () => {
    env.account();
    ensureChannel(env.db, { id: RICK }, NOW);
    const skipped = await ingestChannelBackfill(env.deps(), RICK);
    expect(skipped.notes).toEqual({ skipped: "not a manual channel" });
    env.db.run(
      "INSERT INTO channel_sources (channel_id, account_id, kind, created_at) VALUES (?, NULL, 'manual', ?)",
      RICK,
      NOW,
    );
    env.api("playlistItems", () =>
      jsonResponse(404, { error: { code: 404, errors: [{ reason: "playlistNotFound" }] } }),
    );
    const done = await ingestChannelBackfill(env.deps(), RICK);
    expect(done.notes).toEqual({ caughtUp: true });
    env.db.run("DELETE FROM kv WHERE key = ?", `channel_backfill:${RICK}`);
    env.api("playlistItems", () => jsonResponse(503, { error: { code: 503 } }));
    await expect(ingestChannelBackfill(env.deps(), RICK)).rejects.toThrow(/HTTP 503/);
  });
});

describe("ingest handlers", () => {
  it("runs history and Watch Later for eligible accounts and skips the rest", async () => {
    registerIngestHandlers(env.registry, env.deps());
    // Registering twice is a no-op.
    registerIngestHandlers(env.registry, env.deps());
    const account = env.account();
    const history = env.registry.get(INGEST_HISTORY_JOB)?.handler;
    await history?.(env.ctx(INGEST_HISTORY_JOB, { accountId: account }));
    expect(env.activity("ingest.history")).toHaveLength(1);

    vi.stubEnv("FAKE_YTDLP_PLAYLIST_FILE", WATCH_LATER_FIXTURE);
    const wl = env.registry.get(INGEST_WATCH_LATER_JOB)?.handler;
    await wl?.(env.ctx(INGEST_WATCH_LATER_JOB, { payload: { account_id: account } }));
    expect(env.activity("ingest.watch_later")).toHaveLength(1);

    const apiOnly = env.account({ cookies: false });
    await history?.(env.ctx(INGEST_HISTORY_JOB, { accountId: apiOnly }));
    await history?.(env.ctx(INGEST_HISTORY_JOB));
    expect(env.activity("ingest.history")).toHaveLength(1);
  });

  it("queues an uploads poll for newly subscribed channels", async () => {
    registerIngestHandlers(env.registry, env.deps());
    const account = env.account();
    env.api("subscriptions", () => jsonResponse(200, youtubeFixture("subscriptions.list.json")));
    const handler = env.registry.get(INGEST_SUBSCRIPTIONS_JOB)?.handler;
    await handler?.(env.ctx(INGEST_SUBSCRIPTIONS_JOB, { payload: { account_id: account } }));
    expect(env.jobs(INGEST_CHANNEL_UPLOADS_JOB).map((job) => job.payload)).toEqual([
      { channel_id: THREE_B1B },
      { channel_id: VERITASIUM },
    ]);
  });

  it("runs channel uploads and backfill jobs, honouring the budget hook", async () => {
    let leftoverOk = false;
    registerIngestHandlers(env.registry, {
      ...env.deps(),
      budgetOk: (cls) => cls !== "leftover" || leftoverOk,
    });
    env.account();
    ensureChannel(env.db, { id: RICK }, NOW);
    env.db.run(
      "INSERT INTO channel_sources (channel_id, account_id, kind, created_at) VALUES (?, NULL, 'manual', ?)",
      RICK,
      NOW,
    );
    env.api("playlistItems", pagedHandler([{ items: [playlistItem(vid(1), NOW, RICK)] }]));
    const uploads = env.registry.get(INGEST_CHANNEL_UPLOADS_JOB)?.handler;
    await uploads?.(env.ctx(INGEST_CHANNEL_UPLOADS_JOB, { payload: { channel_id: RICK } }));
    await uploads?.(env.ctx(INGEST_CHANNEL_UPLOADS_JOB, { payload: {} }));
    expect(env.activity("ingest.channel_uploads")).toHaveLength(1);

    const backfill = env.registry.get(INGEST_CHANNEL_BACKFILL_JOB)?.handler;
    await backfill?.(env.ctx(INGEST_CHANNEL_BACKFILL_JOB, { payload: { channel_id: RICK } }));
    expect(env.activity("ingest.channel_backfill")[0]?.data).toMatchObject({
      paused: "leftover budget spent",
    });
    leftoverOk = true;
    await backfill?.(env.ctx(INGEST_CHANNEL_BACKFILL_JOB, { payload: { channel_id: RICK } }));
    expect(env.activity("ingest.channel_backfill")[1]?.data).toMatchObject({ caughtUp: true });
    await backfill?.(env.ctx(INGEST_CHANNEL_BACKFILL_JOB, { payload: null }));
    expect(env.activity("ingest.channel_backfill")).toHaveLength(2);
  });

  it("logs a failed run with the error text", () => {
    const result = emptyResult("channel_uploads", null, RICK);
    finishIngest(env.deps(), result, { error: "boom" });
    expect(env.activity("ingest.channel_uploads")[0]).toMatchObject({
      level: "warn",
      message: `Channel uploads for channel ${RICK} stopped early (0 new videos, 0 new sources, 0 pages, 0 API units): boom`,
    });
    finishIngest(env.deps(), emptyResult("liked", null));
    expect(env.activity("ingest.liked")[0]?.message).toBe(
      "Liked videos: 0 new videos, 0 new sources, 0 pages, 0 API units.",
    );
  });
});
