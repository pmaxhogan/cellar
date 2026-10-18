import { EffectiveSettingsSchema, effectDefaults } from "@cellar/shared";
import type { Logger } from "pino";
import type { Config } from "../config.ts";
import type { Db } from "../db/db.ts";
import { logActivity } from "../domain/activity.ts";
import {
  notify,
  recordDownloadFailure,
  recordDownloadSuccess,
  recordFsError,
  recordStoragePressure,
} from "../domain/notifications.ts";
import { nvencAvailable } from "../domain/selfcheck.ts";
import { listLocationsFallback, readSettingsFallback } from "../domain/systemDeps.ts";
import type { EventBus } from "../events.ts";
import { createSpawnTool } from "../media/spawn.ts";
import { createRunTool } from "../media/tools.ts";
import type { PipelineDeps, PipelineEffective } from "./pipelineDeps.ts";
import { JobQueue } from "./queue.ts";

/**
 * PLACEHOLDER wiring for the media pipeline, built only from modules that
 * exist on this branch. The orchestrator swaps each marked entry for the real
 * module at merge (domain/accounts.ts, domain/proxies.ts, domain/settings.ts,
 * domain/effective.ts, domain/locations.ts) and `enqueue`/`every` for the
 * Scheduler that bootScheduler returns. On main, `config` itself already
 * satisfies PipelineConfig (it has ytdlpPluginDirs).
 */

export const DEFAULT_YTDLP_PLUGIN_DIRS = "/opt/cellar/yt-dlp-plugins";

export interface FallbackInput {
  config: Pick<Config, "dataDir" | "metaDir" | "tmpDir" | "potProviderUrl" | "binDir">;
  db: Db;
  log: Logger;
  events: EventBus;
}

/** Reads `video_effective` directly. PLACEHOLDER: domain/effective.ts. */
export function readEffectiveFallback(db: Db, videoId: string): PipelineEffective | null {
  const row = db.get<{
    effective_json: string;
    reclaim_priority: number;
    location_id: number | null;
    include: number;
  }>(
    "SELECT effective_json, reclaim_priority, location_id, include FROM video_effective WHERE video_id = ?",
    videoId,
  );
  if (row === undefined) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(row.effective_json);
  } catch {
    return null;
  }
  // Rows written before an effect existed lack its key; the default fills it in.
  const parsed = EffectiveSettingsSchema.safeParse(
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? { ...effectDefaults(), ...raw }
      : raw,
  );
  if (!parsed.success) {
    return null;
  }
  return {
    effective: parsed.data,
    reclaim_priority: Number(row.reclaim_priority),
    location_id: row.location_id === null ? null : Number(row.location_id),
    include: Number(row.include) === 1,
  };
}

/** Accounts that sourced the video directly or through its channel. */
export function sourcingAccountsFallback(db: Db, videoId: string): number[] {
  return db
    .all<{ account_id: number }>(
      `SELECT account_id FROM video_sources WHERE video_id = ? AND account_id IS NOT NULL
       UNION
       SELECT cs.account_id FROM channel_sources cs JOIN videos v ON v.channel_id = cs.channel_id
        WHERE v.id = ? AND cs.account_id IS NOT NULL
       ORDER BY 1`,
      videoId,
      videoId,
    )
    .map((row) => Number(row.account_id));
}

export function createFallbackPipelineDeps(input: FallbackInput): PipelineDeps {
  const { config, db, events } = input;
  const log = input.log.child({ mod: "pipeline" });
  const getSettings = (): ReturnType<typeof readSettingsFallback> => readSettingsFallback(db, log);
  const notifyDeps = { db, log, events, getSettings };
  const queue = new JobQueue(db, { events });
  return {
    db,
    log,
    events,
    config: {
      dataDir: config.dataDir,
      metaDir: config.metaDir,
      tmpDir: config.tmpDir,
      potProviderUrl: config.potProviderUrl,
      // PLACEHOLDER: config.ytdlpPluginDirs (CELLAR_YTDLP_PLUGIN_DIRS) on main.
      ytdlpPluginDirs: DEFAULT_YTDLP_PLUGIN_DIRS,
    },
    now: () => Date.now(),
    runTool: createSpawnTool({ binDir: config.binDir }),
    // PLACEHOLDER: domain/accounts.ts withCookiesFile. Never reached while
    // accountsWithCookies() is empty.
    withCookiesFile: () => Promise.reject(new Error("Cookie jars are not wired yet.")),
    // PLACEHOLDER: domain/proxies.ts pickProxy / markProxyFailure / markProxyOk.
    pickProxy: () => null,
    markProxyFailure: () => undefined,
    markProxyOk: () => undefined,
    // PLACEHOLDER: domain/settings.ts getSettings.
    getSettings,
    // PLACEHOLDER: domain/effective.ts.
    getEffective: (videoId) => readEffectiveFallback(db, videoId),
    // PLACEHOLDER: domain/locations.ts.
    locations: () =>
      listLocationsFallback(db).map((location) => ({
        id: location.id,
        container_path: location.container_path,
        quota_bytes: location.quota_bytes,
        enabled: location.enabled,
      })),
    sourcingAccountIds: (videoId) => sourcingAccountsFallback(db, videoId),
    // PLACEHOLDER: domain/accounts.ts (accounts with a valid cookie jar).
    accountsWithCookies: () => [],
    nvenc: () => nvencAvailable({ runTool: createRunTool({ binDir: config.binDir }) }),
    notify: (notification) => notify(notifyDeps, notification),
    recordDownloadFailure: (videoId) => recordDownloadFailure(notifyDeps, videoId),
    recordDownloadSuccess: () => {
      recordDownloadSuccess(notifyDeps);
    },
    recordStoragePressure: (locationId, detail) =>
      recordStoragePressure(notifyDeps, locationId, detail),
    recordFsError: (detail) => recordFsError(notifyDeps, detail),
    logActivity: (activity) => {
      logActivity({ db, events }, activity);
    },
    // PLACEHOLDER: Scheduler.enqueue. Same table and default registry, and the
    // job.queued event wakes the scheduler, so this already works.
    enqueue: (job) => queue.enqueue(job),
    // PLACEHOLDER: Scheduler.every, which also fires at boot and persists the
    // cadence in kv. This interval does neither.
    every: (_name, intervalMs, fn) => {
      setInterval(() => {
        try {
          const out = fn();
          if (out instanceof Promise) {
            out.catch((error: unknown) => {
              log.error({ err: error }, "pipeline schedule failed");
            });
          }
        } catch (error) {
          log.error({ err: error }, "pipeline schedule failed");
        }
      }, intervalMs).unref();
    },
  };
}
