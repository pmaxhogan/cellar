import {
  ActionResponseSchema,
  ActivityListResponseSchema,
  JobLogFilesResponseSchema,
  JobRowSchema,
  JobsListResponseSchema,
  NotificationRowSchema,
  NotificationsListResponseSchema,
  NotifyResultSchema,
  resolveSettings,
} from "@cellar/shared";
import Fastify from "fastify";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { logActivity } from "../src/domain/activity.ts";
import { notify } from "../src/domain/notifications.ts";
import type { CellarEvent } from "../src/events.ts";
import { JobQueue } from "../src/jobs/queue.ts";
import { jobRegistry, JobRegistry } from "../src/jobs/types.ts";
import { createConsoleLogger } from "../src/logging.ts";
import { wave1bRoutes } from "../src/routes/wave1b.ts";
import { createTempApp, type TempApp } from "./helpers.ts";

const mocks = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  generateVAPIDKeys: vi.fn(() => ({ publicKey: "PUBLIC-KEY", privateKey: "PRIVATE-KEY" })),
}));

vi.mock("web-push", () => ({
  default: {
    sendNotification: mocks.sendNotification,
    generateVAPIDKeys: mocks.generateVAPIDKeys,
  },
}));

const noop = async (): Promise<void> => {};

let temp: TempApp;
let queue: JobQueue;

beforeEach(async () => {
  jobRegistry.clear();
  jobRegistry.register("work", { class: "io", handler: noop });
  temp = await createTempApp();
  queue = new JobQueue(temp.db, { events: temp.events });
  mocks.sendNotification.mockReset().mockResolvedValue({});
});

afterEach(async () => {
  await temp.close();
  jobRegistry.clear();
});

describe("GET /api/jobs", () => {
  it("pages, filters and validates the query", async () => {
    for (let i = 0; i < 3; i += 1) {
      queue.enqueue({ type: "work" });
    }
    queue.enqueue({ type: "other" });
    queue.claimNext(["io"]);

    const all = JobsListResponseSchema.parse(
      (await temp.app.inject({ url: "/api/jobs?perPage=2" })).json(),
    );
    expect(all).toMatchObject({ total: 4, page: 1, perPage: 2 });
    expect(all.rows).toHaveLength(2);

    const running = (await temp.app.inject({ url: "/api/jobs?status=running" })).json();
    expect(running.total).toBe(1);
    expect((await temp.app.inject({ url: "/api/jobs?type=other" })).json().total).toBe(1);

    for (const bad of ["perPage=500", "page=0", "status=nope"]) {
      const response = await temp.app.inject({ url: `/api/jobs?${bad}` });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("invalid");
    }
  });

  it("returns one job or 404", async () => {
    const { id } = queue.enqueue({ type: "work", videoId: "v" });
    const row = JobRowSchema.parse(
      (await temp.app.inject({ url: `/api/jobs/${String(id)}` })).json(),
    );
    expect(row).toMatchObject({ id, type: "work", video_id: "v", status: "queued" });
    expect((await temp.app.inject({ url: "/api/jobs/999" })).statusCode).toBe(404);
    expect((await temp.app.inject({ url: "/api/jobs/abc" })).statusCode).toBe(400);
  });
});

describe("POST /api/jobs/:id/cancel and /retry", () => {
  it("cancels, publishes job.cancelled and retries", async () => {
    const seen: CellarEvent[] = [];
    temp.events.subscribe((event) => seen.push(event));
    const { id } = queue.enqueue({ type: "work" });

    const cancelled = await temp.app.inject({
      method: "POST",
      url: `/api/jobs/${String(id)}/cancel`,
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe("cancelled");
    expect(seen.map((event) => event.type)).toContain("job.cancelled");

    const again = await temp.app.inject({ method: "POST", url: `/api/jobs/${String(id)}/cancel` });
    expect(again.statusCode).toBe(409);

    const retried = await temp.app.inject({ method: "POST", url: `/api/jobs/${String(id)}/retry` });
    expect(retried.json()).toMatchObject({ status: "queued", attempts: 0 });
    expect(
      (await temp.app.inject({ method: "POST", url: `/api/jobs/${String(id)}/retry` })).statusCode,
    ).toBe(409);
    expect((await temp.app.inject({ method: "POST", url: "/api/jobs/77/retry" })).statusCode).toBe(
      404,
    );
    expect((await temp.app.inject({ method: "POST", url: "/api/jobs/77/cancel" })).statusCode).toBe(
      404,
    );
  });
});

describe("job logs", () => {
  let id: number;
  let dir: string;

  beforeEach(() => {
    id = queue.enqueue({ type: "work" }).id;
    dir = join(temp.config.logsDir, "jobs", String(id));
  });

  it("lists nothing for a job without a log dir, and 404s an unknown job", async () => {
    const response = await temp.app.inject({ url: `/api/jobs/${String(id)}/log` });
    expect(response.json()).toEqual({ files: [] });
    expect((await temp.app.inject({ url: "/api/jobs/999/log" })).statusCode).toBe(404);
  });

  it("lists files with sizes and serves them as text, gunzipping .gz", async () => {
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "job.log"), "line one\n");
    writeFileSync(join(dir, "videos.list.json.gz"), gzipSync('{"items":[]}'));
    writeFileSync(join(dir, "bad name.txt"), "skipped");

    const list = JobLogFilesResponseSchema.parse(
      (await temp.app.inject({ url: `/api/jobs/${String(id)}/log` })).json(),
    );
    expect(list.files).toEqual([
      { name: "job.log", size: 9 },
      { name: "videos.list.json.gz", size: expect.any(Number) },
    ]);

    const text = await temp.app.inject({ url: `/api/jobs/${String(id)}/log/job.log` });
    expect(text.statusCode).toBe(200);
    expect(text.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(text.headers["x-content-type-options"]).toBe("nosniff");
    expect(text.body).toBe("line one\n");

    const gz = await temp.app.inject({ url: `/api/jobs/${String(id)}/log/videos.list.json.gz` });
    expect(gz.body).toBe('{"items":[]}');
  });

  it("rejects traversal and anything that is not a plain file in the job's dir", async () => {
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(temp.config.logsDir, "secret.txt"), "nope");
    const base = `/api/jobs/${String(id)}/log/`;
    // Dot segments, literal or percent-encoded, are normalised away before routing.
    for (const name of ["..", ".", "%2E%2E", "%2E", "../secret.txt", "../../secret.txt"]) {
      const response = await temp.app.inject({ url: base + name });
      expect(response.statusCode, name).toBeGreaterThanOrEqual(400);
      expect(response.body).not.toContain("nope");
    }
    // Encoded ones reach the handler and are refused by name.
    for (const name of ["..%2Fsecret.txt", "a%5Cb", "%2E%2E%2F%2E%2E%2Fx", "x%00y"]) {
      const response = await temp.app.inject({ url: base + name });
      expect(response.statusCode, name).toBe(400);
      expect(response.body).not.toContain("nope");
    }
    expect((await temp.app.inject({ url: `${base}sub` })).statusCode).toBe(404);
    expect((await temp.app.inject({ url: `${base}missing.log` })).statusCode).toBe(404);
    expect((await temp.app.inject({ url: "/api/jobs/999/log/job.log" })).statusCode).toBe(404);
  });
});

describe("GET /api/activity", () => {
  it("pages and filters", async () => {
    const deps = { db: temp.db };
    logActivity(deps, { kind: "download", message: "a", videoId: "v1", level: "error" });
    logActivity(deps, { kind: "recheck", message: "b", videoId: "v2" });
    const body = ActivityListResponseSchema.parse(
      (await temp.app.inject({ url: "/api/activity" })).json(),
    );
    expect(body.total).toBe(2);
    const filtered = (
      await temp.app.inject({ url: "/api/activity?level=error&kind=download&video_id=v1" })
    ).json();
    expect(filtered.rows.map((row: { message: string }) => row.message)).toEqual(["a"]);
    expect((await temp.app.inject({ url: "/api/activity?level=loud" })).statusCode).toBe(400);
  });
});

describe("POST /api/actions/:name", () => {
  it("answers 501 when no handler is registered", async () => {
    const response = await temp.app.inject({ method: "POST", url: "/api/actions/eval-now" });
    expect(response.statusCode).toBe(501);
    expect(response.json()).toEqual({
      error: "The eval-now action is not available yet.",
      code: "not_implemented",
    });
  });

  it("404s an unknown action", async () => {
    const response = await temp.app.inject({ method: "POST", url: "/api/actions/format-disk" });
    expect(response.statusCode).toBe(404);
  });

  it("enqueues a deduped maintenance job when a handler exists", async () => {
    jobRegistry.register("action:reap-now", { class: "maintenance", handler: noop });
    const first = await temp.app.inject({ method: "POST", url: "/api/actions/reap-now" });
    expect(first.statusCode).toBe(202);
    const { job_id: jobId } = ActionResponseSchema.parse(first.json());
    expect(queue.get(jobId)).toMatchObject({ type: "action:reap-now", status: "queued" });
    const second = await temp.app.inject({ method: "POST", url: "/api/actions/reap-now" });
    expect(second.json().job_id).toBe(jobId);
  });

  it("uses an injected registry", async () => {
    const registry = new JobRegistry();
    registry.register("action:selfcheck", { class: "maintenance", handler: noop });
    const app = Fastify();
    app.decorate("cellar", temp.app.cellar);
    await app.register(wave1bRoutes, {
      prefix: "/api",
      registry,
      getSettings: () => resolveSettings({}),
    });
    const response = await app.inject({ method: "POST", url: "/api/actions/selfcheck" });
    expect(response.statusCode).toBe(202);
    await app.close();
  });
});

describe("/api/notifications", () => {
  it("lists, filters, acks one and acks all", async () => {
    const deps = { db: temp.db, log: createConsoleLogger("silent") };
    await notify(deps, { type: "a", title: "A", body: "" });
    await notify(deps, { type: "b", title: "B", body: "" });

    const list = NotificationsListResponseSchema.parse(
      (await temp.app.inject({ url: "/api/notifications" })).json(),
    );
    expect(list.total).toBe(2);
    const id = list.rows[0]?.id as number;

    const acked = await temp.app.inject({
      method: "POST",
      url: `/api/notifications/${String(id)}/ack`,
    });
    expect(NotificationRowSchema.parse(acked.json()).acked_at).not.toBeNull();
    expect((await temp.app.inject({ url: "/api/notifications?unacked=true" })).json().total).toBe(
      1,
    );
    expect((await temp.app.inject({ url: "/api/notifications?unacked=0" })).json().total).toBe(2);
    expect(
      (await temp.app.inject({ method: "POST", url: "/api/notifications/999/ack" })).statusCode,
    ).toBe(404);

    const all = await temp.app.inject({ method: "POST", url: "/api/notifications/ack-all" });
    expect(all.json()).toEqual({ acked: 1 });
  });

  it("serves the VAPID public key and never the private one", async () => {
    const response = await temp.app.inject({ url: "/api/notifications/vapid-public-key" });
    expect(response.json()).toEqual({ key: "PUBLIC-KEY" });
    expect(response.body).not.toContain("PRIVATE-KEY");
  });

  it("stores and removes push subscriptions and rejects unknown push hosts", async () => {
    const endpoint = "https://fcm.googleapis.com/fcm/send/abc";
    const subscribed = await temp.app.inject({
      method: "POST",
      url: "/api/notifications/subscribe",
      payload: { endpoint, expirationTime: null, keys: { p256dh: "p", auth: "a" } },
    });
    expect(subscribed.statusCode).toBe(204);
    expect(temp.db.all("SELECT endpoint FROM push_subscriptions")).toEqual([{ endpoint }]);

    for (const bad of ["http://fcm.googleapis.com/x", "https://internal.example/hook"]) {
      const rejected = await temp.app.inject({
        method: "POST",
        url: "/api/notifications/subscribe",
        payload: { endpoint: bad, keys: { p256dh: "p", auth: "a" } },
      });
      expect(rejected.statusCode, bad).toBe(400);
    }

    const removed = await temp.app.inject({
      method: "DELETE",
      url: "/api/notifications/subscribe",
      payload: { endpoint },
    });
    expect(removed.statusCode).toBe(204);
    expect(temp.db.all("SELECT endpoint FROM push_subscriptions")).toEqual([]);
    expect(
      (await temp.app.inject({ method: "DELETE", url: "/api/notifications/subscribe" })).statusCode,
    ).toBe(400);
  });

  it("sends a test notification that bypasses the rate limit", async () => {
    await temp.app.inject({
      method: "POST",
      url: "/api/notifications/subscribe",
      payload: {
        endpoint: "https://fcm.googleapis.com/fcm/send/t",
        keys: { p256dh: "p", auth: "a" },
      },
    });
    for (let i = 0; i < 2; i += 1) {
      const response = await temp.app.inject({ method: "POST", url: "/api/notifications/test" });
      expect(NotifyResultSchema.parse(response.json())).toMatchObject({ sent: true, pushed: 1 });
    }
    const [, , options] = mocks.sendNotification.mock.calls[0] as [
      unknown,
      unknown,
      { vapidDetails: { subject: string } },
    ];
    expect(options.vapidDetails.subject).toBe("mailto:cellar@localhost");
  });
});

describe("app wiring", () => {
  it("mounts the routes behind Cloudflare Access", async () => {
    const dir = temp.dir;
    const app = await buildApp({
      config: {
        ...temp.config,
        insecureMode: false,
        cfAccess: { teamDomain: "t", aud: "a", allowedEmails: ["x@y.z"] },
      },
      log: createConsoleLogger("silent"),
      db: temp.db,
      cfAccessGetKey: () => Promise.reject(new Error("no keys")),
    });
    try {
      const response = await app.inject({ url: "/api/jobs" });
      expect(response.statusCode).toBe(401);
      expect(dir).toBeTruthy();
    } finally {
      await app.close();
    }
  });
});
