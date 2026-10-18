<script setup lang="ts">
import { computed, ref, watch } from "vue";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import Message from "primevue/message";
import Textarea from "primevue/textarea";
import { uploadCookies, type AccountView, type CookieValidation } from "../../api/accounts.ts";
import { normalizeError, type ApiClientError } from "../../api/client.ts";
import { useApi } from "../../api/provide.ts";

/**
 * Paste or pick a Netscape cookies.txt. A picked file is read in the browser
 * and sent as text, the same body a paste produces, so the server has one
 * path. The jar is the account's login: it is cleared from the form as soon as
 * the server has it.
 */
const props = defineProps<{ visible: boolean; account: AccountView | null }>();
const emit = defineEmits<{ "update:visible": [boolean]; saved: [AccountView] }>();

const api = useApi();

const text = ref("");
const fileName = ref<string | null>(null);
const fileError = ref<string | null>(null);
const busy = ref(false);
const error = ref<ApiClientError | null>(null);
const result = ref<CookieValidation | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

watch(
  () => props.visible,
  (open) => {
    if (!open) return;
    text.value = "";
    fileName.value = null;
    fileError.value = null;
    error.value = null;
    result.value = null;
  },
);

const trimmed = computed(() => text.value.trim());

/** Non-blocking hints; the server's validation run is the real check. */
const hint = computed(() => {
  if (trimmed.value === "") return null;
  if (!/youtube\.com/i.test(trimmed.value)) {
    return "This does not contain any youtube.com cookies. Export while on youtube.com.";
  }
  if (!trimmed.value.split("\n").some((line) => line.split("\t").length >= 7)) {
    return "This does not look like Netscape cookies.txt format (tab-separated lines).";
  }
  return null;
});

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."));
    reader.readAsText(file);
  });
}

async function onFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file === undefined) return;
  fileError.value = null;
  try {
    text.value = await readFile(file);
    fileName.value = file.name;
    result.value = null;
  } catch (cause) {
    fileError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    // Picking the same file again must fire change again.
    input.value = "";
  }
}

async function submit(): Promise<void> {
  if (props.account === null || trimmed.value === "") return;
  busy.value = true;
  error.value = null;
  try {
    const response = await uploadCookies(api, props.account.id, text.value);
    result.value = response.validation;
    text.value = "";
    fileName.value = null;
    emit("saved", response.account);
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
    :header="account === null ? 'Cookies' : `Cookies for ${account.label}`"
    :style="{ width: 'min(40rem, 94vw)' }"
    :closable="!busy"
    @update:visible="emit('update:visible', $event)"
  >
    <div class="cellar-stack cookies-dialog">
      <p class="cellar-note">
        Netscape cookies.txt for youtube.com. Stored encrypted; it is never shown again. Saving
        replaces any jar this account already has.
      </p>

      <div class="cellar-field">
        <label for="cookies-text">Paste cookies.txt</label>
        <Textarea
          id="cookies-text"
          v-model="text"
          rows="8"
          spellcheck="false"
          autocomplete="off"
          placeholder="# Netscape HTTP Cookie File"
          class="cookies-dialog__text"
          :disabled="busy"
        />
      </div>

      <div class="cellar-row">
        <input
          ref="fileInput"
          class="sr-only"
          type="file"
          accept=".txt,text/plain"
          data-test="cookies-file"
          @change="onFile"
        />
        <Button
          size="small"
          severity="secondary"
          label="Choose cookies.txt file"
          :disabled="busy"
          @click="fileInput?.click()"
        />
        <span v-if="fileName" class="cellar-muted" data-test="cookies-file-name">
          Loaded {{ fileName }}
        </span>
      </div>

      <Message v-if="fileError" severity="error" data-test="cookies-file-error">
        {{ fileError }}
      </Message>
      <Message v-if="hint" severity="warn" data-test="cookies-hint">{{ hint }}</Message>
      <Message v-if="error" severity="error" data-test="cookies-error">{{ error.message }}</Message>
      <Message
        v-if="result"
        :severity="result.ok ? 'success' : 'warn'"
        data-test="cookies-result"
        :data-ok="String(result.ok)"
      >
        <strong>{{
          result.ok ? "Cookies saved and working." : "Cookies saved, but validation failed."
        }}</strong>
        <span v-if="result.detail"> {{ result.detail }}</span>
      </Message>
    </div>

    <template #footer>
      <Button
        :label="result ? 'Done' : 'Cancel'"
        severity="secondary"
        text
        :disabled="busy"
        @click="emit('update:visible', false)"
      />
      <Button
        data-action="save-cookies"
        label="Save and validate"
        :loading="busy"
        :disabled="trimmed === ''"
        @click="submit"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.cookies-dialog__text {
  width: 100%;
  font-family: ui-monospace, "SFMono-Regular", "Cascadia Mono", Menlo, monospace;
  font-size: 0.8rem;
}
</style>
