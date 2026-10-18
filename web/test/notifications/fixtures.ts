import { vi } from "vitest";
import type { NotificationRow } from "../../src/api/notifications.ts";
import type { PushEnv, PushSubscriptionLike } from "../../src/lib/push.ts";

export const NOW = 1_760_000_000_000;

export function makeNotification(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: 1,
    type: "download_failures",
    title: "Downloads are failing",
    body: "3 consecutive downloads failed.",
    data: null,
    video_id: null,
    created_at: NOW - 5 * 60_000,
    acked_at: null,
    pushed_at: null,
    ...overrides,
  };
}

export function paged<T>(rows: T[], total = rows.length, page = 1, perPage = 25) {
  return { rows, total, page, perPage };
}

export interface FakePush {
  env: PushEnv;
  register: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  getSubscription: ReturnType<typeof vi.fn>;
  requestPermission: ReturnType<typeof vi.fn>;
  subscription: PushSubscriptionLike & { unsubscribe: ReturnType<typeof vi.fn> };
  notification: { permission: string; requestPermission: ReturnType<typeof vi.fn> };
}

/** A stubbed navigator.serviceWorker / PushManager / Notification trio. */
export function fakePush(
  options: { subscribed?: boolean; permission?: string; grant?: string } = {},
): FakePush {
  const subscription = {
    endpoint: "https://push.example/endpoint-1",
    toJSON: () => ({
      endpoint: "https://push.example/endpoint-1",
      expirationTime: null,
      keys: { p256dh: "pkey", auth: "akey" },
    }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
  let current: PushSubscriptionLike | null = options.subscribed === true ? subscription : null;
  const getSubscription = vi.fn(async () => current);
  const subscribe = vi.fn(async () => {
    current = subscription;
    return subscription;
  });
  subscription.unsubscribe.mockImplementation(async () => {
    current = null;
    return true;
  });
  const register = vi.fn(async () => ({ pushManager: { getSubscription, subscribe } }));
  const notification = {
    permission: options.permission ?? "default",
    requestPermission: vi.fn(async () => {
      const result = options.grant ?? "granted";
      notification.permission = result;
      return result;
    }),
  };
  return {
    env: { serviceWorker: { register }, hasPushManager: true, notification },
    register,
    subscribe,
    getSubscription,
    requestPermission: notification.requestPermission,
    subscription,
    notification,
  };
}
