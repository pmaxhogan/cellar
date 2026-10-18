<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Button from "primevue/button";
import Column from "primevue/column";
import DataTable from "primevue/datatable";
import InputText from "primevue/inputtext";
import SelectButton from "primevue/selectbutton";
import Tag from "primevue/tag";
import type { ChannelRow } from "@cellar/shared";
import {
  channelUrl,
  deleteChannel,
  listChannels,
  type ChannelKindFilter,
} from "../api/channels.ts";
import { normalizeError, type ApiClientError } from "../api/client.ts";
import { useApi } from "../api/provide.ts";
import { formatNumber, pluralize } from "../lib/format.ts";
import { useToaster } from "../lib/toast.ts";
import AddChannelDialog from "../components/channels/AddChannelDialog.vue";
import AppIcon from "../components/AppIcon.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import EmptyState from "../components/EmptyState.vue";
import ErrorState from "../components/ErrorState.vue";
import PageHeader from "../components/PageHeader.vue";

const api = useApi();
const toast = useToaster();

const rows = ref<ChannelRow[]>([]);
const total = ref(0);
const loading = ref(false);
const loaded = ref(false);
const error = ref<ApiClientError | null>(null);

const page = ref(1);
const perPage = ref(25);
const q = ref("");
const kind = ref<ChannelKindFilter>("all");

const addVisible = ref(false);
const removing = ref<ChannelRow | null>(null);
const removeBusy = ref(false);

const KIND_OPTIONS: { label: string; value: ChannelKindFilter }[] = [
  { label: "All", value: "all" },
  { label: "Subscribed", value: "subscribed" },
  { label: "Manual", value: "manual" },
];

const filtered = computed(() => q.value.trim() !== "" || kind.value !== "all");
const first = computed(() => (page.value - 1) * perPage.value);

let inflight: AbortController | null = null;

async function load(): Promise<void> {
  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;
  loading.value = true;
  try {
    const result = await listChannels(
      api,
      { q: q.value, page: page.value, perPage: perPage.value, kind: kind.value },
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

watch(kind, () => {
  page.value = 1;
  void load();
});

function onPage(event: { page: number; rows: number }): void {
  page.value = event.page + 1;
  perPage.value = event.rows;
  void load();
}

function resetFilters(): void {
  q.value = "";
  cancelSearchTimer();
  kind.value = "all";
  page.value = 1;
  void load();
}

onMounted(() => void load());
onBeforeUnmount(() => {
  cancelSearchTimer();
  inflight?.abort();
});

function onAdded(row: ChannelRow): void {
  toast.success("Channel added", row.title ?? row.handle ?? row.id);
  void load();
}

async function confirmRemove(): Promise<void> {
  const target = removing.value;
  if (target === null) return;
  removeBusy.value = true;
  try {
    await deleteChannel(api, target.id);
    removing.value = null;
    toast.success("Channel removed", target.title ?? target.id);
    void load();
  } catch (cause) {
    toast.failure("Could not remove the channel", cause);
  } finally {
    removeBusy.value = false;
  }
}

/** Handles are stored with or without the leading @; always show one. */
function formatHandle(handle: string | null): string {
  if (handle === null || handle === "") return "-";
  return handle.startsWith("@") ? handle : `@${handle}`;
}

function displayName(row: ChannelRow): string {
  return row.title ?? row.handle ?? row.id;
}
</script>

<template>
  <section class="cellar-stack">
    <PageHeader
      title="Channels"
      description="Channels your accounts subscribe to, plus channels added by hand. Their new uploads are polled and fed to the rules."
    >
      <template #actions>
        <Button
          data-action="add-channel"
          label="Add channel"
          size="small"
          @click="addVisible = true"
        />
      </template>
    </PageHeader>

    <div class="cellar-row channels-filters">
      <span class="channels-search">
        <AppIcon name="search" :size="16" />
        <InputText
          v-model="q"
          data-test="channel-search"
          placeholder="Search title or handle"
          aria-label="Search channels"
          @keyup.enter="searchNow"
        />
      </span>
      <SelectButton
        v-model="kind"
        :options="KIND_OPTIONS"
        option-label="label"
        option-value="value"
        :allow-empty="false"
        aria-label="Channel kind"
        data-test="channel-kind"
      />
    </div>

    <ErrorState v-if="error" :error="error" title="Could not load channels" @retry="load" />
    <EmptyState
      v-else-if="loaded && total === 0 && !filtered"
      icon="channels"
      title="No channels yet"
      description="Subscriptions are imported once an account is linked. Add a channel by hand to follow one no account subscribes to."
    >
      <Button label="Add channel" size="small" @click="addVisible = true" />
    </EmptyState>
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
      class="channels-table"
      @page="onPage"
    >
      <template #empty>
        <div class="channels-none" data-test="no-matches">
          No channels match these filters.
          <Button label="Clear filters" size="small" text @click="resetFilters" />
        </div>
      </template>
      <Column header="" class="channels-thumb-col">
        <template #body="{ data }">
          <img
            v-if="data.thumbnail_url"
            class="channels-thumb"
            :src="data.thumbnail_url"
            alt=""
            width="36"
            height="36"
            loading="lazy"
            referrerpolicy="no-referrer"
          />
          <span v-else class="channels-thumb channels-thumb--none" aria-hidden="true" />
        </template>
      </Column>
      <Column header="Channel">
        <template #body="{ data }">
          <a
            :href="channelUrl(data.id)"
            target="_blank"
            rel="noopener noreferrer"
            class="channels-title"
            :data-channel="data.id"
            >{{ displayName(data) }}</a
          >
          <div class="cellar-muted channels-id">{{ data.id }}</div>
        </template>
      </Column>
      <Column header="Handle">
        <template #body="{ data }">
          <span data-test="handle">{{ formatHandle(data.handle) }}</span>
        </template>
      </Column>
      <Column header="Videos">
        <template #body="{ data }">{{ formatNumber(data.video_count) }}</template>
      </Column>
      <Column header="Source">
        <template #body="{ data }">
          <span class="cellar-row channels-tags">
            <Tag v-if="data.subscribed" value="Subscribed" severity="success" />
            <Tag v-if="data.manual" value="Manual" severity="info" />
          </span>
        </template>
      </Column>
      <Column header="" class="channels-actions-col">
        <template #body="{ data }">
          <Button
            v-if="data.manual"
            data-action="remove-channel"
            size="small"
            severity="danger"
            text
            :aria-label="`Remove ${displayName(data)}`"
            @click="removing = data"
          >
            <AppIcon name="trash" :size="16" />
          </Button>
        </template>
      </Column>
    </DataTable>

    <p v-if="loaded && !error && total > 0" class="cellar-note" data-test="channel-total">
      {{ pluralize(total, "channel") }}
    </p>

    <AddChannelDialog v-model:visible="addVisible" @added="onAdded" />
    <ConfirmDialog
      :visible="removing !== null"
      title="Remove channel?"
      :message="`Remove ${removing ? displayName(removing) : 'this channel'} from the manual list? Its uploads stop being polled unless an account subscribes to it.`"
      confirm-label="Remove"
      danger
      :busy="removeBusy"
      @update:visible="!$event && (removing = null)"
      @confirm="confirmRemove"
    />
  </section>
</template>

<style scoped>
.channels-filters {
  justify-content: space-between;
}

.channels-search {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--p-text-muted-color);
}

.channels-thumb {
  display: block;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  object-fit: cover;
}

.channels-thumb--none {
  background: var(--p-content-hover-background);
}

.channels-title {
  color: var(--p-text-color);
  font-weight: 550;
  text-decoration: none;
}

.channels-title:hover {
  text-decoration: underline;
}

.channels-id {
  font-size: 0.75rem;
  font-family: ui-monospace, "SFMono-Regular", "Cascadia Mono", Menlo, monospace;
}

.channels-tags {
  gap: 0.3rem;
}

.channels-none {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--p-text-muted-color);
}
</style>
