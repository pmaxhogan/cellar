<script setup lang="ts">
import { computed } from "vue";
import { useNotificationsStore } from "../../stores/notifications.ts";

/** The sidebar's unread count next to "Notifications". Hidden at zero. */
const store = useNotificationsStore();
const label = computed(() => (store.unread > 99 ? "99+" : String(store.unread)));
</script>

<template>
  <span v-if="store.unread > 0" class="unread-badge" data-unread-badge>
    {{ label }}<span class="sr-only"> unread</span>
  </span>
</template>

<style scoped>
.unread-badge {
  margin-left: auto;
  min-width: 1.35rem;
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  background: var(--p-primary-color);
  color: var(--p-primary-contrast-color);
  font-size: 0.72rem;
  font-weight: 650;
  line-height: 1.35;
  text-align: center;
}
</style>
