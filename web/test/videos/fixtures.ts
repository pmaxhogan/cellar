import type { ShareLinkRow } from "../../src/api/videos.ts";
import type {
  AccountRow,
  LocationRow,
  MediaRow,
  VideoChangeRow,
  VideoDetail,
  VideoRow,
  VideoStatsPoint,
} from "@cellar/shared";

export function account(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: 1,
    label: "main",
    email: null,
    channel_id: null,
    status: "ok",
    has_cookies: true,
    scrape_budget_per_hour: null,
    last_api_ok_at: null,
    last_cookie_ok_at: null,
    created_at: 1,
    ...overrides,
  };
}

export function location(overrides: Partial<LocationRow> = {}): LocationRow {
  return {
    id: 1,
    label: "Fast disk",
    container_path: "/media/fast",
    quota_bytes: 0,
    enabled: true,
    used_bytes: 0,
    fs_free_bytes: null,
    mounted: true,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

export const ID = "dQw4w9WgXcQ";
export const ID2 = "abcdefghijk";
export const ID3 = "ABCDEFGHIJK";
export const UC = "UC0123456789abcdefghijkl";

/** 2024-03-05T00:00:00Z */
export const UPLOADED = Date.UTC(2024, 2, 5);

export function videoRow(overrides: Partial<VideoRow> = {}): VideoRow {
  return {
    id: ID,
    channel_id: UC,
    channel_title: "Tech Channel",
    title: "A video about things",
    upload_date: UPLOADED,
    published_at: UPLOADED,
    duration_s: 245,
    type: "video",
    privacy: "public",
    gone_since: null,
    views: 12345,
    likes: 678,
    comments: 9,
    ryd_ratio: 0.975,
    caption_available: true,
    max_height: 1080,
    has_av1: true,
    sources: [{ account_id: 1, source: "liked", first_seen_at: UPLOADED + 1000 }],
    downloaded: true,
    media_size_bytes: 104857600,
    location_id: 1,
    reclaim_priority: 5,
    include: true,
    thumbnail_url: `/api/videos/${ID}/thumbnail/best?sha=abc`,
    created_at: UPLOADED,
    updated_at: UPLOADED,
    ...overrides,
  };
}

export function mediaRow(overrides: Partial<MediaRow> = {}): MediaRow {
  return {
    id: 11,
    kind: "video",
    version: 1,
    is_current: true,
    location_id: 1,
    rel_path: `ab/${ID}/v1/video.mkv`,
    size_bytes: 100000000,
    vcodec: "av01.0.08M.08",
    acodec: "opus",
    height: 1080,
    fps: 29.97,
    bitrate: 2000000,
    lang: null,
    downloaded_at: UPLOADED + 5000,
    transcoded_from: null,
    ...overrides,
  };
}

export function videoDetail(overrides: Partial<VideoDetail> = {}): VideoDetail {
  return {
    ...videoRow(),
    description: "Line one\nLine two",
    tags: ["science", "math"],
    category_id: "28",
    default_language: "en",
    formats: {
      max_height: 2160,
      max_fps: 60,
      has_av1: true,
      has_vp9: true,
      has_h264: false,
      is_hdr: false,
    },
    live_status: null,
    last_recheck_at: Date.now() - 3_600_000,
    next_recheck_at: Date.now() + 86_400_000,
    recheck_tier: "weekly",
    consecutive_recheck_failures: 0,
    effective: {
      values: { reclaim_priority: 5 },
      provenance: { reclaim_priority: 7 },
      matched_rule_ids: [1, 7],
      evaluated_at: UPLOADED,
      next_eval_at: null,
    },
    overrides: null,
    media: [
      mediaRow(),
      mediaRow({
        id: 12,
        kind: "audio",
        rel_path: `ab/${ID}/v1/audio.m4a`,
        vcodec: null,
        acodec: "mp4a.40.2",
        height: null,
        fps: null,
        size_bytes: 4000000,
      }),
      mediaRow({
        id: 13,
        kind: "captions",
        rel_path: `ab/${ID}/captions/en.vtt`,
        vcodec: null,
        acodec: null,
        height: null,
        fps: null,
        lang: "en",
        size_bytes: 2000,
        location_id: null,
      }),
      mediaRow({
        id: 14,
        kind: "captions",
        rel_path: `ab/${ID}/captions/de.vtt`,
        vcodec: null,
        acodec: null,
        height: null,
        fps: null,
        lang: "de",
        size_bytes: 1900,
        location_id: null,
      }),
      mediaRow({
        id: 10,
        version: 0,
        is_current: false,
        rel_path: `ab/${ID}/v0/video.mp4`,
        vcodec: "avc1",
        transcoded_from: null,
        height: 720,
        fps: null,
        downloaded_at: null,
      }),
    ],
    captions: [
      { lang: "de", media_id: 14 },
      { lang: "en", media_id: 13 },
    ],
    thumbnails: [],
    share_links: [],
    previous_titles: [],
    ...overrides,
  };
}

export function listPage<T = VideoRow>(rows: T[], total = rows.length, page = 1, perPage = 50) {
  return { rows, total, page, perPage };
}

export function change(overrides: Partial<VideoChangeRow> = {}): VideoChangeRow {
  return {
    id: 1,
    field: "title",
    old: "Old title",
    new: "New title",
    seen_at: Date.now() - 2 * 3_600_000,
    recheck_id: 3,
    ...overrides,
  };
}

export function point(at: number, views: number | null, likes = 1, comments = 0): VideoStatsPoint {
  return { at, views, likes, comments, ryd_dislikes: null };
}

/** An id that is 11 valid characters, numbered so a test can make many. */
export function idFor(index: number): string {
  return `vid${String(index).padStart(8, "0")}`;
}

export function shareRow(overrides: Partial<ShareLinkRow> = {}): ShareLinkRow {
  return {
    token: "tok_aaaaaaaaaaaaaaaaaaaa",
    video_id: ID,
    title: "A video about things",
    channel_title: "Tech Channel",
    expires_at: null,
    revoked_at: null,
    access_count: 3,
    last_access_at: Date.now() - 60_000,
    created_at: Date.now() - 3_600_000,
    url: "https://cellar.test/s/tok_aaaaaaaaaaaaaaaaaaaa",
    status: "active",
    ...overrides,
  };
}
