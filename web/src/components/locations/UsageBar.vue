<script setup lang="ts">
import { computed } from "vue";
import { usageSummary } from "../../api/locations.ts";
import { formatBytes } from "../../lib/format.ts";

/** Used against quota, plus what the filesystem underneath has left. */
const props = defineProps<{
  used: number;
  quota: number;
  fsFree: number | null;
  fsTotal?: number | null;
}>();

const summary = computed(() => usageSummary(props.used, props.quota));
const percentText = computed(() =>
  summary.value.percent === null ? "no quota" : `${summary.value.percent.toFixed(1)}%`,
);
const freeText = computed(() => {
  if (props.fsFree === null) return "Filesystem free space unknown";
  const total =
    props.fsTotal === undefined || props.fsTotal === null
      ? ""
      : ` of ${formatBytes(props.fsTotal)}`;
  return `${formatBytes(props.fsFree)} free on the filesystem${total}`;
});
</script>

<template>
  <div class="usage-bar" :class="`tone-${summary.tone}`">
    <div class="usage-bar__labels">
      <span data-test="usage-text"
        >{{ formatBytes(used) }} of {{ formatBytes(quota) }} quota used</span
      >
      <span data-test="usage-percent">{{ percentText }}</span>
    </div>
    <div
      class="usage-bar__track"
      role="progressbar"
      aria-label="Quota used"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="Math.round(summary.barPercent)"
    >
      <div class="usage-bar__fill" :style="{ width: `${summary.barPercent}%` }" />
    </div>
    <p class="cellar-note" data-test="usage-free">{{ freeText }}</p>
  </div>
</template>

<style scoped>
.usage-bar__labels {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  font-size: 0.85rem;
  margin-bottom: 0.3rem;
}

.usage-bar__track {
  height: 0.55rem;
  border-radius: 999px;
  background: var(--p-content-hover-background);
  overflow: hidden;
}

.usage-bar__fill {
  height: 100%;
  border-radius: inherit;
  background: var(--p-primary-color);
}

.tone-warn .usage-bar__fill {
  background: var(--cellar-warn);
}

.tone-danger .usage-bar__fill {
  background: var(--cellar-error);
}
</style>
