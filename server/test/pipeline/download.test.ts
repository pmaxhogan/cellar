import { resolveSettings } from "@cellar/shared";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getKv, setKv } from "../../src/db/kv.ts";
import {
  accountCandidates,
  COOLDOWN_KV_KEY,
  downloadPayload,
  pickDownloadAccount,
  runDownload,
  YTDLP_LOG_FILE,
} from "../../src/jobs/handlers/download.ts";
import { sha256File } from "../../src/media/paths.ts";
import { setLocationPaused } from "../../src/media/rows.ts";
import {
  activityKinds,
  addMediaFile,
  addVideo,
  CHANNEL_ID,
  createHarness,
  makeCtx,
  mediaRows,
  setEffective,
  VIDEO_ID,
  type Harness,
} from "./harness.ts";

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

afterEach(() => {
  h.close();
});

function download(
  videoId: string = VIDEO_ID,
  payload: unknown = {},
  accountId: number | null = null,
): ReturnType<typeof makeCtx> & { run: Promise<void> } {
  const test = makeCtx(h, { type: "download", videoId, payload, accountId });
  return { ...test, run: runDownload(h.deps, test.ctx) };
}

function recordedArgv(path: string): string[][] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
}

function queuedDownloads(): { id: number; run_after: number; status: string }[] {
  return h.db.all("SELECT id, run_after, status FROM jobs WHERE type = 'download' ORDER BY id");
}

describe("download happy path", () => {
  it("downloads with cookies and lands every file in its place", async () => {
    addVideo(h.db);
    setEffective(h, VIDEO_ID);
    h.sourcing.set(VIDEO_ID, [7]);
    h.withCookies = [7];
    h.env.FAKE_FFPROBE_VCODEC = "vp9";
    h.env.FAKE_YTDLP_VCODEC = "vp09";
    const record = join(h.root, "ytdlp.argv");
    h.env.FAKE_YTDLP_RECORD = record;

    const { run, progress, ctx } = download();
    await run;

    const videoDir = join(h.loc1, CHANNEL_ID, VIDEO_ID);
    const mediaPath = join(videoDir, `${VIDEO_ID}.webm`);
    expect(existsSync(mediaPath)).toBe(true);
    expect(existsSync(join(h.loc1, ".tmp", VIDEO_ID))).toBe(false);

    const metaDir = join(h.metaDir, CHANNEL_ID, VIDEO_ID);
    expect(existsSync(join(metaDir, "info.json"))).toBe(true);
    expect(existsSync(join(metaDir, "en.vtt"))).toBe(true);
    expect(existsSync(join(metaDir, "es.vtt"))).toBe(true);
    const thumbs = readdirSync(join(metaDir, "thumbnails"));
    expect(thumbs).toHaveLength(6);
    for (const name of thumbs) {
      const [variant, sha] = name.replace(/\.jpg$/, "").split("-") as [string, string];
      expect(await sha256File(join(metaDir, "thumbnails", name))).toBe(sha);
      expect(variant).toMatch(/default|hq720/);
    }
    const thumbRows = h.db.all<{ variant: string; url: string }>(
      "SELECT variant, url FROM thumbnails WHERE video_id = ?",
      VIDEO_ID,
    );
    expect(thumbRows).toHaveLength(6);
    expect(thumbRows.find((row) => row.variant === "maxresdefault")?.url).toContain(
      "maxresdefault",
    );

    const rows = mediaRows(h.db);
    const video = rows.find((row) => row.kind === "video");
    expect(video).toMatchObject({
      version: 1,
      is_current: 1,
      location_id: 1,
      rel_path: `${CHANNEL_ID}/${VIDEO_ID}/${VIDEO_ID}.webm`,
      size_bytes: 65536,
      vcodec: "vp9",
      acodec: "opus",
    });
    expect(video?.sha256).toBe(await sha256File(mediaPath));
    expect(
      rows.filter((row) => row.kind === "captions").map((row) => [row.lang, row.location_id]),
    ).toEqual([
      ["en", null],
      ["es", null],
    ]);
    expect(rows.find((row) => row.kind === "info")).toMatchObject({
      location_id: null,
      rel_path: `${CHANNEL_ID}/${VIDEO_ID}/info.json`,
    });

    const summary = h.db.get<Record<string, unknown>>(
      "SELECT max_height, has_av1, has_vp9, has_h264, formats_json FROM videos WHERE id = ?",
      VIDEO_ID,
    );
    expect(summary?.max_height).toBeGreaterThan(0);
    expect(summary?.has_vp9).toBe(1);
    expect(JSON.parse(String(summary?.formats_json)).length).toBeGreaterThan(3);

    // The account's jar was used and the rotated jar came back.
    expect(h.cookieCalls).toEqual([7]);
    expect(h.cookieJars.get(7)).toContain("FAKE_ROTATED_");
    const argv = recordedArgv(record)[0] as string[];
    expect(argv).toContain("--cookies");
    expect(argv).toContain("--write-all-thumbnails");

    // Progress streamed while downloading, then 100.
    const pcts = progress.map((entry) => entry.pct);
    expect(pcts.some((pct) => pct > 0 && pct <= 90)).toBe(true);
    expect(pcts.at(-1)).toBe(100);

    // The yt-dlp log has the run but never the jar contents.
    const log = readFileSync(join(ctx.logDir, YTDLP_LOG_FILE), "utf8");
    expect(log).toContain("[argv]");
    expect(log).not.toContain("secret-value");

    expect(activityKinds(h.db)).toContain("download.done");
    expect(h.events.some((event) => event.type === "video.media")).toBe(true);
    const transcode = h.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM jobs WHERE type = 'transcode' AND video_id = ?",
      VIDEO_ID,
    );
    expect(transcode?.n).toBe(1);
  });

  it("runs without cookies when no account has a jar, and skips transcode when off", async () => {
    addVideo(h.db);
    setEffective(h, VIDEO_ID, {
      effective: {
        transcode: {
          mode: "none",
          codec: "hevc_nvenc",
          quality: 28,
          preset: "p5",
          audio_codec: "copy",
        },
      },
    });
    const record = join(h.root, "ytdlp.argv");
    h.env.FAKE_YTDLP_RECORD = record;
    await download().run;
    expect(h.cookieCalls).toEqual([]);
    expect(recordedArgv(record)[0]).not.toContain("--cookies");
    expect(h.db.get("SELECT id FROM jobs WHERE type = 'transcode'")).toBeUndefined();
    expect(mediaRows(h.db).some((row) => row.kind === "video")).toBe(true);
  });

  it("stores audio-only downloads as audio rows", async () => {
    addVideo(h.db);
    setEffective(h, VIDEO_ID, { effective: { media_mode: "audio_only" } });
    h.env.FAKE_FFPROBE_SCENARIO = JSON.stringify({ noVideo: true });
    await download().run;
    const audio = mediaRows(h.db).find((row) => row.kind === "audio");
    expect(audio).toMatchObject({ vcodec: null, acodec: "opus", location_id: 1 });
    expect(h.db.get("SELECT id FROM jobs WHERE type = 'transcode'")).toBeUndefined();
  });

  it("falls back to yt-dlp's format info when ffprobe fails", async () => {
    addVideo(h.db);
    setEffective(h, VIDEO_ID);
    h.env.FAKE_FFPROBE_FAIL = "1";
    await download().run;
    const video = mediaRows(h.db).find((row) => row.kind === "video");
    expect(video?.vcodec).toBe("av1");
  });

  it("needs no location for metadata_only", async () => {
    addVideo(h.db, VIDEO_ID, { channel_id: null });
    setEffective(h, VIDEO_ID, { effective: { media_mode: "metadata_only" } });
    h.db.run("UPDATE locations SET enabled = 0");
    await download().run;
    const rows = mediaRows(h.db);
    expect(rows.map((row) => row.kind)).toEqual(["info"]);
    // No channel in the catalog: the info dict's channel names the meta dir.
    expect(rows[0]?.rel_path).toBe(`${CHANNEL_ID}/${VIDEO_ID}/info.json`);
    expect(existsSync(join(h.metaDir, CHANNEL_ID, VIDEO_ID, "info.json"))).toBe(true);
    expect(existsSync(join(h.tmpDir, "meta-dl", VIDEO_ID))).toBe(false);
    // A second run finds the metadata and does nothing.
    await download().run;
    expect(mediaRows(h.db)).toHaveLength(1);
  });

  it("puts the media into the effective location", async () => {
    addVideo(h.db);
    setEffective(h, VIDEO_ID, { location_id: 2 });
    await download().run;
    expect(existsSync(join(h.loc2, CHANNEL_ID, VIDEO_ID, `${VIDEO_ID}.webm`))).toBe(true);
    expect(mediaRows(h.db).find((row) => row.kind === "video")?.location_id).toBe(2);
  });
});

describe("download skips and deferrals", () => {
  beforeEach(() => {
    addVideo(h.db);
  });

  async function expectSkipped(why: RegExp): Promise<void> {
    await download().run;
    expect(mediaRows(h.db).filter((row) => row.kind === "video")).toHaveLength(0);
    const activity = h.db.get<{ message: string }>(
      "SELECT message FROM activity WHERE kind = 'download.skipped' ORDER BY id DESC",
    );
    expect(activity?.message).toMatch(why);
  }

  it("skips excluded, pri 0, unevaluated and unknown videos", async () => {
    setEffective(h, VIDEO_ID, { include: false });
    await expectSkipped(/excludes/);
    setEffective(h, VIDEO_ID, { reclaim_priority: 0 });
    await expectSkipped(/priority is 0/);
    h.effective.clear();
    await expectSkipped(/evaluated/);
    const test = makeCtx(h, { type: "download", videoId: "aaaaaaaaaaa" });
    await runDownload(h.deps, test.ctx);
    expect(activityKinds(h.db).at(-1)).toBe("download.skipped");
    const invalid = makeCtx(h, { type: "download", videoId: "bad" });
    await runDownload(h.deps, invalid.ctx);
  });

  it("refuses paused, disabled and missing locations", async () => {
    setEffective(h, VIDEO_ID);
    setLocationPaused(h.db, 1, true, 1);
    await expectSkipped(/paused/);
    setLocationPaused(h.db, 1, false, 1);
    h.db.run("UPDATE locations SET enabled = 0");
    await expectSkipped(/missing or disabled/);
    setEffective(h, VIDEO_ID, { location_id: 99 });
    await expectSkipped(/missing or disabled/);
  });

  it("does nothing when current media exists and no reason is given", async () => {
    setEffective(h, VIDEO_ID);
    addMediaFile(h);
    const record = join(h.root, "ytdlp.argv");
    h.env.FAKE_YTDLP_RECORD = record;
    await download().run;
    expect(existsSync(record)).toBe(false);
  });

  it("defers until the delay after upload passed", async () => {
    h.db.run("UPDATE videos SET published_at = ? WHERE id = ?", h.clock.now - 60_000, VIDEO_ID);
    setEffective(h, VIDEO_ID, { effective: { delay_after_upload: "P1D" } });
    const { run, ctx } = download();
    await run;
    const jobs = queuedDownloads().filter((job) => job.id !== ctx.job.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.run_after).toBe(h.clock.now - 60_000 + 86_400_000);
    expect(activityKinds(h.db)).toContain("download.deferred");
    // A second deferral does not stack another row.
    const again = download();
    await again.run;
    expect(queuedDownloads()).toHaveLength(3);
    expect(queuedDownloads().filter((job) => job.status === "queued")).toHaveLength(1);
  });

  it("downloads once the delay passed", async () => {
    h.db.run(
      "UPDATE videos SET published_at = ? WHERE id = ?",
      h.clock.now - 2 * 86_400_000,
      VIDEO_ID,
    );
    setEffective(h, VIDEO_ID, { effective: { delay_after_upload: { days: 1 } } });
    await download().run;
    expect(mediaRows(h.db).some((row) => row.kind === "video")).toBe(true);
  });

  it("waits 15 minutes for upcoming and vod_only live videos", async () => {
    setEffective(h, VIDEO_ID);
    h.db.run("UPDATE videos SET live_status = 'is_upcoming' WHERE id = ?", VIDEO_ID);
    const first = download();
    await first.run;
    const deferred = queuedDownloads().find((job) => job.id !== first.ctx.job.id);
    expect(deferred?.run_after).toBe(h.clock.now + 15 * 60_000);
  });

  it("records live streams when the rule says so", async () => {
    setEffective(h, VIDEO_ID, { effective: { live: "record_live" } });
    h.db.run("UPDATE videos SET live_status = 'is_live' WHERE id = ?", VIDEO_ID);
    const record = join(h.root, "ytdlp.argv");
    h.env.FAKE_YTDLP_RECORD = record;
    await download().run;
    expect(recordedArgv(record)[0]).toContain("--live-from-start");
  });

  it("defers while a rate-limit cooldown is active", async () => {
    setEffective(h, VIDEO_ID);
    setKv(h.db, COOLDOWN_KV_KEY, { until: h.clock.now + 1000, ms: 1000 });
    const { run, ctx } = download();
    await run;
    expect(queuedDownloads().find((job) => job.id !== ctx.job.id)?.run_after).toBe(
      h.clock.now + 1000,
    );
  });
});

describe("download failures", () => {
  beforeEach(() => {
    addVideo(h.db);
    setEffective(h, VIDEO_ID);
  });

  it("rethrows a bot wall, counts it and trips the canary at the threshold", async () => {
    h.env.FAKE_YTDLP_FAIL = "1";
    const ids = [VIDEO_ID, "aircAruvnKk", "WUvTyaaNkzM"];
    for (const id of ids.slice(1)) {
      addVideo(h.db, id);
      setEffective(h, id);
    }
    await expect(download(ids[0]).run).rejects.toThrow(/bot_wall/);
    await expect(download(ids[1]).run).rejects.toThrow(/bot_wall/);
    expect(h.db.get("SELECT id FROM jobs WHERE type = 'canary'")).toBeUndefined();
    await expect(download(ids[2]).run).rejects.toThrow(/not a bot/);
    expect(h.db.get("SELECT id FROM jobs WHERE type = 'canary'")).toBeDefined();
    expect(h.db.get("SELECT id FROM notifications WHERE type = 'download_failures'")).toBeDefined();
    expect(existsSync(join(h.loc1, ".tmp", VIDEO_ID))).toBe(false);
  });

  it("marks private videos and does not retry", async () => {
    h.env.FAKE_YTDLP_FAIL = "1";
    h.env.FAKE_YTDLP_FAIL_MESSAGE =
      "Private video. Sign in if you've been granted access to this video";
    await download().run;
    expect(
      h.db.get<{ privacy: string }>("SELECT privacy FROM videos WHERE id = ?", VIDEO_ID)?.privacy,
    ).toBe("private");
    expect(activityKinds(h.db)).toContain("download.unavailable");
    expect(getKv(h.db, "notify.download_failures")).toBeUndefined();
  });

  it("sets an escalating cooldown on a rate limit", async () => {
    h.env.FAKE_YTDLP_FAIL = "1";
    h.env.FAKE_YTDLP_FAIL_MESSAGE = "HTTP Error 429: Too Many Requests";
    await expect(download().run).rejects.toThrow(/rate_limited/);
    const first = getKv<{ until: number; ms: number }>(h.db, COOLDOWN_KV_KEY);
    expect(first?.ms).toBe(30 * 60_000);
    h.clock.now = (first?.until ?? 0) + 1;
    await expect(download().run).rejects.toThrow(/rate_limited/);
    expect(getKv<{ ms: number }>(h.db, COOLDOWN_KV_KEY)?.ms).toBe(60 * 60_000);
  });

  it("counts connection errors against the proxy and notifies at three", async () => {
    setEffective(h, VIDEO_ID, { effective: { proxy: "pool" } });
    h.proxyToUse = { id: 4, url: "http://user:pass@proxy.example:3128" };
    h.env.FAKE_YTDLP_FAIL = "1";
    h.env.FAKE_YTDLP_FAIL_MESSAGE =
      "Unable to download webpage: <urlopen error Tunnel connection failed: http://user:pass@proxy.example:3128>";
    for (let i = 0; i < 3; i += 1) {
      const { run, ctx } = download();
      await expect(run).rejects.toThrow(/network/);
      const log = readFileSync(join(ctx.logDir, YTDLP_LOG_FILE), "utf8");
      expect(log).not.toContain("pass@");
      expect(log).toContain("proxy.example");
    }
    expect(h.proxyFailures).toEqual([4, 4, 4]);
    expect(h.db.get("SELECT id FROM notifications WHERE type = 'proxy_failing'")).toBeDefined();
  });

  it("marks the proxy ok after a success", async () => {
    setEffective(h, VIDEO_ID, { effective: { proxy: "pool" } });
    h.proxyToUse = { id: 5, url: "http://proxy.example:3128" };
    await download().run;
    expect(h.proxyOks).toEqual([5]);
  });

  it("aborts with the job", async () => {
    h.env.FAKE_YTDLP_DELAY_MS = "5000";
    const { run, controller } = download();
    setTimeout(() => {
      controller.abort("cancel");
    }, 300);
    await expect(run).rejects.toThrow(/aborted/);
    expect(mediaRows(h.db)).toHaveLength(0);
  });
});

describe("versions and re-downloads", () => {
  beforeEach(() => {
    addVideo(h.db);
    setEffective(h, VIDEO_ID);
  });

  it("keeps the old current media under versions/v1 for a YouTube-side edit", async () => {
    const old = addMediaFile(h, { size: 10 });
    await download(VIDEO_ID, { reason: "version" }).run;
    const rows = mediaRows(h.db).filter((row) => row.kind === "video");
    expect(rows).toHaveLength(2);
    const kept = rows.find((row) => row.id === old.id);
    expect(kept).toMatchObject({
      is_current: 0,
      version: 1,
      rel_path: `${CHANNEL_ID}/${VIDEO_ID}/versions/v1/${VIDEO_ID}.webm`,
    });
    expect(
      existsSync(join(h.loc1, CHANNEL_ID, VIDEO_ID, "versions", "v1", `${VIDEO_ID}.webm`)),
    ).toBe(true);
    const current = rows.find((row) => row.is_current === 1);
    expect(current?.version).toBe(2);
    expect(readFileSync(join(h.loc1, CHANNEL_ID, VIDEO_ID, `${VIDEO_ID}.webm`)).length).toBe(65536);
    expect(mediaRows(h.db).find((row) => row.kind === "info")?.rel_path).toContain("info.json");
  });

  it("replaces the current media for a redownload", async () => {
    const old = addMediaFile(h, {
      size: 10,
      rel: `${CHANNEL_ID}/${VIDEO_ID}/${VIDEO_ID}.mp4`,
      version: 3,
    });
    await download(VIDEO_ID, { reason: "redownload" }).run;
    const rows = mediaRows(h.db).filter((row) => row.kind === "video");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(3);
    expect(existsSync(old.path)).toBe(false);
  });

  it("starts a new version after the reaper deleted everything", async () => {
    await download().run;
    expect(mediaRows(h.db).find((row) => row.kind === "video")?.version).toBe(1);
  });

  it("dedupes thumbnails it already stored", async () => {
    await download().run;
    const before = h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM thumbnails")?.n;
    await download(VIDEO_ID, { reason: "redownload" }).run;
    expect(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM thumbnails")?.n).toBe(before);
    expect(mediaRows(h.db).filter((row) => row.kind === "captions")).toHaveLength(2);
  });
});

describe("account selection", () => {
  it("round-robins over sourcing accounts with cookies", () => {
    h.sourcing.set(VIDEO_ID, [3, 1, 2, 9]);
    h.withCookies = [1, 2, 3];
    expect(accountCandidates(h.deps, VIDEO_ID, "sourcing")).toEqual([1, 2, 3]);
    const picks = [1, 2, 3, 4].map(() => pickDownloadAccount(h.deps, VIDEO_ID, "sourcing"));
    expect(picks).toEqual([1, 2, 3, 1]);
    expect(pickDownloadAccount(h.deps, VIDEO_ID, "sourcing", 3)).toBe(3);
  });

  it("supports any and explicit lists, and null without cookies", () => {
    h.withCookies = [5, 6];
    expect(accountCandidates(h.deps, VIDEO_ID, "any")).toEqual([5, 6]);
    expect(accountCandidates(h.deps, VIDEO_ID, [6, 8])).toEqual([6]);
    h.withCookies = [];
    expect(pickDownloadAccount(h.deps, VIDEO_ID, "any")).toBeNull();
  });

  it("parses the payload", () => {
    expect(downloadPayload({ reason: "version" })).toEqual({ reason: "version" });
    expect(downloadPayload({ reason: "other" })).toEqual({});
    expect(downloadPayload(null)).toEqual({});
  });
});

describe("settings", () => {
  it("keeps only the configured thumbnail variants", async () => {
    addVideo(h.db);
    setEffective(h, VIDEO_ID);
    h.settings = resolveSettings({ "thumbnails.variants": ["hqdefault"] });
    await download().run;
    expect(h.db.all("SELECT variant FROM thumbnails")).toEqual([{ variant: "hqdefault" }]);
  });
});
