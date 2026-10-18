import {
  ApiErrorSchema,
  ShareLinkRowSchema,
  ShareRevokeBulkResponseSchema,
  SharesListResponseSchema,
  type ShareLinkRow,
} from "@cellar/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captionLabel,
  createShare,
  deleteShare,
  generateShareToken,
  getShare,
  isShareToken,
  likeContains,
  listShares,
  pickPublicInfo,
  recordShareAccess,
  resolveActiveShare,
  revokeShare,
  revokeShares,
  shareStatus,
  type ShareCtx,
} from "../src/domain/shares.ts";
import { createTempApp, createTempDb, type TempApp, type TempDb } from "./helpers.ts";
import { DAY, seedChannel, seedVideo, T0, vid } from "./videoSeed.ts";

/** Domain and admin API of share links. The public /s surface is in sharesPublic.test.ts. */

const A = vid("alpha");
const B = vid("beta");
const ORIGIN = "https://cellar.example";

describe("tokens", () => {
  it("are 22 base64url characters from 16 random bytes", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const token = generateShareToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(isShareToken(token)).toBe(true);
      seen.add(token);
    }
    expect(seen.size).toBe(200);
    expect(generateShareToken((size) => Buffer.alloc(size, 0xff))).toBe("_".repeat(21) + "w");
    let asked = 0;
    generateShareToken((size) => {
      asked = size;
      return Buffer.alloc(size);
    });
    expect(asked).toBe(16);
  });

  it("rejects anything that is not exactly 22 base64url characters", () => {
    for (const bad of ["", "a".repeat(21), "a".repeat(23), `${"a".repeat(21)}=`, "a+/".repeat(8)]) {
      expect(isShareToken(bad)).toBe(false);
    }
    expect(isShareToken(42)).toBe(false);
  });
});

describe("shareStatus", () => {
  it("is revoked before expired before active", () => {
    expect(shareStatus({ expires_at: null, revoked_at: null }, 10)).toBe("active");
    expect(shareStatus({ expires_at: 11, revoked_at: null }, 10)).toBe("active");
    expect(shareStatus({ expires_at: 10, revoked_at: null }, 10)).toBe("expired");
    expect(shareStatus({ expires_at: 5, revoked_at: 1 }, 10)).toBe("revoked");
  });
});

describe("helpers", () => {
  it("escapes LIKE wildcards", () => {
    expect(likeContains("50%_a\\b")).toBe("%50\\%\\_a\\\\b%");
  });

  it("labels caption languages in English and falls back to the code", () => {
    expect(captionLabel("en")).toBe("English");
    expect(captionLabel("pt_BR")).toContain("Portuguese");
    expect(captionLabel("zz-not-a-lang-at-all-really")).toBe("zz-not-a-lang-at-all-really");
  });

  it("picks only allowlisted info.json keys", () => {
    expect(pickPublicInfo(null)).toBeNull();
    expect(pickPublicInfo([1])).toBeNull();
    expect(
      pickPublicInfo({
        id: "x",
        title: "t",
        _filename: "/media/x.webm",
        filepath: "/media/x.webm",
        requested_downloads: [{ filepath: "/x" }],
        formats: [{ url: "https://signed" }],
        http_headers: { Cookie: "c" },
        playlist_title: "Watch later",
      }),
    ).toEqual({ id: "x", title: "t" });
  });
});

describe("share links domain", () => {
  let temp: TempDb;
  let clock: number;
  let ctx: ShareCtx;

  beforeEach(() => {
    temp = createTempDb();
    clock = T0 + 10 * DAY;
    ctx = { db: temp.db, publicOrigin: ORIGIN, now: () => clock };
    seedChannel(temp.db, "UCc", "Chan");
    seedVideo(temp.db, { id: A, channel_id: "UCc", title: "Alpha 100% video" });
    seedVideo(temp.db, { id: B, title: "Beta" });
  });

  afterEach(() => {
    temp.close();
  });

  function create(videoId: string, expiresAt: number | null = null): ShareLinkRow {
    return createShare(ctx, { video_id: videoId, expires_at: expiresAt });
  }

  it("creates a row with the public URL and logs activity", () => {
    const row = create(A, clock + DAY);
    expect(ShareLinkRowSchema.parse(row)).toEqual(row);
    expect(row).toMatchObject({
      video_id: A,
      title: "Alpha 100% video",
      channel_title: "Chan",
      expires_at: clock + DAY,
      revoked_at: null,
      access_count: 0,
      last_access_at: null,
      created_at: clock,
      url: `${ORIGIN}/s/${row.token}`,
      status: "active",
    });
    const activity = temp.db.all<{ kind: string; video_id: string; data_json: string }>(
      "SELECT kind, video_id, data_json FROM activity",
    );
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ kind: "share.created", video_id: A });
    // The activity log names a short hint, never the whole bearer token.
    expect(activity[0]!.data_json).not.toContain(row.token);
  });

  it("refuses an unknown video and a past expiry", () => {
    expect(() => create(vid("missing"))).toThrow(/does not exist/);
    expect(() => create(A, clock)).toThrow(/future/);
  });

  it("retries a colliding token, then gives up", () => {
    const fixed = (size: number) => Buffer.alloc(size, 7);
    const first = createShare(ctx, { video_id: A, expires_at: null }, fixed);
    let calls = 0;
    const second = createShare(ctx, { video_id: A, expires_at: null }, (size) => {
      calls += 1;
      return calls === 1 ? Buffer.alloc(size, 7) : Buffer.alloc(size, 8);
    });
    expect(second.token).not.toBe(first.token);
    expect(() => createShare(ctx, { video_id: A, expires_at: null }, fixed)).toThrow(/UNIQUE/);
  });

  it("revokes idempotently and deletes only revoked links", () => {
    const row = create(A);
    expect(() => deleteShare(ctx, row.token)).toThrow(/Revoke/);
    clock += 1000;
    const revoked = revokeShare(ctx, row.token);
    expect(revoked).toMatchObject({ status: "revoked", revoked_at: clock });
    clock += 1000;
    expect(revokeShare(ctx, row.token).revoked_at).toBe(revoked.revoked_at);
    deleteShare(ctx, row.token);
    expect(() => getShare(ctx, row.token)).toThrow(/does not exist/);
    expect(() => revokeShare(ctx, row.token)).toThrow(/does not exist/);
  });

  it("resolves only active links and counts accesses", () => {
    const active = create(A);
    const expiring = create(A, clock + 1000);
    const revoked = create(B);
    revokeShare(ctx, revoked.token);
    expect(resolveActiveShare(temp.db, active.token, clock)).toEqual({
      token: active.token,
      video_id: A,
    });
    expect(resolveActiveShare(temp.db, expiring.token, clock + 999)).not.toBeNull();
    expect(resolveActiveShare(temp.db, expiring.token, clock + 1000)).toBeNull();
    expect(resolveActiveShare(temp.db, revoked.token, clock)).toBeNull();
    expect(resolveActiveShare(temp.db, "a".repeat(22), clock)).toBeNull();
    expect(resolveActiveShare(temp.db, "short", clock)).toBeNull();
    expect(resolveActiveShare(temp.db, undefined, clock)).toBeNull();

    recordShareAccess(temp.db, active.token, clock + 5);
    recordShareAccess(temp.db, active.token, clock + 9);
    expect(getShare(ctx, active.token)).toMatchObject({
      access_count: 2,
      last_access_at: clock + 9,
    });
  });

  it("lists with paging, search, status, video and sort", () => {
    const tokens: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      clock += 1000;
      tokens.push(create(i % 2 === 0 ? A : B, i === 0 ? clock + 500 : null).token);
    }
    revokeShare(ctx, tokens[1]!);
    clock += 1000; // tokens[0] is now expired
    recordShareAccess(temp.db, tokens[3]!, clock);
    recordShareAccess(temp.db, tokens[3]!, clock);
    recordShareAccess(temp.db, tokens[2]!, clock - 10);

    const base = { page: 1, perPage: 25, sort: "created_at", dir: "desc" } as const;
    const all = listShares(ctx, base);
    expect(SharesListResponseSchema.parse(all)).toEqual(all);
    expect(all.total).toBe(5);
    expect(all.rows.map((r) => r.token)).toEqual([...tokens].reverse());
    expect(all.rows.find((r) => r.token === tokens[0])?.status).toBe("expired");

    expect(listShares(ctx, { ...base, perPage: 25, page: 2 }).rows).toEqual([]);
    expect(listShares(ctx, { ...base, status: "active" }).total).toBe(3);
    expect(listShares(ctx, { ...base, status: "expired" }).rows.map((r) => r.token)).toEqual([
      tokens[0],
    ]);
    expect(listShares(ctx, { ...base, status: "revoked" }).rows.map((r) => r.token)).toEqual([
      tokens[1],
    ]);
    expect(listShares(ctx, { ...base, video_id: B }).total).toBe(2);
    expect(listShares(ctx, { ...base, q: "100%" }).total).toBe(3);
    expect(listShares(ctx, { ...base, q: "beta" }).total).toBe(2);
    expect(listShares(ctx, { ...base, q: tokens[4]!.slice(3, 15) }).rows[0]?.token).toBe(tokens[4]);
    expect(listShares(ctx, { ...base, q: "   " }).total).toBe(5);

    const byCount = listShares(ctx, { ...base, sort: "access_count" }).rows.map((r) => r.token);
    expect(byCount.slice(0, 2)).toEqual([tokens[3], tokens[2]]);
    const byLast = listShares(ctx, { ...base, sort: "last_access_at" }).rows.map((r) => r.token);
    expect(byLast.slice(0, 2)).toEqual([tokens[3], tokens[2]]);
    const expAsc = listShares(ctx, { ...base, sort: "expires_at", dir: "asc" }).rows;
    expect(expAsc[0]?.token).toBe(tokens[0]);
    expect(expAsc[4]?.expires_at).toBeNull();
    const expDesc = listShares(ctx, { ...base, sort: "expires_at", dir: "desc" }).rows;
    expect(expDesc[0]?.expires_at).toBeNull();
    expect(expDesc[4]?.token).toBe(tokens[0]);
  });

  it("bulk revokes by tokens and by filter, counting only new revocations", () => {
    const a1 = create(A).token;
    const a2 = create(A).token;
    const b1 = create(B).token;
    const b2 = create(B).token;
    expect(revokeShares(ctx, { tokens: [a1, a1, "z".repeat(22)] })).toBe(1);
    expect(revokeShares(ctx, { tokens: [a1, a2] })).toBe(1);
    const filter = { page: 1, perPage: 25, sort: "created_at", dir: "desc" } as const;
    expect(revokeShares(ctx, { all_matching: { ...filter, q: "nothing matches this" } })).toBe(0);
    expect(revokeShares(ctx, { all_matching: { ...filter, video_id: B, status: "active" } })).toBe(
      2,
    );
    expect(listShares(ctx, { ...filter, status: "revoked" }).total).toBe(4);
    expect(getShare(ctx, b1).status).toBe("revoked");
    expect(getShare(ctx, b2).revoked_at).toBe(clock);
    const kinds = temp.db.all<{ kind: string }>("SELECT kind FROM activity ORDER BY id");
    expect(kinds.filter((k) => k.kind === "share.revoked")).toHaveLength(3);
  });

  it("revokes long token lists in chunks", () => {
    const tokens = Array.from({ length: 3 }, () => create(A).token);
    const many = [...tokens, ...Array.from({ length: 1200 }, () => generateShareToken())];
    expect(revokeShares(ctx, { tokens: many })).toBe(3);
  });

  it("drops links with their video", () => {
    create(B);
    temp.db.run("DELETE FROM videos WHERE id = ?", B);
    expect(temp.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM share_links")?.n).toBe(0);
  });
});

describe("/api/shares", () => {
  let app: TempApp;

  beforeEach(async () => {
    app = await createTempApp({ PUBLIC_ORIGIN: "https://share.example/" });
    seedChannel(app.db, "UCc", "Chan");
    seedVideo(app.db, { id: A, channel_id: "UCc", title: "Alpha" });
    seedVideo(app.db, { id: B, title: "Beta" });
  });

  afterEach(async () => {
    await app.close();
  });

  const inject = (method: "GET" | "POST" | "DELETE", url: string, payload?: object) =>
    app.app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });

  it("creates, reads, lists, revokes and deletes", async () => {
    const created = await inject("POST", "/api/shares", { video_id: A });
    expect(created.statusCode).toBe(201);
    const row = ShareLinkRowSchema.parse(created.json());
    expect(row.url).toBe(`https://share.example/s/${row.token}`);
    expect(row.expires_at).toBeNull();

    const expiring = await inject("POST", "/api/shares", {
      video_id: B,
      expires_at: Date.now() + DAY,
    });
    expect(expiring.statusCode).toBe(201);

    const got = await inject("GET", `/api/shares/${row.token}`);
    expect(ShareLinkRowSchema.parse(got.json())).toEqual(row);

    const list = await inject("GET", "/api/shares?perPage=50&sort=created_at&dir=asc");
    const parsed = SharesListResponseSchema.parse(list.json());
    expect(parsed).toMatchObject({ total: 2, page: 1, perPage: 50 });
    expect(parsed.rows[0]?.token).toBe(row.token);

    const filtered = await inject("GET", `/api/shares?video_id=${B}&status=active&q=bet`);
    expect(SharesListResponseSchema.parse(filtered.json()).total).toBe(1);

    expect((await inject("DELETE", `/api/shares/${row.token}`)).statusCode).toBe(409);
    const revoked = await inject("POST", `/api/shares/${row.token}/revoke`);
    expect(revoked.statusCode).toBe(200);
    expect(ShareLinkRowSchema.parse(revoked.json()).status).toBe("revoked");
    const deleted = await inject("DELETE", `/api/shares/${row.token}`);
    expect(deleted.statusCode).toBe(204);
    expect((await inject("GET", `/api/shares/${row.token}`)).statusCode).toBe(404);
  });

  it("bulk revokes by tokens and by filter", async () => {
    const tokens: string[] = [];
    for (const id of [A, A, B]) {
      tokens.push(
        ShareLinkRowSchema.parse((await inject("POST", "/api/shares", { video_id: id })).json())
          .token,
      );
    }
    const byTokens = await inject("POST", "/api/shares/revoke", { tokens: [tokens[0]] });
    expect(ShareRevokeBulkResponseSchema.parse(byTokens.json())).toEqual({ count: 1 });
    const byFilter = await inject("POST", "/api/shares/revoke", {
      all_matching: { status: "active" },
    });
    expect(byFilter.json()).toEqual({ count: 2 });
  });

  it("validates input with the shared schemas", async () => {
    const cases: [string, string, object | undefined][] = [
      ["POST", "/api/shares", { video_id: "nope" }],
      ["POST", "/api/shares", { video_id: A, expires_at: "tomorrow" }],
      ["POST", "/api/shares", { video_id: A, expires_at: 1 }],
      ["POST", "/api/shares/revoke", { tokens: [] }],
      ["POST", "/api/shares/revoke", { tokens: ["short"] }],
      ["POST", "/api/shares/revoke", { tokens: [generateShareToken()], all_matching: {} }],
      ["POST", "/api/shares/revoke", {}],
      ["GET", "/api/shares?perPage=7", undefined],
      ["GET", "/api/shares?sort=title", undefined],
      ["GET", "/api/shares?status=gone", undefined],
      ["GET", "/api/shares/short", undefined],
    ];
    for (const [method, url, payload] of cases) {
      const response = await inject(method as "GET" | "POST", url, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(400);
      expect(ApiErrorSchema.parse(response.json()).code).toBe("invalid");
    }
    const unknownVideo = await inject("POST", "/api/shares", { video_id: vid("missing") });
    expect(unknownVideo.statusCode).toBe(404);
    const unknownToken = generateShareToken();
    expect((await inject("GET", `/api/shares/${unknownToken}`)).statusCode).toBe(404);
    expect((await inject("POST", `/api/shares/${unknownToken}/revoke`)).statusCode).toBe(404);
    expect((await inject("DELETE", `/api/shares/${unknownToken}`)).statusCode).toBe(404);
  });
});
