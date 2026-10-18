<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Button from "primevue/button";
import Paginator from "primevue/paginator";
import ToggleSwitch from "primevue/toggleswitch";
import { normalizeError, type ApiClientError } from "../api/client.ts";
import { useApi } from "../api/provide.ts";
import {
  NotificationRowSchema,
  ackAllNotifications,
  ackNotification,
  listNotifications,
  type NotificationRow,
} from "../api/notifications.ts";
import type { CellarEvent } from "../api/types.ts";
import { pluralize } from "../lib/format.ts";
import { useToaster } from "../lib/toast.ts";
import { useEventsStore } from "../stores/events.ts";
import { useNotificationsStore } from "../stores/notifications.ts";
import EmptyState from "../components/EmptyState.vue";
import ErrorState from "../components/ErrorState.vue";
import ListSkeleton from "../components/ListSkeleton.vue";
import PageHeader from "../components/PageHeader.vue";
import NotificationItem from "../components/notifications/NotificationItem.vue";
import PushPanel from "../components/notifications/PushPanel.vue";
import type { PushEnv } from "../lib/push.ts";

/** Tests hand the push panel a fake browser; the app never sets this. */
const props = defineProps<{ pushEnv?: PushEnv }>();

const api = useApi();
const toast = useToaster();
const events = useEventsStore();
const badge = useNotificationsStore();

const rows = ref<NotificationRow[]>([]);
const total = ref(0);
const page = ref(1);
const perPage = ref(25);
const unackedOnly = ref(false);
const loading = ref(false);
const loaded = ref(false);
const error = ref<ApiClientError | null>(null);
const acking = ref<Set<number>>(new Set());
const ackingAll = ref(false);
/** Live notifications that arrived while a later page was showing. */
const pendingNew = ref(0);

/** Unread first, then newest first, within the page the server returned. */
const sorted = computed(() =>
  [...rows.value].sort((a, b) => {
    const unreadA = a.acked_at === null ? 0 : 1;
    const unreadB = b.acked_at === null ? 0 : 1;
    if (unreadA !== unreadB) return unreadA - unreadB;
    return b.created_at - a.created_at;
  }),
);

const unreadOnPage = computed(() => rows.value.filter((row) => row.acked_at === null).length);
const hasUnread = computed(() => badge.unread > 0 || unreadOnPage.value > 0);

let inflight: AbortController | null = null;

async function load(): Promise<void> {
  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;
  loading.value = true;
  try {
    const result = await listNotifications(
      api,
      { page: page.value, perPage: perPage.value, unacked: unackedOnly.value },
      controller.signal,
    );
    rows.value = result.rows;
    total.value = result.total;
    error.value = null;
    pendingNew.value = 0;
    // With the filter on, the total is exactly the unread count.
    if (unackedOnly.value) badge.setUnread(result.total);
  } catch (cause) {
    const normalized = normalizeError(cause);
    if (normalized.problem === "aborted") return;
    error.value = normalized;
  } finally {
    if (inflight === controller) {
      loading.value = false;
      loaded.value = true;
      inflight = null;
    }
  }
}

watch(unackedOnly, () => {
  page.value = 1;
  void load();
});

function onPage(event: { page: number; rows: number }): void {
  page.value = event.page + 1;
  perPage.value = event.rows;
  void load();
}

function replaceRow(fresh: NotificationRow): void {
  if (unackedOnly.value && fresh.acked_at !== null) {
    rows.value = rows.value.filter((row) => row.id !== fresh.id);
    total.value = Math.max(0, total.value - 1);
    return;
  }
  rows.value = rows.value.map((row) => (row.id === fresh.id ? fresh : row));
}

async function ack(id: number): Promise<void> {
  const next = new Set(acking.value);
  next.add(id);
  acking.value = next;
  try {
    const fresh = await ackNotification(api, id);
    replaceRow(fresh);
    badge.acknowledged(1);
  } catch (cause) {
    toast.failure("Could not acknowledge the notification", cause);
  } finally {
    const after = new Set(acking.value);
    after.delete(id);
    acking.value = after;
  }
}

async function ackAll(): Promise<void> {
  ackingAll.value = true;
  try {
    await ackAllNotifications(api);
    badge.setUnread(0);
    toast.success("All notifications acknowledged");
    page.value = 1;
    await load();
  } catch (cause) {
    toast.failure("Could not acknowledge all notifications", cause);
  } finally {
    ackingAll.value = false;
  }
}

function showNewest(): void {
  page.value = 1;
  void load();
}

function handleEvent(event: CellarEvent): void {
  if (event.type !== "notification") return;
  if (page.value !== 1) {
    pendingNew.value += 1;
    return;
  }
  const parsed = NotificationRowSchema.safeParse(event.payload);
  if (!parsed.success) {
    // The payload is not a full row: fetch the page rather than guess.
    void load();
    return;
  }
  const row = parsed.data;
  if (rows.value.some((existing) => existing.id === row.id)) return;
  rows.value = [row, ...rows.value].slice(0, perPage.value);
  total.value += 1;
}

let offEvents: (() => void) | null = null;

onMounted(() => {
  void load();
  offEvents = events.on(handleEvent);
});

onBeforeUnmount(() => {
  inflight?.abort();
  offEvents?.();
});
</script>

<template>
  <section class="notifications-page">
    <PageHeader
      title="Notifications"
      description="The inbox of errors and notable events, and push notification setup."
    >
      <template #actions>
        <Button
          label="Acknowledge all"
          size="small"
          severity="secondary"
          :loading="ackingAll"
          :disabled="!hasUnread || ackingAll"
          data-action="ack-all"
          @click="ackAll"
        />
      </template>
    </PageHeader>

    <div class="notifications-toolbar">
      <label class="notifications-toolbar__toggle">
        <ToggleSwitch v-model="unackedOnly" input-id="notifications-unacked" />
        <span>Unacknowledged only</span>
      </label>
      <span class="cellar-muted" data-total>{{ pluralize(total, "notification") }}</span>
    </div>

    <div v-if="pendingNew > 0" class="notifications-stale" role="status" data-pending>
      <span>{{ pluralize(pendingNew, "new notification") }} since this page loaded.</span>
      <Button label="Show newest" size="small" severity="secondary" text @click="showNewest" />
    </div>

    <ErrorState :error="error" title="Could not load notifications" @retry="load" />

    <template v-if="error === null">
      <ListSkeleton v-if="!loaded" :rows="4" label="Loading notifications" />
      <EmptyState
        v-else-if="rows.length === 0"
        icon="notifications"
        :title="unackedOnly ? 'Nothing unacknowledged' : 'No notifications'"
        :description="
          unackedOnly
            ? 'Every notification has been acknowledged.'
            : 'Errors and notable events will collect here.'
        "
      />
      <div v-else class="cellar-card notifications-list">
        <ul>
          <NotificationItem
            v-for="row in sorted"
            :key="row.id"
            :row="row"
            :busy="acking.has(row.id)"
            @ack="ack"
          />
        </ul>
      </div>
      <Paginator
        v-if="total > perPage"
        :rows="perPage"
        :first="(page - 1) * perPage"
        :total-records="total"
        :rows-per-page-options="[25, 50, 100, 200]"
        template="FirstPageLink PrevPageLink PageLinks NextPageLink LastPageLink RowsPerPageDropdown"
        @page="onPage"
      />
    </template>

    <PushPanel class="notifications-push" :env="props.pushEnv" />
  </section>
</template>

<style scoped>
.notifications-page {
  max-width: 64rem;
}

.notifications-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.75rem;
  font-size: 0.88rem;
}

.notifications-toolbar__toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
}

.notifications-stale {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  margin-bottom: 0.75rem;
  border-radius: 8px;
  border: 1px solid var(--p-content-border-color);
  background: var(--p-content-background);
  font-size: 0.87rem;
}

.notifications-list {
  padding: 0;
}

.notifications-list ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

.notifications-push {
  margin-top: 1.5rem;
}
</style>
