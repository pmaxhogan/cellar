import type { AddressInfo } from "node:net";
import { StatusResponseSchema } from "@cellar/shared";
import { afterEach, describe, expect, it } from "vitest";
import { setKv } from "../src/db/kv.ts";
import { EventBus } from "../src/events.ts";
import { TOOL_VERSIONS_KEY } from "../src/media/tools.ts";
import { eventRoutes } from "../src/routes/events.ts";
import { createTempApp, type TempApp } from "./helpers.ts";

let temp: TempApp | null = null;

afterEach(async () => {
  await temp?.close();
  temp = null;
});

describe("GET /healthz", () => {
  it("answers ok with the version, no auth needed", async () => {
    temp = await createTempApp();
    const response = await temp.app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, version: "9.9.9-test" });
  });
});

describe("GET /api/status", () => {
  it("matches the shared contract and reports insecure mode", async () => {
    temp = await createTempApp({}, { startedAt: 1234 });
    const before = Date.now();
    const response = await temp.app.inject({ method: "GET", url: "/api/status" });
    expect(response.statusCode).toBe(200);
    const body = StatusResponseSchema.parse(response.json());
    expect(body).toMatchObject({
      version: "9.9.9-test",
      insecureMode: true,
      startedAt: 1234,
      db: { ok: true, migrations: 3 },
      tools: { ytdlp: null, ffmpeg: null },
    });
    expect(body.now).toBeGreaterThanOrEqual(before);
  });

  it("reports tool versions recorded in kv", async () => {
    temp = await createTempApp();
    setKv(temp.db, TOOL_VERSIONS_KEY, { ytdlp: "2026.08.19", ffmpeg: "N-1", checkedAt: 1 });
    const body = (await temp.app.inject({ method: "GET", url: "/api/status" })).json();
    expect(body.tools).toEqual({ ytdlp: "2026.08.19", ffmpeg: "N-1" });
  });

  it("ignores a malformed tool_versions row", async () => {
    temp = await createTempApp();
    setKv(temp.db, TOOL_VERSIONS_KEY, { ytdlp: 5, ffmpeg: null });
    expect((await temp.app.inject({ method: "GET", url: "/api/status" })).json().tools).toEqual({
      ytdlp: null,
      ffmpeg: null,
    });
    setKv(temp.db, TOOL_VERSIONS_KEY, null);
    expect((await temp.app.inject({ method: "GET", url: "/api/status" })).json().tools).toEqual({
      ytdlp: null,
      ffmpeg: null,
    });
  });

  it("reports the database as down rather than failing the request", async () => {
    temp = await createTempApp();
    temp.db.exec("DROP TABLE migrations");
    const body = (await temp.app.inject({ method: "GET", url: "/api/status" })).json();
    expect(body.db).toEqual({ ok: false, migrations: 0 });
  });
});

describe("unmatched API routes", () => {
  it("answer JSON 404 in the ApiError shape without echoing the query", async () => {
    temp = await createTempApp();
    const response = await temp.app.inject({ method: "GET", url: "/api/nope?secret=abc" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: "No API route matches GET /api/nope.",
      code: "not_found",
    });
  });
});

describe("GET /api/events", () => {
  it("streams published events as SSE frames", async () => {
    temp = await createTempApp();
    await temp.app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = temp.app.server.address() as AddressInfo;
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${String(port)}/api/events`, {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-cache");

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toContain(": connected");

    // The subscription is registered before the first chunk is written.
    expect(temp.events.subscriberCount).toBe(1);
    temp.events.publish("job.updated", { id: 7 });
    const chunk = decoder.decode((await reader.read()).value);
    expect(chunk).toMatch(/^event: job\.updated\ndata: /);
    const frame = JSON.parse(chunk.split("data: ")[1]!.trim()) as Record<string, unknown>;
    expect(frame).toMatchObject({ type: "job.updated", payload: { id: 7 } });
    expect(typeof frame["at"]).toBe("number");

    controller.abort();
    await reader.cancel().catch(() => undefined);
    await expect.poll(() => temp?.events.subscriberCount).toBe(0);
  });

  it("sends a heartbeat comment on the configured interval", async () => {
    temp = await createTempApp();
    // A second instance of the route with a fast heartbeat, under its own prefix.
    await temp.app.register(eventRoutes, { prefix: "/fast", heartbeatMs: 20 });
    await temp.app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = temp.app.server.address() as AddressInfo;
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${String(port)}/fast/events`, {
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes(": heartbeat")) {
      text += decoder.decode((await reader.read()).value);
    }
    expect(text).toContain(": heartbeat");
    controller.abort();
    await reader.cancel().catch(() => undefined);
  });
});

describe("EventBus", () => {
  it("fans out to every subscriber and stops after unsubscribe", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const off = bus.subscribe((event) => seen.push(`a:${event.type}`));
    bus.subscribe((event) => seen.push(`b:${event.type}`));
    bus.publish("x");
    off();
    bus.publish("y");
    expect(seen).toEqual(["a:x", "b:x", "b:y"]);
    expect(bus.subscriberCount).toBe(1);
    bus.clear();
    expect(bus.subscriberCount).toBe(0);
  });
});
