import { getKv, setKv } from "../db/kv.ts";
import { logActivity } from "../domain/activity.ts";
import { nowOf } from "../domain/deps.ts";
import { INGEST_CHANNEL_UPLOADS_JOB, isKnownUpload, type IngestDeps } from "./ingest.ts";
import { apiUsage } from "./quota.ts";
import { CHANNEL_FEED_TIMEOUT_MS, fetchChannelFeed, type ChannelFeedEntry } from "./rss.ts";

/**
 * `ingest_channel_feeds`: the quota-free front of the uploads poll. One sweep
 * reads every tracked channel's public RSS feed and queues the 1-unit API
 * uploads poll (`ingest_channel_uploads`) only for the channels that need it:
 *
 * - never polled through the API yet (the backfill guard needs the API walk);
 * - not polled through the API for FEED_SAFETY_NET_MS (catches anything the
 *   feed ever misses);
 * - the feed lists an upload cellar does not know yet;
 * - the feed failed and the last API poll is older than FEED_FAILURE_API_FLOOR_MS,
 *   so a feed outage degrades to a slow API poll instead of a fast one.
 *
 * `channels.last_checked_at` stays the time of the last API poll. A 429 from
 * youtube.com pauses every feed read for FEED_BACKOFF_MS.
 */

export const INGEST_CHANNEL_FEEDS_JOB = "ingest_channel_feeds";
export const FEED_SAFETY_NET_MS = 24 * 60 * 60_000;
export const FEED_FAILURE_API_FLOOR_MS = 2 * 60 * 60_000;
/** A feed entry published this long before the last API poll was already seen by it. */
export const FEED_SEEN_MARGIN_MS = 60 * 60_000;
export const FEED_BACKOFF_MS = 15 * 60_000;
export const FEED_CONCURRENCY = 4;
export const FEED_BACKOFF_KV = "channel_feeds_backoff_until";
/** Same as FEED_PRIORITY in jobs/ingestBoot.ts (which imports this module). */
const UPLOADS_POLL_PRIORITY = 10;

export type PollReason = "never_polled" | "safety_net" | "new_upload" | "feed_failed";

export interface FeedSweepResult {
  channels: number;
  /** Feeds read successfully. */
  fetched: number;
  /** Feeds that failed (HTTP error, unreadable, timeout, or skipped during a backoff). */
  failed: number;
  /** API polls queued, by reason. */
  queued: Record<PollReason, number>;
  /** Polls wanted but not queued because today's API budget is spent. */
  heldForBudget: number;
  rateLimited: boolean;
}

interface TrackedChannel {
  id: string;
  last_checked_at: number | null;
}

function trackedChannels(deps: IngestDeps): TrackedChannel[] {
  return deps.db.all<TrackedChannel>(
    `SELECT c.id, c.last_checked_at FROM channels c
      WHERE EXISTS (SELECT 1 FROM channel_sources cs WHERE cs.channel_id = c.id)
      ORDER BY c.id`,
  );
}

/** Feed entries that still need the API: unknown, and not already behind the last API poll. */
export function unseenEntries(
  deps: Pick<IngestDeps, "db">,
  entries: readonly ChannelFeedEntry[],
  lastApiPoll: number,
): ChannelFeedEntry[] {
  return entries.filter(
    (entry) =>
      !isKnownUpload(deps.db, entry.videoId) &&
      !(entry.publishedAt !== null && entry.publishedAt < lastApiPoll - FEED_SEEN_MARGIN_MS),
  );
}

export async function sweepChannelFeeds(
  deps: IngestDeps,
  options: { checkpoint?: () => void; timeoutMs?: number } = {},
): Promise<FeedSweepResult> {
  const channels = trackedChannels(deps);
  const result: FeedSweepResult = {
    channels: channels.length,
    fetched: 0,
    failed: 0,
    queued: { never_polled: 0, safety_net: 0, new_upload: 0, feed_failed: 0 },
    heldForBudget: 0,
    rateLimited: (getKv<number>(deps.db, FEED_BACKOFF_KV) ?? 0) > nowOf(deps),
  };

  const queuePoll = (channelId: string, reason: PollReason): void => {
    if (apiUsage(deps).remaining <= 0) {
      result.heldForBudget += 1;
      return;
    }
    deps.enqueue({
      type: INGEST_CHANNEL_UPLOADS_JOB,
      payload: { channel_id: channelId },
      priority: UPLOADS_POLL_PRIORITY,
      dedupe: true,
    });
    result.queued[reason] += 1;
  };

  const visit = async (channel: TrackedChannel): Promise<void> => {
    const now = nowOf(deps);
    const last = channel.last_checked_at;
    if (last === null) {
      queuePoll(channel.id, "never_polled");
      return;
    }
    if (now - last >= FEED_SAFETY_NET_MS) {
      queuePoll(channel.id, "safety_net");
      return;
    }
    const feed = result.rateLimited
      ? null
      : await fetchChannelFeed(deps, channel.id, options.timeoutMs ?? CHANNEL_FEED_TIMEOUT_MS);
    if (feed !== null && !feed.ok && feed.status === 429 && !result.rateLimited) {
      result.rateLimited = true;
      setKv(deps.db, FEED_BACKOFF_KV, now + FEED_BACKOFF_MS, now);
      deps.log.warn({ channelId: channel.id }, "channel feeds rate limited; backing off");
    }
    // An empty feed is treated as a failure: a channel the API knows uploads
    // for should never list none, and a channel with no uploads costs little.
    if (feed === null || !feed.ok || feed.entries.length === 0) {
      result.failed += 1;
      if (now - last >= FEED_FAILURE_API_FLOOR_MS) {
        queuePoll(channel.id, "feed_failed");
      }
      return;
    }
    result.fetched += 1;
    if (unseenEntries(deps, feed.entries, last).length > 0) {
      queuePoll(channel.id, "new_upload");
    }
  };

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < channels.length) {
      options.checkpoint?.();
      const channel = channels[next] as TrackedChannel;
      next += 1;
      await visit(channel);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(FEED_CONCURRENCY, channels.length) }, () => worker()),
  );

  const queued = Object.values(result.queued).reduce((sum, n) => sum + n, 0);
  if (queued > 0 || result.failed > 0 || result.heldForBudget > 0) {
    const parts = [
      `${String(result.channels)} channels`,
      `${String(result.fetched)} feeds read`,
      `${String(queued)} API polls queued`,
    ];
    if (result.failed > 0) {
      parts.push(`${String(result.failed)} feeds failed`);
    }
    if (result.heldForBudget > 0) {
      parts.push(`${String(result.heldForBudget)} held for the API budget`);
    }
    logActivity(deps, {
      level: result.failed > 0 && result.fetched === 0 ? "warn" : "info",
      kind: "ingest.channel_feeds",
      message: `Channel feeds: ${parts.join(", ")}.`,
      data: { ...result },
    });
  }
  return result;
}
