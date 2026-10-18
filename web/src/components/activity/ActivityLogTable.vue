<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import Button from "primevue/button";
import Column from "primevue/column";
import DataTable from "primevue/datatable";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import Tag from "primevue/tag";
import { normalizeError, type ApiClientError } from "../../api/client.ts";
import { useApi } from "../../api/provide.ts";
import {
  ACTIVITY_LEVELS,
  ActivityRowSchema,
  listActivity,
  matchesActivityQuery,
  type ActivityLevel,
  type ActivityQuery,
  type ActivityRow,
} from "../../api/activity.ts";
import type { CellarEvent } from "../../api/types.ts";
import { formatAbsolute, formatRelative, pluralize } from "../../lib/format.ts";
import { useEventsStore } from "../../stores/events.ts";
import EmptyState from "../EmptyState.vue";
import ErrorState from "../ErrorState.vue";
import ListSkeleton from "../ListSkeleton.vue";

/** The activity log: lazy, server-paged, filterable, live on page one. */
const emit = defineEmits<{ "open-job": [id: number] }>();

const api = useApi();
const events = useEventsStore();

const rows = ref<ActivityRow[]>([]);
const total = ref(0);
const page = ref(1);
const perPage = ref(25);
const loading = ref(false);
const error = ref<ApiClientError | null>(null);

const level = ref<ActivityLevel | null>(null);
const kind = ref("");
const pendingNew = ref(0);

const levelOptions = [
  { label: "Any level", value: null },
  ...ACTIVITY_LEVELS.map((value) => ({ label: value, value })),
];

const hasFilters = computed(() => level.value !== null || kind.value.trim() !== "");

function query(): ActivityQuery {
  const trimmed = kind.value.trim();
  return { level: level.value, kind: trimmed === "" ? null : trimmed };
}

let inflight: AbortController | null = null;

async function load(): Promise<void> {
  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;
  loading.value = true;
  try {
    const result = await listActivity(
      api,
      { ...query(), page: page.value, perPage: perPage.value },
      controller.signal,
    );
    rows.value = result.rows;
    total.value = result.total;
    error.value = null;
    pendingNew.value = 0;
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

let kindTimer: ReturnType<typeof setTimeout> | null = null;
watch(kind, () => {
  if (kindTimer !== null) clearTimeout(kindTimer);
  kindTimer = setTimeout(() => {
    kindTimer = null;
    page.value = 1;
    void load();
  }, 300);
});

watch(level, () => {
  page.value = 1;
  void load();
});

function resetFilters(): void {
  level.value = null;
  kind.value = "";
}

function onPage(event: { page: number; rows: number }): void {
  page.value = event.page + 1;
  perPage.value = event.rows;
  void load();
}

function showNewest(): void {
  page.value = 1;
  void load();
}

function handleEvent(event: CellarEvent): void {
  if (event.type !== "activity") return;
  const parsed = ActivityRowSchema.safeParse(event.payload);
  if (!parsed.success) return;
  const row = parsed.data;
  if (!matchesActivityQuery(row, query())) return;
  if (page.value !== 1) {
    pendingNew.value += 1;
    return;
  }
  if (rows.value.some((existing) => existing.id === row.id)) return;
  rows.value = [row, ...rows.value].slice(0, perPage.value);
  total.value += 1;
}

type Severity = "secondary" | "info" | "warn" | "danger";
const LEVEL_SEVERITY: Record<ActivityLevel, Severity> = {
  debug: "secondary",
  info: "info",
  warn: "warn",
  error: "danger",
};

let offEvents: (() => void) | null = null;

onMounted(() => {
  void load();
  offEvents = events.on(handleEvent);
});

onBeforeUnmount(() => {
  inflight?.abort();
  offEvents?.();
  if (kindTimer !== null) clearTimeout(kindTimer);
});

defineExpose({ load });
</script>

<template>
  <div class="activity-log">
    <div class="activity-filters" role="search">
      <div class="cellar-field">
        <label for="activity-level">Level</label>
        <Select
          v-model="level"
          input-id="activity-level"
          placeholder="Any level"
          :options="levelOptions"
          option-label="label"
          option-value="value"
        />
      </div>
      <div class="cellar-field">
        <label for="activity-kind">Kind</label>
        <InputText
          id="activity-kind"
          v-model="kind"
          placeholder="e.g. download"
          autocomplete="off"
        />
      </div>
      <Button
        v-if="hasFilters"
        label="Reset"
        severity="secondary"
        text
        size="small"
        @click="resetFilters"
      />
    </div>

    <div v-if="pendingNew > 0" class="activity-stale" role="status" data-pending>
      <span>{{ pluralize(pendingNew, "new event") }} since this page loaded.</span>
      <Button label="Show newest" size="small" severity="secondary" text @click="showNewest" />
    </div>

    <ErrorState :error="error" title="Could not load the activity log" @retry="load" />

    <DataTable
      v-if="error === null"
      :value="rows"
      data-key="id"
      lazy
      paginator
      :rows="perPage"
      :rows-per-page-options="[25, 50, 100, 200]"
      :total-records="total"
      :loading="loading"
      size="small"
      striped-rows
      class="activity-table"
      current-page-report-template="{first} to {last} of {totalRecords}"
      paginator-template="FirstPageLink PrevPageLink PageLinks NextPageLink LastPageLink RowsPerPageDropdown CurrentPageReport"
      @page="onPage"
    >
      <template #empty>
        <EmptyState
          v-if="!loading && hasFilters"
          icon="search"
          title="No events match these filters"
          description="Try a broader filter, or reset the filters."
        >
          <Button label="Reset filters" size="small" severity="secondary" @click="resetFilters" />
        </EmptyState>
        <EmptyState
          v-else-if="!loading"
          icon="activity"
          title="No activity yet"
          description="Events appear here as soon as the scheduler starts work."
        />
        <ListSkeleton v-else :rows="5" label="Loading activity" />
      </template>

      <Column header="When">
        <template #body="{ data }">
          <span :title="formatAbsolute(data.at)" class="activity-when">
            {{ formatRelative(data.at) }}
          </span>
        </template>
      </Column>
      <Column header="Level">
        <template #body="{ data }">
          <Tag :value="data.level" :severity="LEVEL_SEVERITY[data.level as ActivityLevel]" />
        </template>
      </Column>
      <Column header="Kind">
        <template #body="{ data }">
          <span class="mono activity-kind">{{ data.kind }}</span>
        </template>
      </Column>
      <Column header="Message">
        <template #body="{ data }">
          <span class="activity-message" :data-activity="data.id">{{ data.message }}</span>
        </template>
      </Column>
      <Column header="Links">
        <template #body="{ data }">
          <div class="activity-links">
            <RouterLink
              v-if="data.video_id !== null"
              :to="`/videos/${encodeURIComponent(data.video_id)}`"
              class="mono"
            >
              {{ data.video_id }}
            </RouterLink>
            <Button
              v-if="data.job_id !== null"
              :label="`Job #${data.job_id}`"
              size="small"
              text
              :data-open-job="data.job_id"
              @click="emit('open-job', data.job_id)"
            />
          </div>
        </template>
      </Column>
    </DataTable>
  </div>
</template>

<style scoped>
.activity-filters {
  display: flex;
  gap: 0.75rem;
  align-items: flex-end;
  flex-wrap: wrap;
  margin-bottom: 0.9rem;
}

.activity-stale {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  margin-bottom: 0.75rem;
  border-radius: 8px;
  border: 1px solid var(--p-content-border-color);
  background: var(--p-content-background);
  font-size: 0.87rem;
}

.activity-when {
  white-space: nowrap;
  color: var(--p-text-muted-color);
}

.activity-kind {
  font-size: 0.82rem;
}

.activity-message {
  overflow-wrap: anywhere;
}

.activity-links {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
}

.activity-links a {
  color: var(--p-primary-color);
  text-decoration: none;
}
</style>
