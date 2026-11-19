<script setup lang="ts">
import { nextTick, onMounted, ref } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import { parseVideoId } from "@cellar/shared";
import { normalizeError } from "../api/client.ts";
import { useApi } from "../api/provide.ts";
import { quickAddVideo } from "../api/videos.ts";
import AppIcon from "../components/AppIcon.vue";
import EmptyState from "../components/EmptyState.vue";
import PageHeader from "../components/PageHeader.vue";
import VideoLink from "../components/shares/VideoLink.vue";
import { planPaste, quickAddMessage } from "../lib/quickAdd.ts";

/**
 * Paste a link, press Enter, repeat. Each confirmed link is cleared from the
 * field at once (the field keeps the focus) and listed below, newest first,
 * with what the server did. Requests run one at a time in the order entered,
 * so a paste of fifty links does not open fifty connections.
 */
interface Entry {
  key: number;
  input: string;
  videoId: string | null;
  state: "pending" | "ok" | "error";
  message: string;
  title: string | null;
  channelTitle: string | null;
}

const api = useApi();
const input = ref("");
const entries = ref<Entry[]>([]);
const field = ref<{ $el: HTMLInputElement } | null>(null);
let nextKey = 1;
let chain: Promise<void> = Promise.resolve();

function focusField(): void {
  field.value?.$el.focus();
}

onMounted(() => {
  void nextTick(focusField);
});

function add(raw: string): void {
  const text = raw.trim();
  if (text === "") return;
  const videoId = parseVideoId(text);
  const key = nextKey;
  nextKey += 1;
  entries.value.unshift({
    key,
    input: text,
    videoId,
    state: videoId === null ? "error" : "pending",
    message: videoId === null ? "That does not look like a YouTube video URL or id." : "Adding...",
    title: null,
    channelTitle: null,
  });
  if (videoId === null) return;
  const update = (patch: Partial<Entry>): void => {
    const entry = entries.value.find((candidate) => candidate.key === key);
    if (entry !== undefined) Object.assign(entry, patch);
  };
  chain = chain.then(async () => {
    try {
      const result = await quickAddVideo(api, videoId);
      update({
        state: "ok",
        message: quickAddMessage(result),
        title: result.title,
        channelTitle: result.channel_title,
      });
    } catch (cause) {
      update({ state: "error", message: normalizeError(cause).message });
    }
  });
}

function submit(): void {
  add(input.value);
  input.value = "";
  focusField();
}

function onPaste(event: ClipboardEvent): void {
  const pasted = event.clipboardData?.getData("text") ?? "";
  const plan = planPaste(input.value, pasted);
  if (plan.submit.length === 0 && plan.rest === input.value) return;
  event.preventDefault();
  for (const link of plan.submit) add(link);
  input.value = plan.rest;
}
</script>

<template>
  <section>
    <PageHeader
      title="Quick add"
      description="Paste a video link and press Enter. The video is downloaded right away and kept forever; your other rules still apply to it."
    />
    <form class="quick-form cellar-card" data-test="quick-form" @submit.prevent="submit">
      <div class="cellar-field quick-form__field">
        <label for="quick-input">Video URL or id</label>
        <InputText
          id="quick-input"
          ref="field"
          v-model="input"
          placeholder="https://www.youtube.com/watch?v=..., a youtu.be link or an 11-character id"
          autocomplete="off"
          autofocus
          data-test="quick-input"
          @paste="onPaste"
        />
        <small class="cellar-note">
          Paste several links at once to add them all. The last one waits for Enter unless the paste
          ends with a new line.
        </small>
      </div>
      <Button type="submit" label="Add" :disabled="input.trim() === ''" data-test="quick-submit" />
    </form>

    <ul v-if="entries.length > 0" class="quick-list" aria-live="polite" data-test="quick-list">
      <li
        v-for="entry in entries"
        :key="entry.key"
        class="quick-entry cellar-card"
        :class="`quick-entry--${entry.state}`"
        :data-state="entry.state"
        data-test="quick-entry"
      >
        <AppIcon
          :name="entry.state === 'error' ? 'about' : 'quickadd'"
          :size="18"
          class="quick-entry__icon"
        />
        <div class="quick-entry__body">
          <div class="quick-entry__title">
            <VideoLink v-if="entry.videoId" :video-id="entry.videoId">
              {{ entry.title ?? entry.videoId }}
            </VideoLink>
            <span v-else class="mono">{{ entry.input }}</span>
            <span v-if="entry.channelTitle" class="cellar-muted"> - {{ entry.channelTitle }}</span>
          </div>
          <div class="quick-entry__message" data-test="quick-message">{{ entry.message }}</div>
          <div v-if="entry.videoId && entry.title" class="cellar-note mono">
            {{ entry.videoId }}
          </div>
        </div>
      </li>
    </ul>
    <EmptyState
      v-else
      icon="quickadd"
      title="Nothing added yet"
      description="Videos you add show up here with a confirmation."
    />
  </section>
</template>

<style scoped>
.quick-form {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.quick-form__field {
  flex: 1;
}

.quick-form > :deep(button) {
  margin-top: 1.45rem;
}

.quick-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.quick-entry {
  display: flex;
  gap: 0.7rem;
  align-items: flex-start;
  padding: 0.7rem 0.9rem;
}

.quick-entry__icon {
  margin-top: 0.15rem;
  flex: none;
}

.quick-entry__body {
  min-width: 0;
  overflow-wrap: anywhere;
}

.quick-entry__title {
  font-weight: 600;
}

.quick-entry__message {
  font-size: 0.9rem;
  color: var(--p-text-muted-color);
}

.quick-entry--ok .quick-entry__icon,
.quick-entry--ok .quick-entry__message {
  color: var(--cellar-success);
}

.quick-entry--error {
  border-color: var(--cellar-error-border);
  background: var(--cellar-error-bg);
}

.quick-entry--error .quick-entry__icon,
.quick-entry--error .quick-entry__message {
  color: var(--cellar-error);
}
</style>
