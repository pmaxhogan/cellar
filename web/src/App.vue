<script setup lang="ts">
import { onMounted, onBeforeUnmount } from "vue";
import { RouterLink, RouterView } from "vue-router";
import Toast from "primevue/toast";
import { NAV_LINKS } from "./router/index.ts";
import { LOGO_URL } from "./lib/brand.ts";
import AppIcon from "./components/AppIcon.vue";
import InsecureBanner from "./components/InsecureBanner.vue";
import StatusPill from "./components/StatusPill.vue";
import ThemeToggle from "./components/ThemeToggle.vue";
import { useApi } from "./api/provide.ts";
import { useEventsStore } from "./stores/events.ts";
import { useStatusStore } from "./stores/status.ts";
import { useThemeStore } from "./stores/theme.ts";

const api = useApi();
const status = useStatusStore();
const events = useEventsStore();

// Instantiating the store applies the persisted color scheme to <html>.
useThemeStore();

let stopPolling: (() => void) | null = null;
// Held explicitly rather than trusting the store's onScopeDispose fallback:
// that only fires inside an active effect scope, and a listener that outlives
// its component turns one event into a duplicated handler per remount.
let offEvents: (() => void) | null = null;

onMounted(() => {
  void status.load(api);
  events.connect(api.eventsUrl());
  offEvents = events.on((event) => status.applyEvent(event));
  // A slow poll covers anything the event stream does not announce.
  const handle = setInterval(() => void status.load(), 60_000);
  stopPolling = () => clearInterval(handle);
});

onBeforeUnmount(() => {
  stopPolling?.();
  offEvents?.();
  events.disconnect();
});
</script>

<template>
  <div class="cellar-shell">
    <InsecureBanner v-if="status.insecureMode" />
    <div class="cellar-body">
      <aside class="cellar-sidebar">
        <RouterLink to="/" class="cellar-brand">
          <img :src="LOGO_URL" alt="" width="28" height="28" />
          <span>Cellar</span>
        </RouterLink>
        <nav class="cellar-nav" aria-label="Main">
          <RouterLink v-for="link in NAV_LINKS" :key="link.to" :to="link.to">
            <AppIcon :name="link.icon" :size="17" />
            <span>{{ link.label }}</span>
          </RouterLink>
        </nav>
        <div class="cellar-sidebar__footer">
          <StatusPill />
          <ThemeToggle />
        </div>
      </aside>
      <main class="cellar-main">
        <RouterView />
      </main>
    </div>
    <Toast position="bottom-right" />
  </div>
</template>
