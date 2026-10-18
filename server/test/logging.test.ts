import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import {
  baseLoggerOptions,
  createConsoleLogger,
  createLogger,
  REDACT_PATHS,
} from "../src/logging.ts";

const SENTINEL = "SENTINEL-do-not-log";

function capture(): { log: pino.Logger; text: () => string } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk.toString("utf8"));
      done();
    },
  });
  return { log: pino(baseLoggerOptions("info"), sink), text: () => chunks.join("") };
}

let dir: string | null = null;

afterEach(() => {
  if (dir !== null) {
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  }
});

describe("redaction", () => {
  it("covers the credential headers and our own secret field names", () => {
    for (const path of [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['cf-access-jwt-assertion']",
      "refresh_token",
      "client_secret",
      "password",
      "secret",
      "proxyUrl",
      "*.cookie",
    ]) {
      expect(REDACT_PATHS, path).toContain(path);
    }
  });

  it("censors request headers that carry credentials", () => {
    const { log, text } = capture();
    log.info(
      {
        req: {
          headers: {
            authorization: `Bearer ${SENTINEL}`,
            cookie: `CF_Authorization=${SENTINEL}`,
            "cf-access-jwt-assertion": SENTINEL,
            "user-agent": "kept",
          },
        },
      },
      "request",
    );
    expect(text()).not.toContain(SENTINEL);
    expect(text()).toContain("[redacted]");
    expect(text()).toContain("kept");
  });

  it("censors tokens, client secrets and proxy URLs at the top level and one level down", () => {
    const { log, text } = capture();
    log.info({ refresh_token: SENTINEL, account: { client_secret: SENTINEL } }, "a");
    log.info({ proxy: `http://user:${SENTINEL}@proxy:8080` }, "b");
    log.info({ job: { proxyUrl: SENTINEL, cookies: SENTINEL, password: SENTINEL } }, "c");
    expect(text()).not.toContain(SENTINEL);
    expect(text().split("\n").filter(Boolean)).toHaveLength(3);
  });

  it("names every line cellar", () => {
    const { log, text } = capture();
    log.info("x");
    expect(JSON.parse(text())).toMatchObject({ name: "cellar", msg: "x" });
  });
});

describe("createLogger", () => {
  it("creates the logs directory and a logger at the configured level", () => {
    dir = mkdtempSync(join(tmpdir(), "cellar-logs-"));
    const logsDir = join(dir, "logs");
    const log = createLogger({ logLevel: "warn", logsDir });
    expect(existsSync(logsDir)).toBe(true);
    expect(log.level).toBe("warn");
    const silent = createLogger({ logLevel: "silent", logsDir });
    expect(silent.level).toBe("silent");
  });

  it("has a console fallback for failures before config loads", () => {
    expect(createConsoleLogger().level).toBe("info");
    expect(createConsoleLogger("debug").level).toBe("debug");
  });
});
