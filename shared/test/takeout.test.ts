import { describe, expect, it } from "vitest";
import {
  classifyTakeoutFile,
  parsePlaylistCsv,
  parseSubscriptionsCsv,
  parseTakeoutTimestamp,
  parseWatchHistoryJson,
  TakeoutParseError,
  type TakeoutFileKind,
} from "../src/takeout.ts";

// Synthetic fixtures only: well-known public videos and channels.
const RICK = "dQw4w9WgXcQ";
const ZOO = "jNQXAC9IVRw";
const GANGNAM = "9bZkp7q19f0";
const RICK_CHANNEL = "UCuAXFkgsw1L7xaCfnd5JJOw";
const VERITASIUM = "UCHnyfMqiRRG1u-2MsSQLbXA";
const THREE_B1B = "UCYO_jab_esuFRV4b17AJtAw";

describe("parseTakeoutTimestamp", () => {
  const cases: [string, unknown, number | null][] = [
    ["ISO with millis and Z", "2023-01-02T03:04:05.678Z", Date.UTC(2023, 0, 2, 3, 4, 5, 678)],
    ["ISO without millis", "2023-01-02T03:04:05Z", Date.UTC(2023, 0, 2, 3, 4, 5)],
    ["ISO with offset", "2023-01-02T03:04:05+02:00", Date.UTC(2023, 0, 2, 1, 4, 5)],
    ["ISO with compact offset", "2023-01-02T03:04:05-0130", Date.UTC(2023, 0, 2, 4, 34, 5)],
    [
      "microseconds are truncated",
      "2023-01-02T03:04:05.123456Z",
      Date.UTC(2023, 0, 2, 3, 4, 5, 123),
    ],
    ["older UTC form", "2020-05-06 07:08:09 UTC", Date.UTC(2020, 4, 6, 7, 8, 9)],
    ["no zone means UTC", "2020-05-06 07:08:09", Date.UTC(2020, 4, 6, 7, 8, 9)],
    ["surrounding whitespace", "  2020-05-06T07:08:09Z ", Date.UTC(2020, 4, 6, 7, 8, 9)],
    ["junk that Date.parse would accept", "1", null],
    ["date only", "2020-05-06", null],
    ["impossible date", "2020-13-45T00:00:00Z", null],
    ["empty", "", null],
    ["not a string", 1_600_000_000_000, null],
    ["undefined", undefined, null],
  ];
  it.each(cases)("%s", (_name, input, expected) => {
    expect(parseTakeoutTimestamp(input)).toBe(expected);
  });
});

describe("parseWatchHistoryJson", () => {
  // Raw string so the fixture keeps Takeout's real `=` escape for `=`.
  const fixture = String.raw`[
    {
      "header": "YouTube",
      "title": "Watched Rick Astley - Never Gonna Give You Up (Official Music Video)",
      "titleUrl": "https://www.youtube.com/watch?v\u003d${RICK}",
      "subtitles": [{"name": "Rick Astley", "url": "https://www.youtube.com/channel/${RICK_CHANNEL}"}],
      "time": "2024-03-01T10:00:00.123Z",
      "products": ["YouTube"],
      "activityControls": ["YouTube watch history"]
    },
    {
      "header": "YouTube",
      "title": "Watched a video that has been removed",
      "time": "2024-02-29T10:00:00Z",
      "products": ["YouTube"]
    },
    {
      "header": "YouTube",
      "title": "Watched Some Advert",
      "titleUrl": "https://www.youtube.com/watch?v\u003d${GANGNAM}",
      "time": "2024-02-28T10:00:00Z",
      "details": [{"name": "From Google Ads"}]
    },
    {
      "header": "YouTube Music",
      "title": "Watched Me at the zoo",
      "titleUrl": "https://music.youtube.com/watch?v\u003d${ZOO}",
      "time": "2024-02-27T10:00:00Z"
    },
    {
      "header": "YouTube",
      "title": "Viewed a community post",
      "titleUrl": "https://www.youtube.com/post/UgkxSomePostId",
      "time": "2024-02-26T10:00:00Z"
    },
    {
      "header": "YouTube",
      "title": "Visited a channel",
      "titleUrl": "https://www.youtube.com/channel/${VERITASIUM}",
      "time": "2024-02-25T10:00:00Z"
    },
    {
      "header": "YouTube",
      "title": "Watched Rick again, timestamp lost",
      "titleUrl": "https://www.youtube.com/watch?v\u003d${RICK}\u0026t\u003d42s",
      "time": "yesterday"
    },
    "not an object",
    null,
    [1, 2, 3],
    {
      "header": "YouTube",
      "title": "Watched with an empty url",
      "titleUrl": "   ",
      "time": "2024-02-24T10:00:00Z"
    },
    {
      "header": "YouTube",
      "title": "titleUrl is a bare id, not a URL",
      "titleUrl": "${ZOO}",
      "time": "2024-02-23T10:00:00Z"
    },
    {
      "header": "YouTube",
      "title": "Watched a short",
      "titleUrl": "https://www.youtube.com/shorts/${GANGNAM}",
      "time": "2024-02-22T10:00:00Z",
      "details": [{"name": "Something else"}]
    }
  ]`;

  it("keeps watches in file order and counts every skip by reason", () => {
    const result = parseWatchHistoryJson(fixture);
    expect(result.rows).toEqual([
      { videoId: RICK, ts: Date.UTC(2024, 2, 1, 10, 0, 0, 123) },
      { videoId: ZOO, ts: Date.UTC(2024, 1, 27, 10) },
      { videoId: RICK, ts: null },
      { videoId: GANGNAM, ts: Date.UTC(2024, 1, 22, 10) },
    ]);
    expect(result.skipped).toEqual({
      "no-url": 2,
      ad: 1,
      "not-a-video": 3,
      "malformed-entry": 3,
    });
  });

  it("checks ads before the URL so an ad with a watch URL is not a watch", () => {
    const text = JSON.stringify([
      {
        titleUrl: `https://www.youtube.com/watch?v=${RICK}`,
        time: "2024-01-01T00:00:00Z",
        details: [{ name: "Other" }, { name: "From Google Ads" }],
      },
    ]);
    expect(parseWatchHistoryJson(text)).toEqual({ rows: [], skipped: { ad: 1 } });
  });

  it("tolerates a byte order mark", () => {
    const text = "\uFEFF" + JSON.stringify([{ titleUrl: `https://youtu.be/${RICK}` }]);
    expect(parseWatchHistoryJson(text).rows).toEqual([{ videoId: RICK, ts: null }]);
  });

  it("returns empty results for an empty array", () => {
    expect(parseWatchHistoryJson("[]")).toEqual({ rows: [], skipped: {} });
  });

  it("rejects text that is not JSON or not an array", () => {
    expect(() => parseWatchHistoryJson("<html></html>")).toThrow(TakeoutParseError);
    expect(() => parseWatchHistoryJson('{"titleUrl": "x"}')).toThrow(TakeoutParseError);
    expect(() => parseWatchHistoryJson("")).toThrow(/not valid JSON/);
  });
});

describe("parsePlaylistCsv", () => {
  it("parses the current format", () => {
    const text = [
      "Video ID,Playlist Video Creation Timestamp",
      `${RICK},2024-01-02T03:04:05+00:00`,
      `${ZOO},2023-12-31T23:59:59+01:00`,
      "",
    ].join("\n");
    expect(parsePlaylistCsv(text)).toEqual({
      rows: [
        { videoId: RICK, ts: Date.UTC(2024, 0, 2, 3, 4, 5) },
        { videoId: ZOO, ts: Date.UTC(2023, 11, 31, 22, 59, 59) },
      ],
      skipped: {},
    });
  });

  it("finds the header after the older preamble, with CRLF and padded ids", () => {
    const text = [
      "Playlist ID,Add new videos to top,Playlist Visibility,Time Created,Time Updated,Title",
      "WLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx,False,Private,2015-01-01 00:00:00 UTC,,Watch later",
      "",
      "Video ID,Time Added",
      `${RICK} ,2020-05-06 07:08:09 UTC`,
      `  ${GANGNAM},not a time`,
      "",
      "",
    ].join("\r\n");
    expect(parsePlaylistCsv(text)).toEqual({
      rows: [
        { videoId: RICK, ts: Date.UTC(2020, 4, 6, 7, 8, 9) },
        { videoId: GANGNAM, ts: null },
      ],
      skipped: {},
    });
  });

  it("matches the header case-insensitively and in any column order", () => {
    const text = ["\uFEFFtime added,VIDEO ID", `2021-01-01 00:00:00 UTC,${ZOO}`].join("\n");
    expect(parsePlaylistCsv(text).rows).toEqual([{ videoId: ZOO, ts: Date.UTC(2021, 0, 1) }]);
  });

  it("yields null timestamps when there is no time column", () => {
    expect(parsePlaylistCsv(`Video ID\n${RICK}`).rows).toEqual([{ videoId: RICK, ts: null }]);
  });

  it("counts invalid ids and ignores blank rows", () => {
    const text = [
      "Video ID,Playlist Video Creation Timestamp",
      "tooshort,2024-01-01T00:00:00+00:00",
      ",2024-01-01T00:00:00+00:00",
      " , ",
      `https://youtu.be/${RICK},2024-01-01T00:00:00+00:00`,
      "abcdefghijkl,2024-01-01T00:00:00+00:00",
    ].join("\n");
    const result = parsePlaylistCsv(text);
    expect(result.rows).toEqual([{ videoId: RICK, ts: Date.UTC(2024, 0, 1) }]);
    expect(result.skipped).toEqual({ "invalid-video-id": 3 });
  });

  it("throws when there is no Video ID header", () => {
    expect(() => parsePlaylistCsv("Channel Id,Channel Url\nx,y")).toThrow(TakeoutParseError);
    expect(() => parsePlaylistCsv("")).toThrow(/Video ID/);
  });
});

describe("parseSubscriptionsCsv", () => {
  it("parses rows including quoted titles with commas, quotes and newlines", () => {
    const text = [
      "Channel Id,Channel Url,Channel Title",
      `${RICK_CHANNEL},http://www.youtube.com/channel/${RICK_CHANNEL},Rick Astley`,
      `${VERITASIUM},http://www.youtube.com/channel/${VERITASIUM},"Veritasium, ""the"" channel"`,
      `${THREE_B1B},http://www.youtube.com/channel/${THREE_B1B},"Three Blue\r\nOne Brown"`,
      "",
    ].join("\r\n");
    expect(parseSubscriptionsCsv(text)).toEqual({
      rows: [
        { channelId: RICK_CHANNEL, title: "Rick Astley" },
        { channelId: VERITASIUM, title: 'Veritasium, "the" channel' },
        { channelId: THREE_B1B, title: "Three Blue\r\nOne Brown" },
      ],
      skipped: {},
    });
  });

  it("falls back to the URL cell and counts rows with no usable id", () => {
    const text = [
      "\uFEFFChannel Id,Channel Url,Channel Title",
      `,https://www.youtube.com/channel/${VERITASIUM},From the URL`,
      "garbage,https://www.youtube.com/@veritasium,Handle only",
      "garbage,,Nothing",
      `  ${RICK_CHANNEL}  ,,  Padded  `,
    ].join("\n");
    const result = parseSubscriptionsCsv(text);
    expect(result.rows).toEqual([
      { channelId: VERITASIUM, title: "From the URL" },
      { channelId: RICK_CHANNEL, title: "Padded" },
    ]);
    expect(result.skipped).toEqual({ "invalid-channel-id": 2 });
  });

  it("tolerates missing url and title columns", () => {
    expect(parseSubscriptionsCsv(`Channel Id\n${RICK_CHANNEL}`).rows).toEqual([
      { channelId: RICK_CHANNEL, title: "" },
    ]);
  });

  it("throws when there is no Channel Id header", () => {
    expect(() => parseSubscriptionsCsv(`Video ID\n${RICK}`)).toThrow(TakeoutParseError);
  });
});

describe("classifyTakeoutFile", () => {
  const cases: [string, TakeoutFileKind | null][] = [
    ["watch-history.json", "history"],
    ["Takeout/YouTube and YouTube Music/history/watch-history.json", "history"],
    ["Takeout\\YouTube and YouTube Music\\history\\Watch-History.JSON", "history"],
    ["watch-history.html", null],
    ["search-history.json", null],
    ["subscriptions.csv", "subscription"],
    ["Takeout/YouTube and YouTube Music/subscriptions/subscriptions.csv", "subscription"],
    ["Watch later-videos.csv", "watch_later"],
    ["Watch later.csv", "watch_later"],
    ["Takeout/YouTube and YouTube Music/playlists/Watch later-videos.csv", "watch_later"],
    ["WATCH LATER-VIDEOS.CSV", "watch_later"],
    ["Liked videos.csv", "liked"],
    ["Liked videos-videos.csv", "liked"],
    ["Takeout/YouTube and YouTube Music/playlists/Road trip-videos.csv", "playlist:Road trip"],
    ["Takeout/YouTube and YouTube Music/playlists/Old style.csv", "playlist:Old style"],
    ["Road trip-videos.csv", "playlist:Road trip"],
    ["Chill mix.csv", "playlist:Chill mix"],
    ["Takeout/YouTube and YouTube Music/playlists/playlists.csv", null],
    ["playlists.csv", null],
    ["comments.csv", null],
    ["channel.csv", null],
    ["Takeout/YouTube and YouTube Music/comments/comments.csv", null],
    ["Takeout/YouTube and YouTube Music/channels/channel.csv", null],
    ["Takeout/YouTube and YouTube Music/video metadata/videos.csv", null],
    ["Takeout/YouTube and YouTube Music/music (library and uploads)/music library songs.csv", null],
    ["Takeout/YouTube and YouTube Music/playlists/-videos.csv", null],
    ["notes.txt", null],
    ["", null],
  ];
  it.each(cases)("%s -> %s", (name, expected) => {
    expect(classifyTakeoutFile(name)).toBe(expected);
  });
});
