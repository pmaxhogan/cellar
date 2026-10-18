import {
  effectDefaults,
  resolveSettings,
  type EffectiveSettings,
  type ResolvedSettings,
} from "@cellar/shared";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "../../src/db/db.ts";
import { logActivity } from "../../src/domain/activity.ts";
import {
  notify,
  recordDownloadFailure,
  recordDownloadSuccess,
  recordFsError,
  recordStoragePressure,
} from "../../src/domain/notifications.ts";
import { EventBus, type CellarEvent } from "../../src/events.ts";
import type { PipelineDeps, PipelineEffective } from "../../src/jobs/pipelineDeps.ts";
import { JobQueue } from "../../src/jobs/queue.ts";
import { JobRegistry, type JobContext, type JobRecord } from "../../src/jobs/types.ts";
import { createConsoleLogger } from "../../src/logging.ts";
import type { NvencInfo } from "../../src/media/ffmpeg.ts";
import { createSpawnTool } from "../../src/media/spawn.ts";
import { createTempDb, type TempDb } from "../helpers.ts";

export const fakeBinDir = fileURLToPath(new URL("../../../scripts/fake-bin/", import.meta.url));

export const VIDEO_ID = "jNQXAC9IVRw";
export const CHANNEL_ID = "UC4QobU6STFB0P71PMvOGN5A";
export const COOKIE_JAR =
  "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1999999999\tSID\tsecret-value\n";

/** process.env without FAKE_* or CELLAR_TOOL_* leaking in, plus the shims as the tools. */
export function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("FAKE_") && !key.startsWith("CELLAR_TOOL_")) {
      env[key] = value;
    }
  }
  env.FAKE_BIN_NODE = process.execPath;
  for (const tool of ["yt-dlp", "ffmpeg", "ffprobe"]) {
    const key = `CELLAR_TOOL_${tool.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
    env[key] = JSON.stringify([process.execPath, join(fakeBinDir, `${tool}.mjs`)]);
  }
  return env;
}

export interface Harness {
  temp: TempDb;
  db: Db;
  root: string;
  dataDir: string;
  metaDir: string;
  tmpDir: string;
  logsDir: string;
  loc1: string;
  loc2: string;
  /** Mutable: tests set FAKE_* keys here before running a job. */
  env: NodeJS.ProcessEnv;
  events: CellarEvent[];
  bus: EventBus;
  queue: JobQueue;
  registry: JobRegistry;
  settings: ResolvedSettings;
  effective: Map<string, PipelineEffective>;
  sourcing: Map<string, number[]>;
  withCookies: number[];
  nvencInfo: NvencInfo;
  cookieJars: Map<number, string>;
  cookieCalls: number[];
  proxyFailures: number[];
  proxyOks: number[];
  proxyToUse: { id: number; url: string } | null;
  schedules: { name: string; intervalMs: number; fn: () => unknown }[];
  freeBytes: number | null;
  clock: { now: number };
  deps: PipelineDeps;
  close(): void;
}

export function createHarness(): Harness {
  const temp = createTempDb();
  const root = mkdtempSync(join(tmpdir(), "cellar-pipe-"));
  const dataDir = join(root, "data");
  const metaDir = join(dataDir, "meta");
  const tmpDir = join(dataDir, "tmp");
  const logsDir = join(dataDir, "logs");
  const loc1 = join(root, "media1");
  const loc2 = join(root, "media2");
  for (const dir of [dataDir, metaDir, tmpDir, logsDir, loc1, loc2]) {
    mkdirSync(dir, { recursive: true });
  }
  const db = temp.db;
  db.run("UPDATE locations SET container_path = ? WHERE id = 1", loc1);
  db.run(
    `INSERT INTO locations (label, container_path, quota_bytes, enabled, created_at, updated_at)
     VALUES ('cold', ?, 0, 1, 1, 1)`,
    loc2,
  );

  const env = baseEnv();
  const bus = new EventBus();
  const events: CellarEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const registry = new JobRegistry();
  const clock = { now: 1_800_000_000_000 };
  const queue = new JobQueue(db, { registry, events: bus, now: () => clock.now });
  const log = createConsoleLogger("silent");
  const runTool = createSpawnTool({ binDir: join(root, "no-bin"), env, hasNice: () => false });

  const h = {
    temp,
    db,
    root,
    dataDir,
    metaDir,
    tmpDir,
    logsDir,
    loc1,
    loc2,
    env,
    events,
    bus,
    queue,
    registry,
    settings: resolveSettings({}),
    effective: new Map<string, PipelineEffective>(),
    sourcing: new Map<string, number[]>(),
    withCookies: [] as number[],
    nvencInfo: { hevc: false, h264: false, nvdec: false } as NvencInfo,
    cookieJars: new Map<number, string>(),
    cookieCalls: [] as number[],
    proxyFailures: [] as number[],
    proxyOks: [] as number[],
    proxyToUse: null as { id: number; url: string } | null,
    schedules: [] as { name: string; intervalMs: number; fn: () => unknown }[],
    freeBytes: null as number | null,
    clock,
  } as Omit<Harness, "deps" | "close">;

  const notifyDeps = { db, log, events: bus, getSettings: () => h.settings, now: () => clock.now };
  const deps: PipelineDeps = {
    db,
    log,
    events: bus,
    config: {
      dataDir,
      metaDir,
      tmpDir,
      potProviderUrl: "http://bgutil:4416",
      ytdlpPluginDirs: "/opt/cellar/yt-dlp-plugins",
    },
    now: () => clock.now,
    runTool,
    withCookiesFile: async (accountId, fn) => {
      h.cookieCalls.push(accountId);
      const path = join(tmpDir, `cookies-${String(accountId)}-${String(h.cookieCalls.length)}.txt`);
      writeFileSync(path, h.cookieJars.get(accountId) ?? COOKIE_JAR, { mode: 0o600 });
      try {
        return await fn(path);
      } finally {
        h.cookieJars.set(accountId, readFileSync(path, "utf8"));
        rmSync(path, { force: true });
      }
    },
    pickProxy: (policy) => (policy === "none" ? null : h.proxyToUse),
    markProxyFailure: (id) => {
      h.proxyFailures.push(id);
      return h.proxyFailures.filter((value) => value === id).length;
    },
    markProxyOk: (id) => {
      h.proxyOks.push(id);
    },
    getSettings: () => h.settings,
    getEffective: (videoId) => h.effective.get(videoId) ?? null,
    locations: () =>
      db
        .all<{ id: number; container_path: string; quota_bytes: number; enabled: number }>(
          "SELECT id, container_path, quota_bytes, enabled FROM locations ORDER BY id",
        )
        .map((row) => ({
          id: Number(row.id),
          container_path: row.container_path,
          quota_bytes: Number(row.quota_bytes),
          enabled: Number(row.enabled) === 1,
        })),
    sourcingAccountIds: (videoId) => h.sourcing.get(videoId) ?? [],
    accountsWithCookies: () => h.withCookies,
    nvenc: () => Promise.resolve(h.nvencInfo),
    notify: (input) => notify(notifyDeps, input),
    recordDownloadFailure: (videoId) => recordDownloadFailure(notifyDeps, videoId),
    recordDownloadSuccess: () => {
      recordDownloadSuccess(notifyDeps);
    },
    recordStoragePressure: (locationId, detail) =>
      recordStoragePressure(notifyDeps, locationId, detail),
    recordFsError: (detail) => recordFsError(notifyDeps, detail),
    logActivity: (input) => {
      logActivity({ db, events: bus, now: () => clock.now }, input);
    },
    enqueue: (input) => queue.enqueue(input),
    every: (name, intervalMs, fn) => {
      h.schedules.push({ name, intervalMs, fn });
    },
    registry,
    statfs: () =>
      h.freeBytes === null
        ? Promise.reject(new Error("no statfs"))
        : Promise.resolve({ free: h.freeBytes, total: h.freeBytes * 10 }),
  };

  return Object.assign(h, {
    deps,
    close(): void {
      temp.close();
      rmSync(root, { recursive: true, force: true });
    },
  });
}

export function addChannel(db: Db, id: string = CHANNEL_ID): void {
  db.run(
    `INSERT OR IGNORE INTO channels (id, title, first_seen_at, created_at, updated_at)
     VALUES (?, 'Channel', 1, 1, 1)`,
    id,
  );
}

export function addVideo(
  db: Db,
  id: string = VIDEO_ID,
  extra: {
    channel_id?: string | null;
    live_status?: string | null;
    published_at?: number | null;
  } = {},
): void {
  const channel = extra.channel_id === undefined ? CHANNEL_ID : extra.channel_id;
  if (channel !== null) {
    addChannel(db, channel);
  }
  db.run(
    `INSERT INTO videos (id, channel_id, title, live_status, published_at, created_at, updated_at)
     VALUES (?, ?, 'A video', ?, ?, 1, 1)`,
    id,
    channel,
    extra.live_status ?? null,
    extra.published_at ?? null,
  );
}

export function effective(overrides: Partial<EffectiveSettings> = {}): EffectiveSettings {
  return { ...effectDefaults(), ...overrides };
}

/** Set the effective settings (in the harness map and in video_effective, which the SQL joins read). */
export function setEffective(
  h: Harness,
  videoId: string,
  input: {
    effective?: Partial<EffectiveSettings>;
    reclaim_priority?: number;
    location_id?: number | null;
    include?: boolean;
  } = {},
): void {
  const eff = effective(input.effective ?? {});
  const value: PipelineEffective = {
    effective: {
      ...eff,
      reclaim_priority: input.reclaim_priority ?? eff.reclaim_priority,
      location_id: input.location_id ?? eff.location_id,
    },
    reclaim_priority: input.reclaim_priority ?? eff.reclaim_priority,
    location_id: input.location_id ?? null,
    include: input.include ?? true,
  };
  h.effective.set(videoId, value);
  h.db.run(
    `INSERT INTO video_effective (video_id, effective_json, provenance_json, matched_rule_ids,
                                  evaluated_at, reclaim_priority, location_id, include)
     VALUES (?, ?, '{}', '[]', 1, ?, ?, ?)
     ON CONFLICT (video_id) DO UPDATE SET reclaim_priority = excluded.reclaim_priority,
       location_id = excluded.location_id, include = excluded.include`,
    videoId,
    JSON.stringify(value.effective),
    value.reclaim_priority,
    value.location_id,
    value.include ? 1 : 0,
  );
}

export interface TestCtx {
  ctx: JobContext;
  progress: { pct: number; message?: string }[];
  controller: AbortController;
}

/** Enqueue a job, mark it running and build a JobContext by hand (no scheduler). */
export function makeCtx(
  h: Harness,
  input: { type: string; videoId?: string | null; payload?: unknown; accountId?: number | null },
): TestCtx {
  const { id } = h.queue.enqueue({
    type: input.type,
    videoId: input.videoId ?? null,
    payload: input.payload ?? {},
    accountId: input.accountId ?? null,
  });
  h.db.run("UPDATE jobs SET status = 'running', attempts = 1 WHERE id = ?", id);
  const job = h.queue.get(id) as JobRecord;
  const logDir = join(h.logsDir, "jobs", String(id));
  mkdirSync(logDir, { recursive: true });
  const controller = new AbortController();
  const progress: { pct: number; message?: string }[] = [];
  const ctx: JobContext = {
    job: { ...job, logDir },
    db: h.db,
    log: createConsoleLogger("silent"),
    logDir,
    signal: controller.signal,
    progress: (pct, message) => {
      progress.push(message === undefined ? { pct } : { pct, message });
    },
    checkpoint: () => {
      if (controller.signal.aborted) {
        throw new Error("aborted");
      }
    },
  };
  return { ctx, progress, controller };
}

export function activityKinds(db: Db): string[] {
  return db.all<{ kind: string }>("SELECT kind FROM activity ORDER BY id").map((row) => row.kind);
}

export interface MediaDbRow {
  id: number;
  kind: string;
  version: number;
  is_current: number;
  location_id: number | null;
  rel_path: string;
  size_bytes: number;
  sha256: string | null;
  vcodec: string | null;
  acodec: string | null;
  lang: string | null;
  transcoded_from: string | null;
  downloaded_at: number | null;
}

export function mediaRows(db: Db, videoId: string = VIDEO_ID): MediaDbRow[] {
  return db.all<MediaDbRow>("SELECT * FROM media WHERE video_id = ? ORDER BY id", videoId);
}

/** Insert a video/audio media row plus a file of `size` bytes at `<root>/<rel>`. */
export function addMediaFile(
  h: Harness,
  input: {
    videoId?: string;
    locationId?: number;
    rel?: string;
    size?: number;
    kind?: "video" | "audio";
    version?: number;
    isCurrent?: boolean;
    downloadedAt?: number;
    vcodec?: string | null;
    sha256?: string | null;
    content?: Buffer;
  } = {},
): { id: number; path: string } {
  const videoId = input.videoId ?? VIDEO_ID;
  const locationId = input.locationId ?? 1;
  const root = locationId === 1 ? h.loc1 : h.loc2;
  const rel = input.rel ?? `${CHANNEL_ID}/${videoId}/${videoId}.webm`;
  const content = input.content ?? Buffer.alloc(input.size ?? 1000, 7);
  const path = join(root, ...rel.split("/"));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  const id = h.db.run(
    `INSERT INTO media (video_id, kind, version, is_current, location_id, rel_path, size_bytes,
                        sha256, vcodec, downloaded_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    videoId,
    input.kind ?? "video",
    input.version ?? 1,
    input.isCurrent === false ? 0 : 1,
    locationId,
    rel,
    content.length,
    input.sha256 === undefined ? null : input.sha256,
    input.vcodec === undefined ? "vp9" : input.vcodec,
    input.downloadedAt ?? 1,
  ).lastInsertRowid;
  return { id, path };
}
