<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Button from "primevue/button";
import Select from "primevue/select";
import SelectButton from "primevue/selectbutton";
import type { StatsDailyResponse, StatsLocationRef, StatsSummary } from "@cellar/shared";
import { normalizeError, type ApiClientError } from "../api/client.ts";
import { useApi } from "../api/provide.ts";
import {
  getDailyStats,
  getStatsSummary,
  rangeWindow,
  RANGE_DAYS,
  runStatsRollup,
  type LocationFilter,
  type RangeDays,
} from "../api/stats.ts";
import { pluralize } from "../lib/format.ts";
import { useToaster } from "../lib/toast.ts";
import { useThemeStore } from "../stores/theme.ts";
import EmptyState from "../components/EmptyState.vue";
import ErrorState from "../components/ErrorState.vue";
import ListSkeleton from "../components/ListSkeleton.vue";
import PageHeader from "../components/PageHeader.vue";
import ChartCard from "../components/charts/ChartCard.vue";
import { chartTheme } from "../components/charts/chartTheme.ts";
import PointsTable from "../components/charts/PointsTable.vue";
import SummaryStrip from "../components/charts/SummaryStrip.vue";
import {
  apiUnitsChart,
  barChart,
  hasPoints,
  lineChart,
  measureLocation,
  storageChart,
} from "../components/charts/series.ts";

const api = useApi();
const toast = useToaster();
const themeStore = useThemeStore();

const range = ref<RangeDays>(90);
const location = ref<LocationFilter>("all");

const summary = ref<StatsSummary | null>(null);
const summaryError = ref<ApiClientError | null>(null);
const daily = ref<StatsDailyResponse | null>(null);
const dailyError = ref<ApiClientError | null>(null);
const loaded = ref(false);
const loading = ref(false);
const rolling = ref(false);
/** Every known location, kept across filter changes for the picker. */
const knownLocations = ref<StatsLocationRef[]>([]);

let controller: AbortController | null = null;

const rangeOptions = RANGE_DAYS.map((days) => ({ label: `${String(days)} days`, value: days }));
const locationOptions = computed(() => [
  { label: "All locations", value: "all" as LocationFilter },
  ...knownLocations.value.map((entry) => ({
    label: entry.label,
    value: entry.id as LocationFilter,
  })),
]);

const theme = computed(() => chartTheme(themeStore.dark));
const measure = computed(() => measureLocation(location.value));
const allLocations = computed(() => location.value === "all");
const locationLabel = computed(
  () => knownLocations.value.find((entry) => entry.id === location.value)?.label ?? "",
);

const charts = computed(() => {
  const response = daily.value;
  if (response === null || !hasPoints(response)) return null;
  const t = theme.value;
  return {
    storage: storageChart(response, location.value, t),
    downloads: barChart(
      response,
      measure.value,
      { label: "Downloads", yTitle: "Downloads", pick: (point) => point.downloads },
      t,
    ),
    catalog: lineChart(
      response,
      measure.value,
      {
        label: allLocations.value ? "Videos" : "Videos with files here",
        yTitle: "Videos",
        pick: (point) => point.catalog,
      },
      t,
    ),
    gone: lineChart(
      response,
      0,
      { label: "Gone videos", yTitle: "Videos", pick: (point) => point.gone },
      t,
    ),
    api: apiUnitsChart(response, summary.value?.api_units_budget ?? null, t),
  };
});

async function loadSummary(): Promise<void> {
  try {
    summary.value = await getStatsSummary(api);
    summaryError.value = null;
  } catch (cause) {
    summaryError.value = normalizeError(cause);
  }
}

async function loadDaily(): Promise<void> {
  controller?.abort();
  const own = new AbortController();
  controller = own;
  loading.value = true;
  try {
    const window = rangeWindow(range.value);
    const response = await getDailyStats(api, { ...window, location: location.value }, own.signal);
    if (own.signal.aborted) return;
    knownLocations.value = response.locations;
    daily.value = response;
    dailyError.value = null;
  } catch (cause) {
    if (own.signal.aborted) return;
    dailyError.value = normalizeError(cause);
  } finally {
    if (controller === own) {
      loading.value = false;
      loaded.value = true;
    }
  }
}

async function load(): Promise<void> {
  await Promise.all([loadSummary(), loadDaily()]);
}

async function rollupNow(): Promise<void> {
  rolling.value = true;
  try {
    const result = await runStatsRollup(api);
    toast.success("Statistics rolled up", `${pluralize(result.points, "point")} written`);
    await load();
  } catch (cause) {
    toast.failure("The rollup could not run", cause);
  } finally {
    rolling.value = false;
  }
}

watch([range, location], () => {
  void loadDaily();
});

onMounted(() => {
  void load();
});

onBeforeUnmount(() => {
  controller?.abort();
});
</script>

<template>
  <section class="charts-page">
    <PageHeader title="Charts" description="Storage, downloads and catalog growth over time.">
      <template #actions>
        <Button
          v-if="charts !== null"
          label="Run rollup now"
          size="small"
          severity="secondary"
          :loading="rolling"
          :disabled="rolling"
          data-action="rollup"
          @click="rollupNow"
        />
      </template>
    </PageHeader>

    <SummaryStrip v-if="summary" :summary="summary" />
    <p v-else-if="summaryError !== null" class="cellar-note" data-summary-error>
      Could not load the summary: {{ summaryError.message }}
    </p>

    <div class="charts-filters" data-filters>
      <SelectButton
        v-model="range"
        :options="rangeOptions"
        option-label="label"
        option-value="value"
        :allow-empty="false"
        aria-label="Date range"
        data-filter="range"
      />
      <Select
        v-model="location"
        :options="locationOptions"
        option-label="label"
        option-value="value"
        aria-label="Location"
        size="small"
        data-filter="location"
      />
    </div>

    <ErrorState :error="dailyError" title="Could not load the chart data" @retry="loadDaily" />

    <template v-if="dailyError === null">
      <ListSkeleton v-if="!loaded" :rows="4" label="Loading the chart data" />
      <EmptyState
        v-else-if="charts === null"
        icon="charts"
        title="No data to chart yet"
        description="Daily points are rolled up just after midnight UTC. Run a rollup now to chart today and the past week."
      >
        <Button
          label="Run rollup now"
          size="small"
          :loading="rolling"
          :disabled="rolling"
          data-action="rollup"
          @click="rollupNow"
        />
      </EmptyState>
      <template v-else>
        <div class="charts-grid" :aria-busy="loading">
          <ChartCard
            chart-id="storage"
            :title="allLocations ? 'Storage used per location' : `Storage used on ${locationLabel}`"
            description="Bytes on disk at the end of each day, older versions included."
            :config="charts.storage"
          />
          <ChartCard
            chart-id="downloads"
            title="Downloads per day"
            description="Video and audio files downloaded each day."
            :config="charts.downloads"
          />
          <ChartCard
            chart-id="catalog"
            :title="allLocations ? 'Catalog size' : `Videos with files on ${locationLabel}`"
            :description="
              allLocations
                ? 'Every video cellar knows about, downloaded or not.'
                : 'Videos with a current file at this location.'
            "
            :config="charts.catalog"
          />
          <template v-if="allLocations">
            <ChartCard
              chart-id="gone"
              title="Gone videos"
              description="Videos that went private or were removed, on their own scale."
              :config="charts.gone"
            />
            <ChartCard
              chart-id="api"
              title="API units per day"
              description="YouTube Data API units spent each day against the daily budget."
              :config="charts.api"
            />
          </template>
        </div>
        <p v-if="!allLocations" class="cellar-note charts-note" data-location-note>
          Gone videos and API units are counted across all locations. Choose All locations to chart
          them.
        </p>
        <PointsTable :points="daily?.points ?? []" :locations="knownLocations" />
      </template>
    </template>
  </section>
</template>

<style scoped>
.charts-filters {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-bottom: 1rem;
}

.charts-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 24rem), 1fr));
  gap: 1rem;
}

.charts-note {
  margin-top: 0.75rem;
}
</style>
