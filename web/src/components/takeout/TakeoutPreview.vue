<script setup lang="ts">
import { computed } from "vue";
import type { TakeoutUploadResponse } from "@cellar/shared";
import { kindLabel, skipReasonLabel } from "../../api/takeout.ts";
import { formatNumber } from "../../lib/format.ts";

/** What the server found in the upload: one row per file it will import, then the skipped ones. */
const props = defineProps<{ preview: TakeoutUploadResponse }>();

function rowSkips(skipped: Record<string, number>): string {
  const parts = Object.entries(skipped)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${formatNumber(count)} ${skipReasonLabel(reason).toLowerCase()}`);
  return parts.length === 0 ? "-" : parts.join(", ");
}

const hiddenSkipped = computed(() => props.preview.skipped_total - props.preview.skipped.length);
</script>

<template>
  <div class="takeout-preview">
    <table class="takeout-table" data-test="takeout-preview">
      <thead>
        <tr>
          <th scope="col">File</th>
          <th scope="col">Kind</th>
          <th scope="col" class="takeout-num">Rows</th>
          <th scope="col">Skipped</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="file in preview.files"
          :key="file.name"
          data-test="preview-file"
          :data-kind="file.kind"
        >
          <td class="takeout-name">{{ file.name }}</td>
          <td>{{ kindLabel(file.kind) }}</td>
          <td class="takeout-num">{{ formatNumber(file.rows) }}</td>
          <td>{{ rowSkips(file.skipped_rows) }}</td>
        </tr>
        <tr
          v-for="file in preview.skipped"
          :key="`skip-${file.name}`"
          class="takeout-skipped"
          data-test="preview-skipped"
        >
          <td class="takeout-name">{{ file.name }}</td>
          <td>Not imported</td>
          <td class="takeout-num">-</td>
          <td>{{ skipReasonLabel(file.reason) }}</td>
        </tr>
      </tbody>
    </table>
    <p v-if="hiddenSkipped > 0" class="cellar-note" data-test="preview-more">
      And {{ formatNumber(hiddenSkipped) }} more files that are not part of the import.
    </p>
  </div>
</template>

<style scoped>
.takeout-preview {
  overflow-x: auto;
}

.takeout-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88rem;
}

.takeout-table th,
.takeout-table td {
  text-align: left;
  padding: 0.35rem 0.5rem;
  border-bottom: 1px solid var(--p-content-border-color);
  vertical-align: top;
}

.takeout-table th {
  font-weight: 600;
  color: var(--p-text-muted-color);
}

.takeout-num {
  text-align: right !important;
  font-variant-numeric: tabular-nums;
}

.takeout-name {
  word-break: break-all;
}

.takeout-skipped {
  color: var(--p-text-muted-color);
}
</style>
