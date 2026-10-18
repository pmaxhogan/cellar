<script setup lang="ts">
import { computed, inject } from "vue";
import { RouterLink, routerKey } from "vue-router";

/**
 * A link that opens a rule in the Rules page editor (`/rules?edit=<id>`). It
 * is a RouterLink inside the app and a plain anchor where no router is
 * installed, so the inspect panel can be embedded anywhere.
 */
const props = defineProps<{ ruleId: number }>();
const hasRouter = inject(routerKey, null) !== null;
const to = computed(() => ({ path: "/rules", query: { edit: String(props.ruleId) } }));
const href = computed(() => `/rules?edit=${props.ruleId}`);
</script>

<template>
  <RouterLink v-if="hasRouter" :to="to"><slot /></RouterLink>
  <a v-else :href="href"><slot /></a>
</template>
