<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import Button from "primevue/button";
import type { LocationRow } from "@cellar/shared";
import { normalizeError, type ApiClientError } from "../api/client.ts";
import {
  deleteLocation,
  getLocationUsage,
  listLocations,
  updateLocation,
  type LocationView,
} from "../api/locations.ts";
import { useApi } from "../api/provide.ts";
import { useToaster } from "../lib/toast.ts";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import EmptyState from "../components/EmptyState.vue";
import ErrorState from "../components/ErrorState.vue";
import ListSkeleton from "../components/ListSkeleton.vue";
import LocationCard from "../components/locations/LocationCard.vue";
import LocationFormDialog from "../components/locations/LocationFormDialog.vue";
import PageHeader from "../components/PageHeader.vue";

const api = useApi();
const toast = useToaster();

const locations = ref<LocationView[]>([]);
const loading = ref(true);
const loaded = ref(false);
const error = ref<ApiClientError | null>(null);
const busyId = ref<number | null>(null);
const refreshingId = ref<number | null>(null);

const formVisible = ref(false);
const editing = ref<LocationView | null>(null);
const removing = ref<LocationView | null>(null);
const removeBusy = ref(false);

let inflight: AbortController | null = null;

async function load(): Promise<void> {
  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;
  loading.value = true;
  try {
    locations.value = await listLocations(api, controller.signal);
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

/** A saved row replaces the old one but keeps a filesystem size already fetched. */
function replaceRow(row: LocationRow): void {
  const index = locations.value.findIndex((candidate) => candidate.id === row.id);
  if (index === -1) {
    locations.value = [...locations.value, row];
    return;
  }
  locations.value = locations.value.map((candidate) =>
    candidate.id === row.id ? { ...row, fs_total_bytes: candidate.fs_total_bytes } : candidate,
  );
}

function openCreate(): void {
  editing.value = null;
  formVisible.value = true;
}

function openEdit(location: LocationView): void {
  editing.value = location;
  formVisible.value = true;
}

function onSaved(row: LocationRow, how: "created" | "updated"): void {
  replaceRow(row);
  toast.success(how === "created" ? "Location added" : "Location saved", row.label);
}

async function toggle(location: LocationView): Promise<void> {
  busyId.value = location.id;
  try {
    const row = await updateLocation(api, location.id, { enabled: !location.enabled });
    replaceRow(row);
    toast.success(row.enabled ? "Location enabled" : "Location disabled", row.label);
  } catch (cause) {
    toast.failure("Could not change the location", cause);
  } finally {
    busyId.value = null;
  }
}

async function refresh(location: LocationView): Promise<void> {
  refreshingId.value = location.id;
  try {
    const usage = await getLocationUsage(api, location.id);
    locations.value = locations.value.map((candidate) =>
      candidate.id === location.id ? { ...candidate, ...usage } : candidate,
    );
  } catch (cause) {
    toast.failure("Could not read usage", cause);
  } finally {
    refreshingId.value = null;
  }
}

async function confirmRemove(): Promise<void> {
  const target = removing.value;
  if (target === null) return;
  removeBusy.value = true;
  try {
    await deleteLocation(api, target.id);
    locations.value = locations.value.filter((row) => row.id !== target.id);
    removing.value = null;
    toast.success("Location deleted", target.label);
  } catch (cause) {
    if (normalizeError(cause).status === 409) {
      toast.warn(
        "Location still holds media",
        "Point rules at another location so cellar moves the files out, or let them be reaped, then delete it. Disable it meanwhile to stop new downloads landing there.",
      );
    } else {
      toast.failure("Could not delete the location", cause);
    }
  } finally {
    removeBusy.value = false;
  }
}
</script>

<template>
  <section class="cellar-stack">
    <PageHeader
      title="Locations"
      description="Where media is stored, and how much room each location has left. Each is a bind mount plus a quota cellar enforces."
    >
      <template #actions>
        <Button data-action="add-location" label="Add location" size="small" @click="openCreate" />
      </template>
    </PageHeader>

    <ListSkeleton v-if="loading && !loaded" label="Loading locations" />
    <ErrorState v-else-if="error" :error="error" title="Could not load locations" @retry="load" />
    <EmptyState
      v-else-if="locations.length === 0"
      icon="locations"
      title="No storage locations"
      description="Register the /media mount (or any other bind mount) with a quota so downloads have somewhere to go."
    >
      <Button label="Add location" size="small" @click="openCreate" />
    </EmptyState>
    <div v-else class="locations-grid">
      <LocationCard
        v-for="location in locations"
        :key="location.id"
        :location="location"
        :busy="busyId === location.id"
        :refreshing="refreshingId === location.id"
        @edit="openEdit"
        @toggle="toggle"
        @refresh="refresh"
        @remove="removing = $event"
      />
    </div>

    <LocationFormDialog v-model:visible="formVisible" :location="editing" @saved="onSaved" />
    <ConfirmDialog
      :visible="removing !== null"
      title="Delete location?"
      :message="`Unregister ${removing?.label ?? 'this location'} (${removing?.container_path ?? ''})? Files on disk are not touched. A location that still holds media cannot be deleted.`"
      confirm-label="Delete"
      danger
      :busy="removeBusy"
      @update:visible="!$event && (removing = null)"
      @confirm="confirmRemove"
    />
  </section>
</template>

<style scoped>
.locations-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(22rem, 1fr));
  gap: 1rem;
}
</style>
