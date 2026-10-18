import {
  resolveSettings,
  type NotificationRow,
  type NotifyResult,
  type PushSubscriptionInput,
  type ResolvedSettings,
} from "@cellar/shared";
import type { Logger } from "pino";
import webpush from "web-push";
import type { Config } from "../config.ts";
import type { Db } from "../db/db.ts";
import { getKv, setKv } from "../db/kv.ts";
import { pagedQuery, parseJsonColumn, Where, type Paged } from "../db/paged.ts";
import type { EventBus } from "../events.ts";
import { notFound } from "./errors.ts";

/**
 * Notifications: an in-app inbox (`notifications`) plus Web Push to every
 * stored browser subscription. Each rate key (the type unless the caller
 * narrows it) sends at most once per window while the previous notification
 * of that key is unacknowledged; `force` bypasses the limit. A rate-limited
 * call is suppressed entirely: no inbox row, no push.
 */

export const VAPID_KV_KEY = "vapid";
export const DOWNLOAD_FAILURES_KV_KEY = "notify.download_failures";
export const DEFAULT_VAPID_SUBJECT = "mailto:cellar@localhost";
const HOUR_MS = 60 * 60_000;
const PUSH_TTL_S = 24 * 60 * 60;

export interface NotifyDeps {
  db: Db;
  log: Logger;
  events?: EventBus | undefined;
  getSettings?: () => ResolvedSettings;
  /** `mailto:` or https URL for the VAPID JWT. See vapidSubjectFor(). */
  vapidSubject?: string;
  now?: () => number;
}

export interface NotifyInput {
  type: string;
  title: string;
  body: string;
  data?: unknown;
  videoId?: string | null;
  /** Bypass the rate limit. */
  force?: boolean;
  /** Window for this call; default notify.rate_limit_hours. */
  rateLimitHours?: number;
  /** Rate-limit identity; default `type`. */
  rateKey?: string;
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** The VAPID subject: the first Access-allowed email, else a local placeholder. */
export function vapidSubjectFor(config: Pick<Config, "cfAccess">): string {
  const email = config.cfAccess?.allowedEmails[0];
  return email === undefined ? DEFAULT_VAPID_SUBJECT : `mailto:${email}`;
}

/** Read the VAPID keypair from kv, generating and storing one on first use. */
export function ensureVapidKeys(db: Db): VapidKeys {
  const stored = getKv<Partial<VapidKeys>>(db, VAPID_KV_KEY);
  if (
    stored !== undefined &&
    stored !== null &&
    typeof stored.publicKey === "string" &&
    typeof stored.privateKey === "string"
  ) {
    return { publicKey: stored.publicKey, privateKey: stored.privateKey };
  }
  const keys = webpush.generateVAPIDKeys();
  setKv(db, VAPID_KV_KEY, keys);
  return { publicKey: keys.publicKey, privateKey: keys.privateKey };
}

interface NotificationDbRow {
  id: number;
  type: string;
  title: string;
  body: string;
  data_json: string | null;
  video_id: string | null;
  created_at: number;
  acked_at: number | null;
  pushed_at: number | null;
}

function toNotificationRow(row: NotificationDbRow): NotificationRow {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    data: parseJsonColumn(row.data_json),
    video_id: row.video_id,
    created_at: row.created_at,
    acked_at: row.acked_at,
    pushed_at: row.pushed_at,
  };
}

function settingsOf(deps: NotifyDeps): ResolvedSettings {
  return (deps.getSettings ?? (() => resolveSettings({})))();
}

function isRateLimited(deps: NotifyDeps, input: NotifyInput, now: number): boolean {
  if (input.force === true) {
    return false;
  }
  const key = input.rateKey ?? input.type;
  const state = deps.db.get<{ last_sent_at: number }>(
    "SELECT last_sent_at FROM notification_state WHERE type = ?",
    key,
  );
  if (state === undefined) {
    return false;
  }
  const hours = input.rateLimitHours ?? settingsOf(deps)["notify.rate_limit_hours"];
  if (now - state.last_sent_at >= hours * HOUR_MS) {
    return false;
  }
  // The notification that set last_sent_at was inserted in the same
  // transaction with created_at = last_sent_at.
  const previous = deps.db.get<{ acked_at: number | null }>(
    `SELECT acked_at FROM notifications WHERE type = ? AND created_at = ?
      ORDER BY id DESC LIMIT 1`,
    input.type,
    state.last_sent_at,
  );
  return previous !== undefined && previous.acked_at === null;
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "(invalid)";
  }
}

/**
 * Send one notification to every push subscription. A 404 or 410 answer
 * means the browser dropped the subscription, so it is deleted. Returns the
 * number of successful deliveries. Endpoints are capability URLs, so only
 * their host is logged.
 */
async function pushToAll(deps: NotifyDeps, row: NotificationRow): Promise<number> {
  const subscriptions = deps.db.all<{ endpoint: string; keys_json: string }>(
    "SELECT endpoint, keys_json FROM push_subscriptions",
  );
  if (subscriptions.length === 0) {
    return 0;
  }
  const vapid = ensureVapidKeys(deps.db);
  const payload = JSON.stringify({
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    videoId: row.video_id,
  });
  const options = {
    TTL: PUSH_TTL_S,
    vapidDetails: {
      subject: deps.vapidSubject ?? DEFAULT_VAPID_SUBJECT,
      publicKey: vapid.publicKey,
      privateKey: vapid.privateKey,
    },
  };
  const results = await Promise.allSettled(
    subscriptions.map(async (subscription) => {
      const keys = parseJsonColumn(subscription.keys_json) as { p256dh: string; auth: string };
      await webpush.sendNotification({ endpoint: subscription.endpoint, keys }, payload, options);
    }),
  );
  let delivered = 0;
  results.forEach((result, index) => {
    const endpoint = (subscriptions[index] as { endpoint: string }).endpoint;
    if (result.status === "fulfilled") {
      delivered += 1;
      return;
    }
    const statusCode = (result.reason as { statusCode?: unknown } | null)?.statusCode;
    if (statusCode === 404 || statusCode === 410) {
      deps.db.run("DELETE FROM push_subscriptions WHERE endpoint = ?", endpoint);
      deps.log.info({ host: hostOf(endpoint), statusCode }, "removed an expired push subscription");
    } else {
      deps.log.warn(
        {
          host: hostOf(endpoint),
          statusCode,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        },
        "web push delivery failed",
      );
    }
  });
  return delivered;
}

export async function notify(deps: NotifyDeps, input: NotifyInput): Promise<NotifyResult> {
  const now = (deps.now ?? Date.now)();
  const inserted = deps.db.tx((): NotificationDbRow | undefined => {
    if (isRateLimited(deps, input, now)) {
      return undefined;
    }
    const row = deps.db.get<NotificationDbRow>(
      `INSERT INTO notifications (type, title, body, data_json, video_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
      input.type,
      input.title,
      input.body,
      input.data === undefined ? null : JSON.stringify(input.data),
      input.videoId ?? null,
      now,
    ) as NotificationDbRow;
    deps.db.run(
      `INSERT INTO notification_state (type, last_sent_at) VALUES (?, ?)
       ON CONFLICT (type) DO UPDATE SET last_sent_at = excluded.last_sent_at`,
      input.rateKey ?? input.type,
      now,
    );
    return row;
  });

  if (inserted === undefined) {
    deps.log.debug({ type: input.type }, "notification rate limited");
    return { sent: false, reason: "rate_limited" };
  }

  const row = toNotificationRow(inserted);
  deps.events?.publish("notification", { id: row.id, type: row.type, title: row.title });
  deps.log.info({ id: row.id, type: row.type }, "notification created");

  let pushed = 0;
  try {
    pushed = await pushToAll(deps, row);
  } catch (error) {
    deps.log.warn({ err: error }, "web push failed");
  }
  if (pushed > 0) {
    deps.db.run(
      "UPDATE notifications SET pushed_at = ? WHERE id = ?",
      (deps.now ?? Date.now)(),
      row.id,
    );
  }
  return { sent: true, id: row.id, pushed };
}

// ---------------------------------------------------------------------------
// Error-policy helpers (docs/ARCHITECTURE.md "Notifications and error policy")
// ---------------------------------------------------------------------------

/**
 * A download failed. Distinct failing videos accumulate in kv until a success
 * resets them; at notify.consecutive_download_failures distinct videos a
 * `download_failures` notification is attempted and the counter resets.
 */
export async function recordDownloadFailure(
  deps: NotifyDeps,
  videoId: string,
): Promise<NotifyResult | null> {
  const threshold = settingsOf(deps)["notify.consecutive_download_failures"];
  const stored = getKv<{ videos?: unknown }>(deps.db, DOWNLOAD_FAILURES_KV_KEY);
  const videos = Array.isArray(stored?.videos)
    ? stored.videos.filter((item): item is string => typeof item === "string")
    : [];
  if (!videos.includes(videoId)) {
    videos.push(videoId);
  }
  if (videos.length < threshold) {
    setKv(deps.db, DOWNLOAD_FAILURES_KV_KEY, { videos });
    return null;
  }
  setKv(deps.db, DOWNLOAD_FAILURES_KV_KEY, { videos: [] });
  return notify(deps, {
    type: "download_failures",
    title: "Downloads are failing",
    body: `${String(videos.length)} different videos failed to download in a row.`,
    data: { videos },
  });
}

export function recordDownloadSuccess(deps: Pick<NotifyDeps, "db">): void {
  const stored = getKv<{ videos?: unknown }>(deps.db, DOWNLOAD_FAILURES_KV_KEY);
  if (Array.isArray(stored?.videos) && stored.videos.length > 0) {
    setKv(deps.db, DOWNLOAD_FAILURES_KV_KEY, { videos: [] });
  }
}

/** Storage nearly full and the reaper cannot clear it. notify.storage_pressure_hours. */
export function recordStoragePressure(
  deps: NotifyDeps,
  locationId: number,
  detail: string,
): Promise<NotifyResult> {
  return notify(deps, {
    type: "storage_pressure",
    title: "Storage nearly full",
    body: detail,
    data: { locationId },
    rateLimitHours: settingsOf(deps)["notify.storage_pressure_hours"],
  });
}

/** A filesystem error: always sent, immediately. */
export function recordFsError(deps: NotifyDeps, detail: string): Promise<NotifyResult> {
  return notify(deps, {
    type: "fs_error",
    title: "Filesystem error",
    body: detail,
    force: true,
  });
}

/** The first confirmed 401 / invalid cookie jar of an account. Rate limited per account. */
export function recordAccountAuthLoss(
  deps: NotifyDeps,
  accountId: number,
  detail?: string,
): Promise<NotifyResult> {
  return notify(deps, {
    type: "account_auth_lost",
    title: "Account sign-in lost",
    body: detail ?? `Account ${String(accountId)} is no longer signed in. Re-link it.`,
    data: { accountId },
    rateKey: `account_auth_lost:${String(accountId)}`,
  });
}

/** A whole recheck pass failed. notify.outage_hours. */
export function recordOutage(deps: NotifyDeps, detail: string): Promise<NotifyResult> {
  return notify(deps, {
    type: "recheck_outage",
    title: "Recheck pass failed",
    body: detail,
    rateLimitHours: settingsOf(deps)["notify.outage_hours"],
  });
}

// ---------------------------------------------------------------------------
// Inbox and subscriptions
// ---------------------------------------------------------------------------

export function listNotifications(
  db: Db,
  input: { page: number; perPage: number; unacked?: boolean | undefined },
): Paged<NotificationRow> {
  const where = new Where();
  if (input.unacked === true) {
    where.add("acked_at IS NULL");
  }
  return pagedQuery<NotificationDbRow, NotificationRow>(db, {
    select: "*",
    from: "notifications",
    where,
    orderBy: "created_at DESC, id DESC",
    page: input.page,
    perPage: input.perPage,
    map: toNotificationRow,
  });
}

/** Acknowledge one notification. Idempotent: the first ack time is kept. */
export function ackNotification(db: Db, id: number, now: number = Date.now()): NotificationRow {
  db.run("UPDATE notifications SET acked_at = ? WHERE id = ? AND acked_at IS NULL", now, id);
  const row = db.get<NotificationDbRow>("SELECT * FROM notifications WHERE id = ?", id);
  if (row === undefined) {
    throw notFound("Notification", id);
  }
  return toNotificationRow(row);
}

export function ackAllNotifications(db: Db, now: number = Date.now()): number {
  return db.run("UPDATE notifications SET acked_at = ? WHERE acked_at IS NULL", now).changes;
}

export function savePushSubscription(
  db: Db,
  input: PushSubscriptionInput,
  now: number = Date.now(),
): void {
  db.run(
    `INSERT INTO push_subscriptions (endpoint, keys_json, created_at) VALUES (?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET keys_json = excluded.keys_json`,
    input.endpoint,
    JSON.stringify({ p256dh: input.keys.p256dh, auth: input.keys.auth }),
    now,
  );
}

export function deletePushSubscription(db: Db, endpoint: string): void {
  db.run("DELETE FROM push_subscriptions WHERE endpoint = ?", endpoint);
}

export function sendTestNotification(deps: NotifyDeps): Promise<NotifyResult> {
  return notify(deps, {
    type: "test",
    title: "Test notification",
    body: "Notifications from Cellar reach this browser.",
    force: true,
  });
}
