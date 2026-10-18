<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import Button from "primevue/button";
import { normalizeError, type ApiClientError } from "../../api/client.ts";
import { useApi } from "../../api/provide.ts";
import { fetchJobLog } from "../../api/jobs.ts";
import { formatNumber } from "../../lib/format.ts";

/**
 * One job log file, inline. Tail first: a yt-dlp log is long and the end is
 * where the failure is, so only the last TAIL_LINES lines render until the
 * user asks for the whole file, and the view starts scrolled to the bottom.
 */
interface JobLogViewerProps {
  jobId: number;
  name: string;
  tailLines?: number;
}

const props = withDefaults(defineProps<JobLogViewerProps>(), { tailLines: 400 });

const api = useApi();

const content = ref<string | null>(null);
const loading = ref(false);
const error = ref<ApiClientError | null>(null);
const showAll = ref(false);
const pre = ref<HTMLElement | null>(null);

const lines = computed(() => {
  const text = content.value ?? "";
  const split = text.split(/\r?\n/);
  // A trailing newline is not an extra empty line.
  if (split.length > 0 && split[split.length - 1] === "") split.pop();
  return split;
});

const hiddenCount = computed(() =>
  showAll.value ? 0 : Math.max(0, lines.value.length - props.tailLines),
);

const visible = computed(() =>
  hiddenCount.value === 0 ? lines.value.join("\n") : lines.value.slice(-props.tailLines).join("\n"),
);

const rawUrl = computed(
  () => `${api.baseUrl}/api/jobs/${props.jobId}/log/${encodeURIComponent(props.name)}`,
);

let inflight: AbortController | null = null;

async function load(): Promise<void> {
  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;
  loading.value = true;
  showAll.value = false;
  try {
    content.value = await fetchJobLog(api, props.jobId, props.name, controller.signal);
    error.value = null;
    await nextTick();
    scrollToEnd();
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

function scrollToEnd(): void {
  const element = pre.value;
  if (element !== null) element.scrollTop = element.scrollHeight;
}

watch(
  () => [props.jobId, props.name] as const,
  () => {
    void load();
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  inflight?.abort();
});
</script>

<template>
  <div class="job-log" :data-log="name">
    <div class="job-log__bar">
      <span class="mono job-log__name">{{ name }}</span>
      <span v-if="content !== null" class="cellar-muted job-log__count">
        {{ formatNumber(lines.length) }} lines
      </span>
      <span class="job-log__spacer" />
      <Button
        label="Reload"
        size="small"
        severity="secondary"
        text
        :loading="loading"
        data-log-action="reload"
        @click="load"
      />
      <a :href="rawUrl" target="_blank" rel="noopener" class="job-log__raw">Open raw</a>
    </div>
    <p v-if="error" class="job-log__error" role="alert">{{ error.message }}</p>
    <template v-else-if="content !== null">
      <div v-if="hiddenCount > 0" class="job-log__more" data-log-truncated>
        <span>Showing the last {{ formatNumber(tailLines) }} lines.</span>
        <Button
          :label="`Show all ${formatNumber(lines.length)} lines`"
          size="small"
          severity="secondary"
          text
          data-log-action="show-all"
          @click="showAll = true"
        />
      </div>
      <pre ref="pre" class="job-log__text mono" tabindex="0">{{ visible }}</pre>
      <p v-if="lines.length === 0" class="cellar-muted job-log__empty">This log file is empty.</p>
    </template>
    <p v-else class="cellar-muted">Loading the log...</p>
  </div>
</template>

<style scoped>
.job-log {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.job-log__bar {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
  font-size: 0.85rem;
}

.job-log__spacer {
  flex: 1;
}

.job-log__raw {
  color: var(--p-primary-color);
  text-decoration: none;
  font-size: 0.85rem;
}

.job-log__more {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.82rem;
  color: var(--p-text-muted-color);
}

.job-log__text {
  margin: 0;
  max-height: 60vh;
  overflow: auto;
  padding: 0.75rem;
  border-radius: 8px;
  border: 1px solid var(--p-content-border-color);
  background: var(--p-surface-950, #151013);
  color: var(--p-text-color);
  font-size: 0.78rem;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

:root:not(.cellar-dark) .job-log__text {
  background: var(--p-surface-50, #faf7f8);
}

.job-log__error {
  margin: 0;
  color: var(--cellar-error);
}

.job-log__empty {
  margin: 0;
  font-size: 0.85rem;
}
</style>
