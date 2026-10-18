import { defineStore } from "pinia";
import { ref } from "vue";
import type { ApiClient } from "../api/client.ts";
import { listNotifications } from "../api/notifications.ts";
import type { CellarEvent } from "../api/types.ts";

/**
 * The unread (unacknowledged) notification count behind the sidebar badge.
 * Loaded once from the server, bumped by live `notification` events, and set
 * by the inbox whenever it acknowledges something.
 */
export const useNotificationsStore = defineStore("notifications", () => {
  const unread = ref(0);
  let client: ApiClient | null = null;

  async function load(next?: ApiClient): Promise<void> {
    if (next !== undefined) client = next;
    if (client === null) return;
    try {
      const result = await listNotifications(client, { unacked: true, page: 1, perPage: 1 });
      unread.value = result.total;
    } catch {
      // The badge is a hint; a failed count keeps the last known value.
    }
  }

  function setUnread(count: number): void {
    unread.value = Math.max(0, count);
  }

  function acknowledged(count = 1): void {
    setUnread(unread.value - count);
  }

  function applyEvent(event: CellarEvent): void {
    if (event.type === "notification") unread.value += 1;
  }

  return { unread, load, setUnread, acknowledged, applyEvent };
});
