import {
  NotificationsQuerySchema,
  PushSubscriptionInputSchema,
  PushUnsubscribeInputSchema,
  type AckAllResponse,
  type NotificationRow,
  type NotificationsListResponse,
  type NotifyResult,
  type ResolvedSettings,
  type VapidPublicKeyResponse,
} from "@cellar/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  ackAllNotifications,
  ackNotification,
  deletePushSubscription,
  ensureVapidKeys,
  listNotifications,
  savePushSubscription,
  sendTestNotification,
  vapidSubjectFor,
  type NotifyDeps,
} from "../domain/notifications.ts";
import { parseBody, parseParams, parseQuery } from "./validate.ts";

export interface NotificationRoutesOptions {
  getSettings?: () => ResolvedSettings;
}

const IdParams = z.object({ id: z.coerce.number().int().positive() });

/** /api/notifications: the inbox, acknowledgements and Web Push subscriptions. */
export const notificationRoutes: FastifyPluginAsync<NotificationRoutesOptions> = async (
  app,
  options,
) => {
  const { db, events, config, log } = app.cellar;
  const deps: NotifyDeps = {
    db,
    events,
    log: log.child({ mod: "notifications" }),
    vapidSubject: vapidSubjectFor(config),
    ...(options.getSettings === undefined ? {} : { getSettings: options.getSettings }),
  };

  app.get("/notifications", (request): NotificationsListResponse => {
    const query = parseQuery(NotificationsQuerySchema, request);
    return listNotifications(db, query);
  });

  app.post("/notifications/ack-all", (): AckAllResponse => ({ acked: ackAllNotifications(db) }));

  app.post("/notifications/:id/ack", (request): NotificationRow => {
    const { id } = parseParams(IdParams, request);
    return ackNotification(db, id);
  });

  app.get("/notifications/vapid-public-key", (): VapidPublicKeyResponse => ({
    key: ensureVapidKeys(db).publicKey,
  }));

  app.post("/notifications/subscribe", async (request, reply) => {
    savePushSubscription(db, parseBody(PushSubscriptionInputSchema, request));
    return reply.code(204).send();
  });

  app.delete("/notifications/subscribe", async (request, reply) => {
    deletePushSubscription(db, parseBody(PushUnsubscribeInputSchema, request).endpoint);
    return reply.code(204).send();
  });

  app.post("/notifications/test", (): Promise<NotifyResult> => sendTestNotification(deps));
};
