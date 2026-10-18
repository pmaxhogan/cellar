<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import Button from "primevue/button";
import ProgressSpinner from "primevue/progressspinner";
import Tag from "primevue/tag";
import { normalizeError, type ApiClientError } from "../api/client.ts";
import { useApi } from "../api/provide.ts";
import {
  failingCount,
  latestCheck,
  listChecks,
  runCheck,
  warningCount,
  type CheckRow,
} from "../api/checks.ts";
import { formatAbsolute, formatRelative, pluralize } from "../lib/format.ts";
import { useToaster } from "../lib/toast.ts";
import EmptyState from "../components/EmptyState.vue";
import ErrorState from "../components/ErrorState.vue";
import ListSkeleton from "../components/ListSkeleton.vue";
import PageHeader from "../components/PageHeader.vue";
import CheckGrid from "../components/selfcheck/CheckGrid.vue";
import CheckHistoryTable from "../components/selfcheck/CheckHistoryTable.vue";

const HISTORY_LIMIT = 30;

const api = useApi();
const toast = useToaster();

const latest = ref<CheckRow | null>(null);
/** A past run picked from the history; null shows the latest. */
const viewing = ref<CheckRow | null>(null);
const history = ref<CheckRow[]>([]);
const loading = ref(false);
const loaded = ref(false);
const error = ref<ApiClientError | null>(null);
const historyError = ref<ApiClientError | null>(null);
const running = ref(false);

const shown = computed(() => viewing.value ?? latest.value);

async function loadLatest(): Promise<void> {
  try {
    latest.value = (await latestCheck(api)) ?? null;
    error.value = null;
  } catch (cause) {
    const normalized = normalizeError(cause);
    // 404 means no run has been recorded yet: an empty state, not an error.
    if (normalized.status === 404) {
      latest.value = null;
      error.value = null;
    } else {
      error.value = normalized;
    }
  }
}

async function loadHistory(): Promise<void> {
  try {
    history.value = await listChecks(api, HISTORY_LIMIT);
    historyError.value = null;
  } catch (cause) {
    historyError.value = normalizeError(cause);
  }
}

async function load(): Promise<void> {
  loading.value = true;
  await Promise.all([loadLatest(), loadHistory()]);
  loading.value = false;
  loaded.value = true;
}

async function runNow(): Promise<void> {
  running.value = true;
  try {
    const row = await runCheck(api);
    latest.value = row;
    viewing.value = null;
    error.value = null;
    history.value = [row, ...history.value.filter((past) => past.id !== row.id)].slice(
      0,
      HISTORY_LIMIT,
    );
    const failing = failingCount(row);
    if (failing === 0) toast.success("Self-check passed");
    else toast.warn("Self-check found problems", `${pluralize(failing, "check")} failing`);
  } catch (cause) {
    toast.failure("The self-check could not run", cause);
  } finally {
    running.value = false;
  }
}

function summaryLabel(row: CheckRow): string {
  if (row.ok) return "all checks ok";
  const failing = failingCount(row);
  return failing === 0 ? "problems found" : `${pluralize(failing, "check")} failing`;
}

function select(row: CheckRow): void {
  viewing.value = latest.value !== null && row.id === latest.value.id ? null : row;
}

onMounted(() => {
  void load();
});
</script>

<template>
  <section class="selfcheck-page">
    <PageHeader
      title="Self-check"
      description="Checks that the tools, storage, accounts and access rules all work."
    >
      <template #actions>
        <Button
          label="Run self-check now"
          size="small"
          :loading="running"
          :disabled="running"
          data-action="run"
          @click="runNow"
        />
      </template>
    </PageHeader>

    <ErrorState :error="error" title="Could not load the latest self-check" @retry="load" />

    <template v-if="error === null">
      <div v-if="running" class="selfcheck-running" role="status" data-running>
        <ProgressSpinner style="width: 1.6rem; height: 1.6rem" stroke-width="5" />
        <span>Running every check. This can take a minute.</span>
      </div>
      <ListSkeleton v-else-if="!loaded" :rows="4" label="Loading the self-check" />
      <EmptyState
        v-else-if="shown === null"
        icon="selfcheck"
        title="No checks have run"
        description="The self-check runs at boot and once a day. Run it now to see the status grid."
      />
      <template v-else>
        <div class="selfcheck-summary" data-summary>
          <Tag :value="summaryLabel(shown)" :severity="shown.ok ? 'success' : 'danger'" />
          <span v-if="warningCount(shown) > 0" class="cellar-muted">
            {{ pluralize(warningCount(shown), "warning") }}
          </span>
          <span class="cellar-muted" :title="formatAbsolute(shown.run_at)">
            Ran {{ formatRelative(shown.run_at) }} ({{ shown.trigger }})
          </span>
          <Button
            v-if="viewing !== null"
            label="Back to latest"
            size="small"
            severity="secondary"
            text
            data-action="latest"
            @click="viewing = null"
          />
        </div>
        <p v-if="viewing !== null" class="cellar-note selfcheck-past" data-viewing-past>
          Showing a past run, not the latest.
        </p>
        <CheckGrid :row="shown" />
      </template>
    </template>

    <section class="selfcheck-history" aria-labelledby="selfcheck-history-heading">
      <h2 id="selfcheck-history-heading">History</h2>
      <p v-if="historyError" class="cellar-note">{{ historyError.message }}</p>
      <CheckHistoryTable
        v-else
        :rows="history"
        :selected-id="shown?.id ?? null"
        :loading="loading"
        @select="select"
      />
    </section>
  </section>
</template>

<style scoped>
.selfcheck-running {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 1.5rem 0;
  color: var(--p-text-muted-color);
}

.selfcheck-summary {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-bottom: 0.9rem;
  font-size: 0.88rem;
}

.selfcheck-past {
  margin: -0.4rem 0 0.9rem;
}

.selfcheck-history {
  margin-top: 2rem;
}

.selfcheck-history h2 {
  margin: 0 0 0.6rem;
  font-size: 1rem;
}
</style>
