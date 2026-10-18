import {
  VideoDetailSchema,
  VideoHistoryQuerySchema,
  VideosListQuerySchema,
  VideosListResponseSchema,
  VideoStatsQuerySchema,
  type VideosListQueryInput,
} from "@cellar/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.ts";
import { DomainError } from "../src/domain/errors.ts";
import {
  applyVideoDiff,
  buildFtsQuery,
  diffVideo,
  ensureVideo,
  getVideo,
  listVideos,
  splitSearchTerms,
  statsFromChanges,
  upsertVideoFromApi,
  videoHistory,
  videoStats,
  type StoredVideo,
} from "../src/domain/videos.ts";
import { createTempDb, type TempDb } from "./helpers.ts";
import {
  DAY,
  seedAccount,
  seedChannel,
  seedEffective,
  seedLocation,
  seedMedia,
  seedSource,
  seedThumbnail,
  seedVideo,
  T0,
  vid,
} from "./videoSeed.ts";

const CAFE = `Caf${String.fromCodePoint(0xe9)} racer`;
const TOKYO = String.fromCodePoint(0x6771, 0x4eac);

let temp: TempDb;
let db: Db;

function list(input: VideosListQueryInput = {}) {
  const page = listVideos(db, VideosListQuerySchema.parse(input));
  VideosListResponseSchema.parse(page);
  return page;
}

function ids(input: VideosListQueryInput = {}): string[] {
  return list(input).rows.map((row) => row.id);
}

/** A small catalog with one property per video that the filters can tell apart. */
function seedCatalog(): { acct1: number; acct2: number; loc: number } {
  const acct1 = seedAccount(db, "main");
  const acct2 = seedAccount(db, "alt");
  const loc = seedLocation(db, "big", "/mnt/big");
  seedChannel(db, "UCveritasium0000000000000", "Veritasium");
  seedChannel(db, "UC3blue1brown000000000000", "3Blue1Brown");
  seedVideo(db, {
    id: vid("a"),
    channel_id: "UCveritasium0000000000000",
    title: "Why gravity is not a force",
    description: "A video about general relativity",
    upload_date: T0 + 5 * DAY,
    duration_s: 900,
    type: "video",
    privacy: "public",
    views: 1000,
    likes: 50,
    tags_json: JSON.stringify(["physics", "relativity"]),
    last_recheck_at: T0 + 9 * DAY,
  });
  seedVideo(db, {
    id: vid("b"),
    channel_id: "UC3blue1brown000000000000",
    title: "but what is a neural network",
    description: "Deep learning, chapter one, gravity mentioned once",
    upload_date: T0 + 2 * DAY,
    duration_s: 1140,
    type: "video",
    privacy: "unlisted",
    views: 5000,
    likes: 300,
    last_recheck_at: T0 + DAY,
  });
  seedVideo(db, {
    id: vid("c"),
    channel_id: "UCveritasium0000000000000",
    title: CAFE,
    upload_date: T0 + 8 * DAY,
    duration_s: 45,
    type: "short",
    privacy: "private",
    gone_since: T0 + 9 * DAY,
    views: 10,
  });
  seedVideo(db, {
    id: vid("d"),
    title: TOKYO,
    upload_date: null,
    duration_s: 7200,
    type: "livestream",
    privacy: "removed",
    gone_since: T0 + 3 * DAY,
  });
  seedVideo(db, {
    id: vid("e"),
    title: "Apple pie",
    upload_date: T0 + DAY,
    duration_s: 300,
    type: "premiere",
    privacy: "public",
    gone_since: T0 + 4 * DAY,
    views: 7,
  });
  seedSource(db, vid("a"), "liked", acct1, T0 + 6 * DAY);
  seedSource(db, vid("a"), "history", acct2, T0 + 7 * DAY);
  seedSource(db, vid("b"), "watch_later", acct1, T0 + 3 * DAY);
  seedSource(db, vid("c"), "subscription", acct2, T0 + 9 * DAY);
  seedSource(db, vid("d"), "channel", null, T0 + 4 * DAY);
  seedMedia(db, { video_id: vid("a"), kind: "video", rel_path: "x/a.webm", size_bytes: 500 });
  seedMedia(db, { video_id: vid("a"), kind: "captions", rel_path: "x/en.vtt", size_bytes: 9 });
  seedMedia(db, {
    video_id: vid("b"),
    kind: "audio",
    rel_path: "x/b.m4a",
    size_bytes: 200,
    location_id: loc,
  });
  seedMedia(db, {
    video_id: vid("c"),
    kind: "video",
    rel_path: "x/c.old.webm",
    size_bytes: 999,
    is_current: 0,
  });
  seedEffective(db, vid("a"), { reclaim_priority: -1, location_id: 1 });
  seedEffective(db, vid("b"), { reclaim_priority: 3, location_id: 1 });
  seedEffective(db, vid("c"), { reclaim_priority: 0, location_id: loc, include: false });
  return { acct1, acct2, loc };
}

beforeEach(() => {
  temp = createTempDb();
  db = temp.db;
});

afterEach(() => {
  temp.close();
});

describe("buildFtsQuery", () => {
  it("quotes every term and prefix matches the last", () => {
    expect(buildFtsQuery("neural network")).toBe('"neural" "network"*');
    expect(buildFtsQuery("  grav  ")).toBe('"grav"*');
  });

  it("drops operators, quotes and terms without letters or digits", () => {
    expect(buildFtsQuery('"a" OR b*')).toBe('"a" "b*"*');
    expect(buildFtsQuery("x AND y NOT z NEAR w")).toBe('"x" "y" "z" "w"*');
    expect(buildFtsQuery('* ^ - "" ()')).toBeNull();
    expect(buildFtsQuery("")).toBeNull();
    expect(buildFtsQuery('say "hi" there')).toBe('"say" "hi" "there"*');
  });

  it("keeps lower case words that only look like operators", () => {
    expect(buildFtsQuery("rock and roll")).toBe('"rock" "and" "roll"*');
  });

  it("never produces a query FTS5 rejects", () => {
    seedVideo(db, { id: vid("f"), title: "fuzz target" });
    const alphabet = [
      '"',
      "*",
      "^",
      "(",
      ")",
      ":",
      "+",
      "-",
      "{",
      "}",
      "a",
      "OR",
      " ",
      "NEAR",
      "1",
    ];
    let seed = 7;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let round = 0; round < 300; round++) {
      let input = "";
      const length = 1 + (next() % 8);
      for (let i = 0; i < length; i++) {
        input += alphabet[next() % alphabet.length] ?? "";
      }
      expect(() => listVideos(db, VideosListQuerySchema.parse({ q: input })), input).not.toThrow();
    }
  });

  it("keeps unicode terms", () => {
    expect(buildFtsQuery(TOKYO)).toBe(`"${TOKYO}"*`);
  });
});

describe("splitSearchTerms", () => {
  const UC = "UCxyz0123456789abcdefghi";

  it("pulls whole channel ids out of the text, once each", () => {
    expect(splitSearchTerms(`gravity ${UC}  "${UC}" waves`)).toEqual({
      channelIds: [UC],
      text: "gravity waves",
    });
    expect(splitSearchTerms("  ")).toEqual({ channelIds: [], text: "" });
  });

  it("leaves partial or malformed ids to full text search", () => {
    expect(splitSearchTerms("UCxyz UCxyz0123456789abcdefghij")).toEqual({
      channelIds: [],
      text: "UCxyz UCxyz0123456789abcdefghij",
    });
  });
});

describe("listVideos", () => {
  beforeEach(() => {
    seedCatalog();
  });

  it("sorts by upload date, newest first, nulls last, by default", () => {
    const page = list();
    expect(page.total).toBe(5);
    expect(page.page).toBe(1);
    expect(page.perPage).toBe(50);
    expect(page.rows.map((row) => row.id)).toEqual([
      vid("c"),
      vid("a"),
      vid("b"),
      vid("e"),
      vid("d"),
    ]);
    expect(ids({ dir: "asc" })).toEqual([vid("e"), vid("b"), vid("a"), vid("c"), vid("d")]);
  });

  it("pages", () => {
    const page = list({ perPage: "25", page: "1" });
    expect(page.rows).toHaveLength(5);
    const second = list({ perPage: "25", page: "2" });
    expect(second.rows).toHaveLength(0);
    expect(second.total).toBe(5);
    expect(() => VideosListQuerySchema.parse({ perPage: "30" })).toThrow();
    expect(() => VideosListQuerySchema.parse({ perPage: "500" })).toThrow();
  });

  it("supports every sort key", () => {
    expect(ids({ sort: "title", dir: "asc" })).toEqual([
      vid("e"),
      vid("b"),
      vid("c"),
      vid("a"),
      vid("d"),
    ]);
    expect(ids({ sort: "views", dir: "desc" })).toEqual([
      vid("b"),
      vid("a"),
      vid("c"),
      vid("e"),
      vid("d"),
    ]);
    expect(ids({ sort: "likes", dir: "asc" }).slice(0, 2)).toEqual([vid("a"), vid("b")]);
    expect(ids({ sort: "duration_s", dir: "asc" })).toEqual([
      vid("c"),
      vid("e"),
      vid("a"),
      vid("b"),
      vid("d"),
    ]);
    expect(ids({ sort: "size", dir: "desc" }).slice(0, 2)).toEqual([vid("a"), vid("b")]);
    expect(ids({ sort: "reclaim_priority", dir: "asc" }).slice(0, 3)).toEqual([
      vid("a"),
      vid("c"),
      vid("b"),
    ]);
    expect(ids({ sort: "last_recheck", dir: "desc" }).slice(0, 2)).toEqual([vid("a"), vid("b")]);
    // first_seen falls back to created_at (T0) for videos without a source.
    expect(ids({ sort: "first_seen", dir: "desc" })).toEqual([
      vid("c"),
      vid("a"),
      vid("d"),
      vid("b"),
      vid("e"),
    ]);
  });

  it("filters by source and account", () => {
    const { acct1, acct2 } = seedCatalogIds();
    expect(ids({ source: "liked" })).toEqual([vid("a")]);
    expect(ids({ source: ["liked", "watch_later"] })).toEqual([vid("a"), vid("b")]);
    expect(ids({ source: "liked,watch_later" })).toEqual([vid("a"), vid("b")]);
    expect(ids({ account_id: String(acct1) })).toEqual([vid("a"), vid("b")]);
    expect(ids({ account_id: String(acct2), source: "liked" })).toEqual([]);
    expect(ids({ account_id: String(acct2), source: "history" })).toEqual([vid("a")]);
    expect(() => VideosListQuerySchema.parse({ source: "nope" })).toThrow();
  });

  it("filters by channel, type, duration and upload date", () => {
    expect(ids({ channel_id: "UCveritasium0000000000000" })).toEqual([vid("c"), vid("a")]);
    expect(ids({ type: "short" })).toEqual([vid("c")]);
    expect(ids({ type: ["livestream", "premiere"] })).toEqual([vid("e"), vid("d")]);
    expect(ids({ min_duration: "300", max_duration: "1000" })).toEqual([vid("a"), vid("e")]);
    expect(ids({ date_from: String(T0 + 2 * DAY), date_to: String(T0 + 5 * DAY) })).toEqual([
      vid("a"),
      vid("b"),
    ]);
    // A bare date_to covers that whole day.
    expect(ids({ date_from: "2026-01-03", date_to: "2026-01-06" })).toEqual([vid("a"), vid("b")]);
    expect(() => VideosListQuerySchema.parse({ date_from: "yesterday" })).toThrow();
  });

  it("filters by status the way the rule engine derives it", () => {
    expect(ids({ status: "public" })).toEqual([vid("a")]);
    expect(ids({ status: "unlisted" })).toEqual([vid("b")]);
    expect(ids({ status: "gone" })).toEqual([vid("c"), vid("e"), vid("d")]);
    expect(ids({ status: "private" })).toEqual([vid("c")]);
    expect(ids({ status: "removed" })).toEqual([vid("d")]);
    expect(ids({ status: ["public", "unlisted"] })).toEqual([vid("a"), vid("b")]);
  });

  it("filters by downloaded, location and reclaim priority", () => {
    expect(ids({ downloaded: "true" })).toEqual([vid("a"), vid("b")]);
    expect(ids({ downloaded: "0" })).toEqual([vid("c"), vid("e"), vid("d")]);
    // b's audio lives on the "big" location; c is not downloaded but its rules want "big".
    expect(ids({ location_id: "2" })).toEqual([vid("c"), vid("b")]);
    expect(ids({ location_id: "1" })).toEqual([vid("a")]);
    expect(ids({ pri: "-1" })).toEqual([vid("a")]);
    expect(ids({ pri: "0" })).toEqual([vid("c")]);
    expect(ids({ pri: "positive" })).toEqual([vid("b")]);
    expect(() => VideosListQuerySchema.parse({ downloaded: "yes" })).toThrow();
  });

  it("assembles rows: sources, media size, effective trio and thumbnails", () => {
    seedThumbnail(db, vid("a"), "hqdefault", "h1", "t/a-h1.jpg", T0);
    seedThumbnail(db, vid("a"), "maxresdefault", "m1", "t/a-m1.jpg", T0);
    seedThumbnail(db, vid("a"), "maxresdefault", "m2", "t/a-m2.jpg", T0 + DAY);
    seedThumbnail(db, vid("b"), "custom", "z1", "t/b-z1.jpg", T0);
    const rows = list({ sort: "title", dir: "desc" }).rows;
    const a = rows.find((row) => row.id === vid("a"));
    const b = rows.find((row) => row.id === vid("b"));
    const c = rows.find((row) => row.id === vid("c"));
    const d = rows.find((row) => row.id === vid("d"));
    expect(a).toMatchObject({
      channel_title: "Veritasium",
      downloaded: true,
      media_size_bytes: 500,
      location_id: 1,
      reclaim_priority: -1,
      include: true,
      thumbnail_url: `/api/videos/${vid("a")}/thumbnail/maxresdefault?sha=m2`,
    });
    expect(a?.sources.map((s) => s.source)).toEqual(["liked", "history"]);
    seedSource(db, vid("e"), "watch_later", null, T0);
    seedSource(db, vid("e"), "liked", null, T0);
    const e = list({ q: "apple" }).rows[0];
    // Same instant: ordered by source name.
    expect(e?.sources.map((s) => s.source)).toEqual(["liked", "watch_later"]);
    // An unknown variant is still better than nothing.
    expect(b?.thumbnail_url).toBe(`/api/videos/${vid("b")}/thumbnail/custom?sha=z1`);
    expect(b?.location_id).toBe(2);
    expect(c).toMatchObject({ downloaded: false, media_size_bytes: 0, include: false });
    expect(d).toMatchObject({
      channel_title: null,
      reclaim_priority: null,
      include: null,
      location_id: null,
      thumbnail_url: null,
    });
    expect(d?.sources).toEqual([
      { account_id: null, source: "channel", first_seen_at: T0 + 4 * DAY },
    ]);
  });

  it("searches title, description, channel title and tags with bm25 ranking", () => {
    // Title hit (a) outranks a description hit (b).
    expect(ids({ q: "gravity" })).toEqual([vid("a"), vid("b")]);
    expect(ids({ q: "relativ" })).toEqual([vid("a")]);
    expect(ids({ q: "physics" })).toEqual([vid("a")]);
    expect(ids({ q: "3blue1brown" })).toEqual([vid("b")]);
    expect(ids({ q: "neural netw" })).toEqual([vid("b")]);
    // An explicit sort wins over relevance.
    expect(ids({ q: "gravity", sort: "views" })).toEqual([vid("b"), vid("a")]);
    expect(list({ q: "gravity" }).total).toBe(2);
  });

  it("matches unicode titles and folds diacritics", () => {
    expect(ids({ q: "cafe" })).toEqual([vid("c")]);
    expect(ids({ q: CAFE })).toEqual([vid("c")]);
    expect(ids({ q: TOKYO })).toEqual([vid("d")]);
  });

  it("treats FTS operators in the query as text", () => {
    // Both quoted terms must match: b has "neural" in its title and "gravity" in its description.
    expect(ids({ q: '"gravity" OR neural*' })).toEqual([vid("b")]);
    expect(ids({ q: "gravity OR" })).toEqual([vid("a"), vid("b")]);
    // Not a column filter: the phrase "title gravity" appears nowhere.
    expect(ids({ q: "title:gravity" })).toEqual([]);
    expect(ids({ q: 'NEAR(gravity "x' })).toEqual([]);
    expect(ids({ q: "-gravity ^force" })).toEqual([vid("a")]);
    // Nothing searchable left: no FTS clause at all.
    expect(list({ q: '* "" ()' }).total).toBe(5);
    expect(list({ q: "" }).total).toBe(5);
  });

  it("keeps the index in sync when a title changes", () => {
    applyVideoDiff(db, vid("e"), { title: "Banana bread" }, { seenAt: T0 + 20 * DAY });
    expect(ids({ q: "apple" })).toEqual([]);
    expect(ids({ q: "banana" })).toEqual([vid("e")]);
  });

  it("combines search with filters", () => {
    expect(ids({ q: "gravity", status: "unlisted" })).toEqual([vid("b")]);
    expect(ids({ q: "gravity", downloaded: "true", source: "liked" })).toEqual([vid("a")]);
  });

  it("matches a channel id typed into the search box", () => {
    const UC = "UCxyz0123456789abcdefghi";
    const OTHER = "UCzzz0123456789abcdefghi";
    seedChannel(db, UC, "Minute Physics");
    seedChannel(db, OTHER, "Other");
    seedVideo(db, {
      id: vid("f"),
      channel_id: UC,
      title: "Gravity explained",
      upload_date: T0 + 6 * DAY,
    });
    seedVideo(db, {
      id: vid("g"),
      channel_id: UC,
      title: "Light speed",
      upload_date: T0 + 7 * DAY,
    });
    seedVideo(db, { id: vid("h"), channel_id: OTHER, title: "Gravity", upload_date: T0 + 9 * DAY });
    // A bare id lists the channel in the default upload_date order (no bm25).
    expect(ids({ q: UC })).toEqual([vid("g"), vid("f")]);
    expect(ids({ q: ` "${UC}" `, dir: "asc" })).toEqual([vid("f"), vid("g")]);
    // With words, the id narrows the full text search.
    expect(ids({ q: `gravity ${UC}` })).toEqual([vid("f")]);
    expect(ids({ q: `${UC} light` })).toEqual([vid("g")]);
    // Several ids are alternatives.
    expect(ids({ q: `${UC} ${OTHER} gravity` }).sort()).toEqual([vid("f"), vid("h")].sort());
    // It composes with the channel_id filter and other filters.
    expect(ids({ q: UC, channel_id: UC })).toEqual([vid("g"), vid("f")]);
    expect(ids({ q: UC, channel_id: OTHER })).toEqual([]);
    expect(ids({ q: UC, min_duration: "1" })).toEqual([]);
    // An id nothing belongs to matches nothing.
    expect(list({ q: "UCnobody0123456789abcdef" }).total).toBe(0);
  });
});

/** The account ids seedCatalog created (autoincrement from 1). */
function seedCatalogIds(): { acct1: number; acct2: number } {
  const rows = db.all<{ id: number }>("SELECT id FROM accounts ORDER BY id");
  return { acct1: rows[0]?.id ?? 0, acct2: rows[1]?.id ?? 0 };
}

describe("getVideo", () => {
  it("returns the detail with media, captions, thumbnails, shares, effective and overrides", () => {
    seedCatalog();
    db.run(
      "UPDATE videos SET has_vp9 = 1, has_h264 = 0, is_hdr = 0, max_fps = 60, max_height = 2160 WHERE id = ?",
      vid("a"),
    );
    seedMedia(db, {
      video_id: vid("a"),
      kind: "video",
      rel_path: "x/v1.webm",
      size_bytes: 400,
      version: 0,
      is_current: 0,
    });
    seedThumbnail(db, vid("a"), "hqdefault", "h1", "t/a-h1.jpg", T0);
    db.run(
      `INSERT INTO rules (kind, video_id, name, effects_json, created_at, updated_at)
       VALUES ('video', ?, 'override', '{"reclaim_priority":0}', ?, ?)`,
      vid("a"),
      T0,
      T0,
    );
    db.run(
      `INSERT INTO share_links (token, video_id, expires_at, created_at)
       VALUES ('tok1', ?, NULL, ?), ('tok2', ?, ?, ?)`,
      vid("a"),
      T0,
      vid("a"),
      T0 + DAY,
      T0 + 1,
    );
    db.run("UPDATE media SET lang = 'en' WHERE kind = 'captions'");

    const detail = VideoDetailSchema.parse(getVideo(db, vid("a")));
    expect(detail.tags).toEqual(["physics", "relativity"]);
    expect(detail.formats).toEqual({
      max_height: 2160,
      max_fps: 60,
      has_av1: null,
      has_vp9: true,
      has_h264: false,
      is_hdr: false,
    });
    expect(detail.media.map((m) => [m.kind, m.version, m.is_current])).toEqual([
      ["video", 1, true],
      ["video", 0, false],
      ["captions", 1, true],
    ]);
    expect(detail.captions).toEqual([{ lang: "en", media_id: detail.media[2]?.id }]);
    expect(detail.thumbnails).toEqual([
      {
        variant: "hqdefault",
        sha256: "h1",
        first_seen_at: T0,
        url: `/api/videos/${vid("a")}/thumbnail/hqdefault?sha=h1`,
      },
    ]);
    expect(detail.thumbnail_url).toBe(`/api/videos/${vid("a")}/thumbnail/hqdefault?sha=h1`);
    expect(detail.share_links.map((s) => s.token)).toEqual(["tok2", "tok1"]);
    expect(detail.effective).toEqual({
      values: { reclaim_priority: -1 },
      provenance: { reclaim_priority: "default" },
      matched_rule_ids: [1],
      evaluated_at: T0,
      next_eval_at: null,
    });
    expect(detail.overrides).toEqual({ reclaim_priority: 0 });
    expect(detail.consecutive_recheck_failures).toBe(0);
  });

  it("answers null effective and overrides, and tolerates malformed json", () => {
    seedVideo(db, { id: vid("z"), tags_json: "{not json" });
    const detail = getVideo(db, vid("z"));
    expect(detail.effective).toBeNull();
    expect(detail.overrides).toBeNull();
    expect(detail.tags).toEqual([]);
    expect(detail.thumbnail_url).toBeNull();

    db.run(
      `INSERT INTO video_effective (video_id, effective_json, provenance_json, matched_rule_ids,
         evaluated_at, reclaim_priority, include) VALUES (?, '[1]', 'oops', '{}', ?, 5, 1)`,
      vid("z"),
      T0,
    );
    db.run(
      `INSERT INTO rules (kind, video_id, name, effects_json, created_at, updated_at)
       VALUES ('video', ?, 'override', 'null', ?, ?)`,
      vid("z"),
      T0,
      T0,
    );
    const odd = getVideo(db, vid("z"));
    expect(odd.effective).toEqual({
      values: {},
      provenance: {},
      matched_rule_ids: [],
      evaluated_at: T0,
      next_eval_at: null,
    });
    expect(odd.overrides).toEqual({});
  });

  it("is not_found for an unknown id", () => {
    expect(() => getVideo(db, vid("nope"))).toThrow(DomainError);
  });
});

describe("history and stats", () => {
  beforeEach(() => {
    seedVideo(db, { id: vid("h"), title: "One", views: 1, likes: 1 });
  });

  it("pages the change timeline newest first and filters by field", () => {
    applyVideoDiff(db, vid("h"), { title: "Two", views: 5 }, { seenAt: T0 + DAY, recheckId: 7 });
    applyVideoDiff(db, vid("h"), { title: "Three" }, { seenAt: T0 + 2 * DAY, recheckId: 8 });
    const all = videoHistory(db, vid("h"), VideoHistoryQuerySchema.parse({}));
    expect(all.total).toBe(3);
    expect(all.rows[0]).toMatchObject({
      field: "title",
      old: "Two",
      new: "Three",
      seen_at: T0 + 2 * DAY,
      recheck_id: 8,
    });
    const titles = videoHistory(db, vid("h"), VideoHistoryQuerySchema.parse({ field: "title" }));
    expect(titles.rows.map((row) => row.new)).toEqual(["Three", "Two"]);
    const paged = videoHistory(
      db,
      vid("h"),
      VideoHistoryQuerySchema.parse({ perPage: "1", page: "2" }),
    );
    expect(paged.rows.map((row) => row.field)).toEqual(["views"]);
    expect(() => videoHistory(db, vid("x"), VideoHistoryQuerySchema.parse({}))).toThrow(
      DomainError,
    );
  });

  it("serves video_stats points within from/to", () => {
    applyVideoDiff(db, vid("h"), { views: 10 }, { seenAt: T0 + DAY });
    applyVideoDiff(db, vid("h"), { views: 20, likes: 2 }, { seenAt: T0 + 2 * DAY });
    applyVideoDiff(db, vid("h"), { views: 30 }, { seenAt: T0 + 3 * DAY });
    const all = videoStats(db, vid("h"), VideoStatsQuerySchema.parse({}));
    expect(all).toEqual([
      { at: T0 + DAY, views: 10, likes: 1, comments: null, ryd_dislikes: null },
      { at: T0 + 2 * DAY, views: 20, likes: 2, comments: null, ryd_dislikes: null },
      { at: T0 + 3 * DAY, views: 30, likes: 2, comments: null, ryd_dislikes: null },
    ]);
    const window = videoStats(
      db,
      vid("h"),
      VideoStatsQuerySchema.parse({ from: String(T0 + 2 * DAY), to: String(T0 + 2 * DAY) }),
    );
    expect(window.map((p) => p.views)).toEqual([20]);
    expect(
      videoStats(db, vid("h"), VideoStatsQuerySchema.parse({ from: String(T0 + 9 * DAY) })),
    ).toEqual([]);
    expect(() => videoStats(db, vid("x"), {})).toThrow(DomainError);
  });

  it("falls back to video_changes when video_stats is empty", () => {
    db.run(
      `INSERT INTO video_changes (video_id, field, old_json, new_json, seen_at) VALUES
        (?, 'views', '1', '10', ?), (?, 'likes', '1', '3', ?), (?, 'views', '10', '15', ?),
        (?, 'title', '"a"', '"b"', ?)`,
      vid("h"),
      T0 + DAY,
      vid("h"),
      T0 + 2 * DAY,
      vid("h"),
      T0 + 2 * DAY,
      vid("h"),
      T0 + 3 * DAY,
    );
    expect(videoStats(db, vid("h"), {})).toEqual([
      { at: T0 + DAY, views: 10, likes: 1, comments: null, ryd_dislikes: null },
      { at: T0 + 2 * DAY, views: 15, likes: 3, comments: null, ryd_dislikes: null },
    ]);
    expect(videoStats(db, vid("h"), { from: T0 + 2 * DAY })).toHaveLength(1);
  });

  it("rebuilds points from changes as a pure function", () => {
    expect(statsFromChanges([])).toEqual([]);
    expect(
      statsFromChanges([
        { field: "comments", old_json: null, new_json: "4", seen_at: 5 },
        { field: "ryd_dislikes", old_json: "2", new_json: "x", seen_at: 6 },
      ]),
    ).toEqual([
      { at: 5, views: null, likes: null, comments: 4, ryd_dislikes: 2 },
      { at: 6, views: null, likes: null, comments: 4, ryd_dislikes: null },
    ]);
  });
});

describe("ensureVideo", () => {
  it("creates a skeleton row once and fills a missing channel", () => {
    seedChannel(db, "UCchan00000000000000000000", "Chan");
    expect(ensureVideo(db, vid("new"), { now: T0 })).toBe(true);
    expect(ensureVideo(db, vid("new"), { now: T0 + 1 })).toBe(false);
    expect(db.get("SELECT channel_id, created_at FROM videos WHERE id = ?", vid("new"))).toEqual({
      channel_id: null,
      created_at: T0,
    });
    expect(ensureVideo(db, vid("new"), { channelId: "UCchan00000000000000000000" })).toBe(false);
    expect(db.get("SELECT channel_id FROM videos WHERE id = ?", vid("new"))).toEqual({
      channel_id: "UCchan00000000000000000000",
    });
    expect(ensureVideo(db, vid("new2"), { channelId: "UCchan00000000000000000000" })).toBe(true);
    expect(ensureVideo(db, vid("new3"))).toBe(true);
  });

  it("refuses something that is not a video id", () => {
    expect(() => ensureVideo(db, "short")).toThrow(DomainError);
  });
});

describe("diffVideo / applyVideoDiff", () => {
  const empty = (): StoredVideo =>
    Object.fromEntries(
      [
        "title",
        "description",
        "duration_s",
        "privacy",
        "views",
        "likes",
        "comments",
        "ryd_dislikes",
        "tags_json",
        "category_id",
        "live_status",
        "type",
        "upload_date",
        "content_signature",
        "channel_id",
        "published_at",
        "ryd_ratio",
        "default_language",
        "caption_available",
        "max_height",
        "has_av1",
        "has_vp9",
        "has_h264",
        "max_fps",
        "is_hdr",
        "formats_json",
        "gone_since",
        "consecutive_recheck_failures",
        "last_recheck_at",
        "next_recheck_at",
        "recheck_tier",
      ].map((key) => [key, null]),
    ) as StoredVideo;

  it("is pure: first observations fill, counters are always history", () => {
    const changes = diffVideo(empty(), { title: "T", views: 3, has_av1: true, max_height: 720 });
    expect(changes).toEqual([
      { field: "title", old: null, new: "T", history: false },
      { field: "views", old: null, new: 3, history: true },
      { field: "max_height", old: null, new: 720, history: false },
      { field: "has_av1", old: null, new: 1, history: false },
    ]);
  });

  it("ignores absent and unchanged keys and compares JSON canonically", () => {
    const stored = { ...empty(), title: "T", tags_json: '["a","b"]', has_av1: 1 };
    expect(
      diffVideo(stored, { title: "T", tags_json: '[ "a", "b" ]', has_av1: true, likes: undefined }),
    ).toEqual([]);
    expect(diffVideo(stored, { tags_json: '["b"]' })).toEqual([
      { field: "tags_json", old: '["a","b"]', new: '["b"]', history: true },
    ]);
    expect(diffVideo(stored, { title: null })).toEqual([
      { field: "title", old: "T", new: null, history: true },
    ]);
    expect(diffVideo(stored, { has_av1: false })).toEqual([
      { field: "has_av1", old: 1, new: 0, history: false },
    ]);
    expect(diffVideo(stored, { has_av1: 0 })).toEqual([
      { field: "has_av1", old: 1, new: 0, history: false },
    ]);
  });

  it("rejects unknown fields and bad values", () => {
    const bad = (patch: Record<string, unknown>) => () =>
      diffVideo(empty(), patch as Parameters<typeof diffVideo>[1]);
    expect(bad({ nope: 1 })).toThrow(DomainError);
    expect(bad({ tags_json: "{oops" })).toThrow(DomainError);
    expect(bad({ tags_json: 3 })).toThrow(DomainError);
    expect(bad({ has_av1: "yes" })).toThrow(DomainError);
    expect(bad({ views: Number.NaN })).toThrow(DomainError);
    expect(bad({ title: { x: 1 } })).toThrow(DomainError);
  });

  it("writes columns, history rows with the recheck id, and a stats point", () => {
    seedVideo(db, { id: vid("p"), title: "Old", views: 10, likes: 1, duration_s: 60 });
    const result = applyVideoDiff(
      db,
      vid("p"),
      {
        title: "New",
        views: 12,
        duration_s: 60,
        tags_json: '["x"]',
        content_signature: "sig1",
        ryd_ratio: 0.9,
      },
      { seenAt: T0 + DAY, recheckId: 42 },
    );
    expect(result.statsPoint).toBe(true);
    expect(result.changes.map((c) => [c.field, c.history])).toEqual([
      ["title", true],
      ["views", true],
      ["tags_json", false],
      ["content_signature", false],
      ["ryd_ratio", false],
    ]);
    expect(
      db.all(
        "SELECT field, old_json, new_json, recheck_id, seen_at FROM video_changes ORDER BY id",
      ),
    ).toEqual([
      { field: "title", old_json: '"Old"', new_json: '"New"', recheck_id: 42, seen_at: T0 + DAY },
      { field: "views", old_json: "10", new_json: "12", recheck_id: 42, seen_at: T0 + DAY },
    ]);
    expect(db.get("SELECT * FROM video_stats")).toEqual({
      video_id: vid("p"),
      at: T0 + DAY,
      views: 12,
      likes: 1,
      comments: null,
      ryd_dislikes: null,
    });
    expect(
      db.get("SELECT title, tags_json, ryd_ratio, updated_at FROM videos WHERE id = ?", vid("p")),
    ).toEqual({ title: "New", tags_json: '["x"]', ryd_ratio: 0.9, updated_at: T0 + DAY });

    // A tags change after the first observation is history, parsed back as JSON.
    applyVideoDiff(db, vid("p"), { tags_json: '["x","y"]' }, { seenAt: T0 + 2 * DAY });
    const tagsRow = videoHistory(db, vid("p"), { page: 1, perPage: 50, field: "tags_json" });
    expect(tagsRow.rows[0]).toMatchObject({ old: ["x"], new: ["x", "y"], recheck_id: null });
  });

  it("is a no-op when nothing changed, and merges a second point at the same instant", () => {
    seedVideo(db, { id: vid("q"), views: 5 });
    expect(applyVideoDiff(db, vid("q"), { views: 5 }, { seenAt: T0 })).toEqual({
      changes: [],
      statsPoint: false,
    });
    expect(db.get("SELECT updated_at FROM videos WHERE id = ?", vid("q"))).toEqual({
      updated_at: T0,
    });
    applyVideoDiff(db, vid("q"), { views: 6 }, { seenAt: T0 + 5 });
    applyVideoDiff(db, vid("q"), { likes: 2 }, { seenAt: T0 + 5 });
    expect(db.all("SELECT at, views, likes FROM video_stats")).toEqual([
      { at: T0 + 5, views: 6, likes: 2 },
    ]);
    // A non counter change writes no stats point.
    expect(applyVideoDiff(db, vid("q"), { title: "x" }, { seenAt: T0 + 9 }).statsPoint).toBe(false);
  });

  it("rolls back on a bad value and is not_found for an unknown video", () => {
    seedVideo(db, { id: vid("r"), title: "Keep" });
    expect(() =>
      applyVideoDiff(db, vid("r"), { title: "Lost", tags_json: "{" }, { seenAt: T0 }),
    ).toThrow(DomainError);
    expect(db.get("SELECT title FROM videos WHERE id = ?", vid("r"))).toEqual({ title: "Keep" });
    expect(() => applyVideoDiff(db, vid("none"), { title: "x" }, { seenAt: T0 })).toThrow(
      DomainError,
    );
  });

  it("upsertVideoFromApi creates the row and records the first observation", () => {
    seedChannel(db, "UCchan00000000000000000000", "Chan");
    const first = upsertVideoFromApi(
      db,
      vid("u"),
      { channel_id: "UCchan00000000000000000000", title: "Hello", views: 100 },
      { seenAt: T0 },
    );
    expect(first.changes.map((c) => c.field)).toEqual(["title", "views"]);
    expect(db.all("SELECT field FROM video_changes WHERE video_id = ?", vid("u"))).toEqual([
      { field: "views" },
    ]);
    expect(list0().rows[0]).toMatchObject({ id: vid("u"), channel_title: "Chan" });
    expect(ids({ q: "chan" })).toEqual([vid("u")]);

    const second = upsertVideoFromApi(db, vid("u"), { title: "Hello again" }, { recheckId: 3 });
    expect(second.changes).toHaveLength(1);
    expect(db.get("SELECT recheck_id FROM video_changes WHERE field = 'title'")).toEqual({
      recheck_id: 3,
    });
    expect(upsertVideoFromApi(db, vid("u2"), {}).changes).toEqual([]);
  });
});

function list0() {
  return list({});
}
