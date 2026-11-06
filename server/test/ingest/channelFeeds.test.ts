import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getKv } from "../../src/db/kv.ts";
import { registerIngestHandlers } from "../../src/jobs/handlers/ingest.ts";
import {
  FEED_BACKOFF_KV,
  FEED_BACKOFF_MS,
  FEED_FAILURE_API_FLOOR_MS,
  FEED_SAFETY_NET_MS,
  INGEST_CHANNEL_FEEDS_JOB,
  sweepChannelFeeds,
} from "../../src/youtube/channelFeeds.ts";
import {
  ensureChannel,
  INGEST_CHANNEL_UPLOADS_JOB,
  recordSighting,
} from "../../src/youtube/ingest.ts";
import { markApiBudgetSpent } from "../../src/youtube/quota.ts";
import { fetchChannelFeed, parseChannelFeed } from "../../src/youtube/rss.ts";
import { IngestEnv, NOW, RICK, THREE_B1B, VERITASIUM } from "./ingestHelpers.ts";

const KNOWN = "LKrwhjOI8Nc";
const FRESH = "V_uq3v6xK-4";
const HOUR = 60 * 60_000;

/** The shape of a real feeds/videos.xml document, trimmed. */
function feedXml(entries: { id: string; published: string }[]): string {
  const body = entries
    .map(
      (entry) => ` <entry>
  <id>yt:video:${entry.id}</id>
  <yt:videoId>${entry.id}</yt:videoId>
  <yt:channelId>UCYO_jab_esuFRV4b17AJtAw</yt:channelId>
  <title>A video</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=${entry.id}"/>
  <published>${entry.published}</published>
  <updated>2026-10-29T03:27:28+00:00</updated>
 </entry>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
 <id>yt:channel:YO_jab_esuFRV4b17AJtAw</id>
 <title>3Blue1Brown</title>
 <published>2015-03-03T23:11:55+00:00</published>
${body}
</feed>`;
}

const iso = (ms: number): string => new Date(ms).toISOString();

let env: IngestEnv;
let feeds: Map<string, () => Response>;
let feedHits: string[];

function track(channelId: string, lastCheckedAt: number | null): void {
  ensureChannel(env.db, { id: channelId }, NOW);
  env.db.run(
    "INSERT INTO channel_sources (channel_id, account_id, kind, created_at) VALUES (?, NULL, 'manual', ?)",
    channelId,
    NOW,
  );
  env.db.run("UPDATE channels SET last_checked_at = ? WHERE id = ?", lastCheckedAt, channelId);
}

function knownUpload(videoId: string, channelId: string): void {
  recordSighting(
    env.db,
    {
      videoId,
      channelId,
      fill: {},
      sources: [{ accountId: null, source: "channel", origin: "api" }],
    },
    NOW,
  );
}

function serveFeed(channelId: string, entries: { id: string; published: string }[]): void {
  feeds.set(
    channelId,
    () => new Response(feedXml(entries), { headers: { "content-type": "text/xml" } }),
  );
}

function polls(): unknown[] {
  return env.jobs(INGEST_CHANNEL_UPLOADS_JOB).map((job) => job.payload);
}

beforeEach(async () => {
  env = await IngestEnv.create();
  // The real handlers carry the per-channel dedupe key of the uploads poll.
  registerIngestHandlers(env.registry, env.deps());
  feeds = new Map();
  feedHits = [];
  env.routes.set("www.youtube.com", (url) => {
    const channelId = url.searchParams.get("channel_id") ?? "";
    feedHits.push(channelId);
    const handler = feeds.get(channelId);
    return handler === undefined ? new Response("not found", { status: 404 }) : handler();
  });
});

afterEach(() => {
  env.close();
});

describe("parseChannelFeed", () => {
  it("reads every entry's id and publish time, not the feed's own", () => {
    expect(
      parseChannelFeed(
        feedXml([
          { id: FRESH, published: "2026-10-25T14:30:46+00:00" },
          { id: KNOWN, published: "garbage" },
        ]),
      ),
    ).toEqual([
      { videoId: FRESH, publishedAt: Date.parse("2026-10-25T14:30:46+00:00") },
      { videoId: KNOWN, publishedAt: null },
    ]);
  });

  it("skips entries without a valid id and refuses a non-feed", () => {
    expect(parseChannelFeed(feedXml([{ id: "short", published: iso(NOW) }]))).toEqual([]);
    expect(parseChannelFeed("<html><body>consent</body></html>")).toBeNull();
  });
});

describe("fetchChannelFeed", () => {
  it("reports success, HTTP errors, non-feeds and network failures", async () => {
    serveFeed(THREE_B1B, [{ id: FRESH, published: iso(NOW) }]);
    const deps = env.deps();
    expect(await fetchChannelFeed(deps, THREE_B1B)).toEqual({
      ok: true,
      entries: [{ videoId: FRESH, publishedAt: NOW }],
    });
    expect(feedHits).toEqual([THREE_B1B]);
    expect(await fetchChannelFeed(deps, RICK)).toEqual({
      ok: false,
      status: 404,
      reason: "HTTP 404",
    });
    feeds.set(RICK, () => new Response("<html></html>"));
    expect(await fetchChannelFeed(deps, RICK)).toMatchObject({ ok: false, reason: "not a feed" });
    const broken = env.deps({
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(await fetchChannelFeed(broken, RICK)).toEqual({
      ok: false,
      status: null,
      reason: "fetch failed",
    });
  });
});

describe("sweepChannelFeeds", () => {
  it("costs nothing when every feed entry is already known", async () => {
    track(THREE_B1B, NOW - HOUR);
    knownUpload(KNOWN, THREE_B1B);
    serveFeed(THREE_B1B, [{ id: KNOWN, published: iso(NOW - 2 * HOUR) }]);
    const result = await sweepChannelFeeds(env.deps());
    expect(result).toMatchObject({ channels: 1, fetched: 1, failed: 0, heldForBudget: 0 });
    expect(polls()).toEqual([]);
    expect(env.google.apiCalls()).toHaveLength(0);
    expect(env.activity("ingest.channel_feeds")).toEqual([]);
  });

  it("queues an API poll for a new upload, a never-polled channel and the safety net", async () => {
    track(THREE_B1B, NOW - HOUR);
    knownUpload(KNOWN, THREE_B1B);
    serveFeed(THREE_B1B, [
      { id: FRESH, published: iso(NOW - 10 * 60_000) },
      { id: KNOWN, published: iso(NOW - 2 * HOUR) },
    ]);
    track(RICK, null);
    track(VERITASIUM, NOW - FEED_SAFETY_NET_MS);
    const result = await sweepChannelFeeds(env.deps());
    expect(result.queued).toEqual({
      never_polled: 1,
      safety_net: 1,
      new_upload: 1,
      feed_failed: 0,
    });
    expect(polls()).toEqual(
      expect.arrayContaining([
        { channel_id: THREE_B1B },
        { channel_id: RICK },
        { channel_id: VERITASIUM },
      ]),
    );
    // Only the channel that needed its feed read was fetched.
    expect(feedHits).toEqual([THREE_B1B]);
    expect(env.activity("ingest.channel_feeds")[0]?.message).toMatch(/3 API polls queued/);
  });

  it("ignores an unknown entry the last API poll already passed over", async () => {
    track(THREE_B1B, NOW - HOUR);
    serveFeed(THREE_B1B, [{ id: FRESH, published: iso(NOW - 3 * HOUR) }]);
    await sweepChannelFeeds(env.deps());
    expect(polls()).toEqual([]);
  });

  it("falls back to the API on a failed feed only past the floor", async () => {
    track(THREE_B1B, NOW - HOUR);
    track(RICK, NOW - FEED_FAILURE_API_FLOOR_MS);
    feeds.set(THREE_B1B, () => new Response(feedXml([])));
    const result = await sweepChannelFeeds(env.deps());
    expect(result).toMatchObject({ fetched: 0, failed: 2 });
    expect(polls()).toEqual([{ channel_id: RICK }]);
    expect(env.activity("ingest.channel_feeds")[0]?.level).toBe("warn");
  });

  it("backs off every feed read after a 429", async () => {
    track(THREE_B1B, NOW - HOUR);
    track(RICK, NOW - HOUR);
    track(VERITASIUM, NOW - HOUR);
    for (const id of [THREE_B1B, RICK, VERITASIUM]) {
      feeds.set(id, () => new Response("slow down", { status: 429 }));
    }
    const first = await sweepChannelFeeds(env.deps());
    expect(first.rateLimited).toBe(true);
    expect(getKv(env.db, FEED_BACKOFF_KV)).toBe(NOW + FEED_BACKOFF_MS);
    const hits = feedHits.length;
    expect(hits).toBeLessThanOrEqual(3);

    env.now += FEED_BACKOFF_MS - 1;
    const second = await sweepChannelFeeds(env.deps());
    expect(second).toMatchObject({ rateLimited: true, fetched: 0, failed: 3 });
    expect(feedHits).toHaveLength(hits);
  });

  it("holds polls while the API budget is spent", async () => {
    track(RICK, null);
    markApiBudgetSpent(env.deps());
    const result = await sweepChannelFeeds(env.deps());
    expect(result.heldForBudget).toBe(1);
    expect(polls()).toEqual([]);
  });

  it("runs as the ingest_channel_feeds job", async () => {
    track(RICK, null);
    const registration = env.registry.get(INGEST_CHANNEL_FEEDS_JOB);
    expect(registration?.class).toBe("io");
    await registration?.handler(env.ctx(INGEST_CHANNEL_FEEDS_JOB));
    expect(polls()).toEqual([{ channel_id: RICK }]);
  });
});
