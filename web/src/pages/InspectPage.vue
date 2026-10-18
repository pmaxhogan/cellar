<script setup lang="ts">
import { computed, inject, ref, watch } from "vue";
import { routeLocationKey, routerKey } from "vue-router";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import { parseVideoId } from "@cellar/shared";
import { useApi } from "../api/provide.ts";
import EmptyState from "../components/EmptyState.vue";
import PageHeader from "../components/PageHeader.vue";
import InspectPanel from "../components/inspect/InspectPanel.vue";
import { provideRuleLookups } from "../lib/rulesLookups.ts";

/**
 * Paste any video URL or id; the id is normalised in the browser with the
 * shared parser, then the panel shows the matching rules, the effective
 * settings with provenance and the per-video overrides. The inspected id is
 * mirrored into `?id=` so the view can be linked and reloaded.
 */
provideRuleLookups(useApi());
const router = inject(routerKey, null);
const route = inject(routeLocationKey, null);

function queryId(): string {
  const raw = route?.query["id"];
  return typeof raw === "string" ? raw : "";
}

const input = ref(queryId());
const parsed = computed(() => (input.value.trim() === "" ? null : parseVideoId(input.value)));
const active = ref<string | null>(parseVideoId(queryId()));
const touched = ref(false);

function inspect(): void {
  touched.value = true;
  if (parsed.value === null) return;
  active.value = parsed.value;
  if (router !== null && route?.query["id"] !== parsed.value) {
    void router.replace({ query: { ...route?.query, id: parsed.value } });
  }
}

watch(
  () => route?.query["id"],
  (next) => {
    if (typeof next !== "string") return;
    const id = parseVideoId(next);
    if (id !== null && id !== active.value) {
      input.value = next;
      active.value = id;
    }
  },
);
</script>

<template>
  <section>
    <PageHeader
      title="Inspect"
      description="Paste any video URL or id to see which rules match it and the settings they produce."
    />
    <form class="inspect-form cellar-card" data-test="inspect-form" @submit.prevent="inspect">
      <div class="cellar-field inspect-form__field">
        <label for="inspect-input">Video URL or id</label>
        <InputText
          id="inspect-input"
          v-model="input"
          placeholder="https://www.youtube.com/watch?v=... or an 11-character id"
          autocomplete="off"
          :invalid="touched && input.trim() !== '' && parsed === null"
          data-test="inspect-input"
        />
        <small v-if="parsed" class="cellar-note" data-test="inspect-parsed">
          Video id <span class="mono">{{ parsed }}</span>
        </small>
        <small
          v-else-if="input.trim() !== ''"
          class="inspect-form__error"
          data-test="inspect-invalid"
        >
          That does not look like a YouTube video URL or id.
        </small>
      </div>
      <Button
        type="submit"
        label="Inspect"
        :disabled="parsed === null"
        data-test="inspect-submit"
      />
    </form>

    <InspectPanel v-if="active" :key="active" :video-id="active" />
    <EmptyState
      v-else
      icon="inspect"
      title="Nothing inspected yet"
      description="Rules are evaluated for the video you enter, whether or not it is in the catalog yet."
    />
  </section>
</template>

<style scoped>
.inspect-form {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.inspect-form__field {
  flex: 1;
}

.inspect-form > :deep(button) {
  margin-top: 1.45rem;
}

.inspect-form__error {
  color: var(--cellar-error);
}
</style>
