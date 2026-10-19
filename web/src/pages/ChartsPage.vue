<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Button from "primevue/button";
import Select from "primevue/select";
import SelectButton from "primevue/selectbutton";
import type {
  StatsDailyResponse,
  StatsHourlyResponse,
  StatsLocationRef,
  StatsSummary,
} from "@cellar/shared";
import { normalizeError, type ApiClientError } from "../api/client.ts";
import { useApi } from "../api/provide.ts";
import {
  getDailyStats,
  getHourlyStats,
  getStatsSummary,
  HOURLY_REFRESH_MS,
  rangeWindow,
  RANGE_HOURLY,
  RANGE_OPTIONS,
  runStatsRollup,
  type ChartRange,
  type LocationFilter,
} from "../api/stats.ts";
import { formatBytes, formatNumber, pluralize } from "../lib/format.ts";
import { useToaster } from "../lib/toast.ts";
import { useThemeStore } from "../stores/theme.ts";
import EmptyState from "../components/EmptyState.vue";
import ErrorState from "../components/ErrorState.vue";
import ListSkeleton from "../components/ListSkeleton.vue";
import PageHeader from "../components/PageHeader.vue";
import ChartCard from "../components/charts/ChartCard.vue";
import { chartTheme } from "../components/charts/chartTheme.ts";
import HourlyTable from "../components/charts/HourlyTable.vue";
import { hourlyBarChart, hourlyJobsChart } from "../components/charts/hourlySeries.ts";
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

const range = ref<ChartRange>(90);
const location = ref<LocationFilter>("all");

const summary = ref<StatsSummary | null>(null);
const summaryError = ref<ApiClientError | null>(null);
const daily = ref<StatsDailyResponse | null>(null);
const dailyError = ref<ApiClientError | null>(null);
const loaded = ref(false);
const hourly = ref<StatsHourlyResponse | null>(null);
const hourlyError = ref<ApiClientError | null>(null);
const loading = ref(false);
const rolling = ref(false);
/** Every known location, kept across filter changes for the picker. */
const knownLocations = ref<StatsLocationRef[]>([]);

let controller: AbortController | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

const rangeOptions = [...RANGE_OPTIONS];
const locationOptions = computed(() => [
  { label: "All locations", value: "all" as LocationFilter },
  ...knownLocations.value.map((entry) => ({
    label: entry.label,
    value: entry.id as LocationFilter,
  })),
]);

const isHourly = computed(() => range.value === RANGE_HOURLY);
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

const hourlyCharts = computed(() => {
  const response = hourly.value;
  if (response === null) return null;
  const t = theme.value;
  return {
    downloads: hourlyBarChart(
      response,
      { label: "Downloads", yTitle: "Downloads", pick: (point) => point.downloads },
      t,
    ),
    bytes: hourlyBarChart(
      response,
      {
        label: "Downloaded size",
        yTitle: "Size",
        format: "bytes",
        pick: (point) => point.download_bytes,
      },
      t,
    ),
    jobs: hourlyJobsChart(response, t),
    added: hourlyBarChart(
      response,
      { label: "Videos added", yTitle: "Videos", pick: (point) => point.videos_added },
      t,
    ),
    gone: hourlyBarChart(
      response,
      { label: "Videos gone", yTitle: "Videos", pick: (point) => point.videos_gone },
      t,
    ),
    scrape: hourlyBarChart(
      response,
      { label: "Scrape requests", yTitle: "Requests", pick: (point) => point.scrape_requests },
      t,
    ),
  };
});

/** The live figures with no hourly history, said in words instead of charted. */
const hourlyNote = computed(() => {
  const response = hourly.value;
  if (response === null) return "";
  const where = allLocations.value ? "across every location" : `on ${locationLabel.value}`;
  const storage = `Storage has no hourly history: ${formatBytes(response.bytes_used)} is on disk ${where} now.`;
  if (!allLocations.value) return storage;
  const units = formatNumber(response.api_units_today);
  return `${storage} API units are only counted per UTC day: ${units} spent so far today.`;
});

const activeError = computed(() => (isHourly.value ? hourlyError.value : dailyError.value));

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
    const window = rangeWindow(range.value === RANGE_HOURLY ? 1 : range.value);
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

async function loadHourly(): Promise<void> {
  controller?.abort();
  const own = new AbortController();
  controller = own;
  loading.value = true;
  try {
    const response = await getHourlyStats(api, { location: location.value }, own.signal);
    if (own.signal.aborted) return;
    knownLocations.value = response.locations;
    hourly.value = response;
    hourlyError.value = null;
  } catch (cause) {
    if (own.signal.aborted) return;
    hourlyError.value = normalizeError(cause);
  } finally {
    if (controller === own) {
      loading.value = false;
    }
  }
}

/** Fetch the points for the range on screen. */
function loadPoints(): Promise<void> {
  return isHourly.value ? loadHourly() : loadDaily();
}

async function load(): Promise<void> {
  await Promise.all([loadSummary(), loadPoints()]);
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

function stopRefresh(): void {
  if (refreshTimer !== null) clearInterval(refreshTimer);
  refreshTimer = null;
}

function startRefresh(): void {
  stopRefresh();
  refreshTimer = setInterval(() => {
    void loadHourly();
  }, HOURLY_REFRESH_MS);
}

/**
 * The range picker never emits for the option already chosen, so a click on
 * it is caught here (capture phase, before the picker handles it) and read as
 * "refresh this range".
 */
function onRangeClick(event: MouseEvent): void {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest("button")?.getAttribute("aria-pressed") === "true") void loadPoints();
}

watch([range, location], () => {
  void loadPoints();
});

watch(isHourly, (hourlyView) => {
  if (hourlyView) startRefresh();
  else stopRefresh();
});

onMounted(() => {
  void load();
});

onBeforeUnmount(() => {
  stopRefresh();
  controller?.abort();
});
</script>

<template>
  <section class="charts-page">
    <PageHeader title="Charts" description="Storage, downloads and catalog growth over time.">
      <template #actions>
        <Button
          v-if="isHourly"
          label="Refresh"
          size="small"
          severity="secondary"
          :loading="loading"
          :disabled="loading"
          data-action="refresh"
          @click="loadHourly"
        />
        <Button
          v-else-if="charts !== null"
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
      <div class="charts-range" @click.capture="onRangeClick">
        <SelectButton
          v-model="range"
          :options="rangeOptions"
          option-label="label"
          option-value="value"
          :allow-empty="false"
          aria-label="Date range"
          data-filter="range"
        />
      </div>
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

    <ErrorState :error="activeError" title="Could not load the chart data" @retry="loadPoints" />

    <template v-if="isHourly && hourlyError === null">
      <ListSkeleton v-if="hourlyCharts === null" :rows="4" label="Loading the chart data" />
      <template v-else>
        <div class="charts-grid" :aria-busy="loading" data-view="hourly">
          <ChartCard
            chart-id="hourly-downloads"
            title="Downloads per hour"
            description="Video and audio files downloaded each hour, superseded versions included."
            :config="hourlyCharts.downloads"
          />
          <ChartCard
            chart-id="hourly-bytes"
            title="Downloaded size per hour"
            description="On-disk size of the files downloaded each hour, after any transcode."
            :config="hourlyCharts.bytes"
          />
          <template v-if="allLocations">
            <ChartCard
              chart-id="hourly-jobs"
              title="Jobs finished per hour"
              description="Jobs that finished done or failed each hour. Cancelled jobs are left out."
              :config="hourlyCharts.jobs"
            />
            <ChartCard
              chart-id="hourly-added"
              title="Videos added per hour"
              description="Videos cellar first saw each hour, downloaded or not."
              :config="hourlyCharts.added"
            />
            <ChartCard
              chart-id="hourly-gone"
              title="Videos gone per hour"
              description="Videos still gone that went private or were removed each hour."
              :config="hourlyCharts.gone"
            />
            <ChartCard
              chart-id="hourly-scrape"
              title="Scrape requests per hour"
              description="yt-dlp requests to YouTube each hour, every account."
              :config="hourlyCharts.scrape"
            />
          </template>
        </div>
        <p class="cellar-note charts-note" data-hourly-note>{{ hourlyNote }}</p>
        <p v-if="!allLocations" class="cellar-note charts-note" data-location-note>
          Jobs, videos added, gone videos and scrape requests are counted across all locations.
          Choose All locations to chart them.
        </p>
        <HourlyTable :points="hourly?.points ?? []" :all-locations="allLocations" />
      </template>
    </template>

    <template v-if="!isHourly && dailyError === null">
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

/* A click-capture wrapper only; the picker lays out as a direct flex item. */
.charts-range {
  display: contents;
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
