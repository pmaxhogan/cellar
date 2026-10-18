import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("./fixtures/", import.meta.url));

/** Parse a fixture; throws (failing the test) when it is missing or not valid JSON. */
function load<T>(rel: string): T {
  return JSON.parse(readFileSync(join(root, rel), "utf8")) as T;
}

interface Thumb {
  url: string;
  width: number;
  height: number;
}
interface VideoItem {
  id: string;
  snippet: { channelId: string; liveBroadcastContent: string; thumbnails: Record<string, Thumb> };
  contentDetails: { duration: string };
  statistics: Record<string, string>;
  status: { privacyStatus: string };
  liveStreamingDetails?: { scheduledStartTime: string };
}
interface ListResponse<T> {
  kind: string;
  items: T[];
  nextPageToken?: string;
  prevPageToken?: string;
  pageInfo: { totalResults: number; resultsPerPage: number };
}
interface PlaylistItem {
  snippet: { playlistId: string; publishedAt: string; resourceId: { videoId: string } };
  contentDetails: { videoId: string };
}

describe("every fixture file", () => {
  it("is ASCII-only valid JSON", () => {
    for (const dir of ["youtube", "ytdlp"]) {
      const files = readdirSync(join(root, dir)).filter((f) => f.endsWith(".json"));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const text = readFileSync(join(root, dir, file), "utf8");
        expect(() => JSON.parse(text), `${dir}/${file}`).not.toThrow();
        // eslint-disable-next-line no-control-regex
        expect(/^[\x00-\x7f]*$/.test(text), `${dir}/${file} is ASCII`).toBe(true);
      }
    }
  });
});

describe("youtube fixtures", () => {
  it("videos.list has three ids: public, unlisted and an upcoming premiere", () => {
    const res = load<ListResponse<VideoItem>>("youtube/videos.list.json");
    expect(res.kind).toBe("youtube#videoListResponse");
    expect(res.items.map((i) => i.id)).toEqual(["dQw4w9WgXcQ", "jNQXAC9IVRw", "aircAruvnKk"]);
    expect(res.pageInfo).toEqual({ totalResults: 3, resultsPerPage: 3 });
    expect(res.items.map((i) => i.status.privacyStatus)).toEqual(["public", "unlisted", "public"]);
    const premiere = res.items[2];
    expect(premiere?.snippet.liveBroadcastContent).toBe("upcoming");
    expect(premiere?.liveStreamingDetails?.scheduledStartTime).toBe("2026-11-02T15:00:00Z");
    expect(res.items[0]?.contentDetails.duration).toBe("PT3M33S");
    // The API returns counters as strings.
    expect(res.items[0]?.statistics.viewCount).toMatch(/^\d+$/);
    expect(res.items[0]?.snippet.channelId).toBe("UCuAXFkgsw1L7xaCfnd5JJOw");
    expect(res.items[1]?.snippet.channelId).toBe("UC4QobU6STFB0P71PMvOGN5A");
  });

  it("videos.list.missing returns two of three requested ids", () => {
    const res = load<ListResponse<VideoItem>>("youtube/videos.list.missing.json");
    expect(res.items.map((i) => i.id)).toEqual(["dQw4w9WgXcQ", "jNQXAC9IVRw"]);
    expect(res.pageInfo.totalResults).toBe(2);
  });

  it("playlistItems.list.LL is two pages linked by nextPageToken", () => {
    const pages = load<ListResponse<PlaylistItem>[]>("youtube/playlistItems.list.LL.json");
    expect(pages).toHaveLength(2);
    expect(pages[0]?.nextPageToken).toBeTruthy();
    expect(pages[0]?.prevPageToken).toBeUndefined();
    expect(pages[1]?.nextPageToken).toBeUndefined();
    expect(pages[1]?.prevPageToken).toBeTruthy();
    const items = pages.flatMap((p) => p.items);
    expect(items).toHaveLength(5);
    expect(items.every((i) => i.snippet.playlistId === "LL")).toBe(true);
    expect(items.every((i) => i.snippet.resourceId.videoId === i.contentDetails.videoId)).toBe(
      true,
    );
    // snippet.publishedAt is the like time and the list is newest first.
    const times = items.map((i) => Date.parse(i.snippet.publishedAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("playlistItems.list.UU is a channel uploads page", () => {
    const res = load<ListResponse<PlaylistItem>>("youtube/playlistItems.list.UU.json");
    expect(res.kind).toBe("youtube#playlistItemListResponse");
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.items.every((i) => i.snippet.playlistId === "UUYO_jab_esuFRV4b17AJtAw")).toBe(true);
  });

  it("subscriptions.list has two subscriptions with subscribe dates", () => {
    const res = load<
      ListResponse<{
        snippet: { publishedAt: string; resourceId: { channelId: string } };
      }>
    >("youtube/subscriptions.list.json");
    expect(res.items.map((i) => i.snippet.resourceId.channelId)).toEqual([
      "UCYO_jab_esuFRV4b17AJtAw",
      "UCHnyfMqiRRG1u-2MsSQLbXA",
    ]);
    for (const item of res.items) expect(Date.parse(item.snippet.publishedAt)).not.toBeNaN();
  });

  it("channels.list.mine names the likes and uploads playlists", () => {
    const res = load<
      ListResponse<{
        id: string;
        contentDetails: { relatedPlaylists: { likes: string; uploads: string } };
      }>
    >("youtube/channels.list.mine.json");
    expect(res.items).toHaveLength(1);
    expect(res.items[0]?.contentDetails.relatedPlaylists.likes).toBe("LL");
    expect(res.items[0]?.contentDetails.relatedPlaylists.uploads).toBe(
      `UU${res.items[0]?.id.slice(2)}`,
    );
  });

  it("error fixtures carry the API error envelope", () => {
    const quota = load<{ error: { code: number; errors: { reason: string; domain: string }[] } }>(
      "youtube/error.quotaExceeded.json",
    );
    expect(quota.error.code).toBe(403);
    expect(quota.error.errors[0]).toMatchObject({
      reason: "quotaExceeded",
      domain: "youtube.quota",
    });
    const creds = load<{ error: { code: number; errors: { reason: string }[] } }>(
      "youtube/error.invalidCredentials.json",
    );
    expect(creds.error.code).toBe(401);
    expect(creds.error.errors[0]?.reason).toBe("authError");
  });

  it("ryd.votes has the Return YouTube Dislike shape", () => {
    const res = load<Record<string, unknown>>("youtube/ryd.votes.json");
    expect(res).toMatchObject({ id: "dQw4w9WgXcQ", deleted: false });
    for (const key of ["likes", "dislikes", "rating", "viewCount", "dateCreated"]) {
      expect(res).toHaveProperty(key);
    }
  });
});

describe("yt-dlp fixtures", () => {
  interface FlatPlaylist {
    _type: string;
    id: string;
    entries: { id: string; title: string; ie_key: string; duration: number | null }[];
  }

  it("history.flat has five entries including a private video", () => {
    const res = load<FlatPlaylist>("ytdlp/history.flat.json");
    expect(res._type).toBe("playlist");
    expect(res.id).toBe("history");
    expect(res.entries).toHaveLength(5);
    expect(res.entries.every((e) => e.id.length === 11 && e.ie_key === "Youtube")).toBe(true);
    const priv = res.entries.find((e) => e.title === "[Private video]");
    expect(priv?.duration).toBeNull();
  });

  it("watchlater.flat is the WL playlist", () => {
    const res = load<FlatPlaylist>("ytdlp/watchlater.flat.json");
    expect(res.id).toBe("WL");
    expect(res.entries.length).toBeGreaterThan(0);
  });

  it("info.full has a realistic formats array and caption/thumbnail maps", () => {
    const info = load<{
      id: string;
      live_status: string;
      availability: string;
      formats: { vcodec: string; acodec: string; height: number | null; ext: string }[];
      subtitles: Record<string, unknown[]>;
      automatic_captions: Record<string, unknown[]>;
      thumbnails: { url: string; id: string }[];
    }>("ytdlp/info.full.json");
    expect(info).toMatchObject({
      id: "dQw4w9WgXcQ",
      live_status: "not_live",
      availability: "public",
    });
    const videos = info.formats.filter((f) => f.vcodec !== "none" && f.height);
    for (const prefix of ["av01", "vp09", "avc1"]) {
      for (const height of [720, 1080]) {
        expect(
          videos.some((f) => f.vcodec.startsWith(prefix) && f.height === height),
          `${prefix} ${height}p`,
        ).toBe(true);
      }
    }
    const audio = info.formats.filter((f) => f.vcodec === "none" && f.acodec !== "none");
    expect(audio.some((f) => f.acodec === "opus")).toBe(true);
    expect(audio.some((f) => f.acodec.startsWith("mp4a") && f.ext === "m4a")).toBe(true);
    expect(info.subtitles).toHaveProperty("en");
    expect(info.automatic_captions).toHaveProperty("en");
    expect(info.thumbnails.map((t) => t.url.split("/").pop())).toEqual([
      "default.jpg",
      "mqdefault.jpg",
      "hqdefault.jpg",
      "sddefault.jpg",
      "hq720.jpg",
      "maxresdefault.jpg",
    ]);
  });
});
