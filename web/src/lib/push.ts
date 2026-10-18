import type { ApiClient } from "../api/client.ts";
import { deleteSubscription, saveSubscription, vapidPublicKey } from "../api/notifications.ts";

/**
 * Web Push subscription flow (the mkvid pattern): register /sw.js, subscribe
 * with the server's VAPID public key, and hand the subscription to the server.
 *
 * Every browser API is reached through a PushEnv so tests can pass fakes
 * instead of fighting happy-dom's read-only navigator.
 */

export const SERVICE_WORKER_URL = "/sw.js";

export interface PushSubscriptionLike {
  endpoint: string;
  toJSON: () => {
    endpoint?: string;
    expirationTime?: number | null;
    keys?: Record<string, string>;
  };
  unsubscribe: () => Promise<boolean>;
}

export interface PushManagerLike {
  getSubscription: () => Promise<PushSubscriptionLike | null>;
  subscribe: (options: {
    userVisibleOnly: boolean;
    applicationServerKey: Uint8Array<ArrayBuffer>;
  }) => Promise<PushSubscriptionLike>;
}

export interface ServiceWorkerRegistrationLike {
  pushManager: PushManagerLike;
}

export interface ServiceWorkerContainerLike {
  register: (url: string) => Promise<ServiceWorkerRegistrationLike>;
}

export interface NotificationLike {
  permission: string;
  requestPermission: () => Promise<string>;
}

export interface PushEnv {
  serviceWorker: ServiceWorkerContainerLike | undefined;
  /** `"PushManager" in window`. */
  hasPushManager: boolean;
  notification: NotificationLike | undefined;
}

export function browserPushEnv(): PushEnv {
  const hasNavigator = typeof navigator !== "undefined";
  const hasWindow = typeof window !== "undefined";
  return {
    serviceWorker:
      hasNavigator && "serviceWorker" in navigator
        ? (navigator.serviceWorker as unknown as ServiceWorkerContainerLike)
        : undefined,
    hasPushManager: hasWindow && "PushManager" in window,
    notification:
      typeof Notification === "undefined"
        ? undefined
        : (Notification as unknown as NotificationLike),
  };
}

export function pushSupported(env: PushEnv): boolean {
  return env.serviceWorker !== undefined && env.hasPushManager;
}

export type PushProblem = "unsupported" | "denied";

export class PushError extends Error {
  readonly problem: PushProblem;

  constructor(problem: PushProblem, message: string) {
    super(message);
    this.name = "PushError";
    this.problem = problem;
  }
}

/**
 * VAPID keys travel as unpadded base64url; PushManager wants the raw bytes.
 * The buffer is allocated explicitly so the result is a Uint8Array over an
 * ArrayBuffer (a BufferSource), not over ArrayBufferLike.
 */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

function requireSupport(env: PushEnv): ServiceWorkerContainerLike {
  if (!pushSupported(env) || env.serviceWorker === undefined) {
    throw new PushError("unsupported", "This browser does not support push notifications.");
  }
  return env.serviceWorker;
}

async function registration(env: PushEnv): Promise<ServiceWorkerRegistrationLike> {
  // register() is idempotent for the same script URL and resolves to the
  // existing registration, so it doubles as "get".
  return requireSupport(env).register(SERVICE_WORKER_URL);
}

/** The browser's current subscription, or null (also when push is unsupported). */
export async function currentSubscription(env: PushEnv): Promise<PushSubscriptionLike | null> {
  if (!pushSupported(env)) return null;
  const reg = await registration(env);
  return reg.pushManager.getSubscription();
}

/** Ask for permission, subscribe with the VAPID key, and store it on the server. */
export async function subscribePush(api: ApiClient, env: PushEnv): Promise<PushSubscriptionLike> {
  requireSupport(env);
  if (env.notification !== undefined && env.notification.permission !== "granted") {
    const permission = await env.notification.requestPermission();
    if (permission !== "granted") {
      throw new PushError(
        "denied",
        "Notifications are blocked for this site. Allow them in the browser's site settings.",
      );
    }
  }
  const key = await vapidPublicKey(api);
  const reg = await registration(env);
  const existing = await reg.pushManager.getSubscription();
  const subscription =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    }));
  await saveSubscription(api, subscription.toJSON());
  return subscription;
}

/** Drop the browser subscription and forget it on the server. */
export async function unsubscribePush(api: ApiClient, env: PushEnv): Promise<void> {
  const subscription = await currentSubscription(env);
  if (subscription === null) return;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  await deleteSubscription(api, endpoint);
}
