import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PushError,
  SERVICE_WORKER_URL,
  browserPushEnv,
  currentSubscription,
  pushSupported,
  subscribePush,
  unsubscribePush,
  urlBase64ToUint8Array,
} from "../../src/lib/push.ts";
import { fakeServer, json, noContent } from "../helpers/fakeServer.ts";
import { fakePush } from "./fixtures.ts";

const KEY =
  "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";

function server() {
  return fakeServer()
    .on("GET", "/api/notifications/vapid-public-key", () => json({ key: KEY }))
    .on("POST", "/api/notifications/subscribe", () => noContent())
    .on("DELETE", "/api/notifications/subscribe", () => noContent());
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("urlBase64ToUint8Array", () => {
  it("decodes unpadded base64", () => {
    expect([...urlBase64ToUint8Array("AQID")]).toEqual([1, 2, 3]);
    expect([...urlBase64ToUint8Array("AQIDBA")]).toEqual([1, 2, 3, 4]);
    expect([...urlBase64ToUint8Array("AQIDBAU")]).toEqual([1, 2, 3, 4, 5]);
  });

  it("maps the url-safe alphabet back to standard base64", () => {
    // 0xfb 0xff is "+/8=" in standard base64 and "-_8" in base64url.
    expect([...urlBase64ToUint8Array("-_8")]).toEqual([0xfb, 0xff]);
  });

  it("returns a buffer-backed array the size of a P-256 public key", () => {
    const bytes = urlBase64ToUint8Array(KEY);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.buffer).toBeInstanceOf(ArrayBuffer);
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(4);
  });
});

describe("feature detection", () => {
  it("needs both a service worker container and PushManager", () => {
    const { env } = fakePush();
    expect(pushSupported(env)).toBe(true);
    expect(pushSupported({ ...env, hasPushManager: false })).toBe(false);
    expect(pushSupported({ ...env, serviceWorker: undefined })).toBe(false);
  });

  it("reads the real browser globals", () => {
    const register = vi.fn();
    vi.stubGlobal("PushManager", function PushManager() {});
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register },
    });
    try {
      const env = browserPushEnv();
      expect(env.hasPushManager).toBe(true);
      expect(env.serviceWorker).toEqual({ register });
    } finally {
      delete (navigator as unknown as Record<string, unknown>).serviceWorker;
    }
  });
});

describe("subscribePush", () => {
  it("asks permission, registers /sw.js, subscribes with the VAPID key and posts it", async () => {
    const push = fakePush();
    const fake = server();
    const result = await subscribePush(fake.api, push.env);

    expect(push.requestPermission).toHaveBeenCalledOnce();
    expect(push.register).toHaveBeenCalledWith(SERVICE_WORKER_URL);
    expect(push.subscribe).toHaveBeenCalledOnce();
    const options = push.subscribe.mock.calls[0]![0] as {
      userVisibleOnly: boolean;
      applicationServerKey: Uint8Array;
    };
    expect(options.userVisibleOnly).toBe(true);
    expect([...options.applicationServerKey]).toEqual([...urlBase64ToUint8Array(KEY)]);
    const posts = fake.callsTo("POST", "/api/notifications/subscribe");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({
      endpoint: "https://push.example/endpoint-1",
      expirationTime: null,
      keys: { p256dh: "pkey", auth: "akey" },
    });
    expect(result.endpoint).toBe("https://push.example/endpoint-1");
  });

  it("does not ask again once permission is granted, and reuses a live subscription", async () => {
    const push = fakePush({ permission: "granted", subscribed: true });
    const fake = server();
    await subscribePush(fake.api, push.env);
    expect(push.requestPermission).not.toHaveBeenCalled();
    expect(push.subscribe).not.toHaveBeenCalled();
    expect(fake.callsTo("POST", "/api/notifications/subscribe")).toHaveLength(1);
  });

  it("stops with a readable error when permission is denied", async () => {
    const push = fakePush({ grant: "denied" });
    const fake = server();
    const failure = await subscribePush(fake.api, push.env).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(PushError);
    expect((failure as PushError).problem).toBe("denied");
    expect(push.register).not.toHaveBeenCalled();
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses when the browser has no push support", async () => {
    const push = fakePush();
    const failure = await subscribePush(server().api, { ...push.env, hasPushManager: false }).catch(
      (cause: unknown) => cause,
    );
    expect((failure as PushError).problem).toBe("unsupported");
  });
});

describe("currentSubscription and unsubscribePush", () => {
  it("reports null without push support", async () => {
    const push = fakePush({ subscribed: true });
    expect(await currentSubscription({ ...push.env, serviceWorker: undefined })).toBeNull();
    expect(await currentSubscription(push.env)).not.toBeNull();
  });

  it("unsubscribes the browser, then deletes the endpoint on the server", async () => {
    const push = fakePush({ subscribed: true });
    const fake = server();
    await unsubscribePush(fake.api, push.env);
    expect(push.subscription.unsubscribe).toHaveBeenCalledOnce();
    const deletes = fake.callsTo("DELETE", "/api/notifications/subscribe");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.body).toEqual({ endpoint: "https://push.example/endpoint-1" });
  });

  it("does nothing when there is no subscription", async () => {
    const push = fakePush();
    const fake = server();
    await unsubscribePush(fake.api, push.env);
    expect(fake.calls).toHaveLength(0);
  });
});
