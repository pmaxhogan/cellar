import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CheckRowSchema,
  ChecksListResponseSchema,
  LatestCheckResponseSchema,
  ToolsResponseSchema,
} from "@cellar/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { YOUTUBE_FAVICON_URL } from "../src/domain/selfcheck.ts";
import {
  createSystemDeps,
  listLocationsFallback,
  readSettingsFallback,
  startSystemSchedules,
  type SystemDeps,
} from "../src/domain/systemDeps.ts";
import { createConsoleLogger } from "../src/logging.ts";
import { readToolState, updateToolState } from "../src/media/tools.ts";
import { systemRoutes } from "../src/routes/system.ts";
import { toApiError } from "../src/routes/validate.ts";
import { createTempApp, createTempDb, type TempApp, type TempDb } from "./helpers.ts";
import {
  bytes,
  githubRoutes,
  routedFetch,
  scriptRunFile,
  settingsWith,
  TAR,
  versionScript,
} from "./systemHelpers.ts";

const log = createConsoleLogger("silent");

let dir: string;
let binDir: string;
let temp: TempDb;
let app: FastifyInstance;

function makeDeps(overrides: Partial<SystemDeps> = {}): SystemDeps {
  return {
    db: temp.db,
    log,
    config: {
      dataDir: dir,
      tmpDir: join(dir, "tmp"),
      binDir,
      baselineBinDir: join(dir, "baseline"),
      potProviderUrl: "http://bgutil:4416",
    },
    runTool: async ({ tool }) => ({
      code: 0,
      stdout: tool === "yt-dlp" ? "2026.08.19\n" : `${tool} version 7.1\n`,
      stderr: "",
    }),
    runFile: scriptRunFile,
    fetch: routedFetch(githubRoutes({ ytdlpTag: "2026.09.01" })).fetch,
    listLocations: () => [],
    accounts: {
      list: () => [],
      checkApi: () => Promise.resolve({ ok: true, detail: "" }),
      checkCookies: () => Promise.resolve({ ok: true, detail: "" }),
    },
    proxies: { listDecrypted: () => [] },
    getSettings: () => settingsWith(),
    notify: vi.fn(),
    statfs: () => Promise.resolve({ free: 100 * 1024 ** 3, total: 1024 ** 4 }),
    isSeparateMount: () => Promise.resolve(true),
    tarCommand: TAR,
    ...overrides,
  };
}

async function buildRoutes(deps: SystemDeps): Promise<FastifyInstance> {
  const instance = Fastify();
  instance.setErrorHandler((error, _request, reply) => {
    const { status, body } = toApiError(error);
    void reply.code(status).send(body);
  });
  await instance.register(systemRoutes, { prefix: "/api", deps });
  return instance;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "cellar-system-"));
  binDir = join(dir, "bin");
  mkdirSync(binDir);
  temp = createTempDb();
  app = await buildRoutes(makeDeps());
});

afterEach(async () => {
  await app.close();
  temp.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("/api/tools", () => {
  it("reports versions and settings", async () => {
    updateToolState(temp.db, (state) => {
      state.ytdlp.current = "2026.08.19";
    });
    const response = await app.inject({ method: "GET", url: "/api/tools" });
    expect(response.statusCode).toBe(200);
    const body = ToolsResponseSchema.parse(response.json());
    expect(body).toMatchObject({
      ytdlp: { current: "2026.08.19", update_available: false },
      ffmpeg: { current: null, asset_updated_at: null },
      js_runtime: "node",
      pot_provider_url: "http://bgutil:4416",
      auto_update: true,
    });
    expect(body.outcomes).toBeUndefined();
  });

  it("updates on demand and rolls back", async () => {
    writeFileSync(join(binDir, "yt-dlp"), versionScript("2026.08.19"));
    updateToolState(temp.db, (state) => {
      state.ytdlp.current = "2026.08.19";
    });
    const update = await app.inject({
      method: "POST",
      url: "/api/tools/update",
      payload: { tool: "ytdlp" },
    });
    expect(update.statusCode).toBe(200);
    const updated = ToolsResponseSchema.parse(update.json());
    expect(updated.outcomes).toEqual([
      expect.objectContaining({ tool: "ytdlp", status: "updated" }),
    ]);
    expect(updated.ytdlp).toMatchObject({ current: "2026.09.01", previous: "2026.08.19" });

    const forced = await app.inject({
      method: "POST",
      url: "/api/tools/update",
      payload: { tool: "ytdlp", force: true },
    });
    expect(ToolsResponseSchema.parse(forced.json()).outcomes?.[0]?.status).toBe("updated");

    const rollback = await app.inject({
      method: "POST",
      url: "/api/tools/rollback",
      payload: { tool: "ytdlp" },
    });
    expect(rollback.statusCode).toBe(200);
    expect(ToolsResponseSchema.parse(rollback.json()).ytdlp.rolled_back_from).toBe("2026.09.01");
    expect(readFileSync(join(binDir, "yt-dlp"), "utf8")).toBe(versionScript("2026.09.01"));
  });

  it("checks every tool with an empty body and reports failures in outcomes", async () => {
    const response = await app.inject({ method: "POST", url: "/api/tools/update" });
    expect(response.statusCode).toBe(200);
    const body = ToolsResponseSchema.parse(response.json());
    expect(body.outcomes?.map((outcome) => outcome.tool)).toEqual(["ytdlp", "ffmpeg"]);
    expect(body.outcomes?.[1]?.status).toBe("failed");
    expect(readToolState(temp.db).ffmpeg.last_error).toMatch(/fetch failed/);
  });

  it("validates bodies and refuses a rollback with nothing to roll back to", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/api/tools/update",
      payload: { tool: "youtube-dl" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: "invalid" });
    const missing = await app.inject({ method: "POST", url: "/api/tools/rollback", payload: {} });
    expect(missing.statusCode).toBe(400);
    const nothing = await app.inject({
      method: "POST",
      url: "/api/tools/rollback",
      payload: { tool: "ffmpeg" },
    });
    expect(nothing.statusCode).toBe(412);
    expect(nothing.json()).toMatchObject({ code: "precondition_failed" });
  });
});

describe("/api/checks", () => {
  it("runs, lists and returns the latest run", async () => {
    const empty = await app.inject({ method: "GET", url: "/api/checks/latest" });
    expect(LatestCheckResponseSchema.parse(empty.json())).toEqual({ row: null });

    const run = await app.inject({ method: "POST", url: "/api/checks/run" });
    expect(run.statusCode).toBe(200);
    const row = CheckRowSchema.parse(run.json());
    expect(row.trigger).toBe("manual");
    // The fake fetch only knows GitHub, so the network checks fail.
    expect(row.ok).toBe(false);

    await app.inject({ method: "POST", url: "/api/checks/run" });
    const list = await app.inject({ method: "GET", url: "/api/checks?limit=1" });
    const rows = ChecksListResponseSchema.parse(list.json()).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(row.id + 1);

    const latest = await app.inject({ method: "GET", url: "/api/checks/latest" });
    expect(LatestCheckResponseSchema.parse(latest.json()).row?.id).toBe(row.id + 1);

    const all = await app.inject({ method: "GET", url: "/api/checks" });
    expect(ChecksListResponseSchema.parse(all.json()).rows).toHaveLength(2);
  });

  it("validates the limit", async () => {
    for (const limit of ["0", "201", "x"]) {
      const response = await app.inject({ method: "GET", url: `/api/checks?limit=${limit}` });
      expect(response.statusCode).toBe(400);
    }
  });
});

describe("mounted in the real app", () => {
  let real: TempApp;

  beforeEach(async () => {
    real = await createTempApp();
  });

  afterEach(async () => {
    await real.close();
  });

  it("serves /api/tools and /api/checks with the default deps", async () => {
    const tools = await real.app.inject({ method: "GET", url: "/api/tools" });
    expect(tools.statusCode).toBe(200);
    expect(ToolsResponseSchema.parse(tools.json()).pot_provider_url).toBe("http://bgutil:4416");
    const latest = await real.app.inject({ method: "GET", url: "/api/checks/latest" });
    expect(latest.json()).toEqual({ row: null });
  });

  it("keeps the JSON 404 for unknown API paths", async () => {
    const response = await real.app.inject({ method: "GET", url: "/api/tools/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "not_found" });
  });
});

describe("systemDeps fallbacks", () => {
  it("reads sparse settings over the defaults and survives bad rows", () => {
    const insert = (key: string, value: string) =>
      temp.db.run(
        "INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, 0)",
        key,
        value,
      );
    insert("tools.auto_update", "false");
    insert("not.a.key", "1");
    insert("selfcheck.interval_hours", "{broken");
    const settings = readSettingsFallback(temp.db);
    expect(settings["tools.auto_update"]).toBe(false);
    expect(settings["selfcheck.interval_hours"]).toBe(24);

    insert("reaper.high_water_pct", "5000");
    const warn = vi.fn();
    expect(
      readSettingsFallback(temp.db, { warn } as unknown as SystemDeps["log"])["tools.auto_update"],
    ).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it("lists the seeded location", () => {
    const [first] = listLocationsFallback(temp.db);
    expect(first).toMatchObject({ id: 1, enabled: true, quota_bytes: 0, used_bytes: 0 });
  });

  it("builds working default deps", async () => {
    const real = await createTempApp();
    try {
      const deps = createSystemDeps({ config: real.config, log, db: real.db });
      expect(deps.accounts.list()).toEqual([]);
      expect(deps.proxies.listDecrypted()).toEqual([]);
      await expect(deps.accounts.checkApi(1)).resolves.toMatchObject({ ok: false });
      await expect(deps.accounts.checkCookies(1)).resolves.toMatchObject({ ok: false });
      expect(deps.listLocations()).toHaveLength(1);
      expect(deps.getSettings()["tools.auto_update"]).toBe(true);
      await deps.notify("selfcheck_failed", "t", "b");
      const response = await deps.fetch("data:text/plain,hello");
      expect(await response.text()).toBe("hello");
      expect(deps.runTool).toBeTypeOf("function");
    } finally {
      await real.close();
    }
  });

  it("starts the boot self-check and the timers, then stops", async () => {
    const baseline = join(dir, "baseline");
    mkdirSync(baseline);
    const deps = makeDeps({
      fetch: routedFetch({ [YOUTUBE_FAVICON_URL]: () => bytes("ico") }).fetch,
    });
    const stop = startSystemSchedules(deps);
    await expect
      .poll(() => temp.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM checks")?.n)
      .toBe(1);
    stop();

    const warn = vi.fn();
    const broken = makeDeps({
      log: { ...log, warn, info: vi.fn() } as unknown as SystemDeps["log"],
      db: {
        ...temp.db,
        run: () => {
          throw new Error("read only");
        },
      },
    });
    const stopBroken = startSystemSchedules(broken);
    await expect
      .poll(() => warn.mock.calls.map((call) => call[1]))
      .toEqual(
        expect.arrayContaining([
          "could not record baseline tool versions",
          "self-check run failed",
        ]),
      );
    stopBroken();
  });
});
