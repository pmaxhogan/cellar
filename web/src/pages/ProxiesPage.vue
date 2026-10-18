<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import Button from "primevue/button";
import Column from "primevue/column";
import DataTable from "primevue/datatable";
import Tag from "primevue/tag";
import type { ProxyRow } from "@cellar/shared";
import { normalizeError, type ApiClientError } from "../api/client.ts";
import { useApi } from "../api/provide.ts";
import {
  deleteProxy,
  describeTest,
  listProxies,
  testProxy,
  updateProxy,
  type ProxyTestResult,
} from "../api/proxies.ts";
import { formatAbsolute, formatRelative } from "../lib/format.ts";
import { useToaster } from "../lib/toast.ts";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import EmptyState from "../components/EmptyState.vue";
import ErrorState from "../components/ErrorState.vue";
import ListSkeleton from "../components/ListSkeleton.vue";
import PageHeader from "../components/PageHeader.vue";
import ProxyFormDialog from "../components/proxies/ProxyFormDialog.vue";

const api = useApi();
const toast = useToaster();

const proxies = ref<ProxyRow[]>([]);
const loading = ref(true);
const loaded = ref(false);
const error = ref<ApiClientError | null>(null);
const busyId = ref<number | null>(null);
const testingId = ref<number | null>(null);
const results = ref<Record<number, ProxyTestResult>>({});

const formVisible = ref(false);
const editing = ref<ProxyRow | null>(null);
const removing = ref<ProxyRow | null>(null);
const removeBusy = ref(false);

let inflight: AbortController | null = null;

async function load(): Promise<void> {
  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;
  loading.value = true;
  try {
    proxies.value = await listProxies(api, controller.signal);
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

onMounted(() => void load());
onBeforeUnmount(() => inflight?.abort());

function replaceRow(row: ProxyRow): void {
  const index = proxies.value.findIndex((candidate) => candidate.id === row.id);
  if (index === -1) proxies.value = [...proxies.value, row];
  else
    proxies.value = proxies.value.map((candidate) => (candidate.id === row.id ? row : candidate));
}

function openCreate(): void {
  editing.value = null;
  formVisible.value = true;
}

function openEdit(proxy: ProxyRow): void {
  editing.value = proxy;
  formVisible.value = true;
}

function onSaved(row: ProxyRow, how: "created" | "updated"): void {
  replaceRow(row);
  // A changed URL makes an older test result meaningless.
  const { [row.id]: _dropped, ...rest } = results.value;
  results.value = rest;
  toast.success(how === "created" ? "Proxy added" : "Proxy saved", row.label);
}

async function toggle(proxy: ProxyRow): Promise<void> {
  busyId.value = proxy.id;
  try {
    const row = await updateProxy(api, proxy.id, { enabled: !proxy.enabled });
    replaceRow(row);
    toast.success(row.enabled ? "Proxy enabled" : "Proxy disabled", row.label);
  } catch (cause) {
    toast.failure("Could not change the proxy", cause);
  } finally {
    busyId.value = null;
  }
}

async function runTest(proxy: ProxyRow): Promise<void> {
  testingId.value = proxy.id;
  try {
    const result = await testProxy(api, proxy.id);
    results.value = { ...results.value, [proxy.id]: result };
    if (result.ok) toast.success(`${proxy.label} works`, describeTest(result));
    else toast.warn(`${proxy.label} failed`, describeTest(result));
  } catch (cause) {
    toast.failure("Could not test the proxy", cause);
  } finally {
    testingId.value = null;
  }
}

async function confirmRemove(): Promise<void> {
  const target = removing.value;
  if (target === null) return;
  removeBusy.value = true;
  try {
    await deleteProxy(api, target.id);
    proxies.value = proxies.value.filter((row) => row.id !== target.id);
    removing.value = null;
    toast.success("Proxy deleted", target.label);
  } catch (cause) {
    toast.failure("Could not delete the proxy", cause);
  } finally {
    removeBusy.value = false;
  }
}

/** Skipped-until only matters while it is in the future. */
function skipText(until: number | null): string {
  if (until === null || until <= Date.now()) return "-";
  return `until ${formatRelative(until)}`;
}
</script>

<template>
  <section class="cellar-stack">
    <PageHeader
      title="Proxies"
      description="Outbound proxies that downloads can be routed through. Rules pick none, the enabled pool round-robin, or specific entries. A failing proxy is skipped for a while."
    >
      <template #actions>
        <Button data-action="add-proxy" label="Add proxy" size="small" @click="openCreate" />
      </template>
    </PageHeader>

    <ListSkeleton v-if="loading && !loaded" label="Loading proxies" />
    <ErrorState v-else-if="error" :error="error" title="Could not load proxies" @retry="load" />
    <EmptyState
      v-else-if="proxies.length === 0"
      icon="proxies"
      title="No proxies"
      description="Downloads connect directly until a proxy is added and a rule routes through it."
    >
      <Button label="Add proxy" size="small" @click="openCreate" />
    </EmptyState>
    <DataTable v-else :value="proxies" data-key="id" size="small" class="proxies-table">
      <Column field="label" header="Label" />
      <Column header="URL">
        <template #body="{ data }">
          <code data-test="url-redacted">{{ data.url_redacted }}</code>
        </template>
      </Column>
      <Column header="Status">
        <template #body="{ data }">
          <Tag
            data-test="enabled"
            :value="data.enabled ? 'Enabled' : 'Disabled'"
            :severity="data.enabled ? 'success' : 'secondary'"
          />
        </template>
      </Column>
      <Column header="Failures">
        <template #body="{ data }">
          <span data-test="fail-count">{{ data.fail_count }}</span>
        </template>
      </Column>
      <Column header="Skipped">
        <template #body="{ data }">
          <span
            data-test="skipped"
            :title="data.skipped_until === null ? undefined : formatAbsolute(data.skipped_until)"
            >{{ skipText(data.skipped_until) }}</span
          >
        </template>
      </Column>
      <Column header="Last test">
        <template #body="{ data }">
          <span
            v-if="results[data.id]"
            data-test="test-result"
            :class="results[data.id]!.ok ? 'proxies-ok' : 'proxies-failed'"
            >{{ describeTest(results[data.id]!) }}</span
          >
          <span v-else class="cellar-muted">-</span>
        </template>
      </Column>
      <Column header="">
        <template #body="{ data }">
          <span class="cellar-row proxies-actions" :data-proxy="data.id">
            <Button
              data-action="test"
              size="small"
              severity="secondary"
              label="Test"
              :loading="testingId === data.id"
              @click="runTest(data)"
            />
            <Button
              data-action="edit"
              size="small"
              severity="secondary"
              text
              label="Edit"
              @click="openEdit(data)"
            />
            <Button
              data-action="toggle"
              size="small"
              severity="secondary"
              text
              :label="data.enabled ? 'Disable' : 'Enable'"
              :loading="busyId === data.id"
              @click="toggle(data)"
            />
            <Button
              data-action="remove"
              size="small"
              severity="danger"
              text
              label="Delete"
              @click="removing = data"
            />
          </span>
        </template>
      </Column>
    </DataTable>

    <ProxyFormDialog v-model:visible="formVisible" :proxy="editing" @saved="onSaved" />
    <ConfirmDialog
      :visible="removing !== null"
      title="Delete proxy?"
      :message="`Delete ${removing?.label ?? 'this proxy'}? Rules that name it stop routing through it.`"
      confirm-label="Delete"
      danger
      :busy="removeBusy"
      @update:visible="!$event && (removing = null)"
      @confirm="confirmRemove"
    />
  </section>
</template>

<style scoped>
.proxies-actions {
  gap: 0.25rem;
  flex-wrap: nowrap;
}

.proxies-ok {
  color: var(--cellar-success);
}

.proxies-failed {
  color: var(--cellar-error);
}
</style>
