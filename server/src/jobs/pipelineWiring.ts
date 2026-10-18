import type { Logger } from "pino";
import type { Config } from "../config.ts";
import type { Db } from "../db/db.ts";
import { listAccounts, withCookiesFile } from "../domain/accounts.ts";
import { listLocations } from "../domain/locations.ts";
import { markProxyFailure, markProxyOk, pickProxy } from "../domain/proxies.ts";
import { nvencAvailable } from "../domain/selfcheck.ts";
import { getSettings } from "../domain/settings.ts";
import { createSystemDeps } from "../domain/systemDeps.ts";
import type { EventBus } from "../events.ts";
import { createFallbackPipelineDeps } from "./pipelineFallbacks.ts";
import type { PipelineDeps } from "./pipelineDeps.ts";
import type { Scheduler } from "./scheduler.ts";

/**
 * Production wiring for the media pipeline: the placeholder deps from
 * pipelineFallbacks.ts with every marked entry replaced by the real module.
 * Cookie jars, proxies, settings, locations and the scheduler's queue and
 * schedules all come from the wave-1 modules; the GPU probe shares the
 * self-check's tool runner so both report the same answer.
 */
export function createPipelineDeps(input: {
  config: Config;
  db: Db;
  log: Logger;
  events: EventBus;
  scheduler: Scheduler;
}): PipelineDeps {
  const { config, db, log, events, scheduler } = input;
  const service = { config, db, log };
  const system = createSystemDeps({ config, log, db, events });
  const base = createFallbackPipelineDeps({ config, db, log, events });
  return {
    ...base,
    config: { ...base.config, ytdlpPluginDirs: config.ytdlpPluginDirs },
    withCookiesFile: (accountId, fn) => withCookiesFile(service, accountId, fn),
    pickProxy: (policy) => {
      const proxy = pickProxy(service, policy);
      return proxy === null ? null : { id: proxy.id, url: proxy.url };
    },
    markProxyFailure: (id) => markProxyFailure(db, id),
    markProxyOk: (id) => {
      markProxyOk(db, id);
    },
    getSettings: () => getSettings(db, config),
    locations: () =>
      listLocations(db).map((row) => ({
        id: row.id,
        container_path: row.container_path,
        quota_bytes: row.quota_bytes,
        enabled: row.enabled,
      })),
    accountsWithCookies: () =>
      listAccounts(db)
        .filter((row) => row.has_cookies && row.status === "ok")
        .map((row) => row.id),
    nvenc: () => nvencAvailable(system),
    enqueue: (job) => scheduler.enqueue(job),
    every: (name, intervalMs, fn) => {
      scheduler.every(name, intervalMs, fn);
    },
  };
}
