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
import { startSelfCheckSchedule, type LocationInfo, type SelfCheckDeps } from "./selfcheck.ts";

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

export function createSystemDeps(input: { config: Config; log: Logger; db: Db }): SystemDeps {
  const { config, log, db } = input;
  return {
    db,
    log,
    config,
    // FALLBACK: media/exec.ts runTool.
    runTool: createRunTool({ binDir: config.binDir }),
    runFile,
    fetch: (resource, init) => fetch(resource, init),
    // FALLBACK: domain/locations.ts.
    listLocations: () => listLocationsFallback(db),
    // FALLBACK: domain/accounts.ts. Without it no account is checked.
    accounts: {
      list: () => [],
      checkApi: () => Promise.resolve({ ok: false, detail: "Account checks are not wired yet." }),
      checkCookies: () =>
        Promise.resolve({ ok: false, detail: "Account checks are not wired yet." }),
    },
    // FALLBACK: domain/proxies.ts (needs decryption). Without it no proxy is checked.
    proxies: { listDecrypted: () => [] },
    // FALLBACK: domain/settings.ts.
    getSettings: () => readSettingsFallback(db, log),
    // FALLBACK: domain/notifications.ts.
    notify: (type, title, body) => {
      log.warn({ type, title, body }, "notification (no notifier wired)");
    },
  };
}

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
