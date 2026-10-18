import { resolveSettings, type ResolvedSettings } from "@cellar/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKv, setKv } from "../src/db/kv.ts";
import {
  ackAllNotifications,
  ackNotification,
  DEFAULT_VAPID_SUBJECT,
  deletePushSubscription,
  DOWNLOAD_FAILURES_KV_KEY,
  ensureVapidKeys,
  listNotifications,
  notify,
  recordAccountAuthLoss,
  recordDownloadFailure,
  recordDownloadSuccess,
  recordFsError,
  recordOutage,
  recordStoragePressure,
  savePushSubscription,
  sendTestNotification,
  VAPID_KV_KEY,
  vapidSubjectFor,
  type NotifyDeps,
} from "../src/domain/notifications.ts";
import { EventBus, type CellarEvent } from "../src/events.ts";
import { createConsoleLogger } from "../src/logging.ts";
import { createTempDb, type TempDb } from "./helpers.ts";

const mocks = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  generateVAPIDKeys: vi.fn(),
}));

vi.mock("web-push", () => ({
  default: {
    sendNotification: mocks.sendNotification,
    generateVAPIDKeys: mocks.generateVAPIDKeys,
  },
}));

const HOUR = 60 * 60_000;
const FCM = "https://fcm.googleapis.com/fcm/send/";

let temp: TempDb;
let events: EventBus;
let seen: CellarEvent[];
let clock: number;
let settings: ResolvedSettings;
let deps: NotifyDeps;

function subscribe(endpoint: string): void {
  savePushSubscription(temp.db, { endpoint, keys: { p256dh: "p", auth: "a" } }, clock);
}

function statusError(statusCode: number): Error {
  return Object.assign(new Error(`status ${String(statusCode)}`), { statusCode });
}

beforeEach(() => {
  temp = createTempDb();
  events = new EventBus();
  seen = [];
  events.subscribe((event) => seen.push(event));
  clock = 100 * HOUR;
  settings = resolveSettings({});
  deps = {
    db: temp.db,
    log: createConsoleLogger("silent"),
    events,
    getSettings: () => settings,
    vapidSubject: "mailto:owner@example.com",
    now: () => clock,
  };
  mocks.sendNotification.mockReset().mockResolvedValue({ statusCode: 201 });
  let n = 0;
  mocks.generateVAPIDKeys.mockReset().mockImplementation(() => {
    n += 1;
    return { publicKey: `pub${String(n)}`, privateKey: `priv${String(n)}` };
  });
});

afterEach(() => {
  temp.close();
});

describe("VAPID keys", () => {
  it("generates once and then reads them back from kv", () => {
    expect(ensureVapidKeys(temp.db)).toEqual({ publicKey: "pub1", privateKey: "priv1" });
    expect(ensureVapidKeys(temp.db)).toEqual({ publicKey: "pub1", privateKey: "priv1" });
    expect(mocks.generateVAPIDKeys).toHaveBeenCalledTimes(1);
    expect(getKv(temp.db, VAPID_KV_KEY)).toEqual({ publicKey: "pub1", privateKey: "priv1" });
  });

  it("regenerates a malformed stored keypair", () => {
    setKv(temp.db, VAPID_KV_KEY, { publicKey: 5 });
    expect(ensureVapidKeys(temp.db).publicKey).toBe("pub1");
    setKv(temp.db, VAPID_KV_KEY, null);
    expect(ensureVapidKeys(temp.db).publicKey).toBe("pub2");
  });

  it("derives the subject from the first allowed Access email", () => {
    expect(vapidSubjectFor({ cfAccess: null })).toBe(DEFAULT_VAPID_SUBJECT);
    expect(
      vapidSubjectFor({
        cfAccess: { teamDomain: "t", aud: "a", allowedEmails: ["me@example.com", "x@y.z"] },
      }),
    ).toBe("mailto:me@example.com");
  });
});

describe("notify", () => {
  it("stores the notification, publishes it and records the send time", async () => {
    const result = await notify(deps, {
      type: "thing",
      title: "Title",
      body: "Body",
      data: { a: 1 },
      videoId: "vid",
    });
    expect(result).toEqual({ sent: true, id: expect.any(Number), pushed: 0 });
    const rows = listNotifications(temp.db, { page: 1, perPage: 5 }).rows;
    expect(rows).toEqual([
      {
        id: result.sent ? result.id : -1,
        type: "thing",
        title: "Title",
        body: "Body",
        data: { a: 1 },
        video_id: "vid",
        created_at: clock,
        acked_at: null,
        pushed_at: null,
      },
    ]);
    expect(seen).toEqual([
      expect.objectContaining({
        type: "notification",
        payload: { id: rows[0]?.id, type: "thing", title: "Title" },
      }),
    ]);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("pushes to every subscription with the VAPID details and sets pushed_at", async () => {
    subscribe(`${FCM}one`);
    subscribe("https://updates.push.services.mozilla.com/wpush/v2/two");
    const result = await notify(deps, { type: "t", title: "Hi", body: "There" });
    expect(result).toMatchObject({ sent: true, pushed: 2 });
    expect(mocks.sendNotification).toHaveBeenCalledTimes(2);
    const [subscription, payload, options] = mocks.sendNotification.mock.calls[0] as [
      unknown,
      string,
      { TTL: number; vapidDetails: Record<string, string> },
    ];
    expect(subscription).toEqual({ endpoint: `${FCM}one`, keys: { p256dh: "p", auth: "a" } });
    expect(JSON.parse(payload)).toMatchObject({ type: "t", title: "Hi", body: "There" });
    expect(options.vapidDetails).toEqual({
      subject: "mailto:owner@example.com",
      publicKey: "pub1",
      privateKey: "priv1",
    });
    expect(listNotifications(temp.db, { page: 1, perPage: 1 }).rows[0]?.pushed_at).toBe(clock);
  });

  it("deletes subscriptions that answer 404 or 410 and keeps the rest", async () => {
    subscribe(`${FCM}gone`);
    subscribe(`${FCM}missing`);
    subscribe(`${FCM}flaky`);
    subscribe(`${FCM}ok`);
    mocks.sendNotification.mockImplementation((sub: { endpoint: string }) => {
      if (sub.endpoint.endsWith("gone")) {
        return Promise.reject(statusError(410));
      }
      if (sub.endpoint.endsWith("missing")) {
        return Promise.reject(statusError(404));
      }
      if (sub.endpoint.endsWith("flaky")) {
        return Promise.reject(statusError(500));
      }
      return Promise.resolve({});
    });
    const result = await notify(deps, { type: "t", title: "a", body: "b" });
    expect(result).toMatchObject({ pushed: 1 });
    const left = temp.db
      .all<{ endpoint: string }>("SELECT endpoint FROM push_subscriptions ORDER BY endpoint")
      .map((row) => row.endpoint);
    expect(left).toEqual([`${FCM}flaky`, `${FCM}ok`]);
  });

  it("leaves pushed_at empty when every delivery fails, including non-Error rejections", async () => {
    subscribe(`${FCM}one`);
    mocks.sendNotification.mockRejectedValue("nope");
    const result = await notify(deps, { type: "t", title: "a", body: "b" });
    expect(result).toMatchObject({ sent: true, pushed: 0 });
    expect(listNotifications(temp.db, { page: 1, perPage: 1 }).rows[0]?.pushed_at).toBeNull();
  });

  it("never sends to a stored endpoint that is not a known push service", async () => {
    temp.db.run(
      "INSERT INTO push_subscriptions (endpoint, keys_json, created_at) VALUES (?, ?, 1)",
      "https://169.254.169.254/latest/meta-data",
      '{"p256dh":"p","auth":"a"}',
    );
    temp.db.run(
      "INSERT INTO push_subscriptions (endpoint, keys_json, created_at) VALUES (?, ?, 1)",
      "garbage",
      '{"p256dh":"p","auth":"a"}',
    );
    subscribe(`${FCM}ok`);
    const result = await notify(deps, { type: "t", title: "a", body: "b" });
    expect(result).toMatchObject({ pushed: 1 });
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    expect(mocks.sendNotification.mock.calls[0]?.[0]).toMatchObject({ endpoint: `${FCM}ok` });
  });

  it("still records the notification when push setup itself throws", async () => {
    subscribe(`${FCM}one`);
    mocks.generateVAPIDKeys.mockImplementation(() => {
      throw new Error("no crypto");
    });
    const result = await notify(deps, { type: "t", title: "a", body: "b" });
    expect(result).toMatchObject({ sent: true, pushed: 0 });
  });

  it("rate limits a type until the window passes or the last one is acknowledged", async () => {
    const first = await notify(deps, { type: "t", title: "1", body: "" });
    expect(await notify(deps, { type: "t", title: "2", body: "" })).toEqual({
      sent: false,
      reason: "rate_limited",
    });
    // Another type is independent.
    expect((await notify(deps, { type: "other", title: "x", body: "" })).sent).toBe(true);

    if (first.sent) {
      ackNotification(temp.db, first.id, clock);
    }
    clock += 1;
    const second = await notify(deps, { type: "t", title: "3", body: "" });
    expect(second.sent).toBe(true);

    clock += 6 * HOUR - 1;
    expect((await notify(deps, { type: "t", title: "4", body: "" })).sent).toBe(false);
    clock += 1;
    expect((await notify(deps, { type: "t", title: "5", body: "" })).sent).toBe(true);
    expect((await notify(deps, { type: "t", title: "6", body: "", force: true })).sent).toBe(true);
    expect(listNotifications(temp.db, { page: 1, perPage: 50 }).total).toBe(5);
  });

  it("honours notify.rate_limit_hours, a per-call window and a rate key", async () => {
    settings = resolveSettings({ "notify.rate_limit_hours": 1 });
    await notify(deps, { type: "t", title: "1", body: "" });
    clock += HOUR;
    expect((await notify(deps, { type: "t", title: "2", body: "" })).sent).toBe(true);
    clock += HOUR;
    expect((await notify(deps, { type: "t", title: "3", body: "", rateLimitHours: 3 })).sent).toBe(
      false,
    );
    expect((await notify(deps, { type: "t", title: "4", body: "", rateKey: "t:other" })).sent).toBe(
      true,
    );
  });

  it("allows a send when the notification behind the rate state is gone", async () => {
    await notify(deps, { type: "t", title: "1", body: "" });
    temp.db.run("DELETE FROM notifications");
    expect((await notify(deps, { type: "t", title: "2", body: "" })).sent).toBe(true);
  });

  it("works without an event bus, settings hook or clock", async () => {
    const plain: NotifyDeps = { db: temp.db, log: createConsoleLogger("silent") };
    expect((await notify(plain, { type: "t", title: "a", body: "b" })).sent).toBe(true);
    expect((await notify(plain, { type: "t", title: "a", body: "b" })).sent).toBe(false);
  });
});

describe("error-policy helpers", () => {
  it("notifies after N distinct consecutive download failures and resets", async () => {
    expect(await recordDownloadFailure(deps, "a")).toBeNull();
    expect(await recordDownloadFailure(deps, "a")).toBeNull();
    expect(await recordDownloadFailure(deps, "b")).toBeNull();
    const fired = await recordDownloadFailure(deps, "c");
    expect(fired).toMatchObject({ sent: true });
    const row = listNotifications(temp.db, { page: 1, perPage: 1 }).rows[0];
    expect(row).toMatchObject({ type: "download_failures", data: { videos: ["a", "b", "c"] } });
    expect(getKv(temp.db, DOWNLOAD_FAILURES_KV_KEY)).toEqual({ videos: [] });
  });

  it("resets the failure streak on a success and tolerates a malformed counter", async () => {
    recordDownloadSuccess(deps);
    await recordDownloadFailure(deps, "a");
    await recordDownloadFailure(deps, "b");
    recordDownloadSuccess(deps);
    expect(getKv(temp.db, DOWNLOAD_FAILURES_KV_KEY)).toEqual({ videos: [] });
    expect(await recordDownloadFailure(deps, "c")).toBeNull();

    setKv(temp.db, DOWNLOAD_FAILURES_KV_KEY, { videos: [1, "x"] });
    settings = resolveSettings({ "notify.consecutive_download_failures": 2 });
    expect(await recordDownloadFailure(deps, "y")).toMatchObject({ sent: true });
  });

  it("limits storage pressure to its own window", async () => {
    settings = resolveSettings({ "notify.storage_pressure_hours": 1 });
    const first = await recordStoragePressure(deps, 3, "Location 3 is 99% full");
    expect(first.sent).toBe(true);
    expect(listNotifications(temp.db, { page: 1, perPage: 1 }).rows[0]).toMatchObject({
      type: "storage_pressure",
      body: "Location 3 is 99% full",
      data: { locationId: 3 },
    });
    clock += HOUR - 1;
    expect((await recordStoragePressure(deps, 3, "again")).sent).toBe(false);
    clock += 1;
    expect((await recordStoragePressure(deps, 3, "again")).sent).toBe(true);
  });

  it("always sends filesystem errors", async () => {
    expect((await recordFsError(deps, "EIO on /media")).sent).toBe(true);
    expect((await recordFsError(deps, "EIO on /media")).sent).toBe(true);
  });

  it("limits auth loss per account", async () => {
    expect((await recordAccountAuthLoss(deps, 1)).sent).toBe(true);
    expect((await recordAccountAuthLoss(deps, 1, "cookies rejected")).sent).toBe(false);
    expect((await recordAccountAuthLoss(deps, 2, "cookies rejected")).sent).toBe(true);
    const rows = listNotifications(temp.db, { page: 1, perPage: 5 }).rows;
    expect(rows.map((row) => row.body)).toEqual([
      "cookies rejected",
      "Account 1 is no longer signed in. Re-link it.",
    ]);
  });

  it("limits outage notifications to notify.outage_hours", async () => {
    settings = resolveSettings({ "notify.outage_hours": 2 });
    expect((await recordOutage(deps, "videos.list failed")).sent).toBe(true);
    clock += HOUR;
    expect((await recordOutage(deps, "still failing")).sent).toBe(false);
    clock += HOUR;
    expect((await recordOutage(deps, "still failing")).sent).toBe(true);
  });

  it("sends a forced test notification", async () => {
    expect((await sendTestNotification(deps)).sent).toBe(true);
    expect((await sendTestNotification(deps)).sent).toBe(true);
  });
});

describe("inbox and subscriptions", () => {
  it("lists, filters unacknowledged, acknowledges idempotently and acks all", async () => {
    for (const title of ["a", "b", "c"]) {
      clock += 1;
      await notify(deps, { type: title, title, body: "" });
    }
    const page = listNotifications(temp.db, { page: 1, perPage: 2 });
    expect(page.total).toBe(3);
    expect(page.rows.map((row) => row.title)).toEqual(["c", "b"]);

    const first = page.rows[0]?.id as number;
    expect(ackNotification(temp.db, first, 7).acked_at).toBe(7);
    expect(ackNotification(temp.db, first, 9).acked_at).toBe(7);
    expect(listNotifications(temp.db, { page: 1, perPage: 9, unacked: true }).total).toBe(2);
    expect(() => ackNotification(temp.db, 9999)).toThrow(/does not exist/);

    expect(ackAllNotifications(temp.db, 11)).toBe(2);
    expect(ackAllNotifications(temp.db)).toBe(0);
    expect(listNotifications(temp.db, { page: 1, perPage: 9, unacked: true }).total).toBe(0);
  });

  it("upserts subscriptions by endpoint and deletes them", () => {
    subscribe(`${FCM}x`);
    savePushSubscription(temp.db, { endpoint: `${FCM}x`, keys: { p256dh: "p2", auth: "a2" } });
    const rows = temp.db.all<{ keys_json: string }>("SELECT keys_json FROM push_subscriptions");
    expect(rows.map((row) => JSON.parse(row.keys_json))).toEqual([{ p256dh: "p2", auth: "a2" }]);
    deletePushSubscription(temp.db, `${FCM}x`);
    deletePushSubscription(temp.db, `${FCM}never`);
    expect(temp.db.all("SELECT * FROM push_subscriptions")).toEqual([]);
  });
});
