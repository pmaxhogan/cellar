<script setup lang="ts">
import { computed } from "vue";
import Column from "primevue/column";
import DataTable from "primevue/datatable";
import type { StatsDailyPoint, StatsLocationRef } from "@cellar/shared";
import { formatBytes, formatNumber } from "../../lib/format.ts";

/**
 * The tabular view of the chart points: the accessible fallback for every
 * chart, and the place to read exact values. Newest day first.
 */
const props = defineProps<{ points: StatsDailyPoint[]; locations: StatsLocationRef[] }>();

const rows = computed(() => {
  const labels = new Map(props.locations.map((location) => [location.id, location.label]));
  return [...props.points]
    .sort((a, b) => (a.day === b.day ? a.location_id - b.location_id : a.day < b.day ? 1 : -1))
    .map((point) => ({
      ...point,
      key: `${point.day}:${String(point.location_id)}`,
      location:
        point.location_id === 0
          ? "All locations"
          : (labels.get(point.location_id) ?? `Location ${String(point.location_id)}`),
    }));
});
</script>

<template>
  <details class="points-table">
    <summary>Show the data as a table ({{ formatNumber(rows.length) }} rows)</summary>
    <DataTable
      :value="rows"
      data-key="key"
      size="small"
      :paginator="rows.length > 15"
      :rows="15"
      striped-rows
    >
      <Column field="day" header="Day (UTC)" />
      <Column field="location" header="Location" />
      <Column header="Storage used">
        <template #body="{ data }">{{ formatBytes(data.bytes_used) }}</template>
      </Column>
      <Column header="Downloads">
        <template #body="{ data }">{{ formatNumber(data.downloads) }}</template>
      </Column>
      <Column header="Catalog">
        <template #body="{ data }">{{ formatNumber(data.catalog) }}</template>
      </Column>
      <Column header="Gone">
        <template #body="{ data }">{{ formatNumber(data.gone) }}</template>
      </Column>
      <Column header="API units">
        <template #body="{ data }">{{ formatNumber(data.api_units) }}</template>
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
