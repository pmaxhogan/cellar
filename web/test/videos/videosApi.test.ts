import { describe, expect, it } from "vitest";
import { VideosListQuerySchema } from "@cellar/shared";
import {
  captionsUrl,
  collectMatching,
  createShareLink,
  defaultListState,
  downloadVideoNow,
  emptyFilters,
  estimateBulkDownload,
  getVideoHistory,
  getVideoStats,
  hasFilters,
  mediaUrl,
  metadataUrl,
  recheckVideo,
  revokeShareLink,
  listShareLinks,
  sharePageUrl,
  shareStatus,
  shareView,
  stateFromQuery,
  stateToApiQuery,
  stateToQuery,
  trashVideos,
  type VideoListState,
} from "../../src/api/videos.ts";
import { fakeServer, json } from "../helpers/fakeServer.ts";
import { ID, idFor, listPage, shareRow, videoRow } from "./fixtures.ts";

function busyState(): VideoListState {
  return {
    filters: {
      q: "  cats  ",
      source: ["liked", "history"],
      account_id: 2,
      channel_id: "UCabc",
      status: ["gone", "unlisted"],
      downloaded: "no",
      type: ["short"],
      date_from: "2024-01-01",
      date_to: "2024-12-31",
      min_duration: 60,
      max_duration: 600,
      pri: "-1",
      location_id: 3,
    },
    page: 3,
    perPage: 100,
    sort: "views",
    dir: "asc",
  };
}

describe("list state and the URL", () => {
  it("leaves every default out of the URL", () => {
    expect(stateToQuery(defaultListState())).toEqual({});
    expect(stateToApiQuery(defaultListState())).toEqual({ page: "1", perPage: "50" });
  });

  it("round-trips a fully filtered state through the URL", () => {
    const query = stateToQuery(busyState());
    expect(query).toEqual({
      q: "cats",
      source: "liked,history",
      account_id: "2",
      channel_id: "UCabc",
      status: "gone,unlisted",
      downloaded: "no",
      type: "short",
      date_from: "2024-01-01",
      date_to: "2024-12-31",
      min_duration: "60",
      max_duration: "600",
      pri: "-1",
      location_id: "3",
      page: "3",
      perPage: "100",
      sort: "views",
      dir: "asc",
    });
    const back = stateFromQuery(query);
    expect(back).toEqual({ ...busyState(), filters: { ...busyState().filters, q: "cats" } });
  });

  it("produces an API query the server schema accepts", () => {
    const parsed = VideosListQuerySchema.parse(stateToApiQuery(busyState()));
    expect(parsed).toMatchObject({
      q: "cats",
      source: ["liked", "history"],
      status: ["gone", "unlisted"],
      downloaded: false,
      type: ["short"],
      account_id: 2,
      min_duration: 60,
      pri: "-1",
      sort: "views",
      dir: "asc",
      page: 3,
      perPage: 100,
    });
    expect(parsed.date_from).toBe(Date.UTC(2024, 0, 1));
  });

  it("sends no sort or dir when none is chosen, so a search ranks by relevance", () => {
    const state = { ...defaultListState(), filters: { ...emptyFilters(), q: "x" }, dir: "asc" };
    const query = stateToApiQuery(state as VideoListState);
    expect(query.sort).toBeUndefined();
    expect(query.dir).toBeUndefined();
    expect(stateToQuery({ ...defaultListState(), sort: "title", dir: "desc" })).toEqual({
      sort: "title",
    });
  });

  it("drops anything unreadable from the URL", () => {
    const state = stateFromQuery({
      q: ["first", "second"],
      source: ["liked,bogus", "liked", 3],
      account_id: "-2",
      status: "nope",
      downloaded: "maybe",
      date_from: "2024-1-1",
      min_duration: "1.5",
      max_duration: "abc",
      pri: "7",
      location_id: "0",
      page: "0",
      perPage: "30",
      sort: "rating",
      dir: "sideways",
    });
    expect(state).toEqual({
      ...defaultListState(),
      filters: { ...emptyFilters(), q: "first", source: ["liked"] },
    });
  });

  it("reads the boolean spellings of downloaded", () => {
    expect(stateFromQuery({ downloaded: "true" }).filters.downloaded).toBe("yes");
    expect(stateFromQuery({ downloaded: "false" }).filters.downloaded).toBe("no");
    expect(stateFromQuery({ downloaded: "yes" }).filters.downloaded).toBe("yes");
  });

  it("knows when any filter is set", () => {
    expect(hasFilters(emptyFilters())).toBe(false);
    expect(hasFilters({ ...emptyFilters(), pri: "0" })).toBe(true);
    expect(hasFilters({ ...emptyFilters(), source: ["liked"] })).toBe(true);
  });
});

describe("collectMatching", () => {
  it("pages at 200 until the total is covered and reports progress", async () => {
    const rows = Array.from({ length: 450 }, (_, i) => videoRow({ id: idFor(i) }));
    const server = fakeServer().on("GET", "/api/videos", (request) => {
      const page = Number(request.query.get("page"));
      const perPage = Number(request.query.get("perPage"));
      return json(listPage(rows.slice((page - 1) * perPage, page * perPage), 450, page, perPage));
    });
    const progress: number[] = [];
    const result = await collectMatching(
      server.api,
      { ...emptyFilters(), status: ["gone"] },
      { onProgress: (p) => progress.push(p.collected) },
    );
    expect(result.rows).toHaveLength(450);
    expect(result.capped).toBe(false);
    expect(progress).toEqual([200, 400, 450]);
    const calls = server.callsTo("GET", "/api/videos");
    expect(calls).toHaveLength(3);
    expect(calls[0]!.query.get("perPage")).toBe("200");
    expect(calls[0]!.query.get("status")).toBe("gone");
  });

  it("stops at the cap and says so", async () => {
    const server = fakeServer().on("GET", "/api/videos", (request) => {
      const page = Number(request.query.get("page"));
      return json(
        listPage(
          Array.from({ length: 200 }, (_, i) => videoRow({ id: idFor((page - 1) * 200 + i) })),
          5000,
          page,
          200,
        ),
      );
    });
    const result = await collectMatching(server.api, emptyFilters(), {
      max: 300,
      sort: "title",
      dir: "asc",
    });
    expect(result.rows).toHaveLength(300);
    expect(result.capped).toBe(true);
    expect(result.total).toBe(5000);
    expect(server.callsTo("GET", "/api/videos")[0]!.query.get("sort")).toBe("title");
  });

  it("skips duplicates and stops on a short page", async () => {
    const server = fakeServer().on("GET", "/api/videos", () =>
      json(listPage([videoRow(), videoRow()], 900)),
    );
    const result = await collectMatching(server.api, emptyFilters());
    expect(result.rows.map((row) => row.id)).toEqual([ID]);
  });
});

describe("video endpoints", () => {
  it("builds the direct URLs", () => {
    expect(mediaUrl(ID, 4)).toBe(`/api/videos/${ID}/media/4`);
    expect(mediaUrl(ID, 4, true)).toBe(`/api/videos/${ID}/media/4?download=1`);
    expect(captionsUrl(ID, "en-US")).toBe(`/api/videos/${ID}/captions/en-US`);
    expect(metadataUrl(ID)).toBe(`/api/videos/${ID}/metadata.json`);
    expect(sharePageUrl("tok_en", "https://cellar.test")).toBe("https://cellar.test/s/tok_en");
  });

  it("calls history, stats, jobs, trash and the estimate", async () => {
    const server = fakeServer()
      .on("GET", `/api/videos/${ID}/history`, () => json(listPage([], 0)))
      .on("GET", `/api/videos/${ID}/stats`, () => json({ points: [] }))
      .on("POST", `/api/videos/${ID}/recheck`, () => json({ job_id: 1, deduped: false }, 202))
      .on("POST", `/api/videos/${ID}/download-now`, () => json({ job_id: 2, deduped: true }, 202))
      .on("POST", "/api/videos/trash", () => json({ count: 2 }, 202))
      .on("POST", "/api/videos/bulk-download/estimate", () =>
        json({ files: 2, bytes: 10, warn: false }),
      );
    await getVideoHistory(server.api, ID, { page: 2, field: "title" });
    const history = server.callsTo("GET", `/api/videos/${ID}/history`)[0]!;
    expect(history.query.get("page")).toBe("2");
    expect(history.query.get("perPage")).toBe("50");
    expect(history.query.get("field")).toBe("title");
    expect(history.query.has("counters")).toBe(false);
    await getVideoHistory(server.api, ID, { page: 1, counters: false });
    const filtered = server.callsTo("GET", `/api/videos/${ID}/history`)[1]!;
    expect(filtered.query.get("counters")).toBe("false");
    expect(await getVideoStats(server.api, ID)).toEqual({ points: [] });
    expect(await recheckVideo(server.api, ID)).toEqual({ job_id: 1, deduped: false });
    expect(await downloadVideoNow(server.api, ID)).toEqual({ job_id: 2, deduped: true });
    expect(await trashVideos(server.api, [ID, "abcdefghijk"])).toBe(2);
    expect(server.callsTo("POST", "/api/videos/trash")[0]!.body).toEqual({
      ids: [ID, "abcdefghijk"],
    });
    expect(await estimateBulkDownload(server.api, [ID], "all")).toEqual({
      files: 2,
      bytes: 10,
      warn: false,
    });
    expect(server.callsTo("POST", "/api/videos/bulk-download/estimate")[0]!.body).toEqual({
      ids: [ID],
      kind: "all",
    });
  });
});

describe("share links", () => {
  it("adapts a detail row, deriving the status and URL", () => {
    const base = {
      token: "abc",
      expires_at: null,
      revoked_at: null,
      access_count: 2,
      created_at: 42,
    };
    expect(shareView(base, 100)).toEqual({
      ...base,
      last_access_at: null,
      url: sharePageUrl("abc"),
      status: "active",
    });
    expect(shareView({ ...base, expires_at: 50 }, 100).status).toBe("expired");
    expect(shareView({ ...base, revoked_at: 60 }, 100).status).toBe("revoked");
    expect(shareStatus({ expires_at: 200, revoked_at: null }, 100)).toBe("active");
  });

  it("keeps what a shares API row says", () => {
    const row = shareRow({ status: "expired", last_access_at: 7 });
    expect(shareView(row)).toMatchObject({ status: "expired", last_access_at: 7, url: row.url });
  });

  it("lists, creates and revokes", async () => {
    const server = fakeServer()
      .on("GET", "/api/shares", () => json(listPage([shareRow()], 1, 1, 100)))
      .on("POST", "/api/shares", () =>
        json(shareRow({ token: "tok", url: "https://x/s/tok" }), 201),
      )
      .on("POST", "/api/shares/tok/revoke", () =>
        json(shareRow({ token: "tok", revoked_at: 9, status: "revoked" })),
      );
    const listed = await listShareLinks(server.api, ID);
    expect(listed.map((link) => link.status)).toEqual(["active"]);
    const query = server.callsTo("GET", "/api/shares")[0]!.query;
    expect(query.get("video_id")).toBe(ID);
    expect(query.get("perPage")).toBe("100");
    const link = await createShareLink(server.api, ID, 5);
    expect(link.url).toBe("https://x/s/tok");
    expect(server.callsTo("POST", "/api/shares")[0]!.body).toEqual({ video_id: ID, expires_at: 5 });
    expect((await revokeShareLink(server.api, "tok")).status).toBe("revoked");
  });
});
