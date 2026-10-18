import {
  ChannelRowSchema,
  ChannelSourceKindSchema,
  ChannelsListResponseSchema,
} from "@cellar/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { escapeLike, getChannel } from "../src/domain/channels.ts";
import type { TempApp } from "./helpers.ts";
import { createWave1App, FakeGoogle, jsonResponse, seedLinkedAccount } from "./wave1aHelpers.ts";

const UC_A = "UCaaaaaaaaaaaaaaaaaaaaaa";
const UC_B = "UCbbbbbbbbbbbbbbbbbbbbbb";
const UC_C = "UCcccccccccccccccccccccc";

let temp: TempApp;
let google: FakeGoogle;

function channel(id: string, title: string | null, handle: string | null = null): void {
  temp.db.run(
    `INSERT INTO channels (id, title, handle, first_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, 0, 0, 0)`,
    id,
    title,
    handle,
  );
}

function source(channelId: string, kind: "manual" | "subscription", accountId: number | null) {
  temp.db.run(
    `INSERT INTO channel_sources (channel_id, account_id, kind, created_at) VALUES (?, ?, ?, 0)`,
    channelId,
    accountId,
    kind,
  );
}

async function list(query = "") {
  const res = await temp.app.inject({ method: "GET", url: `/api/channels${query}` });
  expect(res.statusCode).toBe(200);
  return ChannelsListResponseSchema.parse(res.json());
}

function add(ref: string) {
  return temp.app.inject({ method: "POST", url: "/api/channels", payload: { ref } });
}

const apiChannel = (id: string, title: string, handle: string) => ({
  items: [
    {
      id,
      snippet: {
        title,
        customUrl: handle,
        thumbnails: { medium: { url: `https://yt3.example/${id}` } },
      },
      contentDetails: { relatedPlaylists: { uploads: `UU${id.slice(2)}` } },
    },
  ],
});

beforeEach(async () => {
  google = await new FakeGoogle().init();
  temp = await createWave1App({}, { fetch: google.fetch });
});

afterEach(async () => {
  await temp.close();
});

describe("GET /api/channels", () => {
  beforeEach(() => {
    const acct = seedLinkedAccount(temp.db);
    channel(UC_A, "Alpha 100%", "@alpha");
    channel(UC_B, "beta_channel", "@beta");
    channel(UC_C, null, null);
    source(UC_A, "subscription", acct);
    source(UC_B, "manual", null);
    temp.db.run(
      `INSERT INTO videos (id, channel_id, created_at, updated_at)
       VALUES ('dQw4w9WgXcQ', ?, 0, 0), ('jNQXAC9IVRw', ?, 0, 0)`,
      UC_A,
      UC_A,
    );
  });

  it("pages every channel with source flags and video counts", async () => {
    const page = await list();
    expect(page.total).toBe(3);
    expect(page.page).toBe(1);
    expect(page.perPage).toBe(50);
    expect(page.rows.map((row) => row.id)).toEqual([UC_A, UC_B, UC_C]);
    expect(page.rows[0]).toMatchObject({ subscribed: true, manual: false, video_count: 2 });
    expect(page.rows[1]).toMatchObject({ subscribed: false, manual: true, video_count: 0 });

    const second = await list("?page=2&perPage=2");
    expect(second.rows.map((row) => row.id)).toEqual([UC_C]);
    expect((await list("?limit=1")).rows).toHaveLength(1);
  });

  it("searches title and handle literally, and filters by kind", async () => {
    expect((await list("?q=ALPHA")).rows.map((row) => row.id)).toEqual([UC_A]);
    expect((await list("?q=%40beta")).rows.map((row) => row.id)).toEqual([UC_B]);
    // % and _ are literal, not wildcards.
    expect((await list("?q=100%25")).rows.map((row) => row.id)).toEqual([UC_A]);
    expect((await list("?q=alph_")).total).toBe(0);
    expect((await list(`?q=${UC_C}`)).rows.map((row) => row.id)).toEqual([UC_C]);
    // A partly typed id matches by prefix, case-sensitively.
    expect((await list("?q=UCccc")).rows.map((row) => row.id)).toEqual([UC_C]);
    expect((await list("?q=UCCCC")).total).toBe(0);
    expect((await list("?kind=manual")).rows.map((row) => row.id)).toEqual([UC_B]);
    expect((await list("?kind=subscription&q=alpha")).total).toBe(1);
  });

  it("validates the query", async () => {
    for (const query of ["?perPage=500", "?page=0", "?kind=other"]) {
      const res = await temp.app.inject({ method: "GET", url: `/api/channels${query}` });
      expect(res.statusCode).toBe(400);
    }
  });

  it("rejects an unknown kind and names the field in the 400 message", async () => {
    const res = await temp.app.inject({ method: "GET", url: "/api/channels?kind=subscribed" });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe("invalid");
    expect(body.error).toBe("Invalid query string: kind.");
    expect(Object.keys(body.details.fields)).toEqual(["kind"]);
    expect(JSON.stringify(body)).not.toContain("subscribed");
  });

  it("accepts every kind the shared schema defines", async () => {
    for (const kind of ChannelSourceKindSchema.options) {
      const res = await temp.app.inject({ method: "GET", url: `/api/channels?kind=${kind}` });
      expect(res.statusCode).toBe(200);
    }
  });

  it("getChannel throws for an unknown id", () => {
    expect(() => getChannel(temp.db, "UCnope")).toThrow(/does not exist/);
  });

  it("escapeLike escapes the LIKE metacharacters", () => {
    expect(escapeLike("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
  });
});

describe("POST /api/channels", () => {
  it("adds a channel id without any account or API call", async () => {
    const res = await add(`https://www.youtube.com/channel/${UC_A}/videos`);
    expect(res.statusCode).toBe(201);
    expect(ChannelRowSchema.parse(res.json())).toMatchObject({
      id: UC_A,
      title: null,
      manual: true,
      subscribed: false,
    });
    expect(google.calls).toHaveLength(0);
    // Idempotent.
    const again = await add(UC_A);
    expect(again.statusCode).toBe(200);
    expect(temp.db.all("SELECT * FROM channel_sources")).toHaveLength(1);
  });

  it("enriches an id with metadata when an ok account exists", async () => {
    seedLinkedAccount(temp.db);
    google.api["channels"] = (url) => {
      expect(url.searchParams.get("id")).toBe(UC_A);
      return jsonResponse(200, apiChannel(UC_A, "Alpha", "@alpha"));
    };
    const res = await add(UC_A);
    expect(res.json()).toMatchObject({
      id: UC_A,
      title: "Alpha",
      handle: "@alpha",
      thumbnail_url: `https://yt3.example/${UC_A}`,
    });
    expect(temp.db.get<{ u: string }>("SELECT uploads_playlist_id AS u FROM channels")?.u).toBe(
      `UU${UC_A.slice(2)}`,
    );
  });

  it("copes with an API item that has no snippet", async () => {
    seedLinkedAccount(temp.db);
    google.api["channels"] = () => jsonResponse(200, { items: [{ id: UC_A }] });
    const res = await add(UC_A);
    expect(res.json()).toMatchObject({ id: UC_A, title: null, handle: null, thumbnail_url: null });
  });

  it("still adds an id when the metadata lookup fails", async () => {
    seedLinkedAccount(temp.db);
    google.api["channels"] = () => jsonResponse(500, {});
    const res = await add(UC_B);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: UC_B, title: null });
  });

  it("needs an ok account to resolve a handle (409 no_account)", async () => {
    seedLinkedAccount(temp.db, { status: "auth_lost" });
    const res = await add("@veritasium");
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("no_account");
    expect(google.calls).toHaveLength(0);
  });

  it("resolves a handle with forHandle on the freshest ok account", async () => {
    seedLinkedAccount(temp.db, { lastApiOkAt: 1 });
    const fresh = seedLinkedAccount(temp.db, { lastApiOkAt: 2, refreshToken: "fresh" });
    google.api["channels"] = (url) => {
      expect(url.searchParams.get("forHandle")).toBe("@veritasium");
      expect(url.searchParams.get("part")).toBe("snippet,contentDetails");
      return jsonResponse(200, apiChannel(UC_C, "Veritasium", "@veritasium"));
    };
    const res = await add("https://youtube.com/@veritasium");
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: UC_C, title: "Veritasium", handle: "@veritasium" });
    const token = new URLSearchParams(google.calls[0]?.body).get("refresh_token");
    expect(token).toBe("fresh");
    expect(fresh).toBeGreaterThan(0);
  });

  it("resolves /user/ names with forUsername and /c/ names by trying both", async () => {
    seedLinkedAccount(temp.db);
    const seen: string[] = [];
    google.api["channels"] = (url) => {
      const lookup =
        url.searchParams.get("forHandle") ?? `user:${String(url.searchParams.get("forUsername"))}`;
      seen.push(lookup);
      if (lookup === "user:legacyname") {
        return jsonResponse(200, apiChannel(UC_A, "Legacy", "@legacy"));
      }
      return jsonResponse(200, { items: [] });
    };
    expect((await add("https://www.youtube.com/user/legacyname")).statusCode).toBe(201);
    expect((await add("https://www.youtube.com/c/legacyname")).statusCode).toBe(200);
    expect(seen).toEqual(["user:legacyname", "@legacyname", "user:legacyname"]);
  });

  it("answers 404 when nothing matches and 400 for a non-channel ref", async () => {
    seedLinkedAccount(temp.db);
    google.api["channels"] = () => jsonResponse(200, {});
    expect((await add("@nobodyhere")).statusCode).toBe(404);
    const bad = await add("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(bad.statusCode).toBe(400);
    expect(bad.json().details.fields).toHaveProperty("ref");
  });

  it("propagates API failures while resolving a handle", async () => {
    seedLinkedAccount(temp.db);
    google.api["channels"] = () => jsonResponse(503, {});
    expect((await add("@failing")).statusCode).toBe(500);
  });
});

describe("DELETE /api/channels/:id", () => {
  it("removes the manual source only", async () => {
    const acct = seedLinkedAccount(temp.db);
    channel(UC_A, "A");
    source(UC_A, "manual", null);
    source(UC_A, "subscription", acct);
    let res = await temp.app.inject({ method: "DELETE", url: `/api/channels/${UC_A}` });
    expect(res.statusCode).toBe(204);
    expect(temp.db.all("SELECT kind FROM channel_sources")).toEqual([{ kind: "subscription" }]);

    res = await temp.app.inject({ method: "DELETE", url: `/api/channels/${UC_A}` });
    expect(res.statusCode).toBe(409);

    res = await temp.app.inject({ method: "DELETE", url: `/api/channels/${UC_B}` });
    expect(res.statusCode).toBe(404);
  });
});
