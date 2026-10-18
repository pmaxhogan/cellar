<script setup lang="ts">
import { computed } from "vue";

export type MeterTone = "ok" | "warn" | "danger";

/**
 * A thin used-of-limit meter. The fill carries the severity (accent, then
 * warn, then danger); the track is a light step of the same hue. Severity is
 * never color alone: the caller prints the percentage and a status word.
 */
const props = defineProps<{ value: number; max: number; tone: MeterTone; label: string }>();

const percent = computed(() =>
  props.max > 0 ? Math.min(100, Math.max(0, (props.value / props.max) * 100)) : 0,
);
</script>

<template>
  <div
    class="meter"
    :class="`meter--${tone}`"
    role="meter"
    :aria-label="label"
    aria-valuemin="0"
    :aria-valuemax="max"
    :aria-valuenow="value"
    :data-tone="tone"
  >
    <div class="meter__fill" :style="{ width: `${percent}%` }" />
  </div>
</template>

<style scoped>
.meter {
  --meter-color: var(--p-primary-color);
  height: 0.45rem;
  border-radius: 999px;
  background: color-mix(in srgb, var(--meter-color) 22%, transparent);
  overflow: hidden;
}

.meter--warn {
  --meter-color: var(--cellar-warn);
}

.meter--danger {
  --meter-color: var(--cellar-error);
}

.meter__fill {
  height: 100%;
  border-radius: inherit;
  background: var(--meter-color);
}
</style>
