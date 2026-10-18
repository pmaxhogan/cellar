import type { EvalContext, SourceKind, VideoFacts, VideoSourceFact } from "../../src/index.ts";

/** Fixed clock for every rules test: 2026-10-18T12:00:00Z. */
export const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
/** Fixed install time: 2026-01-01T00:00:00Z. */
export const INSTALLED_AT = Date.UTC(2026, 0, 1);
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export const ctx: EvalContext = { now: NOW, installed_at: INSTALLED_AT };

export function at(now: number): EvalContext {
  return { now, installed_at: INSTALLED_AT };
}

/** A synthetic `video_sources` row. */
export function src(
  source: SourceKind,
  firstSeenAt: number,
  opts: { account_id?: number | null; last_seen_at?: number; source_ts?: number | null } = {},
): VideoSourceFact {
  return {
    account_id: opts.account_id === undefined ? 1 : opts.account_id,
    source,
    first_seen_at: firstSeenAt,
    last_seen_at: opts.last_seen_at ?? firstSeenAt,
    source_ts: opts.source_ts ?? null,
  };
}

/** A synthetic public video, uploaded after install, watched once 5 days ago. */
export function video(overrides: Partial<VideoFacts> = {}): VideoFacts {
  return {
    id: "vid00000001",
    channel_id: "UCsynthetic000000000001",
    channel_title: "Synthetic Channel",
    title: "Hello World Example",
    description: "A synthetic description for tests",
    tags: ["alpha", "Beta"],
    type: "video",
    privacy: "public",
    gone_since: null,
    upload_date: NOW - 10 * DAY,
    published_at: NOW - 10 * DAY,
    duration_s: 600,
    views: 1000,
    likes: 50,
    comments: 10,
    ryd_ratio: 0.9,
    max_height: 1080,
    max_fps: 30,
    has_av1: true,
    has_vp9: true,
    has_h264: false,
    is_hdr: false,
    caption_available: true,
    sources: [src("history", NOW - 5 * DAY)],
    media: null,
    share_link_count: 0,
    ...overrides,
  };
}
