import { z } from "zod";
import { pagedSchema } from "@cellar/shared";
import { buildQuery, type ApiClient } from "./client.ts";

/**
 * Notifications API (/api/notifications).
 *
 * The row schema is defined locally until the server's wave1C block lands in
 * shared/src/apiTypes.ts with the same shape; then these re-point at shared.
 *
 *   GET    /api/notifications?page&perPage&unacked -> paged NotificationRow
 *   POST   /api/notifications/:id/ack              -> NotificationRow
 *   POST   /api/notifications/ack-all              -> 204
 *   GET    /api/notifications/vapid-public-key     -> { key }
 *   POST   /api/notifications/subscribe            <- PushSubscription JSON -> 204
 *   DELETE /api/notifications/subscribe            <- { endpoint } -> 204
 *   POST   /api/notifications/test                 -> 204
 */
export const NotificationRowSchema = z.object({
  id: z.number().int(),
  type: z.string(),
  title: z.string(),
  body: z.string(),
  data: z.unknown().nullable(),
  video_id: z.string().nullable(),
  created_at: z.number(),
  acked_at: z.number().nullable(),
  pushed_at: z.number().nullable(),
});
export type NotificationRow = z.infer<typeof NotificationRowSchema>;

export const NotificationsListResponseSchema = pagedSchema(NotificationRowSchema);
export type NotificationsListResponse = z.infer<typeof NotificationsListResponseSchema>;

export const VapidKeyResponseSchema = z.object({ key: z.string().min(1) });

export interface NotificationsQuery {
  page?: number;
  perPage?: number;
  /** Only rows that have not been acknowledged. */
  unacked?: boolean;
}

export function listNotifications(
  api: ApiClient,
  query: NotificationsQuery = {},
  signal?: AbortSignal,
): Promise<NotificationsListResponse> {
  const path = `/api/notifications${buildQuery({
    page: query.page,
    perPage: query.perPage,
    unacked: query.unacked === true ? 1 : undefined,
  })}`;
  return api.request(path, { schema: NotificationsListResponseSchema, signal });
}

export function ackNotification(api: ApiClient, id: number): Promise<NotificationRow> {
  return api.request(`/api/notifications/${id}/ack`, {
    method: "POST",
    schema: NotificationRowSchema,
  });
}

export function ackAllNotifications(api: ApiClient): Promise<void> {
  return api.request("/api/notifications/ack-all", { method: "POST" });
}

export async function vapidPublicKey(api: ApiClient): Promise<string> {
  const result = await api.request("/api/notifications/vapid-public-key", {
    schema: VapidKeyResponseSchema,
  });
  return result.key;
}

/** The browser's PushSubscription.toJSON() shape, as the server stores it. */
export interface PushSubscriptionBody {
  endpoint?: string;
  expirationTime?: number | null;
  keys?: Record<string, string>;
}

export function saveSubscription(api: ApiClient, body: PushSubscriptionBody): Promise<void> {
  return api.request("/api/notifications/subscribe", { method: "POST", body });
}

export function deleteSubscription(api: ApiClient, endpoint: string): Promise<void> {
  return api.request("/api/notifications/subscribe", { method: "DELETE", body: { endpoint } });
}

export function sendTestNotification(api: ApiClient): Promise<void> {
  return api.request("/api/notifications/test", { method: "POST" });
}
