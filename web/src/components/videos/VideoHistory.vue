<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import Button from "primevue/button";
import type { VideoChangeRow } from "@cellar/shared";
import { ABORTED_PROBLEM, normalizeError, type ApiClientError } from "../../api/client.ts";
import { useApi } from "../../api/provide.ts";
import { getVideoHistory, HISTORY_PER_PAGE } from "../../api/videos.ts";
import { formatAbsolute, formatRelative } from "../../lib/format.ts";
import ErrorState from "../ErrorState.vue";
import ListSkeleton from "../ListSkeleton.vue";
import { fieldLabel, formatChangeValue, LONG_VALUE } from "./history.ts";

/**
 * The change history of one video, newest first and paged: every field that
 * changed on YouTube with its old and new value. Counter ticks (views, likes,
 * comments) are left out by the server unless the toggle asks for them, so
 * pages and totals cover only what is shown; the stats chart plots them.
 */
const props = defineProps<{ videoId: string }>();

const api = useApi();
const rows = ref<VideoChangeRow[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const error = ref<ApiClientError | null>(null);
const showCounters = ref(false);
let controller: AbortController | null = null;

const pages = computed(() => Math.max(1, Math.ceil(total.value / HISTORY_PER_PAGE)));

async function load(): Promise<void> {
  controller?.abort();
  const mine = new AbortController();
  controller = mine;
  loading.value = true;
  try {
    const result = await getVideoHistory(
      api,
      props.videoId,
      { page: page.value, counters: showCounters.value },
      mine.signal,
    );
    rows.value = result.rows;
    total.value = result.total;
    error.value = null;
  } catch (cause) {
    const normalized = normalizeError(cause);
    if (normalized.problem === ABORTED_PROBLEM) return;
    error.value = normalized;
  } finally {
    if (controller === mine) {
      loading.value = false;
      controller = null;
    }
  }
}

function go(next: number): void {
  page.value = Math.min(pages.value, Math.max(1, next));
  void load();
}

/** Totals change with the filter, so the toggle starts over at page 1. */
function toggleCounters(): void {
  showCounters.value = !showCounters.value;
  page.value = 1;
  void load();
}

watch(
  () => props.videoId,
  () => {
    page.value = 1;
    void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => controller?.abort());

function isLong(row: VideoChangeRow): boolean {
  return (
    formatChangeValue(row.field, row.old).length > LONG_VALUE ||
    formatChangeValue(row.field, row.new).length > LONG_VALUE
  );
}
</script>

<template>
  <div class="history" data-test="history">
    <ErrorState v-if="error" :error="error" title="Could not load the history" @retry="load" />
    <ListSkeleton v-else-if="loading && rows.length === 0" :rows="3" label="Loading history" />
    <template v-else>
      <p v-if="total === 0" class="cellar-muted" data-test="history-empty">
        No changes recorded yet. Changes appear here after rechecks see something new.
      </p>
      <ol v-else class="history__list">
        <li
          v-for="row in rows"
          :key="row.id"
          class="history__item"
          :data-field="row.field"
          data-test="history-item"
        >
          <div class="history__head">
            <strong>{{ fieldLabel(row.field) }}</strong>
            <span class="cellar-muted" :title="formatAbsolute(row.seen_at)">{{
              formatRelative(row.seen_at)
            }}</span>
          </div>
          <details v-if="isLong(row)" class="history__long">
            <summary>Show the change</summary>
            <div class="history__diff">
              <div class="history__old" data-test="history-old">
                {{ formatChangeValue(row.field, row.old) }}
              </div>
              <div class="history__new" data-test="history-new">
                {{ formatChangeValue(row.field, row.new) }}
              </div>
            </div>
          </details>
          <div v-else class="history__inline">
            <span class="history__old" data-test="history-old">{{
              formatChangeValue(row.field, row.old)
            }}</span>
            <span class="cellar-muted" aria-label="changed to">-&gt;</span>
            <span class="history__new" data-test="history-new">{{
              formatChangeValue(row.field, row.new)
            }}</span>
          </div>
        </li>
      </ol>
      <div class="history__footer">
        <Button
          size="small"
          text
          :label="showCounters ? 'Hide counter changes' : 'Show counter changes'"
          :disabled="loading"
          data-test="history-counters"
          @click="toggleCounters"
        />
        <span v-if="total > 0" class="history__pager">
          <Button
            size="small"
            text
            label="Newer"
            :disabled="page <= 1 || loading"
            data-test="history-newer"
            @click="go(page - 1)"
          />
          <span class="cellar-note" data-test="history-page">Page {{ page }} of {{ pages }}</span>
          <Button
            size="small"
            text
            label="Older"
            :disabled="page >= pages || loading"
            data-test="history-older"
            @click="go(page + 1)"
          />
        </span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.history__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.history__item {
  padding: 0.5rem 0 0.5rem 0.9rem;
  border-left: 2px solid var(--p-content-border-color);
  position: relative;
}

.history__item::before {
  content: "";
  position: absolute;
  left: -5px;
  top: 0.85rem;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--p-primary-color);
}

.history__head {
  display: flex;
  gap: 0.75rem;
  align-items: baseline;
  font-size: 0.9rem;
}

.history__inline {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  font-size: 0.88rem;
  margin-top: 0.15rem;
}

.history__old {
  color: var(--p-text-muted-color);
  text-decoration: line-through;
  word-break: break-word;
}

.history__new {
  word-break: break-word;
}

.history__diff {
  display: grid;
  gap: 0.4rem;
  font-size: 0.85rem;
  white-space: pre-wrap;
  margin-top: 0.3rem;
}

.history__long summary {
  cursor: pointer;
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}

.history__footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-top: 0.5rem;
}

.history__pager {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  margin-left: auto;
}
</style>
