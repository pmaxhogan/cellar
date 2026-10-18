<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import Button from "primevue/button";
import Tag from "primevue/tag";
import type { VideoShareLink } from "@cellar/shared";
import { ABORTED_PROBLEM, normalizeError } from "../../api/client.ts";
import { useApi } from "../../api/provide.ts";
import {
  createShareLink,
  listShareLinks,
  revokeShareLink,
  shareView,
  type ShareLinkView,
  type ShareStatus,
} from "../../api/videos.ts";
import { formatAbsolute, formatNumber, formatRelative } from "../../lib/format.ts";
import { useToaster } from "../../lib/toast.ts";
import ConfirmDialog from "../ConfirmDialog.vue";

/**
 * The public share links of one video: list, create (optionally expiring) and
 * revoke. The list is read from the shares API (`GET /api/shares?video_id=`),
 * which also reports last access times; until that answers, the rows that
 * come with the video detail stand in. Where the shares API is not there at
 * all (404 or 501), creating is switched off with a note instead of failing
 * on every click.
 */
const props = defineProps<{ videoId: string; links: VideoShareLink[] }>();
const emit = defineEmits<{ changed: [] }>();

const api = useApi();
const toast = useToaster();

const local = ref<ShareLinkView[]>([]);
const fromApi = ref(false);
const expiry = ref("");
const creating = ref(false);
const unavailable = ref(false);
const revoking = ref<ShareLinkView | null>(null);
const revokeBusy = ref(false);
let controller: AbortController | null = null;

watch(
  () => props.links,
  (links) => {
    if (!fromApi.value) local.value = links.map((row) => shareView(row));
  },
  { immediate: true },
);

function isUnavailable(cause: unknown): boolean {
  const status = normalizeError(cause).status;
  return status === 404 || status === 501;
}

async function refresh(): Promise<void> {
  controller?.abort();
  const mine = new AbortController();
  controller = mine;
  try {
    local.value = await listShareLinks(api, props.videoId, mine.signal);
    fromApi.value = true;
    unavailable.value = false;
  } catch (cause) {
    if (normalizeError(cause).problem === ABORTED_PROBLEM) return;
    // The detail rows stay on screen; only a missing API turns creating off.
    fromApi.value = false;
    local.value = props.links.map((row) => shareView(row));
    if (isUnavailable(cause)) unavailable.value = true;
  } finally {
    if (controller === mine) controller = null;
  }
}

watch(() => props.videoId, refresh, { immediate: true });
onBeforeUnmount(() => controller?.abort());

const now = ref(Date.now());
const sorted = computed(() => [...local.value].sort((a, b) => b.created_at - a.created_at));

/** The datetime-local value as epoch ms, null for "never", NaN when unreadable. */
const expiresAt = computed(() => {
  if (expiry.value.trim() === "") return null;
  return new Date(expiry.value).getTime();
});
const expiryProblem = computed(() => {
  const at = expiresAt.value;
  if (at === null) return null;
  if (Number.isNaN(at)) return "That is not a date and time.";
  if (at <= Date.now()) return "Pick a time in the future.";
  return null;
});

const SEVERITY: Record<ShareStatus, "success" | "warn" | "danger"> = {
  active: "success",
  expired: "warn",
  revoked: "danger",
};

function upsert(link: ShareLinkView): void {
  const rest = local.value.filter((row) => row.token !== link.token);
  local.value = [link, ...rest];
}

async function create(): Promise<void> {
  if (expiryProblem.value !== null) return;
  creating.value = true;
  try {
    const link = await createShareLink(api, props.videoId, expiresAt.value);
    upsert(link);
    now.value = Date.now();
    expiry.value = "";
    toast.success("Share link created", link.url);
    emit("changed");
  } catch (cause) {
    if (isUnavailable(cause)) {
      unavailable.value = true;
      return;
    }
    toast.failure("Could not create the share link", cause);
  } finally {
    creating.value = false;
  }
}

async function confirmRevoke(): Promise<void> {
  // Only reachable from the dialog, which is open only while a link is chosen.
  const target = revoking.value as ShareLinkView;
  revokeBusy.value = true;
  try {
    upsert(await revokeShareLink(api, target.token));
    revoking.value = null;
    toast.success("Share link revoked", "It now answers the same 404 as an unknown link.");
    emit("changed");
  } catch (cause) {
    if (normalizeError(cause).status === 501) unavailable.value = true;
    toast.failure("Could not revoke the share link", cause);
  } finally {
    revokeBusy.value = false;
  }
}

async function copy(link: ShareLinkView): Promise<void> {
  try {
    await navigator.clipboard.writeText(link.url);
    toast.success("Link copied", link.url);
  } catch {
    toast.warn("Could not copy", link.url);
  }
}
</script>

<template>
  <div class="shares" data-test="shares">
    <form class="shares__create" data-test="share-create" @submit.prevent="create">
      <div class="cellar-field">
        <label for="share-expiry">Expires (leave empty for never)</label>
        <input
          id="share-expiry"
          v-model="expiry"
          class="p-inputtext p-component p-inputtext-sm"
          type="datetime-local"
          :disabled="unavailable || creating"
          data-test="share-expiry"
        />
        <small v-if="expiryProblem" class="shares__error" data-test="share-expiry-problem">{{
          expiryProblem
        }}</small>
      </div>
      <Button
        type="submit"
        size="small"
        label="Create link"
        :loading="creating"
        :disabled="unavailable || expiryProblem !== null"
        data-test="share-create-button"
      />
    </form>
    <p v-if="unavailable" class="cellar-note" data-test="share-unavailable">
      Share links are not available on this server yet.
    </p>

    <p v-if="sorted.length === 0" class="cellar-muted" data-test="share-empty">
      No share links for this video. A link lets anyone with it watch and download this one video
      without signing in.
    </p>
    <table v-else class="shares__table" data-test="share-table">
      <thead>
        <tr>
          <th scope="col">Link</th>
          <th scope="col">State</th>
          <th scope="col">Expires</th>
          <th scope="col">Views</th>
          <th scope="col">Created</th>
          <th scope="col"><span class="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="link in sorted" :key="link.token" :data-token="link.token">
          <td>
            <a :href="link.url" target="_blank" rel="noopener noreferrer" class="mono">{{
              link.token
            }}</a>
          </td>
          <td>
            <Tag :value="link.status" :severity="SEVERITY[link.status]" data-test="share-state" />
          </td>
          <td :title="link.expires_at === null ? undefined : formatAbsolute(link.expires_at)">
            {{ link.expires_at === null ? "never" : formatRelative(link.expires_at, now) }}
          </td>
          <td data-test="share-count">
            {{ formatNumber(link.access_count) }}
            <span v-if="link.last_access_at !== null" class="cellar-muted">
              (last {{ formatRelative(link.last_access_at, now) }})</span
            >
          </td>
          <td :title="formatAbsolute(link.created_at)">
            {{ formatRelative(link.created_at, now) }}
          </td>
          <td class="shares__actions">
            <Button size="small" text label="Copy" data-action="share-copy" @click="copy(link)" />
            <Button
              v-if="link.revoked_at === null"
              size="small"
              text
              severity="danger"
              label="Revoke"
              data-action="share-revoke"
              @click="revoking = link"
            />
          </td>
        </tr>
      </tbody>
    </table>

    <ConfirmDialog
      :visible="revoking !== null"
      title="Revoke share link?"
      message="Anyone holding this link loses access at once. A revoked link cannot be restored; create a new one instead."
      confirm-label="Revoke"
      danger
      :busy="revokeBusy"
      @update:visible="!$event && (revoking = null)"
      @confirm="confirmRevoke"
    />
  </div>
</template>

<style scoped>
.shares {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.shares__create {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 0.75rem;
}

.shares__error {
  color: var(--cellar-error);
}

.shares__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88rem;
}

.shares__table th,
.shares__table td {
  text-align: left;
  padding: 0.35rem 0.5rem;
  border-bottom: 1px solid var(--p-content-border-color);
}

.shares__table thead th {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--p-text-muted-color);
}

.shares__actions {
  text-align: right;
  white-space: nowrap;
}
</style>
