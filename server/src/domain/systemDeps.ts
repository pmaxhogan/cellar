import {
  defaultSettings,
  isSettingKey,
  SettingsSchema,
  type ResolvedSettings,
} from "@cellar/shared";
import type { Logger } from "pino";
import type { Config } from "../config.ts";
import type { Db } from "../db/db.ts";
import {
  createRunTool,
  describeError,
  recordBaselineVersions,
  runFile,
  startToolUpdateSchedule,
  type ToolUpdateDeps,
} from "../media/tools.ts";
import { runTool as execRunTool } from "../media/exec.ts";
import { checkAccountApi, checkAccountCookies, listAccounts } from "./accounts.ts";
import { listLocations } from "./locations.ts";
import { notify } from "./notifications.ts";
import { listProxiesDecrypted } from "./proxies.ts";
import { startSelfCheckSchedule, type LocationInfo, type SelfCheckDeps } from "./selfcheck.ts";
import { getSettings } from "./settings.ts";
import type { EventBus } from "../events.ts";

/**
 * Everything the self-check, the tool updater and their routes need, in one
 * object. createSystemDeps builds it from what exists today; the merge of the
 * wave-1 work swaps the marked fallbacks for the real modules (media/exec.ts
 * runTool, domain/locations.ts, domain/accounts.ts, domain/proxies.ts,
 * domain/settings.ts, domain/notifications.ts).
 */
export type SystemDeps = SelfCheckDeps &
  ToolUpdateDeps & {
    config: Pick<Config, "dataDir" | "tmpDir" | "binDir" | "baselineBinDir" | "potProviderUrl">;
  };

/** Fallback for domain/settings.ts: the sparse `settings` rows over the registry defaults. */
export function readSettingsFallback(db: Db, log?: Logger): ResolvedSettings {
  const raw: Record<string, unknown> = {};
  for (const row of db.all<{ key: string; value_json: string }>(
    "SELECT key, value_json FROM settings",
  )) {
    if (!isSettingKey(row.key)) {
      continue;
    }
    try {
      raw[row.key] = JSON.parse(row.value_json);
    } catch {
      // An unreadable value falls back to its default.
    }
  }
  const parsed = SettingsSchema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }
  log?.warn("stored settings do not validate; using defaults");
  return defaultSettings();
}

/** Fallback for domain/locations.ts. */
export function listLocationsFallback(db: Db): LocationInfo[] {
  return db
    .all<{
      id: number;
      label: string;
      container_path: string;
      quota_bytes: number;
      enabled: number;
      used_bytes: number;
    }>(
      "SELECT id, label, container_path, quota_bytes, enabled, used_bytes FROM locations ORDER BY id",
    )
    .map((row) => ({
      id: Number(row.id),
      label: row.label,
      container_path: row.container_path,
      quota_bytes: Number(row.quota_bytes),
      enabled: Number(row.enabled) === 1,
      used_bytes: Number(row.used_bytes),
    }));
}

function probeFailed(error: unknown): { ok: false; detail: string } {
  return { ok: false, detail: error instanceof Error ? error.message : "probe failed" };
}

export function createSystemDeps(input: {
  config: Config;
  log: Logger;
  db: Db;
  events?: EventBus;
}): SystemDeps {
  const { config, log, db, events } = input;
  const service = { config, db, log };
  return {
    db,
    log,
    config,
    // Adapter: the self-check's RunTool treats a timeout as code null, while
    // media/exec.ts reports -1 plus timedOut.
    runTool: async (request) => {
      const result = await execRunTool(service, {
        tool: request.tool,
        args: request.args,
        timeoutMs: request.timeoutMs ?? 60_000,
      });
      return {
        code: result.timedOut ? null : result.code,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
    runFile,
    fetch: (resource, init) => fetch(resource, init),
    listLocations: () =>
      listLocations(db).map((row) => ({
        id: row.id,
        label: row.label,
        container_path: row.container_path,
        quota_bytes: row.quota_bytes,
        enabled: row.enabled,
        used_bytes: row.used_bytes,
      })),
    accounts: {
      list: () => listAccounts(db).map((row) => ({ id: row.id, label: row.label })),
      // A probe must never throw into the self-check: a missing or broken
      // account is reported as a failed check with the reason.
      checkApi: (id) => checkAccountApi(service, id).catch((error: unknown) => probeFailed(error)),
      checkCookies: (id) =>
        checkAccountCookies(service, id).catch((error: unknown) => probeFailed(error)),
    },
    proxies: { listDecrypted: () => listProxiesDecrypted(service) },
    getSettings: () => getSettings(db, config),
    notify: (type, title, body) => {
      void notify(
        { db, log, events, getSettings: () => getSettings(db, config) },
        {
          type,
          title,
          body,
        },
      ).catch((error: unknown) => {
        log.warn({ err: error, type }, "self-check notification failed");
      });
    },
  };
}

// The read-only fallbacks above stay exported for tests and for an API-only
// boot where the full service modules are not wanted.
void createRunTool;

/**
 * Boot-time wiring: record the baseline versions, run the boot self-check,
 * then the periodic self-check and the daily tool update check. Every timer
 * is unref'ed. Returns a stop function.
 */
export function startSystemSchedules(deps: SystemDeps): () => void {
  void recordBaselineVersions(deps.db, deps.config.baselineBinDir, deps.log).catch(
    (error: unknown) => {
      deps.log.warn({ error: describeError(error) }, "could not record baseline tool versions");
    },
  );
  const stopChecks = startSelfCheckSchedule(deps);
  const stopUpdates = startToolUpdateSchedule(deps);
  return () => {
    stopChecks();
    stopUpdates();
  };
}
