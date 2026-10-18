<script setup lang="ts">
import { computed, ref, watch } from "vue";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import InputNumber from "primevue/inputnumber";
import InputText from "primevue/inputtext";
import Message from "primevue/message";
import ToggleSwitch from "primevue/toggleswitch";
import type { LocationRow } from "@cellar/shared";
import { normalizeError, type ApiClientError } from "../../api/client.ts";
import {
  ADD_LOCATION_DOCS_URL,
  bytesToGb,
  containerPathProblem,
  createLocation,
  gbToBytes,
  updateLocation,
  type LocationDraft,
  type LocationView,
} from "../../api/locations.ts";
import { useApi } from "../../api/provide.ts";
import { formatBytes } from "../../lib/format.ts";

/**
 * Register a location or edit one. The container path is fixed once created:
 * media already on disk is addressed relative to it, so changing it would
 * orphan every file. Moving media is done by pointing rules elsewhere.
 */
const props = defineProps<{ visible: boolean; location: LocationView | null }>();
const emit = defineEmits<{
  "update:visible": [boolean];
  saved: [LocationRow, "created" | "updated"];
}>();

const api = useApi();

const label = ref("");
const path = ref("");
const quotaGb = ref<number | null>(null);
const enabled = ref(true);
const busy = ref(false);
const touched = ref(false);
const error = ref<ApiClientError | null>(null);

const editing = computed(() => props.location !== null);

watch(
  () => props.visible,
  (open) => {
    if (!open) return;
    label.value = props.location?.label ?? "";
    path.value = props.location?.container_path ?? "";
    quotaGb.value = props.location === null ? null : bytesToGb(props.location.quota_bytes);
    enabled.value = props.location?.enabled ?? true;
    touched.value = false;
    error.value = null;
  },
);

const problems = computed(() => {
  const out: Record<string, string> = {};
  if (label.value.trim() === "") out.label = "Give the location a label.";
  if (!editing.value) {
    const pathProblem = containerPathProblem(path.value);
    if (pathProblem !== null) out.path = pathProblem;
  }
  if (quotaGb.value === null || !(quotaGb.value > 0)) out.quota = "Set a quota above 0 GB.";
  return out;
});

const quotaPreview = computed(() =>
  quotaGb.value === null || !(quotaGb.value > 0) ? null : formatBytes(gbToBytes(quotaGb.value)),
);

async function submit(): Promise<void> {
  touched.value = true;
  if (Object.keys(problems.value).length > 0 || quotaGb.value === null) return;
  busy.value = true;
  error.value = null;
  const quota_bytes = gbToBytes(quotaGb.value);
  try {
    if (props.location === null) {
      const draft: LocationDraft = {
        label: label.value.trim(),
        container_path: path.value.trim(),
        quota_bytes,
        enabled: enabled.value,
      };
      emit("saved", await createLocation(api, draft), "created");
    } else {
      const patch: Partial<LocationDraft> = { label: label.value.trim(), enabled: enabled.value };
      // The field shows GB to two decimals; only a changed number is sent, so
      // saving an untouched quota that is not a round GB does not rewrite it.
      if (quotaGb.value !== bytesToGb(props.location.quota_bytes)) patch.quota_bytes = quota_bytes;
      emit("saved", await updateLocation(api, props.location.id, patch), "updated");
    }
    emit("update:visible", false);
  } catch (cause) {
    error.value = normalizeError(cause);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    :header="editing ? 'Edit location' : 'Add location'"
    :style="{ width: 'min(34rem, 94vw)' }"
    :closable="!busy"
    @update:visible="emit('update:visible', $event)"
  >
    <form class="cellar-stack" @submit.prevent="submit">
      <Message v-if="!editing" severity="info" data-test="mount-note">
        A location must also be a bind mount in the cellar Custom App's compose file: the container
        cannot create new top-level paths. Add the mount and redeploy first, then register its
        container path here.
        <a :href="ADD_LOCATION_DOCS_URL" target="_blank" rel="noopener noreferrer"
          >Adding a second storage location</a
        >
      </Message>

      <div class="cellar-field">
        <label for="location-label">Label</label>
        <InputText
          id="location-label"
          v-model="label"
          autocomplete="off"
          :invalid="touched && problems.label !== undefined"
          :disabled="busy"
        />
        <small v-if="touched && problems.label" class="field-error">{{ problems.label }}</small>
      </div>

      <div class="cellar-field">
        <label for="location-path">Container path</label>
        <InputText
          id="location-path"
          v-model="path"
          autocomplete="off"
          spellcheck="false"
          placeholder="/media2"
          :invalid="touched && problems.path !== undefined"
          :disabled="busy || editing"
        />
        <small v-if="touched && problems.path" class="field-error" data-test="path-error">{{
          problems.path
        }}</small>
        <small v-if="editing" class="cellar-note">
          Fixed once created. Point rules at a new location to move media.
        </small>
      </div>

      <div class="cellar-field">
        <label for="location-quota">Quota (GB)</label>
        <InputNumber
          v-model="quotaGb"
          input-id="location-quota"
          :min="0"
          :max-fraction-digits="2"
          :disabled="busy"
          :invalid="touched && problems.quota !== undefined"
        />
        <small v-if="touched && problems.quota" class="field-error" data-test="quota-error">{{
          problems.quota
        }}</small>
        <small v-else-if="quotaPreview" class="cellar-note" data-test="quota-preview">
          {{ quotaPreview }}. Reaping starts near this, enforced by cellar, not by ZFS.
        </small>
      </div>

      <div class="cellar-row">
        <ToggleSwitch v-model="enabled" input-id="location-enabled" :disabled="busy" />
        <label for="location-enabled">Enabled (new downloads may target it)</label>
      </div>

      <Message v-if="error" severity="error" data-test="location-form-error">
        {{ error.message }}
      </Message>
    </form>

    <template #footer>
      <Button
        label="Cancel"
        severity="secondary"
        text
        :disabled="busy"
        @click="emit('update:visible', false)"
      />
      <Button
        data-action="save-location"
        :label="editing ? 'Save' : 'Add location'"
        :loading="busy"
        @click="submit"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.field-error {
  color: var(--cellar-error);
}
</style>
