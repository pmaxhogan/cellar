<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Button from "primevue/button";
import Column from "primevue/column";
import DataTable from "primevue/datatable";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import Tag from "primevue/tag";
import type { ShareLinkRow, ShareSort, ShareStatus } from "@cellar/shared";
import { normalizeError, type ApiClientError } from "../api/client.ts";
import { useApi } from "../api/provide.ts";
import {
  deleteShare,
  listShares,
  revokeShare,
  revokeShares,
  STATUS_LABEL,
  STATUS_SEVERITY,
} from "../api/shares.ts";
import { formatAbsolute, formatNumber, formatRelative, pluralize } from "../lib/format.ts";
import { useToaster } from "../lib/toast.ts";
import AppIcon from "../components/AppIcon.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import EmptyState from "../components/EmptyState.vue";
import ErrorState from "../components/ErrorState.vue";
import PageHeader from "../components/PageHeader.vue";
import CreateShareDialog from "../components/shares/CreateShareDialog.vue";
import VideoLink from "../components/shares/VideoLink.vue";
import { copyText } from "../components/shares/clipboard.ts";

const api = useApi();
const toast = useToaster();

const rows = ref<ShareLinkRow[]>([]);
const total = ref(0);
const loading = ref(false);
const loaded = ref(false);
const error = ref<ApiClientError | null>(null);

const page = ref(1);
const perPage = ref(25);
const q = ref("");
const status = ref<ShareStatus | "all">("all");
const sort = ref<ShareSort>("created_at");
const dir = ref<"asc" | "desc">("desc");
const selection = ref<ShareLinkRow[]>([]);

const createVisible = ref(false);

interface PendingAction {
  title: string;
  message: string;
  confirmLabel: string;
  run: () => Promise<string>;
}
const pending = ref<PendingAction | null>(null);
const pendingBusy = ref(false);

const STATUS_OPTIONS: { label: string; value: ShareStatus | "all" }[] = [
  { label: "All statuses", value: "all" },
  { label: "Active", value: "active" },
  { label: "Expired", value: "expired" },
  { label: "Revoked", value: "revoked" },
];

const SORTABLE: readonly ShareSort[] = [
  "created_at",
  "expires_at",
  "access_count",
  "last_access_at",
];

const filtered = computed(() => q.value.trim() !== "" || status.value !== "all");
const first = computed(() => (page.value - 1) * perPage.value);
const selectedActive = computed(() => selection.value.filter((row) => row.status !== "revoked"));
const filter = computed(() => ({
  ...(q.value.trim() === "" ? {} : { q: q.value.trim() }),
  ...(status.value === "all" ? {} : { status: status.value }),
}));

let inflight: AbortController | null = null;

async function load(): Promise<void> {
  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;
  loading.value = true;
  try {
    const result = await listShares(
      api,
      {
        page: page.value,
        perPage: perPage.value,
        ...filter.value,
        sort: sort.value,
        dir: dir.value,
      },
      controller.signal,
    );
    rows.value = result.rows;
    total.value = result.total;
    // Keep the selection to rows still on screen, with their fresh state.
    const fresh = new Map(result.rows.map((row) => [row.token, row]));
    selection.value = selection.value.flatMap((row) => {
      const next = fresh.get(row.token);
      return next === undefined ? [] : [next];
    });
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

watch(status, () => {
  page.value = 1;
  void load();
});

function onPage(event: { page: number; rows: number }): void {
  page.value = event.page + 1;
  perPage.value = event.rows;
  void load();
}

function onSort(event: { sortField?: unknown; sortOrder?: number | null }): void {
  const field = typeof event.sortField === "string" ? event.sortField : "";
  sort.value = (SORTABLE as readonly string[]).includes(field)
    ? (field as ShareSort)
    : "created_at";
  dir.value = event.sortOrder === 1 ? "asc" : "desc";
  page.value = 1;
  void load();
}

function resetFilters(): void {
  q.value = "";
  cancelSearchTimer();
  status.value = "all";
  page.value = 1;
  void load();
}

onMounted(() => void load());
onBeforeUnmount(() => {
  cancelSearchTimer();
  inflight?.abort();
});

function displayTitle(row: ShareLinkRow): string {
  return row.title ?? row.video_id;
}

function shortToken(token: string): string {
  return `${token.slice(0, 8)}...`;
}

async function copyUrl(row: ShareLinkRow): Promise<void> {
  if (await copyText(row.url)) {
    toast.success("Link copied", row.url);
  } else {
    toast.warn("Copy failed", `Copy it by hand: ${row.url}`);
  }
}

async function onCreated(row: ShareLinkRow): Promise<void> {
  const copied = await copyText(row.url);
  toast.success(copied ? "Link created and copied" : "Link created", row.url);
  void load();
}

function askRevoke(row: ShareLinkRow): void {
  pending.value = {
    title: "Revoke link?",
    message: `Revoke the link to ${displayTitle(row)}? Anyone who opens it gets a 404 from now on.`,
    confirmLabel: "Revoke",
    run: async () => {
      await revokeShare(api, row.token);
      return "Link revoked";
    },
  };
}

function askDelete(row: ShareLinkRow): void {
  pending.value = {
    title: "Delete link?",
    message: `Delete the revoked link to ${displayTitle(row)} for good? Its access count goes with it.`,
    confirmLabel: "Delete",
    run: async () => {
      await deleteShare(api, row.token);
      return "Link deleted";
    },
  };
}

function askRevokeSelected(): void {
  const tokens = selectedActive.value.map((row) => row.token);
  if (tokens.length === 0) return;
  pending.value = {
    title: "Revoke selected links?",
    message: `Revoke ${pluralize(tokens.length, "selected link")}? Anyone who opens them gets a 404 from now on.`,
    confirmLabel: "Revoke",
    run: async () => {
      const count = await revokeShares(api, { tokens });
      selection.value = [];
      return `${pluralize(count, "link")} revoked`;
    },
  };
}

function askRevokeAll(): void {
  const scope = filtered.value ? "matching the current filters" : "in the list";
  pending.value = {
    title: "Revoke all matching links?",
    message: `Revoke every link ${scope} (${pluralize(total.value, "link")}, on every page)? Anyone who opens them gets a 404 from now on.`,
    confirmLabel: "Revoke all",
    run: async () => {
      const count = await revokeShares(api, { filter: filter.value });
      selection.value = [];
      return `${pluralize(count, "link")} revoked`;
    },
  };
}

async function confirmPending(): Promise<void> {
  const action = pending.value;
  if (action === null) return;
  pendingBusy.value = true;
  try {
    const summary = await action.run();
    pending.value = null;
    toast.success(summary);
    void load();
  } catch (cause) {
    toast.failure("That did not work", cause);
  } finally {
    pendingBusy.value = false;
  }
}
</script>

<template>
  <section class="cellar-stack">
    <PageHeader
      title="Share links"
      description="Public links to individual videos. Anyone with a link can watch and download that one video until it expires or you revoke it."
    >
      <template #actions>
        <Button
          data-action="create-share"
          label="Create link"
          size="small"
          @click="createVisible = true"
        />
      </template>
    </PageHeader>

    <div class="cellar-row shares-filters">
      <span class="shares-search">
        <AppIcon name="search" :size="16" />
        <InputText
          v-model="q"
          data-test="share-search"
          placeholder="Search title or token"
          aria-label="Search share links"
          @keyup.enter="searchNow"
        />
      </span>
      <Select
        v-model="status"
        :options="STATUS_OPTIONS"
        option-label="label"
        option-value="value"
        aria-label="Status"
        data-test="share-status"
        size="small"
      />
      <span class="shares-bulk">
        <Button
          data-action="revoke-selected"
          :label="`Revoke selected (${selectedActive.length})`"
          size="small"
          severity="danger"
          outlined
          :disabled="selectedActive.length === 0"
          @click="askRevokeSelected"
        />
        <Button
          data-action="revoke-all"
          label="Revoke all matching"
          size="small"
          severity="danger"
          text
          :disabled="total === 0 || status === 'revoked'"
          @click="askRevokeAll"
        />
      </span>
    </div>

    <ErrorState v-if="error" :error="error" title="Could not load share links" @retry="load" />
    <EmptyState
      v-else-if="loaded && total === 0 && !filtered"
      icon="shares"
      title="No share links"
      description="Create one here or from a video page. Each link opens one video, and can expire or be revoked at any time."
    >
      <Button label="Create link" size="small" @click="createVisible = true" />
    </EmptyState>
    <DataTable
      v-else
      v-model:selection="selection"
      :value="rows"
      lazy
      paginator
      :rows="perPage"
      :first="first"
      :total-records="total"
      :rows-per-page-options="[25, 50, 100]"
      :loading="loading"
      :sort-field="sort"
      :sort-order="dir === 'asc' ? 1 : -1"
      removable-sort
      data-key="token"
      size="small"
      class="shares-table"
      @page="onPage"
      @sort="onSort"
    >
      <template #empty>
        <div class="shares-none" data-test="no-matches">
          No share links match these filters.
          <Button label="Clear filters" size="small" text @click="resetFilters" />
        </div>
      </template>
      <Column selection-mode="multiple" header-style="width: 2.5rem" />
      <Column header="Video">
        <template #body="{ data }">
          <VideoLink :video-id="data.video_id" class="shares-title">{{
            displayTitle(data)
          }}</VideoLink>
          <div v-if="data.channel_title" class="cellar-muted shares-sub">
            {{ data.channel_title }}
          </div>
        </template>
      </Column>
      <Column header="Token">
        <template #body="{ data }">
          <span class="shares-token">
            <code :title="data.token" data-test="token">{{ shortToken(data.token) }}</code>
            <Button
              data-action="copy-link"
              size="small"
              text
              :aria-label="`Copy the link to ${displayTitle(data)}`"
              @click="copyUrl(data)"
            >
              <AppIcon name="copy" :size="15" />
            </Button>
            <a
              :href="data.url"
              target="_blank"
              rel="noopener noreferrer"
              class="shares-open"
              data-test="open-link"
              :aria-label="`Open the link to ${displayTitle(data)} in a new tab`"
            >
              <AppIcon name="external" :size="15" />
            </a>
          </span>
        </template>
      </Column>
      <Column header="Created" field="created_at" sortable>
        <template #body="{ data }">
          <span :title="formatAbsolute(data.created_at)">{{
            formatRelative(data.created_at)
          }}</span>
        </template>
      </Column>
      <Column header="Expires" field="expires_at" sortable>
        <template #body="{ data }">
          <span v-if="data.expires_at === null" data-test="expires">never</span>
          <span v-else data-test="expires">
            {{ formatRelative(data.expires_at) }}
            <span class="cellar-muted shares-sub">{{ formatAbsolute(data.expires_at) }}</span>
          </span>
        </template>
      </Column>
      <Column header="Opens" field="access_count" sortable>
        <template #body="{ data }">{{ formatNumber(data.access_count) }}</template>
      </Column>
      <Column header="Last opened" field="last_access_at" sortable>
        <template #body="{ data }">
          <span :title="formatAbsolute(data.last_access_at)">{{
            formatRelative(data.last_access_at)
          }}</span>
        </template>
      </Column>
      <Column header="Status">
        <template #body="{ data }">
          <Tag
            :value="STATUS_LABEL[data.status as ShareStatus]"
            :severity="STATUS_SEVERITY[data.status as ShareStatus]"
            data-test="status"
          />
        </template>
      </Column>
      <Column header="" class="shares-actions-col">
        <template #body="{ data }">
          <Button
            v-if="data.status !== 'revoked'"
            data-action="revoke"
            label="Revoke"
            size="small"
            severity="danger"
            text
            @click="askRevoke(data)"
          />
          <Button
            v-else
            data-action="delete"
            size="small"
            severity="danger"
            text
            :aria-label="`Delete the revoked link to ${displayTitle(data)}`"
            @click="askDelete(data)"
          >
            <AppIcon name="trash" :size="16" />
          </Button>
        </template>
      </Column>
    </DataTable>

    <p v-if="loaded && !error && total > 0" class="cellar-note" data-test="share-total">
      {{ pluralize(total, "link") }}
    </p>

    <CreateShareDialog v-model:visible="createVisible" @created="onCreated" />
    <ConfirmDialog
      :visible="pending !== null"
      :title="pending?.title ?? ''"
      :message="pending?.message ?? ''"
      :confirm-label="pending?.confirmLabel ?? 'Confirm'"
      danger
      :busy="pendingBusy"
      @update:visible="!$event && (pending = null)"
      @confirm="confirmPending"
    />
  </section>
</template>

<style scoped>
.shares-filters {
  flex-wrap: wrap;
  gap: 0.75rem;
}

.shares-search {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--p-text-muted-color);
}

.shares-bulk {
  display: inline-flex;
  gap: 0.5rem;
  margin-left: auto;
}

.shares-title {
  color: var(--p-text-color);
  font-weight: 550;
  text-decoration: none;
}

.shares-title:hover {
  text-decoration: underline;
}

.shares-sub {
  display: block;
  font-size: 0.75rem;
}

.shares-token {
  display: inline-flex;
  align-items: center;
  gap: 0.15rem;
}

.shares-token code {
  font-family: ui-monospace, "SFMono-Regular", "Cascadia Mono", Menlo, monospace;
  font-size: 0.8rem;
}

.shares-open {
  display: inline-flex;
  padding: 0.35rem;
  color: var(--p-primary-color);
}

.shares-none {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--p-text-muted-color);
}
</style>
