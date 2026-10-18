<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import Button from "primevue/button";
import Message from "primevue/message";
import { resolveSettings, settingGroups, type SettingKey } from "@cellar/shared";
import { normalizeError, type ApiClientError } from "../api/client.ts";
import { useApi } from "../api/provide.ts";
import {
  defaultValue,
  dirtyKeys,
  draftFrom,
  getSettings,
  hasOverride,
  putSettings,
  sameValue,
  serverFieldErrors,
  validateDraft,
  type Draft,
  type Overrides,
} from "../api/settings.ts";
import { pluralize } from "../lib/format.ts";
import { useToaster } from "../lib/toast.ts";
import ErrorState from "../components/ErrorState.vue";
import ListSkeleton from "../components/ListSkeleton.vue";
import PageHeader from "../components/PageHeader.vue";
import SettingField from "../components/settings/SettingField.vue";

const api = useApi();
const toast = useToaster();

const GROUPS = settingGroups();

const overrides = ref<Overrides>({});
const draft = ref<Draft>(draftFrom(resolveSettings({})));
const cleared = ref<Set<SettingKey>>(new Set());
const errors = ref<Partial<Record<SettingKey, string>>>({});
const saveError = ref<string | null>(null);

const loading = ref(true);
const loaded = ref(false);
const loadError = ref<ApiClientError | null>(null);
const saving = ref(false);

const dirty = computed(() => new Set(dirtyKeys(draft.value, overrides.value, cleared.value)));
const errorCount = computed(() => Object.keys(errors.value).length);

function resetDraft(): void {
  draft.value = draftFrom(resolveSettings(overrides.value));
  cleared.value = new Set();
  errors.value = {};
  saveError.value = null;
}

let inflight: AbortController | null = null;

async function load(): Promise<void> {
  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;
  loading.value = true;
  try {
    overrides.value = await getSettings(api, controller.signal);
    resetDraft();
    loadError.value = null;
    loaded.value = true;
  } catch (cause) {
    const normalized = normalizeError(cause);
    if (normalized.problem === "aborted") return;
    loadError.value = normalized;
  } finally {
    if (inflight === controller) {
      loading.value = false;
      inflight = null;
    }
  }
}

onMounted(() => void load());
onBeforeUnmount(() => inflight?.abort());

function clearError(key: SettingKey): void {
  if (errors.value[key] === undefined) return;
  const next = { ...errors.value };
  delete next[key];
  errors.value = next;
}

function onUpdate(key: SettingKey, value: unknown): void {
  draft.value = { ...draft.value, [key]: value };
  if (cleared.value.has(key)) {
    const next = new Set(cleared.value);
    next.delete(key);
    cleared.value = next;
  }
  clearError(key);
}

function onReset(key: SettingKey): void {
  draft.value = { ...draft.value, [key]: defaultValue(key) };
  if (hasOverride(overrides.value, key)) cleared.value = new Set([...cleared.value, key]);
  clearError(key);
}

function isModified(key: SettingKey): boolean {
  return hasOverride(overrides.value, key) && !cleared.value.has(key);
}

function canReset(key: SettingKey): boolean {
  return isModified(key) || !sameValue(draft.value[key], defaultValue(key));
}

async function save(): Promise<void> {
  saveError.value = null;
  const result = validateDraft(draft.value, overrides.value, cleared.value);
  if (!result.ok) {
    errors.value = result.errors;
    toast.warn(
      "Not saved",
      `${pluralize(Object.keys(result.errors).length, "setting")} need attention.`,
    );
    return;
  }
  const count = Object.keys(result.patch).length;
  if (count === 0) {
    resetDraft();
    return;
  }
  saving.value = true;
  try {
    overrides.value = await putSettings(api, result.patch);
    resetDraft();
    toast.success("Settings saved", `${pluralize(count, "setting")} changed.`);
  } catch (cause) {
    const normalized = normalizeError(cause);
    const fieldErrors = serverFieldErrors(normalized.details);
    if (Object.keys(fieldErrors).length > 0) errors.value = fieldErrors;
    saveError.value = normalized.message;
    toast.failure("Could not save settings", normalized);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="cellar-stack">
    <PageHeader
      title="Settings"
      description="Global defaults. Rules override some of these per video; everything not changed here uses the built-in default."
    >
      <template #actions>
        <span v-if="dirty.size > 0" class="cellar-muted" data-test="dirty-count">
          {{ pluralize(dirty.size, "unsaved change") }}
        </span>
        <Button
          data-action="discard"
          label="Discard"
          size="small"
          severity="secondary"
          text
          :disabled="dirty.size === 0 || saving"
          @click="resetDraft"
        />
        <Button
          data-action="save"
          label="Save"
          size="small"
          :loading="saving"
          :disabled="dirty.size === 0"
          @click="save"
        />
      </template>
    </PageHeader>

    <ListSkeleton v-if="loading && !loaded" label="Loading settings" />
    <ErrorState
      v-else-if="loadError && !loaded"
      :error="loadError"
      title="Could not load settings"
      @retry="load"
    />
    <template v-else>
      <Message v-if="saveError" severity="error" data-test="save-error">{{ saveError }}</Message>
      <Message v-else-if="errorCount > 0" severity="warn" data-test="field-errors">
        {{ pluralize(errorCount, "setting") }} need attention before saving.
      </Message>

      <section
        v-for="group in GROUPS"
        :key="group.group"
        class="cellar-card settings-group"
        :data-group="group.group"
      >
        <h2>{{ group.group }}</h2>
        <SettingField
          v-for="key in group.keys"
          :key="key"
          :setting-key="key"
          :model-value="draft[key]"
          :modified="isModified(key)"
          :dirty="dirty.has(key)"
          :can-reset="canReset(key)"
          :error="errors[key] ?? null"
          :disabled="saving"
          @update:model-value="onUpdate(key, $event)"
          @reset="onReset(key)"
        />
      </section>
    </template>
  </section>
</template>

<style scoped>
.settings-group h2 {
  margin: 0 0 0.3rem;
  font-size: 1rem;
}
</style>
