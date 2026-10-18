<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import Chart from "primevue/chart";
import type { VideoStatsPoint } from "@cellar/shared";
import { ABORTED_PROBLEM, normalizeError, type ApiClientError } from "../../api/client.ts";
import { useApi } from "../../api/provide.ts";
import { getVideoStats } from "../../api/videos.ts";
import ErrorState from "../ErrorState.vue";
import { statsChartData, statsChartOptions } from "./history.ts";

/** Views, likes and comments over time, from the counter points rechecks record. */
const props = defineProps<{ videoId: string }>();

const api = useApi();
const points = ref<VideoStatsPoint[]>([]);
const loaded = ref(false);
const error = ref<ApiClientError | null>(null);
let controller: AbortController | null = null;

const data = computed(() => statsChartData(points.value));

function themeColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === "" ? fallback : value;
}

const options = computed(() =>
  statsChartOptions(
    themeColor("--p-text-muted-color", "#9a9a9a"),
    themeColor("--p-content-border-color", "rgba(128, 128, 128, 0.2)"),
  ),
);

async function load(): Promise<void> {
  controller?.abort();
  const mine = new AbortController();
  controller = mine;
  try {
    points.value = (await getVideoStats(api, props.videoId, mine.signal)).points;
    error.value = null;
    loaded.value = true;
  } catch (cause) {
    const normalized = normalizeError(cause);
    if (normalized.problem === ABORTED_PROBLEM) return;
    error.value = normalized;
  } finally {
    if (controller === mine) controller = null;
  }
}

watch(() => props.videoId, load, { immediate: true });
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <div class="stats" data-test="stats">
    <ErrorState v-if="error" :error="error" title="Could not load the stats" @retry="load" />
    <p v-else-if="loaded && points.length === 0" class="cellar-muted" data-test="stats-empty">
      No counter history yet. Each recheck adds a point.
    </p>
    <p v-else-if="loaded && points.length === 1" class="cellar-muted" data-test="stats-single">
      One point so far. The chart fills in as rechecks record changes.
    </p>
    <div v-if="loaded && points.length > 0" class="stats__chart">
      <Chart type="line" :data="data" :options="options" data-test="stats-chart" />
    </div>
  </div>
</template>

<style scoped>
.stats__chart {
  position: relative;
  height: 16rem;
}

.stats__chart :deep(.p-chart) {
  height: 100%;
}
</style>
