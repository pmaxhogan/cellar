import {
  ApiErrorSchema,
  TitleChangesQuerySchema,
  TitleChangesResponseSchema,
  type TitleChangesQuery,
} from "@cellar/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.ts";
import { listTitleChanges } from "../src/domain/videos.ts";
import { createTempApp, createTempDb, type TempApp, type TempDb } from "./helpers.ts";
import { seedChannel, seedThumbnail, seedVideo, T0, vid } from "./videoSeed.ts";

const A = vid("alpha");
const B = vid("beta");
const C = vid("gamma");

function change(
  db: Db,
  videoId: string,
  field: string,
  old: unknown,
  next: unknown,
  seenAt: number,
): void {
  db.run(
    `INSERT INTO video_changes (video_id, field, old_json, new_json, seen_at)
     VALUES (?, ?, ?, ?, ?)`,
    videoId,
    field,
    old === undefined ? null : JSON.stringify(old),
    next === undefined ? null : JSON.stringify(next),
    seenAt,
  );
}

/** Two channels, three videos, five title changes and some noise. */
function seed(db: Db): void {
  seedChannel(db, "UCone", "One");
  seedChannel(db, "UCtwo", "Two");
  seedVideo(db, { id: A, channel_id: "UCone", title: "A three" });
  seedVideo(db, { id: B, channel_id: "UCtwo", title: "B 100% real" });
  seedVideo(db, { id: C, title: null });
  seedThumbnail(db, A, "hqdefault", "h1", `UCone/${A}/hq.jpg`, T0);
  seedThumbnail(db, A, "maxresdefault", "m1", `UCone/${A}/max.jpg`, T0);
  change(db, A, "title", "A one", "A two", T0 + 1);
  change(db, A, "title", "A two", "A three", T0 + 5);
  change(db, B, "title", "B 100 real", "B 100% real", T0 + 3);
  change(db, C, "title", "C_old", 'C "quoted" new', T0 + 4);
  // Same instant as A's second change: the higher id comes first.
  change(db, B, "title", "B a_b", "B 100 real", T0 + 5);
  change(db, A, "views", 1, 2, T0 + 9);
  change(db, A, "description", "d1", "d2", T0 + 8);
}

function query(input: Record<string, string> = {}): TitleChangesQuery {
  return TitleChangesQuerySchema.parse(input);
}

describe("listTitleChanges", () => {
  let temp: TempDb;

  beforeEach(() => {
    temp = createTempDb();
    seed(temp.db);
  });

  afterEach(() => {
    temp.close();
  });

  it("lists only title rows, newest first, with the video and channel", () => {
    const page = listTitleChanges(temp.db, query());
    expect(page.total).toBe(5);
    expect(page.rows.map((row) => [row.video_id, row.changed_at])).toEqual([
      [B, T0 + 5],
      [A, T0 + 5],
      [C, T0 + 4],
      [B, T0 + 3],
      [A, T0 + 1],
    ]);
    const a = page.rows[1]!;
    expect(a).toMatchObject({
      video_id: A,
      channel_id: "UCone",
      channel_title: "One",
      title: "A three",
      old_title: "A two",
      new_title: "A three",
    });
    expect(a.thumbnail_url).toBe(`/api/videos/${A}/thumbnail/maxresdefault?sha=m1`);
    const c = page.rows[2]!;
    expect(c).toMatchObject({ channel_id: null, channel_title: null, title: null });
    expect(c.new_title).toBe('C "quoted" new');
    expect(c.thumbnail_url).toBeNull();
    expect(TitleChangesResponseSchema.parse(page)).toEqual(page);
  });

  it("pages with a stable total", () => {
    const first = listTitleChanges(temp.db, query({ perPage: "2" }));
    const third = listTitleChanges(temp.db, query({ perPage: "2", page: "3" }));
    expect(first.rows).toHaveLength(2);
    expect(third.rows.map((row) => row.changed_at)).toEqual([T0 + 1]);
    expect([first.total, third.total]).toEqual([5, 5]);
    expect(third).toMatchObject({ page: 3, perPage: 2 });
    expect(listTitleChanges(temp.db, query({ page: "9" })).rows).toEqual([]);
  });

  it("filters by channel", () => {
    const page = listTitleChanges(temp.db, query({ channel_id: "UCtwo" }));
    expect(page.total).toBe(2);
    expect(page.rows.every((row) => row.video_id === B)).toBe(true);
    expect(listTitleChanges(temp.db, query({ channel_id: "UCnone" })).total).toBe(0);
  });

  it("matches q against the old or the new title, case insensitively", () => {
    const byOld = listTitleChanges(temp.db, query({ q: "a ONE" }));
    expect(byOld.rows.map((row) => row.old_title)).toEqual(["A one"]);
    const byNew = listTitleChanges(temp.db, query({ q: "a three" }));
    expect(byNew.rows.map((row) => row.new_title)).toEqual(["A three"]);
    // A quote is matched in the decoded title, not its JSON encoding.
    expect(listTitleChanges(temp.db, query({ q: '"quoted"' })).total).toBe(1);
    expect(
      listTitleChanges(temp.db, query({ q: "two", channel_id: "UCone" })).rows.map(
        (row) => row.changed_at,
      ),
    ).toEqual([T0 + 5, T0 + 1]);
  });

  it("treats % and _ in q literally", () => {
    expect(
      listTitleChanges(temp.db, query({ q: "100%" })).rows.map((row) => row.new_title),
    ).toEqual(["B 100% real"]);
    expect(listTitleChanges(temp.db, query({ q: "_" })).rows.map((row) => row.old_title)).toEqual([
      "B a_b",
      "C_old",
    ]);
    expect(listTitleChanges(temp.db, query({ q: "%%" })).total).toBe(0);
  });

  it("ignores an empty q", () => {
    expect(listTitleChanges(temp.db, query({ q: "   " })).total).toBe(5);
  });

  it("reads null, non-text and malformed values as null", () => {
    seedVideo(temp.db, { id: vid("odd"), title: "Odd" });
    change(temp.db, vid("odd"), "title", 42, undefined, T0 + 20);
    temp.db.run(
      `INSERT INTO video_changes (video_id, field, old_json, new_json, seen_at)
       VALUES (?, 'title', '{broken', '"Fine"', ?)`,
      vid("odd"),
      T0 + 21,
    );
    const rows = listTitleChanges(temp.db, query({ perPage: "2" })).rows;
    expect(rows.map((row) => [row.old_title, row.new_title])).toEqual([
      [null, "Fine"],
      [null, null],
    ]);
    // A malformed value never breaks a search either.
    expect(listTitleChanges(temp.db, query({ q: "fine" })).total).toBe(1);
  });

  it("walks the (field, seen_at) index instead of sorting", () => {
    const plan = temp.db
      .all<{ detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT vc.id FROM video_changes vc JOIN videos v ON v.id = vc.video_id
          WHERE vc.field = 'title' ORDER BY vc.seen_at DESC, vc.id DESC LIMIT 50`,
      )
      .map((row) => row.detail)
      .join("\n");
    expect(plan).toContain("video_changes_field_seen");
    expect(plan).not.toContain("TEMP B-TREE");
  });
});

describe("GET /api/title-changes", () => {
  let temp: TempApp;

  beforeEach(async () => {
    temp = await createTempApp();
    seed(temp.db);
  });

  afterEach(async () => {
    await temp.close();
  });

  it("answers the paged list with filters", async () => {
    const res = await temp.app.inject({
      method: "GET",
      url: "/api/title-changes?perPage=25&channel_id=UCone&q=two",
    });
    expect(res.statusCode).toBe(200);
    const body = TitleChangesResponseSchema.parse(res.json());
    expect(body).toMatchObject({ total: 2, page: 1, perPage: 25 });
    expect(body.rows.map((row) => row.changed_at)).toEqual([T0 + 5, T0 + 1]);
  });

  it("answers every row without filters", async () => {
    const res = await temp.app.inject({ method: "GET", url: "/api/title-changes" });
    expect(TitleChangesResponseSchema.parse(res.json()).total).toBe(5);
  });

  it.each([
    ["page=0", "page"],
    ["perPage=500", "perPage"],
    ["perPage=abc", "perPage"],
    [`q=${"x".repeat(201)}`, "q"],
    ["channel_id=", "channel_id"],
  ])("rejects %s with a 400", async (search, field) => {
    const res = await temp.app.inject({ method: "GET", url: `/api/title-changes?${search}` });
    expect(res.statusCode).toBe(400);
    const body = ApiErrorSchema.parse(res.json());
    expect(body.code).toBe("invalid");
    expect(body.error).toContain(field);
  });
});
