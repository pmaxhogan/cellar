<script setup lang="ts">
import Column from "primevue/column";
import DataTable from "primevue/datatable";
import Tag from "primevue/tag";
import { failingCount, warningCount, type CheckRow } from "../../api/checks.ts";
import { formatAbsolute, formatRelative } from "../../lib/format.ts";

/** Past self-check runs, newest first. Clicking a run shows its grid. */
defineProps<{ rows: CheckRow[]; selectedId: number | null; loading?: boolean }>();
const emit = defineEmits<{ select: [row: CheckRow] }>();

function rowClass(selectedId: number | null) {
  return (row: CheckRow) => (row.id === selectedId ? "check-history__selected" : "");
}
</script>

<template>
  <DataTable
    :value="rows"
    data-key="id"
    size="small"
    striped-rows
    row-hover
    :loading="loading"
    :row-class="rowClass(selectedId)"
    class="check-history"
    @row-click="emit('select', $event.data)"
  >
    <template #empty>
      <span class="cellar-muted">No past runs.</span>
    </template>
    <Column header="Run">
      <template #body="{ data }">
        <span :title="formatAbsolute(data.run_at)" :data-run="data.id">
          {{ formatRelative(data.run_at) }}
        </span>
      </template>
    </Column>
    <Column header="Trigger">
      <template #body="{ data }">
        <span class="mono">{{ data.trigger }}</span>
      </template>
    </Column>
    <Column header="Result">
      <template #body="{ data }">
        <Tag :value="data.ok ? 'ok' : 'failing'" :severity="data.ok ? 'success' : 'danger'" />
      </template>
    </Column>
    <Column header="Failing">
      <template #body="{ data }">
        <span :data-failing="failingCount(data)">{{ failingCount(data) }}</span>
      </template>
    </Column>
    <Column header="Warnings">
      <template #body="{ data }">{{ warningCount(data) }}</template>
    </Column>
  </DataTable>
</template>

<style scoped>
.check-history :deep(tbody tr) {
  cursor: pointer;
}

.check-history :deep(tbody tr.check-history__selected) {
  background: var(--p-highlight-background);
  color: var(--p-highlight-color);
}
</style>
