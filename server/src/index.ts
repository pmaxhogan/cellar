import { buildApp, INSECURE_BANNER } from "./app.ts";
import { ConfigError, ensureDataDirs, loadConfig } from "./config.ts";
import { openDb } from "./db/db.ts";
import { ensureInstalledAt } from "./db/kv.ts";
import { migrate } from "./db/migrate.ts";
import { EventBus } from "./events.ts";
import { bootScheduler } from "./jobs/boot.ts"; // wave1B
import { createRulesDeps } from "./domain/ruleEval.ts"; // wave2B
import { ensureDefaultRules } from "./domain/rules.ts"; // wave2B
import { registerRuleHandlers, registerRuleSchedules } from "./jobs/handlers/evalPass.ts"; // wave2B
import { jobRegistry } from "./jobs/types.ts"; // wave2B
import { createConsoleLogger, createLogger } from "./logging.ts";
import { installBaselineTools, refreshToolVersions } from "./media/tools.ts";
import { APP_VERSION } from "./version.ts";

/** How often insecure mode re-warns, so it never goes unnoticed in a long run. */
const INSECURE_REMINDER_MS = 10 * 60 * 1000;

async function main(): Promise<void> {
  const startedAt = Date.now();
  const config = loadConfig();
  ensureDataDirs(config);

  const log = createLogger(config);
  log.info(
    { version: APP_VERSION, dataDir: config.dataDir, insecureMode: config.insecureMode },
    "cellar starting",
  );
  if (config.secretKey === null) {
    log.warn("CELLAR_SECRET_KEY is not set; accounts cannot store credentials until it is");
  }

  const db = openDb(config.dbPath);
  migrate(db, log.child({ mod: "migrate" }));
  ensureInstalledAt(db);

  const toolsLog = log.child({ mod: "tools" });
  installBaselineTools(config, toolsLog);

  const events = new EventBus();
  const app = await buildApp({ config, log, db, events, version: APP_VERSION, startedAt });

  // --- wave1B scheduler boot ---
  // Starts now; app.close() (the SIGTERM/SIGINT shutdown below) awaits its graceful stop.
  const scheduler = bootScheduler(app, { config, db, log, events });
  // --- end wave1B scheduler boot ---

  // --- wave2B boot ---
  ensureDefaultRules(db, log.child({ mod: "rules" }));
  const rulesDeps = createRulesDeps({
    db,
    log: log.child({ mod: "rules" }),
    events,
    dataDir: config.dataDir,
    registry: jobRegistry,
    enqueue: (input) => scheduler.enqueue(input),
  });
  registerRuleHandlers(jobRegistry, rulesDeps);
  registerRuleSchedules(scheduler, rulesDeps);
  // --- end wave2B boot ---

  const reminder = config.insecureMode
    ? setInterval(() => {
        log.warn(INSECURE_BANNER);
      }, INSECURE_REMINDER_MS)
    : null;
  reminder?.unref();

  /** Stop taking requests, then close the database last. */
  const shutdown = (signal: string): void => {
    log.info({ signal }, "shutting down");
    if (reminder !== null) {
      clearInterval(reminder);
    }
    void app
      .close()
      .then(() => {
        db.close();
        process.exit(0);
      })
      .catch((error: unknown) => {
        log.error({ err: error }, "error during shutdown");
        process.exit(1);
      });
  };

  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });

  await app.listen({ port: config.port, host: config.host });
  log.info({ port: config.port, host: config.host }, "cellar listening");

  // After listen so /healthz answers while the probes run; never fatal.
  void refreshToolVersions(db, config.binDir, toolsLog).catch((error: unknown) => {
    toolsLog.warn({ err: error }, "could not record tool versions");
  });
}

main().catch((error: unknown) => {
  // The pino logger may not exist yet, so fall back to a stdout-only one.
  const log = createConsoleLogger();
  if (error instanceof ConfigError) {
    log.fatal(error.message);
  } else {
    log.fatal({ err: error }, "failed to start");
  }
  process.exit(1);
});
