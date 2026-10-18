import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino, { type Logger, type LoggerOptions } from "pino";
import type { Config } from "./config.ts";

export type { Logger };

/**
 * Fields that must never reach a log line. Covers the request headers that
 * carry credentials (the Access JWT, the CF_Authorization cookie) and the
 * names our own code uses for OAuth tokens, client secrets and proxy URLs
 * (a proxy URL can embed a username and password), at the top level and one
 * object down.
 */
export const REDACT_PATHS: readonly string[] = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['cf-access-jwt-assertion']",
  "res.headers['set-cookie']",
  ...[
    "authorization",
    "cookie",
    "cookies",
    "refresh_token",
    "refreshToken",
    "access_token",
    "accessToken",
    "client_secret",
    "clientSecret",
    "password",
    "secret",
    "proxy",
    "proxyUrl",
    "proxy_url",
  ].flatMap((key) => [key, `*.${key}`]),
];

/** Shared by the file logger and the console logger, so redaction is identical. */
export function baseLoggerOptions(level: string): LoggerOptions {
  return {
    level,
    base: { name: "cellar" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: [...REDACT_PATHS], censor: "[redacted]" },
  };
}

/**
 * pino only, never console.*. Two destinations: NDJSON on stdout for the
 * container log driver, and a size-rotated file in $DATA_DIR/logs for the NAS.
 */
export function createLogger(config: Pick<Config, "logLevel" | "logsDir">): Logger {
  mkdirSync(config.logsDir, { recursive: true });

  // Per-stream levels do not accept "silent"; the logger level already gates it.
  const streamLevel: pino.Level = config.logLevel === "silent" ? "fatal" : config.logLevel;

  const streams: pino.StreamEntry[] = [
    { level: streamLevel, stream: pino.destination({ fd: 1, sync: false }) },
    {
      level: streamLevel,
      stream: pino.transport({
        target: "pino-roll",
        options: {
          file: join(config.logsDir, "cellar.log"),
          size: "20m",
          limit: { count: 5 },
          mkdir: true,
        },
      }) as pino.DestinationStream,
    },
  ];

  return pino(baseLoggerOptions(config.logLevel), pino.multistream(streams));
}

/** stdout-only logger for tests and for failures that happen before config loads. */
export function createConsoleLogger(level: string = "info"): Logger {
  return pino(baseLoggerOptions(level));
}
