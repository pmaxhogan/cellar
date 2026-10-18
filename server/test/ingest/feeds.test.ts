import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "../../src/domain/errors.ts";
import type { RecheckDeps } from "../../src/domain/recheck.ts";
import { updateSettings } from "../../src/domain/settings.ts";
import {
  feedErrorDetail,
  FeedError,
  fetchHistory,
  fetchWatchLater,
  parseFlatEntries,
} from "../../src/youtube/feeds.ts";
import { QuotaExhausted, scrapeUsage } from "../../src/youtube/quota.ts";
import { HISTORY_FIXTURE, IngestEnv, RICK, vid, WATCH_LATER_FIXTURE } from "./ingestHelpers.ts";

let env: IngestEnv;
let record: string;

function recordedArgv(): string[][] {
  if (!existsSync(record)) {
    return [];
  }
  return readFileSync(record, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as string[])
    .filter((argv) => !argv.includes("--version") && !argv.includes("--help"));
}

/** A flat playlist file of `count` synthetic entries. */
function playlistFile(count: number): string {
  const path = join(env.temp.dir, `playlist-${String(count)}.json`);
  const entries = Array.from({ length: count }, (_, i) => ({
    _type: "url",
    id: vid(i),
    url: `https://www.youtube.com/watch?v=${vid(i)}`,
    title: `Synthetic ${String(i)}`,
    duration: 60 + i,
    channel_id: RICK,
    channel: "Rick Astley",
  }));
  writeFileSync(path, JSON.stringify({ id: "history", _type: "playlist", entries }));
  return path;
}

beforeEach(async () => {
  env = await IngestEnv.create();
  record = join(env.temp.dir, "ytdlp.record");
  vi.stubEnv("FAKE_YTDLP_RECORD", record);
  vi.stubEnv("FAKE_YTDLP_PLAYLIST_FILE", HISTORY_FIXTURE);
});

afterEach(() => {
  vi.unstubAllEnvs();
  env.close();
});

describe("parseFlatEntries", () => {
  it("parses the history fixture, marking placeholders private without a title", () => {
    const doc = JSON.parse(readFileSync(HISTORY_FIXTURE, "utf8")) as unknown;
    const entries = parseFlatEntries(doc);
    expect(entries.map((e) => e.id)).toEqual([
      "dQw4w9WgXcQ",
      "jNQXAC9IVRw",
      "aircAruvnKk",
      "pRiVaTe0001",
      "WUvTyaaNkzM",
    ]);
    expect(entries[0]).toEqual({
      id: "dQw4w9WgXcQ",
      title: "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)",
      channelId: RICK,
      channelTitle: "Rick Astley",
      durationS: 213,
      privacy: null,
      isShort: false,
    });
    expect(entries[3]).toEqual({
      id: "pRiVaTe0001",
      title: null,
      channelId: null,
      channelTitle: null,
      durationS: null,
      privacy: "private",
      isShort: false,
    });
  });

  it("accepts a bare array, drops junk and duplicates, and reads shorts and deleted entries", () => {
    const entries = parseFlatEntries([
      null,
      "nope",
      { id: "short" },
      { id: "abcdefghijk", title: "[Deleted video]", url: "https://www.youtube.com/shorts/x" },
      { id: "abcdefghijk", title: "Duplicate" },
      { id: "bcdefghijkl", title: "  ", channel_id: "not-a-channel", duration: -4, uploader: "U" },
      { id: "cdefghijklm", duration: 12.6 },
    ]);
    expect(entries).toEqual([
      {
        id: "abcdefghijk",
        title: null,
        channelId: null,
        channelTitle: null,
        durationS: null,
        privacy: "removed",
        isShort: true,
      },
      {
        id: "bcdefghijkl",
        title: null,
        channelId: null,
        channelTitle: "U",
        durationS: null,
        privacy: null,
        isShort: null,
      },
      {
        id: "cdefghijklm",
        title: null,
        channelId: null,
        channelTitle: null,
        durationS: 13,
        privacy: null,
        isShort: null,
      },
    ]);
    expect(parseFlatEntries({ entries: "x" })).toEqual([]);
    expect(parseFlatEntries(42)).toEqual([]);
  });
});

describe("feedErrorDetail", () => {
  it("masks the jar path, prefers the last ERROR line and caps the length", () => {
    expect(
      feedErrorDetail("[info] x\nERROR: bad /tmp/jar.txt here\nWARNING: y\n", "/tmp/jar.txt"),
    ).toBe("ERROR: bad <cookies> here");
    expect(feedErrorDetail("", "/j")).toBe("yt-dlp failed without an error message");
    expect(feedErrorDetail(`ERROR: ${"x".repeat(400)}`, "/j")).toMatch(/^ERROR: x+\.\.\.$/);
    expect(feedErrorDetail("plain line", "/j")).toBe("plain line");
  });
});

describe("fetchHistory", () => {
  it("reads one page through the fake yt-dlp and counts one scrape request", async () => {
    const id = env.account();
    const run = await fetchHistory(env.deps(), id);
    expect(run.runs).toBe(1);
    expect(run.depth).toBe(50);
    expect(run.entries).toHaveLength(5);
    const argv = recordedArgv();
    expect(argv).toHaveLength(1);
    const call = argv[0] ?? [];
    expect(call).toContain("https://www.youtube.com/feed/history");
    expect(call).toEqual(expect.arrayContaining(["--flat-playlist", "-J"]));
    expect(call[call.indexOf("--playlist-end") + 1]).toBe("50");
    const jar = call[call.indexOf("--cookies") + 1] ?? "";
    expect(jar).toMatch(/cookies-[0-9a-f]+\.txt$/);
    // The decrypted jar is gone afterwards and never in the argv as content.
    expect(existsSync(jar)).toBe(false);
    expect(call.join(" ")).not.toContain("SID");
    expect(readdirSync(env.config.tmpDir)).toEqual([]);
    expect(scrapeUsage(env.deps(), id).used).toBe(1);
  });

  it("doubles the depth while the newest page has unknown ids, until the feed runs out", async () => {
    vi.stubEnv("FAKE_YTDLP_PLAYLIST_FILE", playlistFile(120));
    const id = env.account();
    const run = await fetchHistory(env.deps(), id);
    expect(run.runs).toBe(3);
    expect(run.depth).toBe(200);
    expect(run.entries).toHaveLength(120);
    const depths = recordedArgv().map((argv) => argv[argv.indexOf("--playlist-end") + 1]);
    expect(depths).toEqual(["50", "100", "200"]);
    expect(scrapeUsage(env.deps(), id).used).toBe(3);
  });

  it("stops once a page is all known, and at the max depth", async () => {
    vi.stubEnv("FAKE_YTDLP_PLAYLIST_FILE", playlistFile(300));
    const id = env.account();
    const known = new Set(Array.from({ length: 300 }, (_, i) => vid(i)).slice(50));
    const run = await fetchHistory(env.deps(), id, { isKnown: (v) => known.has(v) });
    expect(run.runs).toBe(2);
    expect(run.depth).toBe(100);

    const capped = await fetchHistory(env.deps(), id, { max: 100 });
    expect(capped.runs).toBe(2);
    expect(capped.entries).toHaveLength(100);
  });

  it("refuses once the account's hourly scrape budget is spent, without running yt-dlp", async () => {
    const id = env.account();
    updateSettings(env.db, { "quota.scrape_requests_per_hour": 1 });
    await fetchHistory(env.deps(), id);
    await expect(fetchHistory(env.deps(), id)).rejects.toBeInstanceOf(QuotaExhausted);
    expect(recordedArgv()).toHaveLength(1);
  });

  it("reports a yt-dlp failure as a FeedError with the jar path masked", async () => {
    vi.stubEnv("FAKE_YTDLP_FAIL", "1");
    const id = env.account();
    const error = await fetchHistory(env.deps(), id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FeedError);
    expect((error as Error).message).toMatch(/^ERROR: \[youtube:tab\]/);
    expect((error as Error).message).not.toContain(env.config.tmpDir);
  });

  it("rejects output that is not JSON, and a run that times out", async () => {
    const id = env.account();
    const tool = (script: string): RecheckDeps => ({
      ...env.deps(),
      config: {
        ...env.config,
        toolOverrides: { "yt-dlp": [process.execPath, "-e", script, "--"] },
      },
    });
    const junk = await fetchHistory(tool("process.stdout.write('not json')"), id).catch(
      (e: unknown) => e,
    );
    expect(junk).toBeInstanceOf(FeedError);
    expect((junk as Error).message).toBe("yt-dlp returned output that is not JSON.");

    const slow = await fetchWatchLater(
      tool("if (!process.argv.includes('--help')) setTimeout(() => {}, 10000)"),
      id,
      {
        timeoutMs: 200,
      },
    ).catch((e: unknown) => e);
    expect(slow).toBeInstanceOf(FeedError);
    expect((slow as Error).message).toBe("yt-dlp timed out reading the feed.");
  });

  it("needs a cookie jar", async () => {
    const id = env.account({ cookies: false });
    const error = await fetchHistory(env.deps(), id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).details).toEqual({ reason: "no_cookies" });
    expect(recordedArgv()).toHaveLength(0);
    expect(scrapeUsage(env.deps(), id).used).toBe(0);
  });
});

describe("fetchWatchLater", () => {
  it("lists the whole list in one run without a depth limit", async () => {
    vi.stubEnv("FAKE_YTDLP_PLAYLIST_FILE", WATCH_LATER_FIXTURE);
    const id = env.account();
    const run = await fetchWatchLater(env.deps(), id);
    expect(run.entries.map((e) => e.id)).toEqual(["HeQX2HjkcNo", "IHZwWFHWa-w", "9bZkp7q19f0"]);
    expect(run.runs).toBe(1);
    const call = recordedArgv()[0] ?? [];
    expect(call).toContain(":ytwatchlater");
    expect(call).not.toContain("--playlist-end");
  });
});
