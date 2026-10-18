<script setup lang="ts">
import { onMounted, ref } from "vue";
import Button from "primevue/button";
import { TAKEOUT_ACTIVITY_KIND } from "@cellar/shared";
import ErrorState from "../ErrorState.vue";
import TakeoutCounts from "./TakeoutCounts.vue";
import { normalizeError, type ApiClientError } from "../../api/client.ts";
import { useApi } from "../../api/provide.ts";
import { listTakeoutImports, type TakeoutImportEntry } from "../../api/takeout.ts";
import { formatAbsolute, formatRelative } from "../../lib/format.ts";
import { useEventsStore } from "../../stores/events.ts";

/** Previous imports, newest first, from the `takeout.imported` Activity rows. */
const api = useApi();
const events = useEventsStore();

const entries = ref<TakeoutImportEntry[]>([]);
const loaded = ref(false);
const error = ref<ApiClientError | null>(null);
const open = ref<number | null>(null);

async function load(): Promise<void> {
  error.value = null;
  try {
    entries.value = await listTakeoutImports(api);
  } catch (cause) {
    error.value = normalizeError(cause);
  } finally {
    loaded.value = true;
  }
}

events.on((event) => {
  if (event.type !== "activity") return;
  const kind = (event.payload as { kind?: unknown } | null)?.kind;
  if (kind === TAKEOUT_ACTIVITY_KIND) void load();
});

onMounted(load);

defineExpose({ load });
</script>

<template>
  <section class="cellar-card takeout-history" aria-labelledby="takeout-history-title">
    <h2 id="takeout-history-title">Previous imports</h2>
    <ErrorState :error="error" title="Could not load previous imports" @retry="load" />
    <p v-if="!error && loaded && entries.length === 0" class="cellar-muted" data-test="no-imports">
      No Takeout imports yet.
    </p>
    <ul v-if="!error && entries.length > 0" class="takeout-history__list">
      <li v-for="entry in entries" :key="entry.id" data-test="import-entry">
        <div class="takeout-history__head">
          <span :title="formatAbsolute(entry.at)" class="cellar-muted">{{
            formatRelative(entry.at)
          }}</span>
          <span>{{ entry.message }}</span>
          <Button
            v-if="entry.counts"
            :label="open === entry.id ? 'Hide counts' : 'Show counts'"
            size="small"
            text
            data-action="toggle-counts"
            @click="open = open === entry.id ? null : entry.id"
          />
        </div>
        <TakeoutCounts v-if="entry.counts && open === entry.id" :counts="entry.counts" />
      </li>
    </ul>
  </section>
</template>

<style scoped>
.takeout-history h2 {
  margin: 0 0 0.6rem;
  font-size: 1rem;
  font-weight: 650;
}

.takeout-history__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.takeout-history__head {
  display: flex;
  gap: 0.6rem;
  align-items: baseline;
  flex-wrap: wrap;
  font-size: 0.88rem;
}
</style>
