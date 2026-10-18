<script setup lang="ts">
import { computed, ref, watch } from "vue";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import InputText from "primevue/inputtext";
import Message from "primevue/message";
import { parseChannelRef, type ChannelRow } from "@cellar/shared";
import {
  NO_ACCOUNT_PROBLEM,
  addChannel,
  describeChannelRef,
  needsResolve,
} from "../../api/channels.ts";
import { normalizeError, type ApiClientError } from "../../api/client.ts";
import { useApi } from "../../api/provide.ts";

/**
 * Add a channel by hand. The reference is parsed in the browser with the same
 * parser the server uses, so a video link or a typo is caught before the
 * request and the owner sees which kind of reference cellar understood.
 */
const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ "update:visible": [boolean]; added: [ChannelRow] }>();

const api = useApi();

const input = ref("");
const busy = ref(false);
const error = ref<ApiClientError | null>(null);

watch(
  () => props.visible,
  (open) => {
    if (!open) return;
    input.value = "";
    error.value = null;
  },
);

watch(input, () => {
  error.value = null;
});

const parsed = computed(() => parseChannelRef(input.value));
const described = computed(() => (parsed.value === null ? null : describeChannelRef(parsed.value)));
const showInvalid = computed(() => input.value.trim() !== "" && parsed.value === null);
const noAccount = computed(() => error.value?.problem === NO_ACCOUNT_PROBLEM);

async function submit(): Promise<void> {
  if (parsed.value === null) return;
  busy.value = true;
  error.value = null;
  try {
    const row = await addChannel(api, input.value.trim());
    emit("added", row);
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
    header="Add channel"
    :style="{ width: 'min(34rem, 94vw)' }"
    :closable="!busy"
    @update:visible="emit('update:visible', $event)"
  >
    <form class="cellar-stack" @submit.prevent="submit">
      <div class="cellar-field">
        <label for="channel-ref">Channel URL, @handle or UC channel id</label>
        <InputText
          id="channel-ref"
          v-model="input"
          autocomplete="off"
          spellcheck="false"
          placeholder="https://www.youtube.com/@handle"
          :invalid="showInvalid"
          :disabled="busy"
        />
      </div>

      <p v-if="described && parsed" class="channel-ref-kind" data-test="ref-kind">
        <span class="cellar-muted">{{ described.kind }}:</span>
        <code>{{ described.detail }}</code>
        <span v-if="needsResolve(parsed)" class="cellar-note">
          Resolved to a channel id with a linked account's API access.
        </span>
      </p>
      <Message v-else-if="showInvalid" severity="warn" data-test="ref-invalid">
        Not a channel URL, @handle or UC channel id. Video and playlist links are not accepted.
      </Message>

      <Message v-if="noAccount" severity="warn" data-test="no-account">
        No linked account could resolve this reference: handles and custom URLs are looked up with a
        linked Google account's API access. Link one on the
        <a href="/accounts">Accounts page</a>, or paste the channel's UC id instead (it is in the
        channel page's About, under Share channel, Copy channel ID).
      </Message>
      <Message v-else-if="error" severity="error" data-test="add-error">{{
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
        data-action="add-channel-submit"
        label="Add channel"
        :loading="busy"
        :disabled="parsed === null"
        @click="submit"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.channel-ref-kind {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  align-items: baseline;
}

.channel-ref-kind .cellar-note {
  flex-basis: 100%;
  margin: 0;
}
</style>
