<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, routeLocationKey, routerKey } from "vue-router";
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
import Column from "primevue/column";
import DataTable from "primevue/datatable";
import Tag from "primevue/tag";
import { MAX_BULK_IDS, VIDEO_PER_PAGE, type VideoRow, type VideoSort } from "@cellar/shared";
import { ABORTED_PROBLEM, normalizeError, type ApiClientError } from "../api/client.ts";
import { useApi } from "../api/provide.ts";
import {
  collectMatching,
  downloadVideoNow,
  hasFilters,
  listVideos,
  recheckVideo,
  stateFromQuery,
  stateToQuery,
  trashVideos,
  type VideoFilters,
  type VideoListState,
} from "../api/videos.ts";
import AppIcon from "../components/AppIcon.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import EmptyState from "../components/EmptyState.vue";
import ErrorState from "../components/ErrorState.vue";
import PageHeader from "../components/PageHeader.vue";
import BulkDownloadDialog from "../components/videos/BulkDownloadDialog.vue";
import VideoFiltersBar from "../components/videos/VideoFiltersBar.vue";
import {
  formatDay,
  priorityLabel,
  sourceChip,
  videoStatus,
} from "../components/videos/videoDisplay.ts";
import { runBulkJobs, type BulkJobKind } from "../components/videos/bulkJobs.ts";
import { formatBytes, formatDuration, formatNumber, pluralize } from "../lib/format.ts";
import { provideRuleLookups } from "../lib/rulesLookups.ts";
import { useToaster } from "../lib/toast.ts";

/**
 * The catalog: a lazy, server-side sorted, filtered and paged table with full
 * text search. The whole view state lives in the URL query so a filtered list
 * can be shared or reloaded. Rows can be selected (per page, or every match
 * up to the bulk limit) for trash, bulk download, recheck or download now.
 */
const api = useApi();
const toast = useToaster();
const lookups = provideRuleLookups(api);
const router = inject(routerKey, null);
const route = inject(routeLocationKey, null);

const state = ref<VideoListState>(stateFromQuery(route?.query ?? {}));
const rows = ref<VideoRow[]>([]);
const total = ref(0);
const loading = ref(false);
const loaded = ref(false);
const error = ref<ApiClientError | null>(null);

const selected = ref(new Map<string, VideoRow>());
const collecting = ref<{ collected: number; total: number } | null>(null);
const capped = ref(false);
const trashVisible = ref(false);
const trashBusy = ref(false);
const bulkVisible = ref(false);
const jobBusy = ref<BulkJobKind | null>(null);

const accountOptions = computed(() =>
  lookups.accounts.value.map((row) => ({ id: row.id, label: row.label })),
);
const locationOptions = computed(() =>
  lookups.locations.value.map((row) => ({ id: row.id, label: row.label })),
);
const accountLabels = computed(() => new Map(accountOptions.value.map((a) => [a.id, a.label])));

const filtered = computed(() => hasFilters(state.value.filters));
const first = computed(() => (state.value.page - 1) * state.value.perPage);
const sortOrder = computed(() =>
  state.value.sort === null ? undefined : state.value.dir === "asc" ? 1 : -1,
);
const selectedIds = computed(() => [...selected.value.keys()]);
const sample = computed(() => selected.value.values().next().value ?? null);
const pageSelected = computed(
  () => rows.value.length > 0 && rows.value.every((row) => selected.value.has(row.id)),
);
const matchLimit = computed(() => Math.min(total.value, MAX_BULK_IDS));
const offerSelectAll = computed(
  () =>
    pageSelected.value &&
    collecting.value === null &&
    total.value > rows.value.length &&
    selected.value.size < matchLimit.value,
);

let inflight: AbortController | null = null;
let collector: AbortController | null = null;

async function load(): Promise<void> {
  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;
  loading.value = true;
  try {
    const result = await listVideos(api, state.value, controller.signal);
    rows.value = result.rows;
    total.value = result.total;
    error.value = null;
    loaded.value = true;
  } catch (cause) {
    const normalized = normalizeError(cause);
    if (normalized.problem === ABORTED_PROBLEM) return;
    error.value = normalized;
  } finally {
    if (inflight === controller) {
      loading.value = false;
      inflight = null;
    }
  }
}

function queryKey(query: Record<string, string>): string {
  return JSON.stringify(Object.entries(query).sort(([a], [b]) => a.localeCompare(b)));
}

/** Mirror the state into the URL, then load. */
function apply(next: VideoListState): void {
  state.value = next;
  const query = stateToQuery(next);
  if (router !== null && route !== null && queryKey(query) !== currentRouteKey()) {
    void router.replace({ query });
  }
  void load();
}

function currentRouteKey(): string {
  return route === null ? "" : queryKey(stateToQuery(stateFromQuery(route.query)));
}

// Back and forward (or a pasted link) change the query under the page.
watch(
  () => route?.query,
  (query) => {
    if (query === undefined) return;
    const next = stateFromQuery(query);
    if (queryKey(stateToQuery(next)) === queryKey(stateToQuery(state.value))) return;
    state.value = next;
    clearSelection();
    void load();
  },
);

function onFilters(filters: VideoFilters): void {
  clearSelection();
  apply({ ...state.value, filters, page: 1 });
}

function resetFilters(): void {
  onFilters({ ...stateFromQuery({}).filters });
}

function onPage(event: { page: number; rows: number }): void {
  apply({ ...state.value, page: event.page + 1, perPage: event.rows });
}

function onSort(event: { sortField?: unknown; sortOrder?: number | null }): void {
  const field = typeof event.sortField === "string" ? (event.sortField as VideoSort) : null;
  apply({
    ...state.value,
    page: 1,
    sort: field,
    dir: event.sortOrder === 1 ? "asc" : "desc",
  });
}

// --- selection --------------------------------------------------------------

function clearSelection(): void {
  collector?.abort();
  selected.value = new Map();
  capped.value = false;
}

function toggleRow(row: VideoRow, on: boolean): void {
  const next = new Map(selected.value);
  if (on) next.set(row.id, row);
  else next.delete(row.id);
  selected.value = next;
  capped.value = false;
}

function togglePage(on: boolean): void {
  const next = new Map(selected.value);
  for (const row of rows.value) {
    if (on) next.set(row.id, row);
    else next.delete(row.id);
  }
  selected.value = next;
  capped.value = false;
}

async function selectAllMatching(): Promise<void> {
  collector?.abort();
  const controller = new AbortController();
  collector = controller;
  collecting.value = { collected: selected.value.size, total: matchLimit.value };
  try {
    const result = await collectMatching(api, state.value.filters, {
      sort: state.value.sort,
      dir: state.value.dir,
      signal: controller.signal,
      onProgress: (progress) => {
        collecting.value = progress;
      },
    });
    selected.value = new Map(result.rows.map((row) => [row.id, row]));
    capped.value = result.capped;
  } catch (cause) {
    if (normalizeError(cause).problem !== ABORTED_PROBLEM) {
      toast.failure("Could not select every match", cause);
    }
  } finally {
    if (collector === controller) {
      collecting.value = null;
      collector = null;
    }
  }
}

function cancelCollect(): void {
  collector?.abort();
}

// --- bulk actions -----------------------------------------------------------

async function confirmTrash(): Promise<void> {
  trashBusy.value = true;
  try {
    const count = await trashVideos(api, selectedIds.value);
    trashVisible.value = false;
    toast.success(
      "Moved to trash",
      `${pluralize(count, "video")} trashed. Their media is deleted.`,
    );
    clearSelection();
    void load();
  } catch (cause) {
    toast.failure("Could not trash the selection", cause);
  } finally {
    trashBusy.value = false;
  }
}

async function bulkJob(kind: BulkJobKind): Promise<void> {
  jobBusy.value = kind;
  try {
    const run = kind === "recheck" ? recheckVideo : downloadVideoNow;
    const outcome = await runBulkJobs(selectedIds.value, (id) => run(api, id));
    const what = kind === "recheck" ? "Recheck" : "Download";
    if (outcome.unavailable) {
      toast.warn(`${what} is not available yet`, "The server has no handler for this job type.");
    } else if (outcome.failed > 0) {
      toast.warn(
        `${what} queued with errors`,
        `${pluralize(outcome.queued, "job")} queued, ${outcome.failed} failed: ${outcome.firstError}`,
      );
    } else {
      const deduped = outcome.deduped > 0 ? ` (${outcome.deduped} already queued)` : "";
      toast.success(`${what} queued`, `${pluralize(outcome.queued, "job")} queued${deduped}.`);
    }
  } finally {
    jobBusy.value = null;
  }
}

onMounted(() => {
  void load();
  void lookups.ensureAccounts();
  void lookups.ensureLocations();
});

onBeforeUnmount(() => {
  inflight?.abort();
  collector?.abort();
});

function title(row: VideoRow): string {
  return row.title ?? row.id;
}
</script>

<template>
  <section class="cellar-stack">
    <PageHeader
      title="Videos"
      description="Every archived and known video, with full-text search and filters."
    />

    <VideoFiltersBar
      :model-value="state.filters"
      :accounts="accountOptions"
      :locations="locationOptions"
      @update:model-value="onFilters"
    />

    <div v-if="selected.size > 0" class="videos-toolbar cellar-card" data-test="bulk-toolbar">
      <span data-test="selected-count">{{ pluralize(selected.size, "video") }} selected</span>
      <span v-if="capped" class="cellar-note" data-test="selection-capped">
        (the first {{ formatNumber(MAX_BULK_IDS) }} of {{ formatNumber(total) }})
      </span>
      <span class="videos-toolbar__spacer" />
      <Button
        size="small"
        severity="danger"
        data-action="trash"
        :disabled="collecting !== null"
        @click="trashVisible = true"
      >
        <AppIcon name="trash" :size="15" />
        <span>Trash</span>
      </Button>
      <Button
        size="small"
        data-action="bulk-download"
        :disabled="collecting !== null"
        @click="bulkVisible = true"
      >
        <AppIcon name="download" :size="15" />
        <span>Download</span>
      </Button>
      <Button
        size="small"
        severity="secondary"
        label="Recheck now"
        data-action="bulk-recheck"
        :loading="jobBusy === 'recheck'"
        :disabled="jobBusy !== null || collecting !== null"
        @click="bulkJob('recheck')"
      />
      <Button
        size="small"
        severity="secondary"
        label="Download now"
        data-action="bulk-download-now"
        :loading="jobBusy === 'download'"
        :disabled="jobBusy !== null || collecting !== null"
        @click="bulkJob('download')"
      />
      <Button
        size="small"
        text
        label="Clear"
        data-action="clear-selection"
        @click="clearSelection"
      />
    </div>
    <div v-if="offerSelectAll" class="videos-banner" data-test="select-all-banner">
      All {{ rows.length }} on this page are selected.
      <Button
        size="small"
        text
        :label="`Select all ${formatNumber(matchLimit)} matching`"
        data-action="select-all-matching"
        @click="selectAllMatching"
      />
    </div>
    <div v-if="collecting" class="videos-banner" data-test="collecting">
      Selecting {{ formatNumber(collecting.collected) }} of {{ formatNumber(collecting.total) }}...
      <Button size="small" text label="Stop" data-action="cancel-collect" @click="cancelCollect" />
    </div>

    <ErrorState v-if="error" :error="error" title="Could not load videos" @retry="load" />
    <EmptyState
      v-else-if="loaded && total === 0 && !filtered"
      icon="videos"
      title="No videos yet"
      description="Videos appear here once an account is linked and the first ingestion runs."
    />
    <DataTable
      v-else
      :value="rows"
      lazy
      paginator
      :rows="state.perPage"
      :first="first"
      :total-records="total"
      :rows-per-page-options="[...VIDEO_PER_PAGE]"
      :loading="loading"
      :sort-field="state.sort ?? undefined"
      :sort-order="sortOrder"
      removable-sort
      data-key="id"
      size="small"
      class="videos-table"
      @page="onPage"
      @sort="onSort"
    >
      <template #empty>
        <div class="videos-none" data-test="no-matches">
          No videos match these filters.
          <Button label="Clear filters" size="small" text @click="resetFilters" />
        </div>
      </template>
      <Column class="videos-check-col">
        <template #header>
          <Checkbox
            :model-value="pageSelected"
            binary
            :disabled="rows.length === 0"
            aria-label="Select this page"
            data-test="select-page"
            @update:model-value="togglePage($event)"
          />
        </template>
        <template #body="{ data }">
          <Checkbox
            :model-value="selected.has(data.id)"
            binary
            :aria-label="`Select ${title(data)}`"
            :data-select="data.id"
            @update:model-value="toggleRow(data, $event)"
          />
        </template>
      </Column>
      <Column header="" class="videos-thumb-col">
        <template #body="{ data }">
          <img
            v-if="data.thumbnail_url"
            class="videos-thumb"
            :src="data.thumbnail_url"
            alt=""
            width="96"
            height="54"
            loading="lazy"
          />
          <span v-else class="videos-thumb videos-thumb--none" aria-hidden="true" />
        </template>
      </Column>
      <Column header="Title" field="title" sortable>
        <template #body="{ data }">
          <RouterLink
            v-if="router"
            :to="{ name: 'video', params: { id: data.id } }"
            class="videos-title"
            :data-video="data.id"
            >{{ title(data) }}</RouterLink
          >
          <a v-else :href="`/videos/${data.id}`" class="videos-title" :data-video="data.id">{{
            title(data)
          }}</a>
          <div class="cellar-muted videos-channel">{{ data.channel_title ?? "-" }}</div>
        </template>
      </Column>
      <Column header="Uploaded" field="upload_date" sortable>
        <template #body="{ data }">{{ formatDay(data.upload_date) }}</template>
      </Column>
      <Column header="Length" field="duration_s" sortable>
        <template #body="{ data }">{{ formatDuration(data.duration_s) }}</template>
      </Column>
      <Column header="Sources">
        <template #body="{ data }">
          <span class="videos-chips">
            <Tag
              v-for="(source, index) in data.sources"
              :key="index"
              :value="sourceChip(source, accountLabels)"
              severity="secondary"
              data-test="source-chip"
            />
          </span>
        </template>
      </Column>
      <Column header="Status">
        <template #body="{ data }">
          <Tag
            :value="videoStatus(data).label"
            :severity="videoStatus(data).severity"
            data-test="status"
          />
        </template>
      </Column>
      <Column header="Downloaded" field="size" sortable>
        <template #body="{ data }">
          <span data-test="downloaded">{{
            data.downloaded ? formatBytes(data.media_size_bytes) : "-"
          }}</span>
        </template>
      </Column>
      <Column header="Priority" field="reclaim_priority" sortable>
        <template #body="{ data }">
          <span data-test="priority">{{ priorityLabel(data.reclaim_priority) }}</span>
        </template>
      </Column>
      <Column header="Views" field="views" sortable>
        <template #body="{ data }">{{ formatNumber(data.views) }}</template>
      </Column>
    </DataTable>

    <p v-if="loaded && !error && total > 0" class="cellar-note" data-test="video-total">
      {{ pluralize(total, "video") }}
    </p>

    <ConfirmDialog
      :visible="trashVisible"
      title="Trash videos?"
      :message="`Trash ${pluralize(selected.size, 'video')}? This sets priority 0 and deletes the media now; metadata, history and captions are kept.`"
      confirm-label="Trash"
      danger
      :busy="trashBusy"
      @update:visible="trashVisible = $event"
      @confirm="confirmTrash"
    />
    <BulkDownloadDialog v-model:visible="bulkVisible" :ids="selectedIds" :sample="sample" />
  </section>
</template>

<style scoped>
.videos-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}

.videos-toolbar :deep(.p-button) {
  gap: 0.35rem;
}

.videos-toolbar__spacer {
  flex: 1;
}

.videos-banner {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--p-text-muted-color);
  font-size: 0.9rem;
}

.videos-thumb {
  display: block;
  width: 96px;
  height: 54px;
  border-radius: 4px;
  object-fit: cover;
}

.videos-thumb--none {
  background: var(--p-content-hover-background);
}

.videos-title {
  color: var(--p-text-color);
  font-weight: 550;
  text-decoration: none;
}

.videos-title:hover {
  text-decoration: underline;
}

.videos-channel {
  font-size: 0.8rem;
}

.videos-chips {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}

.videos-none {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--p-text-muted-color);
}
</style>
