<script setup lang="ts">
import { computed, ref, watch } from "vue";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import InputText from "primevue/inputtext";
import Message from "primevue/message";
import ToggleSwitch from "primevue/toggleswitch";
import type { ProxyRow } from "@cellar/shared";
import { normalizeError, type ApiClientError } from "../../api/client.ts";
import { useApi } from "../../api/provide.ts";
import { createProxy, proxyUrlProblem, updateProxy, type ProxyUpdate } from "../../api/proxies.ts";

/**
 * Add or edit a proxy. The URL field is a password field and starts empty on
 * edit: the stored URL never reaches the browser, and leaving the field empty
 * keeps it unchanged.
 */
const props = defineProps<{ visible: boolean; proxy: ProxyRow | null }>();
const emit = defineEmits<{
  "update:visible": [boolean];
  saved: [ProxyRow, "created" | "updated"];
}>();

const api = useApi();

const label = ref("");
const url = ref("");
const enabled = ref(true);
const busy = ref(false);
const touched = ref(false);
const error = ref<ApiClientError | null>(null);

const editing = computed(() => props.proxy !== null);

watch(
  () => props.visible,
  (open) => {
    if (!open) {
      // Drop the typed secret as soon as the dialog closes.
      url.value = "";
      return;
    }
    label.value = props.proxy?.label ?? "";
    url.value = "";
    enabled.value = props.proxy?.enabled ?? true;
    touched.value = false;
    error.value = null;
  },
);

const labelProblem = computed(() => (label.value.trim() === "" ? "Give the proxy a label." : null));
const urlProblem = computed(() =>
  editing.value && url.value.trim() === "" ? null : proxyUrlProblem(url.value),
);

async function submit(): Promise<void> {
  touched.value = true;
  if (labelProblem.value !== null || urlProblem.value !== null) return;
  busy.value = true;
  error.value = null;
  try {
    if (props.proxy === null) {
      const row = await createProxy(api, {
        label: label.value.trim(),
        url: url.value.trim(),
        enabled: enabled.value,
      });
      emit("saved", row, "created");
    } else {
      const patch: ProxyUpdate = { label: label.value.trim(), enabled: enabled.value };
      if (url.value.trim() !== "") patch.url = url.value.trim();
      emit("saved", await updateProxy(api, props.proxy.id, patch), "updated");
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
    :header="editing ? 'Edit proxy' : 'Add proxy'"
    :style="{ width: 'min(32rem, 94vw)' }"
    :closable="!busy"
    @update:visible="emit('update:visible', $event)"
  >
    <form class="cellar-stack" @submit.prevent="submit">
      <div class="cellar-field">
        <label for="proxy-label">Label</label>
        <InputText
          id="proxy-label"
          v-model="label"
          autocomplete="off"
          :invalid="touched && labelProblem !== null"
          :disabled="busy"
        />
        <small v-if="touched && labelProblem" class="field-error">{{ labelProblem }}</small>
      </div>

      <div class="cellar-field">
        <label for="proxy-url">Proxy URL</label>
        <InputText
          id="proxy-url"
          v-model="url"
          type="password"
          autocomplete="new-password"
          spellcheck="false"
          :placeholder="
            editing ? 'Leave empty to keep the stored URL' : 'socks5://user:password@host:1080'
          "
          :invalid="touched && urlProblem !== null"
          :disabled="busy"
        />
        <small v-if="touched && urlProblem" class="field-error" data-test="url-error">{{
          urlProblem
        }}</small>
        <small v-else-if="editing" class="cellar-note">
          Stored encrypted and never shown. Currently {{ proxy?.url_redacted }}.
        </small>
        <small v-else class="cellar-note">Stored encrypted; only a redacted form is shown.</small>
      </div>

      <div class="cellar-row">
        <ToggleSwitch v-model="enabled" input-id="proxy-enabled" :disabled="busy" />
        <label for="proxy-enabled">Enabled (in the pool rules can pick from)</label>
      </div>

      <Message v-if="error" severity="error" data-test="proxy-form-error">
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
        data-action="save-proxy"
        :label="editing ? 'Save' : 'Add proxy'"
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
