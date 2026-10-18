import {
  ApiErrorSchema,
  InspectResponseSchema,
  RulePreviewSchema,
  RuleRowSchema,
  RulesListResponseSchema,
  type RuleRow,
} from "@cellar/shared";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDefaultRules } from "../src/domain/rules.ts";
import { EVAL_PASS_JOB } from "../src/domain/ruleEval.ts";
import { JobRegistry } from "../src/jobs/types.ts";
import { createConsoleLogger } from "../src/logging.ts";
import { wave2bRoutes } from "../src/routes/wave2b.ts";
import { createTempApp, type TempApp } from "./helpers.ts";
import { addVideo, harness, vid } from "./rulesFixtures.ts";

const log = createConsoleLogger("silent");

let temp: TempApp;

function custom(name: string): Record<string, unknown> {
  return {
    kind: "custom",
    video_id: null,
    position: 1,
    name,
    enabled: true,
    condition: { type: "cond", field: "views", op: "gt", value: 10 },
    effects: { reclaim_priority: 4 },
  };
}

async function rules(): Promise<RuleRow[]> {
  const res = await temp.app.inject({ method: "GET", url: "/api/rules" });
  expect(res.statusCode).toBe(200);
  return RulesListResponseSchema.parse(res.json()).rows;
}

function evalJobs(): number {
  return (
    temp.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE type = ?", EVAL_PASS_JOB)?.n ??
    0
  );
}

beforeEach(async () => {
  temp = await createTempApp();
  ensureDefaultRules(temp.db, log);
});

afterEach(async () => {
  await temp.close();
});

describe("/api/rules", () => {
  it("lists the global rule first, then customs by position", async () => {
    const rows = await rules();
    expect(rows).toHaveLength(8);
    expect(rows[0]?.kind).toBe("global");
    expect(rows.slice(1).map((r) => r.position)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("creates, updates (PUT and PATCH) and deletes custom rules, scheduling a pass", async () => {
    const created = await temp.app.inject({
      method: "POST",
      url: "/api/rules",
      payload: custom("New"),
    });
    expect(created.statusCode).toBe(201);
    const row = RuleRowSchema.parse(created.json());
    expect(row.position).toBe(8);
    expect(evalJobs()).toBe(1);

    const put = await temp.app.inject({
      method: "PUT",
      url: `/api/rules/${String(row.id)}`,
      payload: { ...custom("Renamed"), enabled: false },
    });
    expect(put.statusCode).toBe(200);
    expect(RuleRowSchema.parse(put.json())).toMatchObject({ name: "Renamed", enabled: false });

    const patch = await temp.app.inject({
      method: "PATCH",
      url: `/api/rules/${String(row.id)}`,
      payload: custom("Patched"),
    });
    expect(patch.json()).toMatchObject({ name: "Patched", enabled: true });
    expect(evalJobs()).toBe(1);

    const del = await temp.app.inject({ method: "DELETE", url: `/api/rules/${String(row.id)}` });
    expect(del.statusCode).toBe(204);
    expect(await rules()).toHaveLength(8);
  });

  it("answers 400 / 404 / 409 with the ApiError shape", async () => {
    const bad = await temp.app.inject({
      method: "POST",
      url: "/api/rules",
      payload: { ...custom("x"), condition: { type: "cond", field: "views", op: "nope" } },
    });
    expect(bad.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(bad.json())).toMatchObject({ code: "invalid" });
    expect(bad.json().details.condition[0]).toMatchObject({ code: "unknown_op" });

    const global = (await rules())[0] as RuleRow;
    const del = await temp.app.inject({ method: "DELETE", url: `/api/rules/${String(global.id)}` });
    expect(del.statusCode).toBe(409);
    expect(del.json()).toMatchObject({ code: "immutable" });

    const missing = await temp.app.inject({
      method: "PUT",
      url: "/api/rules/9999",
      payload: custom("x"),
    });
    expect(missing.statusCode).toBe(404);
    const badId = await temp.app.inject({ method: "DELETE", url: "/api/rules/abc" });
    expect(badId.statusCode).toBe(400);
  });

  it("reorders custom rules and validates the id set", async () => {
    const ids = (await rules()).slice(1).map((r) => r.id);
    const reversed = [...ids].reverse();
    const res = await temp.app.inject({
      method: "PUT",
      url: "/api/rules/order",
      payload: { ids: reversed },
    });
    expect(res.statusCode).toBe(200);
    expect(
      RulesListResponseSchema.parse(res.json())
        .rows.slice(1)
        .map((r) => r.id),
    ).toEqual(reversed);
    const wrong = await temp.app.inject({
      method: "PUT",
      url: "/api/rules/order",
      payload: { ids: ids.slice(1) },
    });
    expect(wrong.statusCode).toBe(400);
    const shape = await temp.app.inject({
      method: "PUT",
      url: "/api/rules/order",
      payload: { ids: "x" },
    });
    expect(shape.statusCode).toBe(400);
  });

  it("previews a condition", async () => {
    addVideo(temp.db, vid("prevA"), { views: 50 });
    addVideo(temp.db, vid("prevB"), { views: 5 });
    const res = await temp.app.inject({
      method: "POST",
      url: "/api/rules/preview",
      payload: { condition: { type: "cond", field: "views", op: "gt", value: 10 } },
    });
    expect(res.statusCode).toBe(200);
    expect(RulePreviewSchema.parse(res.json())).toMatchObject({ count: 1, total: 2 });
    const bad = await temp.app.inject({ method: "POST", url: "/api/rules/preview", payload: {} });
    expect(bad.statusCode).toBe(400);
  });
});

describe("/api/inspect and overrides", () => {
  it("inspects known and unknown ids", async () => {
    const id = addVideo(temp.db, vid("inspect"), { title: "Known" });
    const res = await temp.app.inject({
      method: "GET",
      url: `/api/inspect?id=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(InspectResponseSchema.parse(res.json())).toMatchObject({
      video_id: id,
      known: true,
      title: "Known",
    });

    const unknown = await temp.app.inject({ method: "GET", url: "/api/inspect?id=qqqqqqqqqqq" });
    expect(unknown.json()).toMatchObject({ known: false });
    expect((await temp.app.inject({ method: "GET", url: "/api/inspect" })).statusCode).toBe(400);
    expect((await temp.app.inject({ method: "GET", url: "/api/inspect?id=nope" })).statusCode).toBe(
      400,
    );
  });

  it("sets and clears per-video overrides", async () => {
    const id = addVideo(temp.db, vid("override"));
    const set = await temp.app.inject({
      method: "PUT",
      url: `/api/videos/${id}/overrides`,
      payload: { effects: { include: false } },
    });
    expect(set.statusCode).toBe(200);
    const view = InspectResponseSchema.parse(set.json());
    expect(view.overrides).toEqual({ include: false });
    expect(view.effective["include"]).toBe(false);
    expect(view.evaluated_at).not.toBeNull();

    const clear = await temp.app.inject({
      method: "PUT",
      url: `/api/videos/${id}/overrides`,
      payload: { effects: null },
    });
    expect(clear.json()).toMatchObject({ overrides: null });

    const missing = await temp.app.inject({
      method: "PUT",
      url: `/api/videos/${id}/overrides`,
      payload: { include: false },
    });
    expect(missing.statusCode).toBe(400);
    const invalid = await temp.app.inject({
      method: "PUT",
      url: `/api/videos/${id}/overrides`,
      payload: { effects: { reclaim_priority: "high" } },
    });
    expect(invalid.statusCode).toBe(400);
  });
});

describe("wave2bRoutes options", () => {
  it("uses injected deps when given", async () => {
    const app = Fastify();
    app.decorate("cellar", {
      config: temp.config,
      log,
      db: temp.db,
      events: temp.events,
      version: "t",
      startedAt: 0,
    });
    const h = harness(temp.db, temp.dir);
    await app.register(wave2bRoutes, { prefix: "/api", deps: h.deps, registry: new JobRegistry() });
    const res = await app.inject({
      method: "POST",
      url: "/api/rules",
      payload: custom("Injected"),
    });
    expect(res.statusCode).toBe(201);
    expect(h.seen.some((e) => e.type === "rules.changed")).toBe(true);
    await app.close();
  });
});
