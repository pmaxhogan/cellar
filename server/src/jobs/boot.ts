import { resolveSettings, type ResolvedSettings } from "@cellar/shared";
import type { Logger } from "pino";
import type { Config } from "../config.ts";
import type { Db } from "../db/db.ts";
import { LOGS_RETENTION_JOB, registerLogsRetention } from "../domain/activity.ts";
import { ensureVapidKeys } from "../domain/notifications.ts";
import type { EventBus } from "../events.ts";
import { Scheduler, type SchedulerDeps } from "./scheduler.ts";
import { jobRegistry, type JobClass, type JobRegistry } from "./types.ts";

export const DAY_MS = 24 * 60 * 60_000;

/** The slice of Fastify bootScheduler needs: stop the scheduler when the app closes. */
export interface CloseHookTarget {
  addHook(name: "onClose", hook: () => Promise<void>): unknown;
}

export interface BootSchedulerDeps {
  config: Pick<Config, "logsDir">;
  db: Db;
  log: Logger;
  events: EventBus;
  registry?: JobRegistry;
  /** Wired to the settings domain by the orchestrator; registry defaults until then. */
  getSettings?: () => ResolvedSettings;
  budgetOk?: (cls: JobClass) => boolean;
  canConsumeScrape?: (accountId: number, cls: JobClass) => boolean;
  /** Test seams. */
  tickMs?: number;
  now?: () => number;
}

/**
 * Build, wire and start the scheduler: the built-in maintenance handlers, the
 * daily log retention schedule, the VAPID keypair (generated on first boot),
 * and an onClose hook so app.close() (the SIGTERM/SIGINT path in index.ts)
 * waits for the graceful stop before the database is closed.
 */
export function bootScheduler(app: CloseHookTarget, deps: BootSchedulerDeps): Scheduler {
  const registry = deps.registry ?? jobRegistry;
  const getSettings = deps.getSettings ?? (() => resolveSettings({}));

  if (!registry.has(LOGS_RETENTION_JOB)) {
    registerLogsRetention(registry, { logsDir: deps.config.logsDir, getSettings });
  }
  ensureVapidKeys(deps.db);

  const schedulerDeps: SchedulerDeps = {
    db: deps.db,
    log: deps.log,
    events: deps.events,
    logsDir: deps.config.logsDir,
    registry,
    getSettings,
    ...(deps.budgetOk === undefined ? {} : { budgetOk: deps.budgetOk }),
    ...(deps.canConsumeScrape === undefined ? {} : { canConsumeScrape: deps.canConsumeScrape }),
    ...(deps.tickMs === undefined ? {} : { tickMs: deps.tickMs }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  };
  const scheduler = new Scheduler(schedulerDeps);
  scheduler.every(LOGS_RETENTION_JOB, DAY_MS, () =>
    scheduler.enqueue({ type: LOGS_RETENTION_JOB, dedupe: true }),
  );
  app.addHook("onClose", async () => {
    await scheduler.stop();
  });
  scheduler.start();
  return scheduler;
}
