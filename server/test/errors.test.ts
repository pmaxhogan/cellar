import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { ApiErrorSchema } from "@cellar/shared";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp, type CellarApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { openDb, type Db } from "../src/db/db.ts";
import { migrate } from "../src/db/migrate.ts";
import {
  conflict,
  DomainError,
  invalid,
  isForeignKeyViolation,
  isUniqueViolation,
  notFound,
} from "../src/domain/errors.ts";
import { baseLoggerOptions } from "../src/logging.ts";
import {
  INTERNAL_ERROR,
  parseBody,
  parseParams,
  parseQuery,
  sendError,
  toApiError,
} from "../src/routes/validate.ts";

const SENTINEL = "SENTINEL-db-password-hunter2";

let dir: string | null = null;
let db: Db | null = null;
let app: CellarApp | null = null;

afterEach(async () => {
  await app?.close();
  db?.close();
  if (dir !== null) {
    rmSync(dir, { recursive: true, force: true });
  }
  app = null;
  db = null;
  dir = null;
});

/** A real app whose log lines are captured, with a few routes that throw. */
async function buildThrowingApp(): Promise<{ app: CellarApp; lines: string[] }> {
  dir = mkdtempSync(join(tmpdir(), "cellar-errors-"));
  const config = loadConfig({
    INSECURE_ALLOW_PUBLIC_ACCESS: "1",
    DATA_DIR: dir,
    WEB_DIST_DIR: join(dir, "none"),
  });
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString("utf8"));
      done();
    },
  });
  const log = pino(baseLoggerOptions("debug"), sink);
  db = openDb(config.dbPath);
  migrate(db, log);
  app = await buildApp({ config, log, db, version: "t" });

  const BodySchema = z.object({ name: z.string().min(1) });
  app.get("/api/boom", () => {
    throw new Error(`database said ${SENTINEL}`);
  });
  app.get("/api/missing", () => {
    throw notFound("Video", "abc");
  });
  app.post("/api/validated", (request) => parseBody(BodySchema, request));
  app.get("/s/boom", () => {
    throw new Error(SENTINEL);
  });
  return { app, lines };
}

describe("the single error handler", () => {
  it("answers a 5xx with a fixed message and logs the real error", async () => {
    const built = await buildThrowingApp();
    const response = await built.app.inject({ method: "GET", url: "/api/boom" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "internal error", code: "internal" });
    expect(response.body).not.toContain(SENTINEL);
    expect(built.lines.join("")).toContain(SENTINEL);
    expect(built.lines.join("")).toContain("unhandled route error");
  });

  it("covers routes outside /api too", async () => {
    const built = await buildThrowingApp();
    const response = await built.app.inject({ method: "GET", url: "/s/boom" });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(SENTINEL);
  });

  it("maps a DomainError to its status with the ApiError shape", async () => {
    const built = await buildThrowingApp();
    const response = await built.app.inject({ method: "GET", url: "/api/missing" });
    expect(response.statusCode).toBe(404);
    expect(ApiErrorSchema.parse(response.json())).toEqual({
      error: "Video abc does not exist.",
      code: "not_found",
    });
  });

  it("returns field details for a body that fails validation", async () => {
    const built = await buildThrowingApp();
    const response = await built.app.inject({
      method: "POST",
      url: "/api/validated",
      payload: { name: "" },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.code).toBe("invalid");
    expect(body.error).toBe("Invalid request body: name.");
    expect(Object.keys(body.details.fields)).toEqual(["name"]);

    const ok = await built.app.inject({
      method: "POST",
      url: "/api/validated",
      payload: { name: "x" },
    });
    expect(ok.json()).toEqual({ name: "x" });
  });

  it("passes framework 4xx errors through, such as malformed JSON", async () => {
    const built = await buildThrowingApp();
    const response = await built.app.inject({
      method: "POST",
      url: "/api/validated",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("FST_ERR_CTP_INVALID_JSON_BODY");
  });
});

describe("toApiError", () => {
  it("handles every input kind", () => {
    expect(toApiError(conflict("taken", { id: 1 }))).toEqual({
      status: 409,
      body: { error: "taken", code: "conflict", details: { id: 1 } },
    });
    expect(toApiError(invalid("bad")).status).toBe(400);
    expect(toApiError(new DomainError("precondition_failed", "later")).status).toBe(412);
    expect(toApiError(Object.assign(new Error("nope"), { statusCode: 413 }))).toEqual({
      status: 413,
      body: { error: "nope", code: "bad_request" },
    });
    expect(toApiError({ statusCode: 418 })).toEqual({
      status: 418,
      body: { error: "The request could not be processed.", code: "bad_request" },
    });
    expect(toApiError(Object.assign(new Error("x"), { statusCode: 503 }))).toEqual({
      status: 500,
      body: INTERNAL_ERROR,
    });
    expect(toApiError(null)).toEqual({ status: 500, body: INTERNAL_ERROR });
    expect(toApiError("string")).toEqual({ status: 500, body: INTERNAL_ERROR });
  });

  it("sendError writes the mapped status and body", () => {
    const sent: { status?: number; body?: unknown } = {};
    const reply = {
      code(status: number) {
        sent.status = status;
        return this;
      },
      send(body: unknown) {
        sent.body = body;
        return this;
      },
    } as unknown as Parameters<typeof sendError>[0];
    sendError(reply, notFound("Thing", 1));
    expect(sent).toEqual({
      status: 404,
      body: { error: "Thing 1 does not exist.", code: "not_found" },
    });
  });
});

describe("parse helpers", () => {
  const Schema = z.object({ id: z.coerce.number().int() });
  const request = (part: Record<string, unknown>) =>
    part as unknown as Parameters<typeof parseQuery>[1];

  it("parse query and params, and treat a missing part as empty", () => {
    expect(parseQuery(Schema, request({ query: { id: "3" } }))).toEqual({ id: 3 });
    expect(parseParams(Schema, request({ params: { id: "4" } }))).toEqual({ id: 4 });
    expect(() => parseParams(Schema, request({}))).toThrow(DomainError);
    expect(() => parseBody(z.object({}).strict(), request({}))).not.toThrow();
  });

  it("names the root when the whole value is wrong", () => {
    try {
      parseBody(z.string(), request({ body: 5 }));
      expect.unreachable();
    } catch (error) {
      expect((error as DomainError).details).toEqual({
        fields: { "(root)": expect.any(String) },
      });
    }
  });
});

describe("sqlite error classifiers", () => {
  it("recognise unique and foreign key violations", () => {
    const memory = openDb(":memory:");
    memory.exec("CREATE TABLE p (id INTEGER PRIMARY KEY)");
    memory.exec("CREATE TABLE c (pid INTEGER REFERENCES p (id), u TEXT UNIQUE)");
    memory.run("INSERT INTO p (id) VALUES (1)");
    memory.run("INSERT INTO c (pid, u) VALUES (1, 'a')");

    let unique: unknown;
    try {
      memory.run("INSERT INTO c (pid, u) VALUES (1, 'a')");
    } catch (error) {
      unique = error;
    }
    let foreign: unknown;
    try {
      memory.run("INSERT INTO c (pid, u) VALUES (9, 'b')");
    } catch (error) {
      foreign = error;
    }
    memory.close();

    expect(isUniqueViolation(unique)).toBe(true);
    expect(isUniqueViolation(foreign)).toBe(false);
    expect(isForeignKeyViolation(foreign)).toBe(true);
    expect(isUniqueViolation("nope")).toBe(false);
    expect(isForeignKeyViolation(undefined)).toBe(false);
  });
});
