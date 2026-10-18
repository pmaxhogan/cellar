<script setup lang="ts">
import { computed, inject } from "vue";
import { RouterLink, routerKey } from "vue-router";

/**
 * A link to a video's detail page: a RouterLink inside the app, a plain
 * anchor where no router is installed (component tests).
 */
const props = defineProps<{ videoId: string }>();
const hasRouter = inject(routerKey, null) !== null;
const href = computed(() => `/videos/${encodeURIComponent(props.videoId)}`);
</script>

<template>
  <RouterLink v-if="hasRouter" :to="href" :data-video="videoId"><slot /></RouterLink>
  <a v-else :href="href" :data-video="videoId"><slot /></a>
</template>
