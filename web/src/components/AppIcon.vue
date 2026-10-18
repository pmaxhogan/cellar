<script setup lang="ts">
import { computed } from "vue";

/**
 * Inline stroke icons. Hand-rolled rather than pulling an icon font in: the
 * whole set below is smaller than a webfont request and never flashes.
 *
 * Icons are decorative by default (aria-hidden). Pass a `title` when an icon is
 * the only carrier of meaning, which makes it a labelled image instead.
 */

const PATHS: Record<string, string> = {
  videos: "M4 4h16v16H4zM8 4v16M16 4v16M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4",
  inspect: "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14M21 21l-6-6M10 7v6M7 10h6",
  rules: "M3 4h18l-7 8.5V19l-4 2v-8.5z",
  accounts:
    "M16 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M19 8v6M22 11h-6",
  channels: "M3 7h18v13H3zM8 3l4 4 4-4",
  locations: "M3 13h18M3 13l3-8h12l3 8v6H3zM7 16h.01M11 16h.01",
  proxies:
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18",
  shares:
    "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  notifications: "M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 21h4",
  selfcheck: "M9 3h6v3H9zM9 5H5v16h14V5h-4M9 14l2 2 4-4",
  charts: "M4 20h16M7 16v-5M12 16V6M17 16V9",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.4 14a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 4.5 14H4a2 2 0 1 1 0-4h.2A1.6 1.6 0 0 0 5.3 7.2l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 11 3.3V3a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.3a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.3.9z",
  about: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 16v-5M12 8h.01",
  database:
    "M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  check: "m4 12.5 5 5L20 6.5",
  alert:
    "M12 8v5M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10",
  sync: "M20 11a8 8 0 0 0-13.7-5.7L4 7.5M4 4v3.5h3.5M4 13a8 8 0 0 0 13.7 5.7L20 16.5M20 20v-3.5h-3.5",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 7v5l3 2",
  pause: "M9 4v16M15 4v16",
  play: "m6 3 14 9-14 9z",
  trash: "M3 6h18M8 6V4h8v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14M10 11v6M14 11v6",
  download: "M12 3v12m0 0 4-4m-4 4-4-4M4 21h16",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  copy: "M9 9h10v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8",
  close: "M6 6l12 12M18 6 6 18",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5",
  plus: "M12 5v14M5 12h14",
  edit: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16M21 21l-4.3-4.3",
};

const props = withDefaults(defineProps<{ name: string; size?: number; title?: string }>(), {
  size: 18,
  title: undefined,
});

const d = computed(() => PATHS[props.name] ?? PATHS.about);
const decorative = computed(() => props.title === undefined);
</script>

<template>
  <svg
    class="app-icon"
    :data-icon="name"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    :aria-hidden="decorative ? 'true' : undefined"
    :role="decorative ? undefined : 'img'"
    focusable="false"
  >
    <title v-if="title !== undefined">{{ title }}</title>
    <path :d="d" />
  </svg>
</template>

<style scoped>
.app-icon {
  flex: none;
  vertical-align: -0.15em;
}
</style>
