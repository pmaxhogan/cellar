import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  refreshThumbnails,
  thumbnailRelPath,
  thumbnailsNeedRefresh,
  thumbnailUrls,
} from "../../src/domain/thumbnails.ts";
import { listVideos } from "../../src/domain/videos.ts";
import { ensureChannel, recordSighting } from "../../src/youtube/ingest.ts";
import { cachedRyd, createRydClient, rydRatio, RYD_VOTES_URL } from "../../src/youtube/ryd.ts";
import { IngestEnv, jsonResponse, log, NOW, RICK } from "./ingestHelpers.ts";

let env: IngestEnv;

beforeEach(async () => {
  env = await IngestEnv.create();
});

afterEach(() => {
  env.close();
});

describe("RYD client", () => {
  it("spaces requests at least a second apart and parses the votes", async () => {
    let clock = 1000;
    const sleeps: number[] = [];
    const urls: string[] = [];
    const client = createRydClient({
      now: () => clock,
      sleep: (ms) => {
        sleeps.push(ms);
        clock += ms;
        return Promise.resolve();
      },
      fetch: (input) => {
        urls.push(String(input));
        clock += 100;
        return Promise.resolve(jsonResponse(200, { likes: 9, dislikes: 1 }));
      },
    });
    const [a, b] = await Promise.all([client.votes("dQw4w9WgXcQ"), client.votes("jNQXAC9IVRw")]);
    expect(a).toEqual({ likes: 9, dislikes: 1 });
    expect(b).toEqual({ likes: 9, dislikes: 1 });
    expect(urls).toEqual([
      `${RYD_VOTES_URL}?videoId=dQw4w9WgXcQ`,
      `${RYD_VOTES_URL}?videoId=jNQXAC9IVRw`,
    ]);
    expect(sleeps).toEqual([900]);
  });

  it("reads failures, timeouts and odd bodies as no data", async () => {
    const answers: (() => Promise<Response>)[] = [
      () => Promise.resolve(new Response("x", { status: 503 })),
      () => Promise.reject(new DOMException("timed out", "TimeoutError")),
      () => Promise.resolve(jsonResponse(200, { likes: 5 })),
      () => Promise.resolve(new Response("not json", { status: 200 })),
      () => Promise.resolve(jsonResponse(200, { likes: -1, dislikes: 4.4 })),
    ];
    const client = createRydClient({
      minIntervalMs: 0,
      log,
      fetch: () => (answers.shift() as () => Promise<Response>)(),
    });
    expect(await client.votes("a")).toBeNull();
    expect(await client.votes("b")).toBeNull();
    expect(await client.votes("c")).toBeNull();
    expect(await client.votes("d")).toBeNull();
    expect(await client.votes("e")).toEqual({ likes: null, dislikes: 4 });
  });

  it("asks once per video within a run, and computes the ratio", async () => {
    let calls = 0;
    const cached = cachedRyd({
      votes: () => {
        calls += 1;
        return Promise.resolve({ likes: 1, dislikes: 1 });
      },
    });
    await cached.votes("a");
    await cached.votes("a");
    await cached.votes("b");
    expect(calls).toBe(2);
    expect(rydRatio(3, 1)).toBe(0.75);
    expect(rydRatio(0, 0)).toBeNull();
    expect(rydRatio(null, 1)).toBeNull();
    expect(rydRatio(1, null)).toBeNull();
  });
});

describe("thumbnails", () => {
  const api = {
    default: { url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/default.jpg" },
    medium: { url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg" },
    high: { url: "" },
  };

  function seed(): void {
    ensureChannel(env.db, { id: RICK }, NOW);
    recordSighting(env.db, { videoId: "dQw4w9WgXcQ", channelId: RICK, fill: {}, sources: [] }, NOW);
  }

  it("maps API keys onto variants and builds the rest", () => {
    const urls = thumbnailUrls("dQw4w9WgXcQ", api, ["default", "mqdefault", "hqdefault", "hq720"]);
    expect([...urls]).toEqual([
      ["default", "https://i.ytimg.com/vi/dQw4w9WgXcQ/default.jpg"],
      ["mqdefault", "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg"],
      ["hqdefault", "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"],
      ["hq720", "https://i.ytimg.com/vi/dQw4w9WgXcQ/hq720.jpg"],
    ]);
    expect(thumbnailUrls("dQw4w9WgXcQ", undefined, ["sddefault"]).get("sddefault")).toBe(
      "https://i.ytimg.com/vi/dQw4w9WgXcQ/sddefault.jpg",
    );
    expect(thumbnailRelPath(RICK, "dQw4w9WgXcQ", "default", "ab")).toBe(
      `${RICK}/dQw4w9WgXcQ/thumbnails/default-ab.jpg`,
    );
  });

  it("stores on change only, hashing into the meta dir", async () => {
    seed();
    const bodies = new Map<string, Response | Error>();
    const deps = {
      ...env.deps(),
      fetch: (input: string | URL) => {
        const answer = bodies.get(String(input));
        if (answer instanceof Error) {
          return Promise.reject(answer);
        }
        return Promise.resolve(answer ?? new Response("missing", { status: 404 }));
      },
    };
    const urls = new Map([
      ["default", "https://t/default.jpg"],
      ["mqdefault", "https://t/mq.jpg"],
      ["hqdefault", "https://t/hq.jpg"],
      ["sddefault", "https://t/sd.jpg"],
      ["maxresdefault", "https://t/max.jpg"],
    ]);
    bodies.set("https://t/default.jpg", new Response("one"));
    bodies.set("https://t/mq.jpg", new Response("mq"));
    bodies.set("https://t/hq.jpg", new Response("", { status: 200 }));
    bodies.set("https://t/sd.jpg", new Error("socket hang up"));
    expect(thumbnailsNeedRefresh(env.db, "dQw4w9WgXcQ", api)).toBe(true);
    const first = await refreshThumbnails(deps, { videoId: "dQw4w9WgXcQ", channelId: RICK, urls });
    expect(first).toEqual({ stored: 2, unchanged: 0, missing: 1, failed: 2 });
    const sha = createHash("sha256").update("one").digest("hex");
    const file = join(env.config.metaDir, RICK, "dQw4w9WgXcQ", "thumbnails", `default-${sha}.jpg`);
    expect(readFileSync(file, "utf8")).toBe("one");
    expect(existsSync(`${file}.part`)).toBe(false);

    bodies.set("https://t/default.jpg?v=2", new Response("one"));
    bodies.set("https://t/mq.jpg", new Response("mq"));
    bodies.set("https://t/sd.jpg", new Response("x", { status: 500 }));
    const second = await refreshThumbnails(deps, {
      videoId: "dQw4w9WgXcQ",
      channelId: RICK,
      urls: new Map([
        ["default", "https://t/default.jpg?v=2"],
        ["mqdefault", "https://t/mq.jpg"],
        ["sddefault", "https://t/sd.jpg"],
      ]),
    });
    expect(second).toEqual({ stored: 0, unchanged: 2, missing: 0, failed: 1 });
    // Same bytes under a new URL: the latest row's URL moves, no new row.
    expect(env.db.all("SELECT variant, url FROM thumbnails ORDER BY variant")).toEqual([
      { variant: "default", url: "https://t/default.jpg?v=2" },
      { variant: "mqdefault", url: "https://t/mq.jpg" },
    ]);

    env.now += 1000;
    bodies.set("https://t/default.jpg", new Response("two"));
    const third = await refreshThumbnails(deps, {
      videoId: "dQw4w9WgXcQ",
      channelId: RICK,
      urls: new Map([["default", "https://t/default.jpg"]]),
    });
    expect(third.stored).toBe(1);
    expect(
      env.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM thumbnails WHERE variant = 'default'")
        ?.n,
    ).toBe(2);

    // Back to the first image: its row becomes the latest again.
    env.now += 1000;
    bodies.set("https://t/default.jpg", new Response("one"));
    await refreshThumbnails(deps, {
      videoId: "dQw4w9WgXcQ",
      channelId: RICK,
      urls: new Map([["default", "https://t/default.jpg"]]),
    });
    expect(
      env.db.get(
        `SELECT sha256 FROM thumbnails WHERE variant = 'default'
          ORDER BY first_seen_at DESC, id DESC LIMIT 1`,
      ),
    ).toEqual({ sha256: sha });
  });

  it("needs a refresh only when a stored variant's URL changed", () => {
    seed();
    env.db.run(
      `INSERT INTO thumbnails (video_id, variant, url, sha256, path, first_seen_at)
       VALUES ('dQw4w9WgXcQ', 'default', ?, 'a', 'p', 1)`,
      api.default.url,
    );
    expect(thumbnailsNeedRefresh(env.db, "dQw4w9WgXcQ", api)).toBe(false);
    expect(thumbnailsNeedRefresh(env.db, "dQw4w9WgXcQ", undefined)).toBe(false);
    expect(
      thumbnailsNeedRefresh(env.db, "dQw4w9WgXcQ", { default: { url: `${api.default.url}?2` } }),
    ).toBe(true);
  });

  it("reports an unwritable meta dir as a failure", async () => {
    seed();
    const deps = {
      ...env.deps(),
      config: { ...env.config, metaDir: join(env.temp.dir, "cellar.db") },
      fetch: () => Promise.resolve(new Response("bytes")),
    };
    const result = await refreshThumbnails(deps, {
      videoId: "dQw4w9WgXcQ",
      channelId: RICK,
      urls: new Map([["default", "https://t/d.jpg"]]),
    });
    expect(result).toEqual({ stored: 0, unchanged: 0, missing: 0, failed: 1 });
  });
});

describe("channel rename", () => {
  it("reindexes the channel's videos so search and later updates keep working", () => {
    ensureChannel(env.db, { id: RICK, title: "Old Name" }, NOW);
    recordSighting(
      env.db,
      { videoId: "dQw4w9WgXcQ", channelId: RICK, fill: { title: "Never gonna" }, sources: [] },
      NOW,
    );
    ensureChannel(env.db, { id: RICK, title: "Fresh Name" }, NOW + 1);
    const search = (q: string): string[] =>
      listVideos(env.db, { q, page: 1, perPage: 10 } as never).rows.map((row) => row.id);
    expect(search("Fresh")).toEqual(["dQw4w9WgXcQ"]);
    expect(search("Old")).toEqual([]);
    // The update trigger deletes with the current channel title: no corruption.
    env.db.run("UPDATE videos SET title = 'Give you up' WHERE id = 'dQw4w9WgXcQ'");
    expect(search("give")).toEqual(["dQw4w9WgXcQ"]);
    expect(search("never")).toEqual([]);
  });
});
