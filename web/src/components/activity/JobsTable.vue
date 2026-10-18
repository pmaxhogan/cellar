<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import Button from "primevue/button";
import Column from "primevue/column";
import DataTable from "primevue/datatable";
import ProgressBar from "primevue/progressbar";
import Select from "primevue/select";
import Tag from "primevue/tag";
import { normalizeError, type ApiClientError } from "../../api/client.ts";
import { useApi } from "../../api/provide.ts";
import {
  JOB_STATUSES,
  JOB_TYPES,
  canCancel,
  canRetry,
  cancelJob,
  getJob,
  listJobs,
  readJobEvent,
  retryJob,
  type JobRow,
  type JobStatus,
} from "../../api/jobs.ts";
import type { CellarEvent } from "../../api/types.ts";
import { formatAbsolute, formatDuration, formatRelative, pluralize } from "../../lib/format.ts";
import { useToaster } from "../../lib/toast.ts";
import { useEventsStore } from "../../stores/events.ts";
import EmptyState from "../EmptyState.vue";
import ErrorState from "../ErrorState.vue";
import ListSkeleton from "../ListSkeleton.vue";

/**
 * The jobs table: lazy, server-paged, filterable. Rows on screen are patched
 * in place from `job.*` events (status, progress); a row that finishes is
 * refetched once for its timestamps and error. New jobs only raise a banner,
 * so a burst of queued downloads does not turn into a refetch storm.
 */
const emit = defineEmits<{ open: [job: JobRow] }>();

const api = useApi();
const toast = useToaster();
const events = useEventsStore();

const rows = ref<JobRow[]>([]);
const total = ref(0);
const page = ref(1);
const perPage = ref(25);
const loading = ref(false);
const error = ref<ApiClientError | null>(null);

const status = ref<JobStatus | null>(null);
const type = ref<string | null>(null);
const pendingNew = ref(0);
/** Live progress (0..100) by job id; absent means none reported yet. */
const progress = ref<Map<number, number>>(new Map());
const busy = ref<Set<number>>(new Set());

const statusOptions = [
  { label: "Any status", value: null },
  ...JOB_STATUSES.map((value) => ({ label: value, value })),
];
const typeOptions = [
  { label: "Any type", value: null },
  ...JOB_TYPES.map((value) => ({ label: value, value })),
];

const hasFilters = computed(() => status.value !== null || type.value !== null);

let inflight: AbortController | null = null;

async function load(): Promise<void> {
  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;
  loading.value = true;
  try {
    const result = await listJobs(
      api,
      { page: page.value, perPage: perPage.value, status: status.value, type: type.value },
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

watch([status, type], () => {
  page.value = 1;
  void load();
});

function resetFilters(): void {
  status.value = null;
  type.value = null;
}

function onPage(event: { page: number; rows: number }): void {
  page.value = event.page + 1;
  perPage.value = event.rows;
  void load();
}

function mergeRow(fresh: JobRow): void {
  const index = rows.value.findIndex((row) => row.id === fresh.id);
  if (index === -1) return;
  const next = [...rows.value];
  next[index] = fresh;
  rows.value = next;
}

function patchRow(id: number, patch: Partial<JobRow>): void {
  const current = rows.value.find((row) => row.id === id);
  if (current !== undefined) mergeRow({ ...current, ...patch });
}

function setProgress(id: number, value: number | null): void {
  const next = new Map(progress.value);
  if (value === null) next.delete(id);
  else next.set(id, value);
  progress.value = next;
}

const pendingRefresh = new Set<number>();
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function queueRowRefresh(id: number): void {
  pendingRefresh.add(id);
  if (refreshTimer !== null) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    const ids = [...pendingRefresh];
    pendingRefresh.clear();
    void Promise.all(ids.map((jobId) => refreshRow(jobId)));
  }, 400);
}

async function refreshRow(id: number): Promise<void> {
  try {
    mergeRow(await getJob(api, id));
  } catch {
    // A row that cannot be refreshed keeps its last known values.
  }
}

const TERMINAL: ReadonlySet<JobStatus> = new Set(["done", "failed", "cancelled"]);

function handleEvent(event: CellarEvent): void {
  const update = readJobEvent(event.type, event.payload);
  if (update === null) return;
  const onScreen = rows.value.some((row) => row.id === update.id);
  if (!onScreen) {
    if (event.type === "job.queued") pendingNew.value += 1;
    return;
  }
  if (update.row !== null) mergeRow(update.row);
  else if (update.status !== null) patchRow(update.id, { status: update.status });

  if (update.status !== null && TERMINAL.has(update.status)) {
    setProgress(update.id, null);
    queueRowRefresh(update.id);
  } else if (update.progress !== null) {
    setProgress(update.id, update.progress);
  } else if (event.type === "job.started") {
    queueRowRefresh(update.id);
  }
}

function setBusy(id: number, on: boolean): void {
  const next = new Set(busy.value);
  if (on) next.add(id);
  else next.delete(id);
  busy.value = next;
}

async function act(job: JobRow, action: "cancel" | "retry"): Promise<void> {
  setBusy(job.id, true);
  try {
    if (action === "cancel") await cancelJob(api, job.id);
    else await retryJob(api, job.id);
    toast.success(action === "cancel" ? `Cancelled job #${job.id}` : `Retrying job #${job.id}`);
    await refreshRow(job.id);
    if (action === "retry") setProgress(job.id, null);
  } catch (cause) {
    toast.failure(
      action === "cancel" ? "Could not cancel the job" : "Could not retry the job",
      cause,
    );
  } finally {
    setBusy(job.id, false);
  }
}

type Severity = "secondary" | "info" | "success" | "danger" | "warn";
const STATUS_SEVERITY: Record<JobStatus, Severity> = {
  queued: "secondary",
  running: "info",
  done: "success",
  failed: "danger",
  cancelled: "warn",
};

function runtime(job: JobRow): string {
  if (job.started_at === null) return "-";
  const end = job.finished_at ?? Date.now();
  return formatDuration(Math.max(0, (end - job.started_at) / 1000));
}

let offEvents: (() => void) | null = null;

onMounted(() => {
  void load();
  offEvents = events.on(handleEvent);
});

onBeforeUnmount(() => {
  inflight?.abort();
  offEvents?.();
  if (refreshTimer !== null) clearTimeout(refreshTimer);
});

defineExpose({ load, refreshRow });
</script>

<template>
  <div class="jobs">
    <div class="jobs-filters" role="search">
      <div class="cellar-field">
        <label for="jobs-status">Status</label>
        <Select
          v-model="status"
          input-id="jobs-status"
          placeholder="Any status"
          :options="statusOptions"
          option-label="label"
          option-value="value"
        />
      </div>
      <div class="cellar-field">
        <label for="jobs-type">Type</label>
        <Select
          v-model="type"
          input-id="jobs-type"
          placeholder="Any type"
          :options="typeOptions"
          option-label="label"
          option-value="value"
          filter
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

    <div v-if="pendingNew > 0" class="jobs-stale" role="status" data-pending>
      <span>{{ pluralize(pendingNew, "new job") }} queued since this page loaded.</span>
      <Button label="Refresh" size="small" severity="secondary" text @click="load" />
    </div>

    <ErrorState :error="error" title="Could not load the jobs" @retry="load" />

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
      row-hover
      class="jobs-table"
      current-page-report-template="{first} to {last} of {totalRecords}"
      paginator-template="FirstPageLink PrevPageLink PageLinks NextPageLink LastPageLink RowsPerPageDropdown CurrentPageReport"
      @page="onPage"
      @row-click="emit('open', $event.data)"
    >
      <template #empty>
        <EmptyState
          v-if="!loading && hasFilters"
          icon="search"
          title="No jobs match these filters"
          description="Try a broader filter, or reset the filters."
        >
          <Button label="Reset filters" size="small" severity="secondary" @click="resetFilters" />
        </EmptyState>
        <EmptyState
          v-else-if="!loading"
          icon="activity"
          title="No jobs yet"
          description="Jobs appear here as soon as the scheduler starts work."
        />
        <ListSkeleton v-else :rows="5" label="Loading jobs" />
      </template>

      <Column header="Job">
        <template #body="{ data }">
          <div class="job-cell" :data-job="data.id">
            <span class="mono">#{{ data.id }}</span>
            <span class="job-cell__type mono">{{ data.type }}</span>
          </div>
        </template>
      </Column>
      <Column header="Status">
        <template #body="{ data }">
          <div class="job-status">
            <Tag
              :value="data.status"
              :severity="STATUS_SEVERITY[data.status as JobStatus]"
              data-job-status
            />
            <ProgressBar
              v-if="data.status === 'running'"
              :value="progress.get(data.id) ?? 0"
              :mode="progress.has(data.id) ? 'determinate' : 'indeterminate'"
              :show-value="false"
              class="job-progress"
              :aria-label="`Job ${data.id} progress`"
              :data-progress="progress.get(data.id)"
            />
          </div>
        </template>
      </Column>
      <Column header="Attempts">
        <template #body="{ data }">{{ data.attempts }} / {{ data.max_attempts }}</template>
      </Column>
      <Column header="Video">
        <template #body="{ data }">
          <RouterLink
            v-if="data.video_id !== null"
            :to="`/videos/${encodeURIComponent(data.video_id)}`"
            class="mono job-link"
            @click.stop
          >
            {{ data.video_id }}
          </RouterLink>
          <span v-else class="cellar-muted">-</span>
        </template>
      </Column>
      <Column header="Created">
        <template #body="{ data }">
          <span :title="formatAbsolute(data.created_at)">{{
            formatRelative(data.created_at)
          }}</span>
        </template>
      </Column>
      <Column header="Runtime">
        <template #body="{ data }">{{ runtime(data) }}</template>
      </Column>
      <Column header="Error">
        <template #body="{ data }">
          <span v-if="data.error" class="job-error" :title="data.error">{{ data.error }}</span>
        </template>
      </Column>
      <Column header="" class="job-actions-column">
        <template #body="{ data }">
          <div class="job-actions">
            <Button
              v-if="canCancel(data)"
              label="Cancel"
              size="small"
              severity="secondary"
              outlined
              :loading="busy.has(data.id)"
              :disabled="busy.has(data.id)"
              data-job-action="cancel"
              @click.stop="act(data, 'cancel')"
            />
            <Button
              v-if="canRetry(data)"
              label="Retry"
              size="small"
              severity="secondary"
              outlined
              :loading="busy.has(data.id)"
              :disabled="busy.has(data.id)"
              data-job-action="retry"
              @click.stop="act(data, 'retry')"
            />
          </div>
        </template>
      </Column>
    </DataTable>
  </div>
</template>

<style scoped>
.jobs-filters {
  display: flex;
  gap: 0.75rem;
  align-items: flex-end;
  flex-wrap: wrap;
  margin-bottom: 0.9rem;
}

.jobs-stale {
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

.jobs-table :deep(tbody tr) {
  cursor: pointer;
}

.job-cell {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.job-cell__type {
  font-size: 0.78rem;
  color: var(--p-text-muted-color);
}

.job-status {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  min-width: 6rem;
}

.job-progress {
  height: 0.35rem;
}

.job-link {
  color: var(--p-primary-color);
  text-decoration: none;
}

.job-error {
  display: inline-block;
  max-width: 22rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--cellar-error);
  font-size: 0.85rem;
}

.job-actions {
  display: flex;
  gap: 0.4rem;
  justify-content: flex-end;
}
</style>
