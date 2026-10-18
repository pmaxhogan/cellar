import {
  ApiErrorSchema,
  TAKEOUT_MAX_UPLOAD_BYTES,
  TakeoutJobResponseSchema,
  TakeoutUploadResponseSchema,
  type TakeoutUploadResponse,
} from "@cellar/shared";
import AdmZip from "adm-zip";
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePayload, type TarRunner } from "../src/domain/takeout.ts";
import { JobRegistry } from "../src/jobs/types.ts";
import { takeoutRoutes, type TakeoutRoutesOptions } from "../src/routes/takeout.ts";
import { toApiError } from "../src/routes/validate.ts";
import { createTempApp, type TempApp } from "./helpers.ts";
import {
  buildTgz,
  buildZip,
  EMOJI_PLAYLIST,
  hasSystemTar,
  historyJson,
  multipartBody,
  playlistCsv,
  ROOT,
  subscriptionsCsv,
  takeoutFiles,
  T_WL,
  UPTOWN,
  type UploadPart,
} from "./takeoutFixtures.ts";
import { seedAccount } from "./videoSeed.ts";

let temp: TempApp;
let bare: FastifyInstance | undefined;
let account: number;

beforeEach(async () => {
  temp = await createTempApp();
  account = seedAccount(temp.db, "main");
});

afterEach(async () => {
  await bare?.close();
  bare = undefined;
  await temp.close();
});

/** The routes on their own Fastify instance, with test seams. */
async function withOptions(options: TakeoutRoutesOptions): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorate("cellar", temp.app.cellar);
  app.setErrorHandler((error, _request, reply) => {
    const { status, body } = toApiError(error);
    void reply.code(status).send(body);
  });
  await app.register(takeoutRoutes, { prefix: "/api", registry: new JobRegistry(), ...options });
  await app.ready();
  bare = app;
  return app;
}

async function upload(
  parts: readonly UploadPart[],
  options: { query?: string; fields?: Record<string, string>; app?: FastifyInstance } = {},
) {
  const { body, contentType } = await multipartBody(parts, options.fields);
  return (options.app ?? temp.app).inject({
    method: "POST",
    url: `/api/takeout${options.query ?? `?account_id=${String(account)}`}`,
    headers: { "content-type": contentType },
    payload: body,
  });
}

function stagingDirs(): string[] {
  return readdirSync(temp.config.tmpDir).filter((name) => name.startsWith("takeout-"));
}

function byKind(response: TakeoutUploadResponse): Record<string, number> {
  return Object.fromEntries(response.files.map((file) => [file.kind, file.rows]));
}

const EXPECTED_KINDS = {
  history: 3,
  watch_later: 1,
  liked: 1,
  subscription: 2,
  [`playlist:${EMOJI_PLAYLIST}`]: 2,
};

describe("POST /api/takeout", () => {
  it("stages a .zip export, previews every file and queues one import job", async () => {
    const response = await upload([
      { filename: "takeout-20261018T000000Z-001.zip", data: buildZip(takeoutFiles()) },
    ]);
    expect(response.statusCode).toBe(202);
    const body = TakeoutUploadResponseSchema.parse(response.json());
    expect(byKind(body)).toEqual(EXPECTED_KINDS);
    const history = body.files.find((file) => file.kind === "history");
    expect(history?.name).toBe(`${ROOT}/history/watch-history.json`);
    expect(history?.skipped_rows).toEqual({ ad: 1, "no-url": 1 });
    expect(body.skipped).toEqual(
      expect.arrayContaining([
        { name: `${ROOT}/history/search-history.json`, reason: "not-used" },
        { name: `${ROOT}/playlists/playlists.csv`, reason: "not-used" },
      ]),
    );
    expect(body.skipped_total).toBe(body.skipped.length);

    const job = temp.db.get<{ type: string; status: string; payload_json: string }>(
      "SELECT type, status, payload_json FROM jobs WHERE id = ?",
      body.job_id,
    );
    expect(job?.type).toBe("takeout_import");
    expect(job?.status).toBe("queued");
    const payload = parsePayload(JSON.parse(job?.payload_json ?? "null"));
    expect(payload.account_id).toBe(account);
    expect(payload.files.map((file) => file.name)).toContain(
      `${ROOT}/playlists/${EMOJI_PLAYLIST}-videos.csv`,
    );
    expect(existsSync(payload.dir)).toBe(true);
    for (const file of payload.files) {
      expect(existsSync(join(payload.dir, file.path))).toBe(true);
    }
    expect(stagingDirs()).toHaveLength(1);
  });

  it.skipIf(!hasSystemTar())("stages a .tgz export through the system tar", async () => {
    // Windows tars do not agree on non-ASCII member names; Linux (the image, CI) does.
    const emoji = process.platform !== "win32";
    const files = takeoutFiles({ emoji });
    const tgz = buildTgz([
      { name: "Takeout/", type: "5" },
      ...files.map((file) => ({ name: file.name, data: file.data })),
    ]);
    const response = await upload([{ filename: "takeout-20261018T000000Z-001.tgz", data: tgz }]);
    expect(response.statusCode).toBe(202);
    const body = TakeoutUploadResponseSchema.parse(response.json());
    const kinds = byKind(body);
    expect(kinds.history).toBe(3);
    expect(kinds.watch_later).toBe(1);
    expect(kinds.liked).toBe(1);
    expect(kinds.subscription).toBe(2);
    expect(kinds[`playlist:${emoji ? EMOJI_PLAYLIST : "Road trip"}`]).toBe(2);
  });

  it.skipIf(!hasSystemTar() || process.platform === "win32")(
    "skips symlinks inside a .tgz instead of following them",
    async () => {
      const tgz = buildTgz([
        { name: `${ROOT}/history/watch-history.json`, data: historyJson() },
        { name: `${ROOT}/subscriptions/subscriptions.csv`, type: "2", linkname: "/etc/hostname" },
      ]);
      const response = await upload([{ filename: "t.tgz", data: tgz }]);
      expect(response.statusCode).toBe(202);
      const body = TakeoutUploadResponseSchema.parse(response.json());
      expect(body.files.map((file) => file.kind)).toEqual(["history"]);
      expect(body.skipped).toContainEqual({
        name: `t.tgz: ${ROOT}/subscriptions/subscriptions.csv`,
        reason: "not-a-regular-file",
      });
    },
  );

  it.skipIf(!hasSystemTar())("refuses a .tgz with a path traversal member", async () => {
    const tgz = buildTgz([
      { name: `${ROOT}/history/watch-history.json`, data: historyJson() },
      { name: "../subscriptions.csv", data: subscriptionsCsv() },
    ]);
    const response = await upload([{ filename: "evil.tgz", data: tgz }]);
    expect(response.statusCode).toBe(400);
    const body = ApiErrorSchema.parse(response.json());
    expect(body.code).toBe("unsafe_archive");
    expect(body.error).toContain("../subscriptions.csv");
    expect(stagingDirs()).toEqual([]);
  });

  it("refuses a .zip with a path traversal or absolute member", async () => {
    for (const name of ["../../evil.csv", "/etc/subscriptions.csv", "C:/x/subscriptions.csv"]) {
      const zip = new AdmZip();
      zip.addFile(`${ROOT}/history/watch-history.json`, Buffer.from(historyJson()));
      zip.addFile("placeholder.csv", Buffer.from(subscriptionsCsv()));
      const entry = zip.getEntry("placeholder.csv");
      if (entry === null) throw new Error("no entry");
      entry.entryName = name;
      const response = await upload([{ filename: "evil.zip", data: zip.toBuffer() }]);
      expect(response.statusCode, name).toBe(400);
      expect(ApiErrorSchema.parse(response.json()).code).toBe("unsafe_archive");
    }
    expect(stagingDirs()).toEqual([]);
  });

  it("accepts loose files with the account as a form field, keeping non-ASCII names", async () => {
    const response = await upload(
      [
        { filename: "watch-history.json", data: historyJson() },
        { filename: `${EMOJI_PLAYLIST}-videos.csv`, data: playlistCsv([[UPTOWN, T_WL]]) },
        { filename: "subscriptions.csv", data: subscriptionsCsv() },
        { filename: "notes.txt", data: "hello" },
      ],
      { query: "", fields: { account_id: String(account) } },
    );
    expect(response.statusCode).toBe(202);
    const body = TakeoutUploadResponseSchema.parse(response.json());
    expect(body.files.map((file) => [file.name, file.kind])).toEqual([
      ["watch-history.json", "history"],
      [`${EMOJI_PLAYLIST}-videos.csv`, `playlist:${EMOJI_PLAYLIST}`],
      ["subscriptions.csv", "subscription"],
    ]);
    expect(body.skipped).toEqual([{ name: "notes.txt", reason: "unsupported-file-type" }]);
  });

  it("rejects an HTML history export with history_is_html and cleans up", async () => {
    const response = await upload([
      { filename: "takeout.zip", data: buildZip(takeoutFiles({ htmlHistory: true })) },
    ]);
    expect(response.statusCode).toBe(400);
    const body = ApiErrorSchema.parse(response.json());
    expect(body.code).toBe("history_is_html");
    expect(body.error).toContain("JSON");
    expect(stagingDirs()).toEqual([]);
    expect(temp.db.get("SELECT id FROM jobs WHERE type = 'takeout_import'")).toBeUndefined();
  });

  it("rejects a watch-history.json that is really HTML", async () => {
    const response = await upload([
      { filename: "watch-history.json", data: "<!DOCTYPE html><html></html>" },
      { filename: "subscriptions.csv", data: subscriptionsCsv() },
    ]);
    expect(response.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(response.json()).code).toBe("history_is_html");
  });

  it("imports the rest when a file is not the Takeout file it claims to be", async () => {
    const response = await upload([
      { filename: "watch-history.json", data: historyJson() },
      { filename: "subscriptions.csv", data: "just,some,text\n" },
    ]);
    expect(response.statusCode).toBe(202);
    const body = TakeoutUploadResponseSchema.parse(response.json());
    expect(body.files.map((file) => file.kind)).toEqual(["history"]);
    expect(body.skipped[0]?.name).toBe("subscriptions.csv");
    expect(body.skipped[0]?.reason).toMatch(/^unreadable: /);
  });

  it("says so when nothing is importable", async () => {
    const response = await upload([{ filename: "search-history.json", data: "[]" }]);
    expect(response.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(response.json()).code).toBe("no_takeout_files");
    expect(stagingDirs()).toEqual([]);
  });

  it("reports an archive it cannot read", async () => {
    const zip = await upload([{ filename: "broken.zip", data: "not a zip at all" }]);
    expect(zip.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(zip.json()).code).toBe("archive_unreadable");
    if (hasSystemTar()) {
      const tgz = await upload([{ filename: "broken.tgz", data: "not gzip either" }]);
      expect(tgz.statusCode).toBe(400);
      expect(ApiErrorSchema.parse(tgz.json()).code).toBe("archive_unreadable");
    }
    expect(stagingDirs()).toEqual([]);
  });

  it("reports a tar that lists but does not extract", async () => {
    const tar: TarRunner = (args) =>
      Promise.resolve(
        args[0] === "-tzf"
          ? { code: 0, stdout: "Takeout/a.csv\n", stderr: "" }
          : { code: 2, stdout: "", stderr: "boom" },
      );
    const app = await withOptions({ tar });
    const response = await upload([{ filename: "x.tgz", data: "x" }], { app });
    expect(response.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(response.json()).code).toBe("archive_unreadable");
  });

  it("requires a known account", async () => {
    const parts = [{ filename: "watch-history.json", data: historyJson() }];
    const missing = await upload(parts, { query: "" });
    expect(missing.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(missing.json()).details).toEqual({
      fields: { account_id: "Required" },
    });
    const bad = await upload(parts, { query: "?account_id=abc" });
    expect(bad.statusCode).toBe(400);
    const badField = await upload(parts, { query: "", fields: { account_id: "-3" } });
    expect(badField.statusCode).toBe(400);
    const unknown = await upload(parts, { query: "?account_id=999" });
    expect(unknown.statusCode).toBe(404);
    expect(stagingDirs()).toEqual([]);
  });

  it("requires multipart and at least one file", async () => {
    const json = await temp.app.inject({
      method: "POST",
      url: `/api/takeout?account_id=${String(account)}`,
      payload: { files: [] },
    });
    expect(json.statusCode).toBe(400);
    const empty = await upload([], { fields: { note: "x" } });
    expect(empty.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(empty.json()).code).toBe("no_files");
  });

  it("caps an upload at 2 GB, enforced per file and across files", async () => {
    expect(TAKEOUT_MAX_UPLOAD_BYTES).toBe(2 * 1024 ** 3);
    const app = await withOptions({ maxUploadBytes: 1024 });

    const one = await upload([{ filename: "watch-history.json", data: "x".repeat(2048) }], { app });
    expect(one.statusCode).toBe(413);
    expect(ApiErrorSchema.parse(one.json()).code).toBe("upload_too_large");

    const many = await upload(
      [
        { filename: "a.csv", data: "y".repeat(700) },
        { filename: "b.csv", data: "y".repeat(700) },
      ],
      { app },
    );
    expect(many.statusCode).toBe(413);
    expect(ApiErrorSchema.parse(many.json()).error).toContain("1024 bytes");
    expect(stagingDirs()).toEqual([]);
  });
});

describe("GET /api/takeout/:jobId", () => {
  it("reports a queued import with its files and no counts yet", async () => {
    const staged = await upload([{ filename: "watch-history.json", data: historyJson() }]);
    const { job_id } = TakeoutUploadResponseSchema.parse(staged.json());
    const response = await temp.app.inject({ method: "GET", url: `/api/takeout/${job_id}` });
    expect(response.statusCode).toBe(200);
    const body = TakeoutJobResponseSchema.parse(response.json());
    expect(body).toMatchObject({ job_id, status: "queued", error: null, counts: null });
    expect(body.files).toEqual([{ name: "watch-history.json", kind: "history" }]);
  });

  it("is 404 for an unknown job or a job of another type", async () => {
    const other = temp.db.run(
      "INSERT INTO jobs (type, status, payload_json, run_after, created_at) VALUES ('x', 'done', '{}', 0, 0)",
    ).lastInsertRowid;
    for (const id of [999, other]) {
      const response = await temp.app.inject({ method: "GET", url: `/api/takeout/${id}` });
      expect(response.statusCode).toBe(404);
    }
    const bad = await temp.app.inject({ method: "GET", url: "/api/takeout/abc" });
    expect(bad.statusCode).toBe(400);
  });
});
