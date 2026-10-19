<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Button from "primevue/button";
import Column from "primevue/column";
import DataTable from "primevue/datatable";
import InputText from "primevue/inputtext";
import type { TitleChangeRow } from "@cellar/shared";
import { normalizeError, type ApiClientError } from "../api/client.ts";
import { useApi } from "../api/provide.ts";
import { listTitleChanges } from "../api/titleChanges.ts";
import { formatAbsolute, formatRelative, pluralize } from "../lib/format.ts";
import { provideRuleLookups } from "../lib/rulesLookups.ts";
import AppIcon from "../components/AppIcon.vue";
import EmptyState from "../components/EmptyState.vue";
import ErrorState from "../components/ErrorState.vue";
import PageHeader from "../components/PageHeader.vue";
import ChannelPicker from "../components/rules/ChannelPicker.vue";
import VideoLink from "../components/shares/VideoLink.vue";

/**
 * Every title change across the catalog, newest first, from the `title` rows
 * of video_changes. Filters: a channel and a substring of the old or new title.
 */
const api = useApi();
// ChannelPicker resolves channel titles through the rule lookups.
provideRuleLookups(api);

const rows = ref<TitleChangeRow[]>([]);
const total = ref(0);
const loading = ref(false);
const loaded = ref(false);
const error = ref<ApiClientError | null>(null);

const page = ref(1);
const perPage = ref(25);
const q = ref("");
const channelId = ref<string | null>(null);

const filtered = computed(() => q.value.trim() !== "" || channelId.value !== null);
const first = computed(() => (page.value - 1) * perPage.value);

let inflight: AbortController | null = null;
/** The trimmed search text of the latest load. */
let loadedQ = "";

async function load(): Promise<void> {
  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;
  loading.value = true;
  loadedQ = q.value.trim();
  try {
    const result = await listTitleChanges(
      api,
      { page: page.value, perPage: perPage.value, channelId: channelId.value, q: loadedQ },
      controller.signal,
    );
    rows.value = result.rows;
    total.value = result.total;
    error.value = null;
    loaded.value = true;
  } catch (cause) {
    const normalized = normalizeError(cause);
    if (normalized.problem === "aborted") return;
    error.value = normalized;
  } finally {
    if (inflight === controller) {
      loading.value = false;
      inflight = null;
    }
  }
}

/** Debounced so typing does not fire a request per keystroke. */
let searchTimer: ReturnType<typeof setTimeout> | null = null;
function cancelSearchTimer(): void {
  if (searchTimer !== null) clearTimeout(searchTimer);
  searchTimer = null;
}

watch(q, () => {
  cancelSearchTimer();
  // A reset already loaded with the cleared text; trailing spaces change nothing.
  if (q.value.trim() === loadedQ) return;
  searchTimer = setTimeout(() => {
    searchTimer = null;
    page.value = 1;
    void load();
  }, 300);
});

function searchNow(): void {
  cancelSearchTimer();
  page.value = 1;
  void load();
}

function onChannel(value: string | string[] | null): void {
  channelId.value = typeof value === "string" && value !== "" ? value : null;
  page.value = 1;
  void load();
}

function onPage(event: { page: number; rows: number }): void {
  page.value = event.page + 1;
  perPage.value = event.rows;
  void load();
}

function resetFilters(): void {
  q.value = "";
  channelId.value = null;
  page.value = 1;
  void load();
}

onMounted(() => void load());
onBeforeUnmount(() => {
  cancelSearchTimer();
  inflight?.abort();
});

function shownTitle(value: string | null): string {
  return value ?? "(no title)";
}
</script>

<template>
  <section class="cellar-stack">
    <PageHeader
      title="Title changes"
      description="Every rename YouTube made to an archived video, newest first. Each row links to the video."
    />

    <div class="cellar-row title-changes-filters">
      <span class="title-changes-search">
        <AppIcon name="search" :size="16" />
        <InputText
          v-model="q"
          data-test="title-search"
          placeholder="Search old or new title"
          aria-label="Search title changes"
          @keyup.enter="searchNow"
        />
      </span>
      <span class="title-changes-channel">
        <ChannelPicker
          :model-value="channelId"
          data-test="title-channel"
          @update:model-value="onChannel"
        />
      </span>
      <Button
        v-if="filtered"
        label="Clear filters"
        size="small"
        severity="secondary"
        text
        data-test="title-changes-reset"
        @click="resetFilters"
      />
    </div>

    <ErrorState v-if="error" :error="error" title="Could not load title changes" @retry="load" />
    <EmptyState
      v-else-if="loaded && total === 0 && !filtered"
      icon="titles"
      title="No title changes yet"
      description="Rechecks record a row here whenever a video's title differs from the one stored."
    />
    <DataTable
      v-else
      :value="rows"
      lazy
      paginator
      :rows="perPage"
      :first="first"
      :total-records="total"
      :rows-per-page-options="[25, 50, 100]"
      :loading="loading"
      data-key="id"
      size="small"
      class="title-changes-table"
      @page="onPage"
    >
      <template #empty>
        <div class="title-changes-none" data-test="no-matches">
          No title changes match these filters.
          <Button label="Clear filters" size="small" text @click="resetFilters" />
        </div>
      </template>
      <Column header="" class="title-changes-thumb-col">
        <template #body="{ data }">
          <img
            v-if="data.thumbnail_url"
            class="title-changes-thumb"
            :src="data.thumbnail_url"
            alt=""
            width="80"
            height="45"
            loading="lazy"
          />
          <span v-else class="title-changes-thumb title-changes-thumb--none" aria-hidden="true" />
        </template>
      </Column>
      <Column header="Change">
        <template #body="{ data }">
          <div class="title-changes-change">
            <span class="title-changes-old" data-test="old-title">{{
              shownTitle(data.old_title)
            }}</span>
            <span class="title-changes-arrow" data-test="arrow" aria-label="changed to">-&gt;</span>
            <VideoLink :video-id="data.video_id" class="title-changes-new">{{
              shownTitle(data.new_title)
            }}</VideoLink>
          </div>
          <div
            v-if="data.title !== null && data.title !== data.new_title"
            class="cellar-muted title-changes-sub"
            data-test="current-title"
          >
            Now: {{ data.title }}
          </div>
        </template>
      </Column>
      <Column header="Channel">
        <template #body="{ data }">
          <span data-test="channel">{{ data.channel_title ?? data.channel_id ?? "-" }}</span>
        </template>
      </Column>
      <Column header="Changed">
        <template #body="{ data }">
          <span
            class="title-changes-when"
            :title="formatAbsolute(data.changed_at)"
            data-test="changed-at"
            >{{ formatRelative(data.changed_at) }}</span
          >
        </template>
      </Column>
    </DataTable>

    <p v-if="loaded && !error && total > 0" class="cellar-note" data-test="title-changes-total">
      {{ pluralize(total, "title change") }}
    </p>
  </section>
</template>

<style scoped>
.title-changes-filters {
  gap: 0.75rem;
}

.title-changes-search {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  color: var(--p-text-muted-color);
}

.title-changes-search :deep(input) {
  min-width: 0;
}

.title-changes-thumb {
  display: block;
  width: 80px;
  height: 45px;
  border-radius: 4px;
  object-fit: cover;
}

.title-changes-thumb--none {
  background: var(--p-content-hover-background);
}

.title-changes-change {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.25rem 0.5rem;
  overflow-wrap: anywhere;
}

.title-changes-old {
  color: var(--p-text-muted-color);
  text-decoration: line-through;
}

.title-changes-arrow {
  color: var(--p-text-muted-color);
  font-family: ui-monospace, "SFMono-Regular", "Cascadia Mono", Menlo, monospace;
}

.title-changes-new {
  color: var(--p-text-color);
  font-weight: 550;
  text-decoration: none;
}

.title-changes-new:hover {
  text-decoration: underline;
}

.title-changes-sub {
  font-size: 0.75rem;
  overflow-wrap: anywhere;
}

.title-changes-when {
  white-space: nowrap;
}

.title-changes-none {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  color: var(--p-text-muted-color);
}

/* Phone width: drop the thumbnail so the change itself gets the room. */
@media (max-width: 640px) {
  .title-changes-table :deep(.title-changes-thumb-col) {
    display: none;
  }

  .title-changes-search,
  .title-changes-channel {
    flex: 1 1 100%;
  }

  .title-changes-search :deep(input),
  .title-changes-channel :deep(.p-autocomplete) {
    flex: 1;
    width: 100%;
  }
}
</style>
