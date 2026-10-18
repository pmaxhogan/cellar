import type { Logger } from "pino";
import type { FetchLike } from "../domain/deps.ts";

/**
 * Return YouTube Dislike lookups (estimated dislikes). Best effort by design:
 * at most one request per second per process, a short timeout, and any
 * failure (timeout, HTTP error, odd body) reads as "no data" so a recheck
 * never fails because of it. The derived numbers are labelled estimated in
 * the UI.
 */

export const RYD_VOTES_URL = "https://returnyoutubedislikeapi.com/votes";
export const RYD_MIN_INTERVAL_MS = 1000;
export const RYD_TIMEOUT_MS = 5000;

export interface RydVotes {
  likes: number | null;
  dislikes: number;
}

export interface RydClientOptions {
  fetch?: FetchLike;
  log?: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  minIntervalMs?: number;
  timeoutMs?: number;
}

export interface RydClient {
  /** Votes for one video, or null when the service had nothing usable. */
  votes(videoId: string): Promise<RydVotes | null>;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/** A rate-limited client. Share one per process so the 1 req/s limit is global. */
export function createRydClient(options: RydClientOptions = {}): RydClient {
  const fetchFn: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const interval = options.minIntervalMs ?? RYD_MIN_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? RYD_TIMEOUT_MS;
  let nextAt = 0;
  let chain: Promise<unknown> = Promise.resolve();

  async function lookup(videoId: string): Promise<RydVotes | null> {
    const wait = nextAt - now();
    if (wait > 0) {
      await sleep(wait);
    }
    nextAt = now() + interval;
    const url = new URL(RYD_VOTES_URL);
    url.searchParams.set("videoId", videoId);
    try {
      const response = await fetchFn(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        options.log?.debug({ videoId, status: response.status }, "ryd lookup not ok");
        return null;
      }
      const body = (await response.json()) as Record<string, unknown> | null;
      const dislikes = count(body?.["dislikes"]);
      if (dislikes === null) {
        return null;
      }
      return { likes: count(body?.["likes"]), dislikes };
    } catch (error) {
      options.log?.debug({ err: error, videoId }, "ryd lookup failed");
      return null;
    }
  }

  return {
    votes(videoId: string): Promise<RydVotes | null> {
      // Serialise so concurrent callers still respect the interval.
      const result = chain.then(() => lookup(videoId));
      chain = result.catch(() => undefined);
      return result;
    },
  };
}

/** Wrap a client with a per-run cache, so one recheck asks once per video. */
export function cachedRyd(client: RydClient): RydClient {
  const cache = new Map<string, Promise<RydVotes | null>>();
  return {
    votes(videoId: string): Promise<RydVotes | null> {
      let hit = cache.get(videoId);
      if (hit === undefined) {
        hit = client.votes(videoId);
        cache.set(videoId, hit);
      }
      return hit;
    },
  };
}

/** likes / (likes + dislikes), or null when it cannot be computed. */
export function rydRatio(likes: number | null, dislikes: number | null): number | null {
  if (likes === null || dislikes === null || likes + dislikes === 0) {
    return null;
  }
  return likes / (likes + dislikes);
}
