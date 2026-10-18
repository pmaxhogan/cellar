import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckRowSchema, type CheckLevel, type CheckRow } from "@cellar/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../src/db/db.ts";
import { setKv } from "../src/db/kv.ts";
import { migrate } from "../src/db/migrate.ts";
import {
  CLOCK_REFERENCE_URL,
  formatBytes,
  lastCheck,
  listChecks,
  nvencAvailable,
  NVENC_CACHE_MS,
  redactProxy,
  resetNvencCache,
  runSelfCheck,
  startSelfCheckSchedule,
  VAPID_KV_KEY,
  YOUTUBE_FAVICON_URL,
  type SelfCheckDeps,
} from "../src/domain/selfcheck.ts";
import { createConsoleLogger } from "../src/logging.ts";
import { updateToolState, type RunTool, type RunToolResult } from "../src/media/tools.ts";
import { createTempDb, type TempDb } from "./helpers.ts";
import {
  bytes,
  fakeRunTool,
  json,
  networkError,
  routedFetch,
  settingsWith,
  type Route,
} from "./systemHelpers.ts";

const log = createConsoleLogger("silent");
const GB = 1024 ** 3;
/** A whole second, so the Date header round trips exactly. */
const NOW = 1_760_000_000_000;
const POT = "http://bgutil:4416";

let dir: string;
let mediaDir: string;
let temp: TempDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cellar-selfcheck-"));
  mediaDir = join(dir, "media");
  mkdirSync(mediaDir);
  temp = createTempDb();
  resetNvencCache();
});

afterEach(() => {
  temp.close();
  rmSync(dir, { recursive: true, force: true });
});

const result = (stdout: string, code: number | null = 0): RunToolResult => ({
  code,
  stdout,
  stderr: "",
});

/** Instant canned tool output; individual tests override single answers. */
function stubRunTool(
  override: (tool: string, args: readonly string[]) => RunToolResult | null | undefined = () =>
    undefined,
): RunTool {
  return async ({ tool, args }) => {
    const custom = override(tool, args);
    if (custom === null) {
      throw Object.assign(new Error(`spawn ${tool} ENOENT`), { code: "ENOENT" });
    }
    if (custom !== undefined) {
      return custom;
    }
    if (tool === "yt-dlp") return result("2026.08.19\n");
    if (args.includes("-version")) return result(`${tool} version 7.1 Copyright\n`);
    if (args.includes("-encoders")) return result(" V....D libx264\n");
    if (args.includes("-hwaccels")) return result("Hardware acceleration methods:\n");
    if (tool === "ffprobe") {
      return result(
        JSON.stringify({
          streams: [{ codec_type: "video" }, { codec_type: "audio" }],
          format: { duration: "1.020000" },
        }),
      );
    }
    return result("");
  };
}

function healthyRoutes(dateMs = NOW): Record<string, Route> {
  return {
    [`${POT}/ping`]: () => json({ version: "1.2.3", server_uptime: 5 }),
    [YOUTUBE_FAVICON_URL]: () => bytes("ico"),
    [CLOCK_REFERENCE_URL]: () =>
      new Response(null, { headers: { date: new Date(dateMs).toUTCString() } }),
  };
}

function makeDeps(overrides: Partial<SelfCheckDeps> = {}): SelfCheckDeps {
  return {
    db: temp.db,
    log,
    config: { dataDir: dir, tmpDir: join(dir, "tmp"), potProviderUrl: POT },
    runTool: stubRunTool(),
    fetch: routedFetch(healthyRoutes()).fetch,
    listLocations: () => [
      { id: 1, label: "Media", container_path: mediaDir, quota_bytes: 0, enabled: true },
    ],
    accounts: {
      list: () => [],
      checkApi: () => Promise.resolve({ ok: true, detail: "api ok" }),
      checkCookies: () => Promise.resolve({ ok: true, detail: "cookies ok" }),
    },
    proxies: { listDecrypted: () => [] },
    getSettings: () => settingsWith(),
    notify: vi.fn(),
    now: () => NOW,
    statfs: () => Promise.resolve({ free: 100 * GB, total: 1000 * GB }),
    isSeparateMount: () => Promise.resolve(true),
    ...overrides,
  };
}

function levels(row: CheckRow): Record<string, CheckLevel> {
  return Object.fromEntries(row.results.map((entry) => [entry.key, entry.level]));
}

function find(row: CheckRow, key: string) {
  const entry = row.results.find((candidate) => candidate.key === key);
  if (entry === undefined) {
    throw new Error(`no result ${key}`);
  }
  return entry;
}

describe("runSelfCheck with the fake-bin tools", () => {
  it("passes on a healthy install and stores the run", async () => {
    setKv(temp.db, VAPID_KV_KEY, { publicKey: "p", privateKey: "k" });
    const deps = makeDeps({ runTool: fakeRunTool(join(dir, "bin"), { FAKE_FFMPEG_NVENC: "1" }) });
    const row = await runSelfCheck(deps, "manual");

    expect(CheckRowSchema.parse(row)).toEqual(row);
    expect(levels(row)).toEqual({
      "data.writable": "ok",
      "data.free_space": "ok",
      "location.1.mounted": "ok",
      "location.1.writable": "ok",
      "location.1.free": "ok",
      "location.1.quota_headroom": "ok",
      "db.integrity": "ok",
      "db.wal": "ok",
      "db.migrations": "ok",
      "tools.ytdlp": "ok",
      "tools.ffmpeg": "ok",
      "tools.ffprobe": "ok",
      "tools.ffprobe_dry_run": "ok",
      "gpu.nvenc": "ok",
      "gpu.nvdec": "ok",
      "pot.sidecar": "ok",
      "youtube.favicon": "ok",
      "push.vapid": "ok",
      "clock.skew": "ok",
      "tools.updates": "skip",
    });
    expect(find(row, "tools.ytdlp").value).toBe("2026.08.19-fake");
    expect(find(row, "gpu.nvenc").value).toBe("hevc_nvenc,h264_nvenc");
    expect(find(row, "pot.sidecar").value).toBe("1.2.3");
    expect(find(row, "clock.skew").value).toBe(-500);
    expect(row).toMatchObject({ ok: true, trigger: "manual", run_at: NOW });
    expect(deps.notify).not.toHaveBeenCalled();
    expect(lastCheck(temp.db)).toEqual(row);
    expect(listChecks(temp.db, 10)).toEqual([row]);
    expect(await nvencAvailable(deps)).toEqual({ hevc: true, h264: true, nvdec: true });
  });

  it("warns, not fails, without NVENC", async () => {
    for (const env of [{ FAKE_FFMPEG_NVENC: "0" }, {}] as Record<string, string>[]) {
      resetNvencCache();
      const row = await runSelfCheck(
        makeDeps({ runTool: fakeRunTool(join(dir, "bin"), env) }),
        "boot",
      );
      expect(find(row, "gpu.nvenc")).toMatchObject({ level: "warn" });
      expect(find(row, "gpu.nvenc").detail).toMatch(/no NVENC encoder/);
      expect(find(row, "gpu.nvdec").level).toBe("warn");
      expect(row.ok).toBe(true);
    }
  });

  it("warns when NVENC is listed but a test encode fails", async () => {
    const runTool = fakeRunTool(join(dir, "bin"), {
      FAKE_FFMPEG_NVENC: "1",
      FAKE_FFMPEG_SCENARIO: JSON.stringify({ nvenc: "0" }),
    });
    const row = await runSelfCheck(makeDeps({ runTool }), "manual");
    expect(find(row, "gpu.nvenc").detail).toMatch(/test encode failed/);
    expect(find(row, "gpu.nvenc").level).toBe("warn");
    expect(await nvencAvailable({ runTool })).toEqual({ hevc: false, h264: false, nvdec: true });
  });

  it("fails the tool checks and notifies when the tools are missing", async () => {
    const missing = JSON.stringify([join(dir, "no-such-binary")]);
    const deps = makeDeps({
      runTool: fakeRunTool(join(dir, "bin"), {
        CELLAR_TOOL_YT_DLP: missing,
        CELLAR_TOOL_FFMPEG: missing,
        CELLAR_TOOL_FFPROBE: missing,
      }),
    });
    const row = await runSelfCheck(deps, "schedule");
    expect(levels(row)).toMatchObject({
      "tools.ytdlp": "fail",
      "tools.ffmpeg": "fail",
      "tools.ffprobe": "fail",
      "tools.ffprobe_dry_run": "skip",
      "gpu.nvenc": "skip",
      "gpu.nvdec": "skip",
    });
    expect(row.ok).toBe(false);
    expect(deps.notify).toHaveBeenCalledWith(
      "selfcheck_failed",
      "Self-check: 3 checks failed",
      expect.stringContaining("yt-dlp: yt-dlp was not found."),
    );
    expect(lastCheck(temp.db)?.ok).toBe(false);
  });

  it("fails the dry run when ffprobe disagrees about the clip", async () => {
    const row = await runSelfCheck(
      makeDeps({ runTool: fakeRunTool(join(dir, "bin"), { FAKE_FFPROBE_DURATION: "212.5" }) }),
      "manual",
    );
    expect(find(row, "tools.ffprobe_dry_run")).toMatchObject({ level: "fail" });
    expect(find(row, "tools.ffprobe_dry_run").detail).toMatch(/212.5 s/);
    expect(row.ok).toBe(false);
  });
});

describe("runSelfCheck: tool failure paths", () => {
  async function dryRun(
    override: (tool: string, args: readonly string[]) => RunToolResult | null | undefined,
  ): Promise<string> {
    const row = await runSelfCheck(makeDeps({ runTool: stubRunTool(override) }), "manual");
    const entry = find(row, "tools.ffprobe_dry_run");
    return `${entry.level}: ${entry.detail}`;
  }

  const probeJson = (body: unknown) => (tool: string, args: readonly string[]) =>
    tool === "ffprobe" && args.includes("-show_streams") ? result(JSON.stringify(body)) : undefined;

  it("reports each way the dry run can fail", async () => {
    expect(
      await dryRun((tool, args) =>
        tool === "ffmpeg" && args.includes("-y") ? result("", 1) : undefined,
      ),
    ).toBe("fail: ffmpeg could not make the test clip (exit 1).");
    expect(
      await dryRun((tool, args) => (tool === "ffmpeg" && args.includes("-y") ? null : undefined)),
    ).toBe("skip: ffmpeg is missing, so no test clip can be made.");
    expect(await dryRun((tool) => (tool === "ffprobe" ? null : undefined))).toBe(
      "fail: ffprobe was not found.",
    );
    expect(
      await dryRun((tool, args) =>
        tool === "ffprobe" && args.includes("-show_streams") ? result("", 1) : undefined,
      ),
    ).toBe("fail: ffprobe could not read the test clip (exit 1).");
    expect(
      await dryRun((tool, args) =>
        tool === "ffprobe" && args.includes("-show_streams") ? result("not json") : undefined,
      ),
    ).toMatch(/^fail: ffprobe printed something/);
    expect(
      await dryRun(probeJson({ streams: [{ codec_type: "video" }], format: { duration: 1 } })),
    ).toMatch(/missing its video or audio/);
    expect(
      await dryRun(
        probeJson({ streams: [{ codec_type: "video" }, { codec_type: "audio" }], format: {} }),
      ),
    ).toMatch(/should last 1 s, ffprobe says NaN s/);
  });

  it("fails a version check that exits non-zero", async () => {
    const row = await runSelfCheck(
      makeDeps({ runTool: stubRunTool((tool) => (tool === "yt-dlp" ? result("", 2) : undefined)) }),
      "manual",
    );
    expect(find(row, "tools.ytdlp").detail).toBe("yt-dlp --version failed (exit 2).");
  });

  it("treats a failed encoder listing as no NVENC", async () => {
    const row = await runSelfCheck(
      makeDeps({
        runTool: stubRunTool((_tool, args) =>
          args.includes("-encoders") ? result("", 1) : undefined,
        ),
      }),
      "manual",
    );
    expect(find(row, "gpu.nvenc").level).toBe("warn");
  });
});

describe("nvencAvailable", () => {
  it("caches for ten minutes unless forced", async () => {
    let calls = 0;
    let now = NOW;
    const inner = stubRunTool((_tool, args) =>
      args.includes("-encoders") ? result(" V....D h264_nvenc\n") : undefined,
    );
    const runTool: RunTool = (request) => {
      calls += 1;
      return inner(request);
    };
    const deps = { runTool, now: () => now };
    expect(await nvencAvailable(deps)).toEqual({ hevc: false, h264: true, nvdec: false });
    const first = calls;
    await nvencAvailable(deps);
    expect(calls).toBe(first);
    await nvencAvailable(deps, { force: true });
    expect(calls).toBe(first * 2);
    now += NVENC_CACHE_MS + 1;
    await nvencAvailable(deps);
    expect(calls).toBe(first * 3);
  });

  it("reports nothing when ffmpeg is missing", async () => {
    expect(await nvencAvailable({ runTool: stubRunTool(() => null) })).toEqual({
      hevc: false,
      h264: false,
      nvdec: false,
    });
  });
});

describe("runSelfCheck: network checks", () => {
  it("fails or warns when nothing is reachable", async () => {
    const row = await runSelfCheck(makeDeps({ fetch: routedFetch().fetch }), "manual");
    expect(find(row, "pot.sidecar")).toMatchObject({
      level: "fail",
      detail:
        "The PO token provider is unreachable: fetch failed: getaddrinfo ENOTFOUND bgutil:4416",
    });
    expect(find(row, "youtube.favicon").level).toBe("fail");
    expect(find(row, "clock.skew").level).toBe("warn");
    expect(find(row, "clock.skew").detail).toMatch(/Could not reach/);
  });

  it("fails on HTTP errors and a ping without a version", async () => {
    const routes = healthyRoutes();
    routes[`${POT}/ping`] = () => json({ error: "down" }, 503);
    routes[YOUTUBE_FAVICON_URL] = () => bytes("blocked", 429);
    let row = await runSelfCheck(makeDeps({ fetch: routedFetch(routes).fetch }), "manual");
    expect(find(row, "pot.sidecar").detail).toBe("The PO token provider answered HTTP 503.");
    expect(find(row, "youtube.favicon").detail).toBe("youtube.com/favicon.ico answered HTTP 429.");

    routes[`${POT}/ping`] = () => bytes("pong");
    row = await runSelfCheck(makeDeps({ fetch: routedFetch(routes).fetch }), "manual");
    expect(find(row, "pot.sidecar").detail).toMatch(/did not report a version/);
  });

  it("uses an owner-set provider URL and skips a disabled one", async () => {
    const routes = healthyRoutes();
    routes["http://pot.lan:9000/ping"] = () => json({ version: 7 });
    let row = await runSelfCheck(
      makeDeps({
        fetch: routedFetch(routes).fetch,
        getSettings: () => settingsWith({ "tools.pot_provider_url": "http://pot.lan:9000/" }),
      }),
      "manual",
    );
    expect(find(row, "pot.sidecar")).toMatchObject({ level: "ok", value: "7" });
    row = await runSelfCheck(
      makeDeps({ getSettings: () => settingsWith({ "tools.pot_provider_url": "" }) }),
      "manual",
    );
    expect(find(row, "pot.sidecar").level).toBe("skip");
  });

  it("grades clock skew against Google's Date header", async () => {
    const skewOf = async (dateMs: number | null) => {
      const routes = healthyRoutes();
      routes[CLOCK_REFERENCE_URL] = () =>
        new Response(null, {
          headers: dateMs === null ? {} : { date: new Date(dateMs).toUTCString() },
        });
      const row = await runSelfCheck(makeDeps({ fetch: routedFetch(routes).fetch }), "manual");
      return find(row, "clock.skew");
    };
    expect((await skewOf(NOW - 60_000)).level).toBe("warn");
    expect((await skewOf(NOW - 60_000)).detail).toMatch(/59.5 s ahead of/);
    expect((await skewOf(NOW + 10 * 60_000)).level).toBe("fail");
    expect((await skewOf(NOW + 10 * 60_000)).detail).toMatch(/behind/);
    expect((await skewOf(null)).detail).toMatch(/no usable Date header/);
  });
});

describe("runSelfCheck: storage", () => {
  it("grades data and location free space", async () => {
    const at = async (free: number) => {
      const row = await runSelfCheck(
        makeDeps({ statfs: () => Promise.resolve({ free, total: 100 * GB }) }),
        "manual",
      );
      return [find(row, "data.free_space").level, find(row, "location.1.free").level];
    };
    expect(await at(5 * GB)).toEqual(["warn", "warn"]);
    expect(await at(0.5 * GB)).toEqual(["fail", "fail"]);
    expect(await at(50 * GB)).toEqual(["ok", "ok"]);
  });

  it("checks a location's mount, presence and quota headroom", async () => {
    const quota = 100 * GB;
    const row = await runSelfCheck(
      makeDeps({
        isSeparateMount: () => Promise.resolve(false),
        listLocations: () => [
          {
            id: 1,
            label: "A",
            container_path: mediaDir,
            quota_bytes: quota,
            enabled: true,
            used_bytes: 10 * GB,
          },
          {
            id: 2,
            label: "B",
            container_path: mediaDir,
            quota_bytes: quota,
            enabled: true,
            used_bytes: 96 * GB,
          },
          {
            id: 3,
            label: "C",
            container_path: mediaDir,
            quota_bytes: quota,
            enabled: true,
            used_bytes: quota,
          },
          { id: 4, label: "D", container_path: mediaDir, quota_bytes: quota, enabled: true },
          { id: 5, label: "E", container_path: join(dir, "absent"), quota_bytes: 0, enabled: true },
          {
            id: 6,
            label: "F",
            container_path: join(dir, "absent"),
            quota_bytes: 0,
            enabled: false,
          },
        ],
      }),
      "manual",
    );
    expect(levels(row)).toMatchObject({
      "location.1.mounted": "warn",
      "location.1.quota_headroom": "ok",
      "location.2.quota_headroom": "warn",
      "location.3.quota_headroom": "fail",
      "location.4.quota_headroom": "skip",
      "location.5.mounted": "fail",
      "location.5.writable": "skip",
      "location.5.free": "skip",
      "location.6.mounted": "skip",
      "location.6.writable": "skip",
      "location.6.free": "skip",
      "location.6.quota_headroom": "skip",
    });
    expect(find(row, "location.1.quota_headroom").value).toBe(90 * GB);
    expect(find(row, "location.1.quota_headroom").detail).toBe("10.0 GB of 100.0 GB used (10.0%).");
    expect(find(row, "location.3.quota_headroom").detail).toMatch(/^Over quota/);
  });

  it("fails a location whose path is a file, and a data dir that is not writable", async () => {
    const file = join(dir, "a-file");
    writeFileSync(file, "x");
    const row = await runSelfCheck(
      makeDeps({
        config: { dataDir: file, tmpDir: join(dir, "tmp"), potProviderUrl: POT },
        listLocations: () => [
          { id: 9, label: "File", container_path: file, quota_bytes: 0, enabled: true },
        ],
      }),
      "manual",
    );
    expect(find(row, "location.9.mounted").level).toBe("fail");
    expect(find(row, "data.writable").level).toBe("fail");
  });

  it("measures the real filesystem when no seam is given", async () => {
    const row = await runSelfCheck(
      makeDeps({ statfs: undefined, isSeparateMount: undefined }),
      "manual",
    );
    expect(["ok", "warn", "fail"]).toContain(find(row, "data.free_space").level);
    expect(find(row, "data.free_space").value).toBeTypeOf("number");
    expect(["ok", "warn"]).toContain(find(row, "location.1.mounted").level);
  });
});

describe("runSelfCheck: database, push and updates", () => {
  it("fails missing migrations and a bad integrity check, warns without WAL", async () => {
    temp.db.run("DELETE FROM migrations WHERE name = (SELECT MAX(name) FROM migrations)");
    const corrupt: Db = {
      ...temp.db,
      all: <T>(sql: string, ...params: never[]): T[] =>
        sql.includes("integrity_check")
          ? ([{ integrity_check: "row 5 missing from index x" }] as T[])
          : temp.db.all<T>(sql, ...params),
    };
    const row = await runSelfCheck(makeDeps({ db: corrupt }), "manual");
    expect(find(row, "db.migrations").level).toBe("fail");
    expect(find(row, "db.integrity").detail).toBe("integrity_check: row 5 missing from index x");

    const memory = openDb(":memory:");
    try {
      migrate(memory, log);
      const memoryRow = await runSelfCheck(makeDeps({ db: memory }), "manual");
      expect(find(memoryRow, "db.wal")).toMatchObject({ level: "warn", value: "memory" });
    } finally {
      memory.close();
    }
  });

  it("warns without VAPID keys", async () => {
    const row = await runSelfCheck(makeDeps(), "manual");
    expect(find(row, "push.vapid").level).toBe("warn");
  });

  it("summarises the tool update state", async () => {
    const updates = async () => find(await runSelfCheck(makeDeps(), "manual"), "tools.updates");
    updateToolState(temp.db, (state) => {
      state.ytdlp.current = "a";
      state.ytdlp.latest = "a";
      state.ytdlp.checked_at = 1;
      state.ffmpeg.latest = "t1";
      state.ffmpeg.asset_updated_at = "t1";
    });
    expect((await updates()).level).toBe("ok");
    updateToolState(temp.db, (state) => {
      state.ytdlp.latest = "b";
      state.ffmpeg.last_error = "fetch failed";
    });
    const summary = await updates();
    expect(summary.level).toBe("warn");
    expect(summary.detail).toBe(
      "yt-dlp b is available (installed a); ffmpeg update check failed: fetch failed.",
    );
    updateToolState(temp.db, (state) => {
      state.ytdlp.current = null;
      state.ytdlp.latest = null;
      state.ffmpeg.last_error = null;
      state.ffmpeg.latest = "t2";
    });
    expect((await updates()).detail).toBe("ffmpeg t2 is available (installed unknown).");
  });
});

describe("runSelfCheck: accounts and proxies", () => {
  it("reports each account's API token and cookie jar", async () => {
    const row = await runSelfCheck(
      makeDeps({
        accounts: {
          list: () => [
            { id: 1, label: "main" },
            { id: 2, label: "alt" },
          ],
          checkApi: (id) =>
            id === 1
              ? Promise.resolve({ ok: true, detail: "channels.list ok" })
              : Promise.reject(new Error("refresh token revoked")),
          checkCookies: (id) =>
            Promise.resolve(
              id === 1 ? { ok: true, detail: "jar ok" } : { ok: false, detail: "jar expired" },
            ),
        },
      }),
      "manual",
    );
    expect(levels(row)).toMatchObject({
      "account.1.api": "ok",
      "account.1.cookies": "ok",
      "account.2.api": "fail",
      "account.2.cookies": "fail",
    });
    expect(find(row, "account.2.api").detail).toBe("refresh token revoked");
    expect(find(row, "account.1.api").label).toBe('Account "main" API token');
  });

  it("times a hung check out at the budget", async () => {
    const row = await runSelfCheck(
      makeDeps({
        checkTimeoutMs: 50,
        accounts: {
          list: () => [{ id: 3, label: "slow" }],
          checkApi: () => new Promise(() => undefined),
          checkCookies: () => Promise.resolve({ ok: true, detail: "ok" }),
        },
      }),
      "manual",
    );
    expect(find(row, "account.3.api")).toMatchObject({
      level: "fail",
      detail: "timed out after 0 s",
    });
  });

  it("checks each proxy and never leaks its URL", async () => {
    const secretUrl = "http://alice:s3cr%40t@proxy.example:3128";
    const proxyFetch = vi.fn(async (_url: string, proxyUrl: string) => {
      if (proxyUrl === secretUrl) {
        throw new Error(`connect failed via ${secretUrl} as alice with s3cr@t`);
      }
      return proxyUrl.includes("blocked") ? 403 : 200;
    });
    const row = await runSelfCheck(
      makeDeps({
        proxyFetch,
        proxies: {
          listDecrypted: () => [
            { id: 1, label: "good", url: "http://good:1" },
            { id: 2, label: "blocked", url: "http://blocked:1" },
            { id: 3, label: "secret", url: secretUrl },
          ],
        },
      }),
      "manual",
    );
    expect(levels(row)).toMatchObject({ "proxy.1": "ok", "proxy.2": "fail", "proxy.3": "fail" });
    const stored = JSON.stringify(lastCheck(temp.db));
    expect(stored).not.toContain("s3cr");
    expect(stored).not.toContain("alice");
    expect(find(row, "proxy.3").detail).toBe(
      "Unreachable through this proxy: connect failed via [proxy] as [redacted] with [redacted]",
    );
  });

  it("probes through a real ProxyAgent by default", async () => {
    const url = "http://bob:hunter2@127.0.0.1:1";
    const row = await runSelfCheck(
      makeDeps({ proxies: { listDecrypted: () => [{ id: 7, label: "dead", url }] } }),
      "manual",
    );
    const entry = find(row, "proxy.7");
    expect(entry.level).toBe("fail");
    expect(entry.detail).not.toContain("hunter2");
    expect(entry.detail).not.toContain("bob");
  });
});

describe("runSelfCheck: resilience", () => {
  it("turns a list that cannot be produced into a failing result", async () => {
    const boom = (): never => {
      throw new Error("db locked");
    };
    const row = await runSelfCheck(
      makeDeps({
        listLocations: boom,
        accounts: {
          list: boom,
          checkApi: () => Promise.resolve({ ok: true, detail: "" }),
          checkCookies: () => Promise.resolve({ ok: true, detail: "" }),
        },
        proxies: { listDecrypted: boom },
        getSettings: boom,
      }),
      "manual",
    );
    expect(levels(row)).toMatchObject({ locations: "fail", accounts: "fail", proxies: "fail" });
    expect(find(row, "locations").detail).toBe("Could not list locations: db locked");
    // Defaults were used, so the registry default provider URL maps to the env one.
    expect(find(row, "pot.sidecar").level).toBe("ok");
  });

  it("still returns the run when the notifier throws", async () => {
    const row = await runSelfCheck(
      makeDeps({
        fetch: routedFetch().fetch,
        notify: () => Promise.reject(new Error("push down")),
      }),
      "manual",
    );
    expect(row.ok).toBe(false);
  });

  it("reads back a damaged row without crashing", () => {
    temp.db.run(
      "INSERT INTO checks (run_at, trigger, results_json, ok) VALUES (?, ?, ?, ?)",
      5,
      "cron",
      "{not json",
      1,
    );
    temp.db.run(
      "INSERT INTO checks (run_at, trigger, results_json, ok) VALUES (?, ?, ?, ?)",
      4,
      "boot",
      JSON.stringify([{ key: 1 }]),
      0,
    );
    expect(listChecks(temp.db, 5)).toEqual([
      { id: 1, run_at: 5, trigger: "manual", ok: true, results: [] },
      { id: 2, run_at: 4, trigger: "boot", ok: false, results: [] },
    ]);
  });
});

describe("startSelfCheckSchedule", () => {
  it("runs at boot and then on the interval", async () => {
    const stop = startSelfCheckSchedule(makeDeps(), { intervalMs: 20 });
    await expect
      .poll(() => listChecks(temp.db, 10).filter((row) => row.trigger === "schedule").length, {
        timeout: 10_000,
      })
      .toBeGreaterThan(0);
    stop();
    expect(listChecks(temp.db, 50).some((row) => row.trigger === "boot")).toBe(true);
  });

  it("survives a run that throws and a settings read that throws", async () => {
    const warn = vi.fn();
    const failingDb: Db = {
      ...temp.db,
      run: () => {
        throw new Error("disk I/O error");
      },
    };
    const stop = startSelfCheckSchedule(
      makeDeps({
        db: failingDb,
        log: { ...log, warn, info: vi.fn() } as unknown as SelfCheckDeps["log"],
      }),
    );
    await expect.poll(() => warn.mock.calls.length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledWith(
      { error: "disk I/O error", trigger: "boot" },
      "self-check run failed",
    );
    stop();

    const quiet = startSelfCheckSchedule(
      makeDeps({
        getSettings: () => {
          throw new Error("no settings");
        },
      }),
      { boot: false },
    );
    quiet();
  });
});

describe("helpers", () => {
  it("formats bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(3 * GB)).toBe("3.0 GB");
  });

  it("redacts proxy URLs and credentials", () => {
    expect(redactProxy("via socks5://u:p@h:1 down", "not a url")).toBe(
      "via socks5://[redacted]@h:1 down",
    );
    expect(redactProxy("x http://h:1 y", "http://h:1")).toBe("x [proxy] y");
  });

  it("network errors keep their cause", () => {
    expect(networkError("a.b").cause).toBeInstanceOf(Error);
  });
});
