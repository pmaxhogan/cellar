import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuildAppDeps, type CellarApp } from "../src/app.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { openDb, type Db } from "../src/db/db.ts";
import { ensureInstalledAt } from "../src/db/kv.ts";
import { migrate } from "../src/db/migrate.ts";
import { EventBus } from "../src/events.ts";
import { createConsoleLogger } from "../src/logging.ts";

/**
 * Shared fixtures for the server suite. Everything runs against a real
 * node:sqlite file with the real migrations applied: no db mocking.
 */

/** A well formed AES key for tests that need to store account secrets. */
export const TEST_SECRET_KEY = "a".repeat(64);

export interface TempDb {
  db: Db;
  dir: string;
  close(): void;
}

export function createTempDb(): TempDb {
  const dir = mkdtempSync(join(tmpdir(), "cellar-db-"));
  const db = openDb(join(dir, "cellar.db"));
  migrate(db, createConsoleLogger("silent"));
  ensureInstalledAt(db);
  return {
    db,
    dir,
    close(): void {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface TempApp {
  app: CellarApp;
  db: Db;
  config: Config;
  events: EventBus;
  dir: string;
  close(): Promise<void>;
}

/**
 * A full app in insecure mode (no Cloudflare Access), which is how the route
 * tests drive app.inject without minting a JWT for every call.
 *
 * WEB_DIST_DIR points at a directory that does not exist unless the caller
 * overrides it, so a local web build never changes what these tests see.
 */
export async function createTempApp(
  env: Record<string, string> = {},
  extra: Partial<Pick<BuildAppDeps, "shareRateLimit" | "startedAt">> = {},
): Promise<TempApp> {
  const dir = mkdtempSync(join(tmpdir(), "cellar-app-"));
  const config = loadConfig({
    INSECURE_ALLOW_PUBLIC_ACCESS: "1",
    DATA_DIR: dir,
    CELLAR_SECRET_KEY: TEST_SECRET_KEY,
    WEB_DIST_DIR: join(dir, "no-frontend-here"),
    ...env,
  });
  const log = createConsoleLogger("silent");
  const db = openDb(config.dbPath);
  migrate(db, log);
  ensureInstalledAt(db);
  const events = new EventBus();
  const app = await buildApp({ config, log, db, events, version: "9.9.9-test", ...extra });

  return {
    app,
    db,
    config,
    events,
    dir,
    async close(): Promise<void> {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
