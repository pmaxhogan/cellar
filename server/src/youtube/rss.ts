import { isVideoId } from "@cellar/shared";
import { fetchOf, type ServiceDeps } from "../domain/deps.ts";

/**
 * A channel's public uploads feed: `feeds/videos.xml?channel_id=`. It is an
 * unauthenticated GET (no cookies, no API key, no quota) that lists the
 * channel's newest ~15 uploads, shorts and premieres included. Cellar reads
 * it only to decide whether a channel needs a real API uploads poll.
 */

export const CHANNEL_FEED_URL = "https://www.youtube.com/feeds/videos.xml";
export const CHANNEL_FEED_TIMEOUT_MS = 10_000;

export interface ChannelFeedEntry {
  videoId: string;
  /** The `<published>` time in epoch ms, null when missing or unreadable. */
  publishedAt: number | null;
}

export type ChannelFeedResult =
  { ok: true; entries: ChannelFeedEntry[] } | { ok: false; status: number | null; reason: string };

const ENTRY_RE = /<entry\b[^>]*>([\s\S]*?)<\/entry>/g;
const VIDEO_ID_RE = /<yt:videoId>\s*([^<\s]+)\s*<\/yt:videoId>/;
const PUBLISHED_RE = /<published>\s*([^<\s]+)\s*<\/published>/;

/** The entries of a feed document, or null when the text is not an Atom feed. */
export function parseChannelFeed(xml: string): ChannelFeedEntry[] | null {
  if (!/<feed\b/.test(xml)) {
    return null;
  }
  const entries: ChannelFeedEntry[] = [];
  for (const match of xml.matchAll(ENTRY_RE)) {
    const body = match[1] ?? "";
    const videoId = VIDEO_ID_RE.exec(body)?.[1];
    if (videoId === undefined || !isVideoId(videoId)) {
      continue;
    }
    const published = PUBLISHED_RE.exec(body)?.[1];
    const ms = published === undefined ? Number.NaN : Date.parse(published);
    entries.push({ videoId, publishedAt: Number.isFinite(ms) ? ms : null });
  }
  return entries;
}

/** GET and parse one channel's feed. Never throws: every failure is a result. */
export async function fetchChannelFeed(
  deps: Pick<ServiceDeps, "fetch">,
  channelId: string,
  timeoutMs = CHANNEL_FEED_TIMEOUT_MS,
): Promise<ChannelFeedResult> {
  const url = `${CHANNEL_FEED_URL}?channel_id=${encodeURIComponent(channelId)}`;
  let response: Response;
  try {
    response = await fetchOf(deps)(url, {
      headers: { accept: "application/atom+xml, application/xml;q=0.9, */*;q=0.1" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return {
      ok: false,
      status: null,
      reason: error instanceof Error ? error.message : "request failed",
    };
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { ok: false, status: response.status, reason: "unreadable body" };
  }
  if (!response.ok) {
    return { ok: false, status: response.status, reason: `HTTP ${String(response.status)}` };
  }
  const entries = parseChannelFeed(text);
  if (entries === null) {
    return { ok: false, status: response.status, reason: "not a feed" };
  }
  return { ok: true, entries };
}
