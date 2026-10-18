<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import type { ConditionNode, RulePreview } from "@cellar/shared";
import { normalizeError, ABORTED_PROBLEM } from "../../api/client.ts";
import { useApi } from "../../api/provide.ts";
import { PREVIEW_DEBOUNCE_MS, previewCondition } from "../../api/rules.ts";
import { formatNumber } from "../../lib/format.ts";

/**
 * Live "matches N of T videos" preview for a condition. Asks
 * POST /api/rules/preview 400 ms after the last edit, cancels a request that
 * an edit made stale, and stays quiet while the condition is invalid.
 */
const props = defineProps<{ condition: ConditionNode | null; valid: boolean }>();

const api = useApi();
const preview = ref<RulePreview | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
let timer: ReturnType<typeof setTimeout> | null = null;
let controller: AbortController | null = null;

function cancel(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  controller?.abort();
  controller = null;
}

async function run(condition: ConditionNode): Promise<void> {
  const mine = new AbortController();
  controller = mine;
  loading.value = true;
  try {
    preview.value = await previewCondition(api, condition, mine.signal);
    error.value = null;
  } catch (cause) {
    const problem = normalizeError(cause);
    if (problem.problem === ABORTED_PROBLEM || mine.signal.aborted) return;
    error.value = problem.message;
  } finally {
    if (controller === mine) {
      loading.value = false;
      controller = null;
    }
  }
}

watch(
  () => [JSON.stringify(props.condition), props.valid] as const,
  () => {
    cancel();
    const condition = props.condition;
    if (!props.valid || condition === null) {
      loading.value = false;
      return;
    }
    loading.value = true;
    timer = setTimeout(() => {
      timer = null;
      void run(condition);
    }, PREVIEW_DEBOUNCE_MS);
  },
  { immediate: true },
);

onBeforeUnmount(cancel);
</script>

<template>
  <aside class="rule-preview cellar-card" aria-live="polite" data-test="rule-preview">
    <h3>Preview</h3>
    <p v-if="!valid" class="cellar-note" data-test="preview-invalid">
      Fix the highlighted conditions to see what this rule matches.
    </p>
    <p v-else-if="error" class="rule-preview__error" data-test="preview-error">{{ error }}</p>
    <template v-else-if="preview">
      <p class="rule-preview__count" data-test="preview-count">
        Matches <strong>{{ formatNumber(preview.count) }}</strong> of
        {{ formatNumber(preview.total) }} videos
      </p>
      <ul v-if="preview.sample.length > 0" class="rule-preview__sample">
        <li v-for="video in preview.sample" :key="video.id" data-test="preview-sample">
          <span>{{ video.title }}</span>
          <span v-if="video.channel_title" class="cellar-muted"> - {{ video.channel_title }}</span>
        </li>
      </ul>
    </template>
    <p v-if="loading" class="cellar-note" data-test="preview-loading">Counting matches...</p>
  </aside>
</template>

<style scoped>
.rule-preview h3 {
  margin: 0 0 0.5rem;
  font-size: 0.95rem;
}

.rule-preview__count {
  margin: 0 0 0.5rem;
}

.rule-preview__error {
  margin: 0;
  color: var(--cellar-error);
}

.rule-preview__sample {
  margin: 0;
  padding-left: 1.1rem;
  font-size: 0.85rem;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
</style>
