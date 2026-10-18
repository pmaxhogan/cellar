<script setup lang="ts">
import { computed, ref, watch } from "vue";
import Button from "primevue/button";
import DatePicker from "primevue/datepicker";
import Dialog from "primevue/dialog";
import InputText from "primevue/inputtext";
import Message from "primevue/message";
import SelectButton from "primevue/selectbutton";
import { parseVideoId, type ShareLinkRow } from "@cellar/shared";
import { normalizeError, type ApiClientError } from "../../api/client.ts";
import { useApi } from "../../api/provide.ts";
import { createShare, EXPIRY_PRESETS, expiryFor, type ExpiryPreset } from "../../api/shares.ts";

/**
 * Create a share link for one video. The id or URL is parsed in the browser
 * with the shared parser, so a channel or playlist link is caught before the
 * request. The expiry is a preset or a custom date and time.
 */
const props = withDefaults(defineProps<{ visible: boolean; videoId?: string }>(), {
  videoId: "",
});
const emit = defineEmits<{ "update:visible": [boolean]; created: [ShareLinkRow] }>();

const api = useApi();

const input = ref("");
const preset = ref<ExpiryPreset>("7d");
const custom = ref<Date | null>(null);
const busy = ref(false);
const error = ref<ApiClientError | null>(null);

watch(
  () => props.visible,
  (open) => {
    if (!open) return;
    input.value = props.videoId;
    preset.value = "7d";
    custom.value = null;
    error.value = null;
  },
  { immediate: true },
);

watch([input, preset, custom], () => {
  error.value = null;
});

const parsedId = computed(() => parseVideoId(input.value));
const showInvalid = computed(() => input.value.trim() !== "" && parsedId.value === null);
const customInvalid = computed(
  () =>
    preset.value === "custom" &&
    custom.value !== null &&
    expiryFor("custom", custom.value) === undefined,
);
const canSubmit = computed(
  () =>
    parsedId.value !== null &&
    !busy.value &&
    (preset.value !== "custom" || expiryFor("custom", custom.value) !== undefined),
);

async function submit(): Promise<void> {
  const id = parsedId.value;
  const expiresAt = expiryFor(preset.value, custom.value);
  if (id === null || expiresAt === undefined) return;
  busy.value = true;
  error.value = null;
  try {
    const row = await createShare(api, id, expiresAt);
    emit("created", row);
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
    header="Create share link"
    :style="{ width: 'min(34rem, 94vw)' }"
    :closable="!busy"
    @update:visible="emit('update:visible', $event)"
  >
    <form class="cellar-stack" @submit.prevent="submit">
      <div class="cellar-field">
        <label for="share-video">Video URL or id</label>
        <InputText
          id="share-video"
          v-model="input"
          data-test="share-video"
          autocomplete="off"
          spellcheck="false"
          placeholder="https://www.youtube.com/watch?v=..."
          :invalid="showInvalid"
          :disabled="busy"
        />
        <small v-if="parsedId" class="cellar-muted" data-test="share-video-id">
          Video id <code>{{ parsedId }}</code>
        </small>
      </div>
      <Message v-if="showInvalid" severity="warn" data-test="share-video-invalid">
        Not a video URL or id. Channel and playlist links are not accepted.
      </Message>

      <div class="cellar-field">
        <span id="share-expiry-label">Expires</span>
        <SelectButton
          v-model="preset"
          :options="EXPIRY_PRESETS"
          option-label="label"
          option-value="value"
          :allow-empty="false"
          aria-labelledby="share-expiry-label"
          data-test="share-expiry"
          :disabled="busy"
        />
        <DatePicker
          v-if="preset === 'custom'"
          v-model="custom"
          show-time
          hour-format="24"
          show-icon
          :min-date="new Date()"
          :disabled="busy"
          aria-label="Expiry date and time"
          data-test="share-custom"
        />
        <small v-if="customInvalid" class="cellar-note" data-test="share-custom-invalid">
          Pick a date and time in the future.
        </small>
      </div>

      <Message v-if="error" severity="error" data-test="share-create-error">{{
        error.message
      }}</Message>
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
        data-action="create-share-submit"
        label="Create link"
        :loading="busy"
        :disabled="!canSubmit"
        @click="submit"
      />
    </template>
  </Dialog>
</template>
