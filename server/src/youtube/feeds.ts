import { isVideoId } from "@cellar/shared";
import { withCookiesFile } from "../domain/accounts.ts";
import type { ServiceDeps } from "../domain/deps.ts";
import { runTool } from "../media/exec.ts";
import { consumeScrape } from "./quota.ts";

/**
 * Cookie-driven feeds read with yt-dlp in flat mode: the watch history and
 * Watch Later. Neither has an API path. Every yt-dlp run is one request from
 * the account's hourly scrape budget (consumeScrape refuses once it is spent),
 * and the decrypted jar only ever exists as a 0600 temp file whose path is the
 * one cookie-related thing that reaches the argv.
 */

export const HISTORY_URL = "https://www.youtube.com/feed/history";
export const WATCH_LATER_URL = ":ytwatchlater";
/** First history page size; doubled while the newest page still has unknown ids. */
export const HISTORY_FIRST_PAGE = 50;
export const HISTORY_MAX_ENTRIES = 500;
/** A flat listing of a long Watch Later can take a while. */
export const FEED_TIMEOUT_MS = 5 * 60_000;
const MAX_DETAIL_CHARS = 300;

export type FeedPrivacy = "private" | "removed";

/** One entry of a flat feed listing. */
export interface FeedEntry {
  id: string;
  /** Null for placeholder entries ("[Private video]", "[Deleted video]"). */
  title: string | null;
  channelId: string | null;
  channelTitle: string | null;
  durationS: number | null;
  /** Set when the entry is a placeholder for a video the viewer cannot see. */
  privacy: FeedPrivacy | null;
  /** True when the entry links to /shorts/. Null when the feed does not say. */
  isShort: boolean | null;
}

export interface FeedRun {
  entries: FeedEntry[];
  /** yt-dlp runs made (each one scrape request). */
  runs: number;
  /** Largest --playlist-end used, history only. */
  depth: number;
}

/** A yt-dlp feed run that did not produce a listing. Never carries the jar path. */
export class FeedError extends Error {
  override readonly name = "FeedError";
}

const CHANNEL_ID_RE = /^UC[\w-]{22}$/;

function stringOr(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function placeholderPrivacy(title: string | null): FeedPrivacy | null {
  if (title === null) {
    return null;
  }
  const bare = title.trim().toLowerCase();
  if (bare === "[private video]") {
    return "private";
  }
  if (bare === "[deleted video]") {
    return "removed";
  }
  return null;
}

/**
 * Parse a yt-dlp `-J --flat-playlist` document (or a bare entries array).
 * Entries without a valid 11-character id are dropped; duplicates keep the
 * first (newest) occurrence. Placeholder titles become a privacy marker and a
 * null title, so they never overwrite a real title.
 */
export function parseFlatEntries(doc: unknown): FeedEntry[] {
  const raw = Array.isArray(doc)
    ? (doc as unknown[])
    : typeof doc === "object" &&
        doc !== null &&
        Array.isArray((doc as { entries?: unknown }).entries)
      ? ((doc as { entries: unknown[] }).entries as unknown[])
      : [];
  const seen = new Set<string>();
  const out: FeedEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const entry = item as Record<string, unknown>;
    const id = entry["id"];
    if (typeof id !== "string" || !isVideoId(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const rawTitle = stringOr(entry["title"]);
    const privacy = placeholderPrivacy(rawTitle);
    const channelId = stringOr(entry["channel_id"]);
    const duration = entry["duration"];
    const url = stringOr(entry["url"]) ?? stringOr(entry["webpage_url"]);
    out.push({
      id,
      title: privacy === null ? rawTitle : null,
      channelId: channelId !== null && CHANNEL_ID_RE.test(channelId) ? channelId : null,
      channelTitle: stringOr(entry["channel"]) ?? stringOr(entry["uploader"]),
      durationS:
        typeof duration === "number" && Number.isFinite(duration) && duration >= 0
          ? Math.round(duration)
          : null,
      privacy,
      isShort: url === null ? null : url.includes("/shorts/"),
    });
  }
  return out;
}

/** The last error line of yt-dlp's stderr with the jar path masked, length capped. */
export function feedErrorDetail(stderr: string, cookiesPath: string): string {
  const lines = stderr.split(/\r?\n/).filter((line) => line.trim() !== "");
  const line = [...lines].reverse().find((l) => l.startsWith("ERROR")) ?? lines.at(-1) ?? "";
  const masked = line.split(cookiesPath).join("<cookies>").trim();
  const text = masked === "" ? "yt-dlp failed without an error message" : masked;
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}...` : text;
}

export interface FeedOptions {
  timeoutMs?: number;
  /** Aborts between runs (yt-dlp itself is not interrupted). */
  checkpoint?: () => void;
}

/** One flat listing through yt-dlp. Charges one scrape request first. */
async function listFeed(
  deps: ServiceDeps,
  accountId: number,
  url: string,
  extra: readonly string[],
  options: FeedOptions,
): Promise<FeedEntry[]> {
  return withCookiesFile(deps, accountId, async (cookiesPath) => {
    consumeScrape(deps, accountId);
    const result = await runTool(
      { config: deps.config, log: deps.log, db: deps.db },
      {
        tool: "yt-dlp",
        args: [
          url,
          "--flat-playlist",
          "-J",
          ...extra,
          "--sleep-requests",
          "1",
          "--cookies",
          cookiesPath,
        ],
        timeoutMs: options.timeoutMs ?? FEED_TIMEOUT_MS,
      },
    );
    if (result.timedOut) {
      throw new FeedError("yt-dlp timed out reading the feed.");
    }
    if (result.code !== 0) {
      throw new FeedError(feedErrorDetail(result.stderr, cookiesPath));
    }
    let doc: unknown;
    try {
      doc = JSON.parse(result.stdout) as unknown;
    } catch {
      throw new FeedError("yt-dlp returned output that is not JSON.");
    }
    return parseFlatEntries(doc);
  });
}

/**
 * The account's watch history, newest first. Starts with 50 entries and
 * doubles the depth (up to `max`, default 500) while the newest page still
 * holds an id `isKnown` rejects; stops as soon as a page is all known or the
 * feed returned fewer entries than asked for. Every run is one scrape request.
 */
export async function fetchHistory(
  deps: ServiceDeps,
  accountId: number,
  options: FeedOptions & { max?: number; isKnown?: (id: string) => boolean } = {},
): Promise<FeedRun> {
  const max = Math.max(1, options.max ?? HISTORY_MAX_ENTRIES);
  const isKnown = options.isKnown ?? (() => false);
  let depth = Math.min(HISTORY_FIRST_PAGE, max);
  let previous = 0;
  let runs = 0;
  for (;;) {
    options.checkpoint?.();
    const entries = await listFeed(
      deps,
      accountId,
      HISTORY_URL,
      ["--playlist-end", String(depth)],
      options,
    );
    runs += 1;
    const page = entries.slice(previous);
    const exhausted = entries.length < depth;
    if (exhausted || depth >= max || page.every((entry) => isKnown(entry.id))) {
      return { entries, runs, depth };
    }
    previous = depth;
    depth = Math.min(depth * 2, max);
  }
}

/** The account's whole Watch Later list (one scrape request). */
export async function fetchWatchLater(
  deps: ServiceDeps,
  accountId: number,
  options: FeedOptions = {},
): Promise<FeedRun> {
  options.checkpoint?.();
  const entries = await listFeed(deps, accountId, WATCH_LATER_URL, [], options);
  return { entries, runs: 1, depth: entries.length };
}
