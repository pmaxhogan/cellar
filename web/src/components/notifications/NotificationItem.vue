<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";
import Button from "primevue/button";
import Tag from "primevue/tag";
import type { NotificationRow } from "../../api/notifications.ts";
import { formatAbsolute, formatRelative } from "../../lib/format.ts";

/** One inbox entry: type badge, title, body, age, video link, acknowledge. */
const props = defineProps<{ row: NotificationRow; busy?: boolean; now?: number }>();
defineEmits<{ ack: [id: number] }>();

const unread = computed(() => props.row.acked_at === null);

type Severity = "danger" | "warn" | "info" | "secondary";

/** Colour by what the type name says; unknown types stay neutral. */
function severityFor(type: string): Severity {
  if (/fail|error|auth|fs_|filesystem/i.test(type)) return "danger";
  if (/gone|storage|proxy|outage|quota/i.test(type)) return "warn";
  if (/test|rule|notify/i.test(type)) return "info";
  return "secondary";
}
</script>

<template>
  <li
    class="notification-item"
    :class="{ 'notification-item--unread': unread }"
    :data-notification="row.id"
  >
    <span class="notification-item__dot" :aria-label="unread ? 'Unread' : undefined" />
    <div class="notification-item__main">
      <div class="notification-item__head">
        <Tag :value="row.type" :severity="severityFor(row.type)" class="notification-item__type" />
        <strong class="notification-item__title">{{ row.title }}</strong>
        <span class="notification-item__time cellar-muted" :title="formatAbsolute(row.created_at)">
          {{ formatRelative(row.created_at, now) }}
        </span>
      </div>
      <p class="notification-item__body">{{ row.body }}</p>
      <div class="notification-item__meta">
        <RouterLink
          v-if="row.video_id !== null"
          :to="`/videos/${encodeURIComponent(row.video_id)}`"
          class="notification-item__video mono"
        >
          {{ row.video_id }}
        </RouterLink>
        <span v-if="row.acked_at !== null" class="cellar-muted">
          Acknowledged {{ formatRelative(row.acked_at, now) }}
        </span>
        <span v-if="row.pushed_at !== null" class="cellar-muted">Pushed</span>
      </div>
    </div>
    <Button
      v-if="unread"
      label="Acknowledge"
      size="small"
      severity="secondary"
      outlined
      :loading="busy"
      data-action="ack"
      @click="$emit('ack', row.id)"
    />
  </li>
</template>

<style scoped>
.notification-item {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
  padding: 0.85rem 1rem;
  border-bottom: 1px solid var(--p-content-border-color);
}

.notification-item:last-child {
  border-bottom: none;
}

.notification-item__dot {
  flex: none;
  width: 0.55rem;
  height: 0.55rem;
  margin-top: 0.45rem;
  border-radius: 999px;
  background: transparent;
}

.notification-item--unread .notification-item__dot {
  background: var(--p-primary-color);
}

.notification-item__main {
  flex: 1;
  min-width: 0;
}

.notification-item__head {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
}

.notification-item__title {
  font-weight: 600;
}

.notification-item:not(.notification-item--unread) .notification-item__title {
  font-weight: 500;
}

.notification-item__time {
  margin-left: auto;
  font-size: 0.8rem;
}

.notification-item__body {
  margin: 0.3rem 0 0;
  line-height: 1.5;
  overflow-wrap: anywhere;
  white-space: pre-line;
}

.notification-item__meta {
  display: flex;
  gap: 0.75rem;
  margin-top: 0.3rem;
  font-size: 0.8rem;
}

.notification-item__meta:empty {
  display: none;
}

.notification-item__video {
  color: var(--p-primary-color);
  text-decoration: none;
}

.notification-item__video:hover {
  text-decoration: underline;
}
</style>
