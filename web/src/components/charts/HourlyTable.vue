<script setup lang="ts">
import { computed } from "vue";
import Column from "primevue/column";
import DataTable from "primevue/datatable";
import type { StatsHourlyPoint } from "@cellar/shared";
import { formatBytes, formatNumber } from "../../lib/format.ts";

/**
 * The tabular view of the hourly points, the accessible fallback for the
 * hourly charts. Newest hour first, labelled in local time. The catalog-wide
 * columns are left out while a location is chosen, like their charts.
 */
const props = defineProps<{ points: StatsHourlyPoint[]; allLocations: boolean }>();

const LABEL = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric" });

const rows = computed(() =>
  [...props.points]
    .sort((a, b) => b.hour - a.hour)
    .map((point) => ({ ...point, label: LABEL.format(new Date(point.hour)) })),
);
</script>

<template>
  <details class="points-table" data-hourly-table>
    <summary>Show the data as a table ({{ formatNumber(rows.length) }} hours)</summary>
    <DataTable :value="rows" data-key="hour" size="small" striped-rows>
      <Column field="label" header="Hour (local time)" />
      <Column header="Downloads">
        <template #body="{ data }">{{ formatNumber(data.downloads) }}</template>
      </Column>
      <Column header="Downloaded size">
        <template #body="{ data }">{{ formatBytes(data.download_bytes) }}</template>
      </Column>
      <Column header="Jobs done" :hidden="!allLocations">
        <template #body="{ data }">{{ formatNumber(data.jobs_done) }}</template>
      </Column>
      <Column header="Jobs failed" :hidden="!allLocations">
        <template #body="{ data }">{{ formatNumber(data.jobs_failed) }}</template>
      </Column>
      <Column header="Videos added" :hidden="!allLocations">
        <template #body="{ data }">{{ formatNumber(data.videos_added) }}</template>
      </Column>
      <Column header="Gone" :hidden="!allLocations">
        <template #body="{ data }">{{ formatNumber(data.videos_gone) }}</template>
      </Column>
      <Column header="Scrape requests" :hidden="!allLocations">
        <template #body="{ data }">{{ formatNumber(data.scrape_requests) }}</template>
      </Column>
    </DataTable>
  </details>
</template>

<style scoped>
.points-table {
  margin-top: 1.25rem;
}

.points-table summary {
  cursor: pointer;
  font-size: 0.9rem;
  margin-bottom: 0.6rem;
}

.points-table :deep(td) {
  font-variant-numeric: tabular-nums;
}
</style>
