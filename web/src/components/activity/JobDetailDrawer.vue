<script setup lang="ts">
import { ref, watch } from "vue";
import Button from "primevue/button";
import Drawer from "primevue/drawer";
import Tag from "primevue/tag";
import { normalizeError, type ApiClientError } from "../../api/client.ts";
import { useApi } from "../../api/provide.ts";
import { getJob, listJobLogs, type JobLogFile, type JobRow } from "../../api/jobs.ts";
import { formatAbsolute, formatBytes, formatRelative } from "../../lib/format.ts";
import JobLogViewer from "./JobLogViewer.vue";

/**
 * Job detail: the row's facts plus the per-job log directory. Opening a file
 * shows it inline; the first file opens on its own so a failed job shows its
 * log without another click.
 */
const props = defineProps<{ visible: boolean; jobId: number | null; initial?: JobRow | null }>();
const emit = defineEmits<{ "update:visible": [boolean] }>();

const api = useApi();

const job = ref<JobRow | null>(null);
const files = ref<JobLogFile[]>([]);
const selected = ref<string | null>(null);
const loading = ref(false);
const error = ref<ApiClientError | null>(null);
const logsError = ref<ApiClientError | null>(null);

async function load(id: number): Promise<void> {
  loading.value = true;
  error.value = null;
  logsError.value = null;
  files.value = [];
  selected.value = null;
  const [jobResult, logResult] = await Promise.allSettled([getJob(api, id), listJobLogs(api, id)]);
  if (props.jobId !== id) return;
  if (jobResult.status === "fulfilled") job.value = jobResult.value;
  else if (job.value === null) error.value = normalizeError(jobResult.reason);
  if (logResult.status === "fulfilled") {
    files.value = logResult.value;
    selected.value = logResult.value[0]?.name ?? null;
  } else {
    logsError.value = normalizeError(logResult.reason);
  }
  loading.value = false;
}

watch(
  () => [props.visible, props.jobId] as const,
  ([visible, id]) => {
    if (!visible || id === null) return;
    job.value = props.initial?.id === id ? props.initial : null;
    void load(id);
  },
  { immediate: true },
);

type Severity = "secondary" | "info" | "success" | "danger" | "warn";
const STATUS_SEVERITY: Record<JobRow["status"], Severity> = {
  queued: "secondary",
  running: "info",
  done: "success",
  failed: "danger",
  cancelled: "warn",
};
</script>

<template>
  <Drawer
    :visible="visible"
    position="right"
    :header="jobId === null ? 'Job' : `Job #${jobId}`"
    class="job-drawer"
    :style="{ width: 'min(56rem, 96vw)' }"
    @update:visible="emit('update:visible', $event)"
  >
    <p v-if="error" class="job-drawer__error" role="alert">{{ error.message }}</p>

    <dl v-if="job" class="job-facts" data-job-facts>
      <div>
        <dt>Type</dt>
        <dd class="mono">{{ job.type }}</dd>
      </div>
      <div>
        <dt>Status</dt>
        <dd><Tag :value="job.status" :severity="STATUS_SEVERITY[job.status]" /></dd>
      </div>
      <div>
        <dt>Attempts</dt>
        <dd>{{ job.attempts }} / {{ job.max_attempts }}</dd>
      </div>
      <div>
        <dt>Priority</dt>
        <dd>{{ job.priority }}</dd>
      </div>
      <div>
        <dt>Created</dt>
        <dd :title="formatAbsolute(job.created_at)">{{ formatRelative(job.created_at) }}</dd>
      </div>
      <div>
        <dt>Started</dt>
        <dd :title="formatAbsolute(job.started_at)">{{ formatRelative(job.started_at) }}</dd>
      </div>
      <div>
        <dt>Finished</dt>
        <dd :title="formatAbsolute(job.finished_at)">{{ formatRelative(job.finished_at) }}</dd>
      </div>
      <div v-if="job.video_id !== null">
        <dt>Video</dt>
        <dd class="mono">{{ job.video_id }}</dd>
      </div>
      <div v-if="job.account_id !== null">
        <dt>Account</dt>
        <dd>#{{ job.account_id }}</dd>
      </div>
    </dl>
    <pre v-if="job?.error" class="job-drawer__job-error mono" data-job-error>{{ job.error }}</pre>

    <section class="job-logs" aria-label="Log files">
      <h3>Log files</h3>
      <p v-if="loading && files.length === 0" class="cellar-muted">Reading the log directory...</p>
      <p v-else-if="logsError" class="job-drawer__error">{{ logsError.message }}</p>
      <p v-else-if="files.length === 0" class="cellar-muted" data-no-logs>
        This job has no log files. Logs are kept 14 days (60 for failed jobs).
      </p>
      <div v-else class="job-logs__files" role="tablist">
        <Button
          v-for="file in files"
          :key="file.name"
          :label="`${file.name} (${formatBytes(file.size)})`"
          size="small"
          :severity="selected === file.name ? undefined : 'secondary'"
          :outlined="selected !== file.name"
          role="tab"
          :aria-selected="selected === file.name"
          :data-log-file="file.name"
          @click="selected = file.name"
        />
      </div>
      <JobLogViewer v-if="selected !== null && jobId !== null" :job-id="jobId" :name="selected" />
    </section>
  </Drawer>
</template>

<style scoped>
.job-facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: 0.75rem 1.25rem;
  margin: 0 0 1rem;
}

.job-facts dt {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--p-text-muted-color);
}

.job-facts dd {
  margin: 0.2rem 0 0;
  min-width: 0;
  overflow-wrap: anywhere;
}

.job-drawer__error {
  color: var(--cellar-error);
}

.job-drawer__job-error {
  margin: 0 0 1rem;
  padding: 0.6rem 0.75rem;
  border-radius: 8px;
  border: 1px solid var(--cellar-error-border);
  background: var(--cellar-error-bg);
  color: var(--cellar-error);
  font-size: 0.8rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.job-logs h3 {
  margin: 0 0 0.6rem;
  font-size: 0.8rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
}

.job-logs__files {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-bottom: 0.75rem;
}
</style>
