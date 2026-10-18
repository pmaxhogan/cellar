<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import Button from "primevue/button";
import Message from "primevue/message";
import ProgressBar from "primevue/progressbar";
import Select from "primevue/select";
import {
  TAKEOUT_MAX_UPLOAD_BYTES,
  type TakeoutJobResponse,
  type TakeoutUploadResponse,
} from "@cellar/shared";
import ErrorState from "../components/ErrorState.vue";
import PageHeader from "../components/PageHeader.vue";
import TakeoutChecklist from "../components/takeout/TakeoutChecklist.vue";
import TakeoutCounts from "../components/takeout/TakeoutCounts.vue";
import TakeoutDropZone from "../components/takeout/TakeoutDropZone.vue";
import TakeoutHistory from "../components/takeout/TakeoutHistory.vue";
import TakeoutPreview from "../components/takeout/TakeoutPreview.vue";
import { listAccounts, type AccountView } from "../api/accounts.ts";
import { ABORTED_PROBLEM, normalizeError, type ApiClientError } from "../api/client.ts";
import { useApi } from "../api/provide.ts";
import {
  getTakeoutJob,
  readTakeoutJobEvent,
  uploadTakeout,
  type UploadHandle,
} from "../api/takeout.ts";
import { formatBytes, pluralize } from "../lib/format.ts";
import { useEventsStore } from "../stores/events.ts";

/**
 * Google Takeout import: the export checklist, an account to attach the
 * sources to, the upload (with progress), the server's preview of what it
 * found, then the import job's live progress and final counts.
 */

type Phase = "idle" | "uploading" | "running" | "done" | "failed";

/** While the job runs, its row is also polled in case an SSE frame is missed. */
const JOB_POLL_MS = 3000;

const api = useApi();
const events = useEventsStore();

const accounts = ref<AccountView[]>([]);
const accountsLoaded = ref(false);
const accountsError = ref<ApiClientError | null>(null);
const accountId = ref<number | null>(null);

const files = ref<File[]>([]);
const rejected = ref<string[]>([]);
const phase = ref<Phase>("idle");
const uploadPct = ref(0);
const uploadError = ref<ApiClientError | null>(null);
const preview = ref<TakeoutUploadResponse | null>(null);
const job = ref<TakeoutJobResponse | null>(null);
const jobPct = ref(0);
const jobMessage = ref<string | null>(null);
const history = ref<InstanceType<typeof TakeoutHistory> | null>(null);

let handle: UploadHandle | null = null;
let poll: ReturnType<typeof setInterval> | null = null;

const accountOptions = computed(() =>
  accounts.value.map((account) => ({
    value: account.id,
    label: account.email === null ? account.label : `${account.label} (${account.email})`,
  })),
);
const totalBytes = computed(() => files.value.reduce((sum, file) => sum + file.size, 0));
const tooLarge = computed(() => totalBytes.value > TAKEOUT_MAX_UPLOAD_BYTES);
const busy = computed(() => phase.value === "uploading" || phase.value === "running");
const canUpload = computed(
  () =>
    accountId.value !== null && files.value.length > 0 && !tooLarge.value && phase.value === "idle",
);

async function loadAccounts(): Promise<void> {
  accountsError.value = null;
  try {
    accounts.value = await listAccounts(api);
    if (accountId.value === null && accounts.value.length > 0) {
      accountId.value = accounts.value[0]?.id ?? null;
    }
  } catch (cause) {
    accountsError.value = normalizeError(cause);
  } finally {
    accountsLoaded.value = true;
  }
}

function addFiles(added: File[]): void {
  const key = (file: File): string => `${file.name}:${String(file.size)}`;
  const known = new Set(files.value.map(key));
  const next = [...files.value];
  for (const file of added) {
    if (known.has(key(file))) continue;
    known.add(key(file));
    next.push(file);
  }
  files.value = next;
  uploadError.value = null;
}

function removeFile(index: number): void {
  files.value = files.value.filter((_, i) => i !== index);
}

function stopPolling(): void {
  if (poll !== null) clearInterval(poll);
  poll = null;
}

async function refreshJob(): Promise<void> {
  const id = preview.value?.job_id;
  if (id === undefined) return;
  try {
    const next = await getTakeoutJob(api, id);
    job.value = next;
    if (next.status === "done") {
      phase.value = "done";
      jobPct.value = 100;
      stopPolling();
      void history.value?.load();
    } else if (next.status === "failed" || next.status === "cancelled") {
      phase.value = "failed";
      stopPolling();
    }
  } catch {
    // The next poll or SSE frame tries again.
  }
}

async function upload(): Promise<void> {
  if (!canUpload.value || accountId.value === null) return;
  phase.value = "uploading";
  uploadPct.value = 0;
  uploadError.value = null;
  handle = uploadTakeout(api, {
    files: files.value,
    accountId: accountId.value,
    onProgress: (loaded, total) => {
      uploadPct.value = total > 0 ? Math.round((loaded / total) * 100) : 0;
    },
  });
  try {
    preview.value = await handle.promise;
    phase.value = "running";
    jobPct.value = 0;
    jobMessage.value = null;
    poll = setInterval(() => void refreshJob(), JOB_POLL_MS);
    void refreshJob();
  } catch (cause) {
    const error = normalizeError(cause);
    uploadError.value = error.problem === ABORTED_PROBLEM ? null : error;
    phase.value = "idle";
  } finally {
    handle = null;
  }
}

function cancelUpload(): void {
  handle?.abort();
}

function reset(): void {
  stopPolling();
  files.value = [];
  rejected.value = [];
  preview.value = null;
  job.value = null;
  jobPct.value = 0;
  jobMessage.value = null;
  uploadError.value = null;
  phase.value = "idle";
}

events.on((event) => {
  const id = preview.value?.job_id;
  if (id === undefined) return;
  const update = readTakeoutJobEvent(event.type, event.payload, id);
  if (update === null) return;
  if (update.type === "progress" && update.pct !== null) {
    jobPct.value = Math.round(update.pct);
    jobMessage.value = update.message;
  } else if (update.type === "done" || update.type === "failed" || update.type === "cancelled") {
    void refreshJob();
  }
});

onMounted(loadAccounts);
onBeforeUnmount(() => {
  stopPolling();
  handle?.abort();
});
</script>

<template>
  <section class="cellar-stack">
    <PageHeader
      title="Takeout"
      description="Import a Google Takeout export: watch history with real watch times, Watch later, Liked videos and subscriptions. Importing the same export twice changes nothing."
    />

    <TakeoutChecklist />

    <section class="cellar-card cellar-stack" aria-labelledby="takeout-upload-title">
      <h2 id="takeout-upload-title" class="takeout-h2">Upload</h2>

      <ErrorState :error="accountsError" title="Could not load accounts" @retry="loadAccounts" />
      <Message
        v-if="accountsLoaded && !accountsError && accounts.length === 0"
        severity="warn"
        data-test="no-accounts"
      >
        Add an account first: the import attaches sources to one.
        <a href="/accounts">Go to Accounts</a>
      </Message>

      <div v-if="accounts.length > 0" class="cellar-field takeout-account">
        <label for="takeout-account">Account</label>
        <Select
          v-model="accountId"
          input-id="takeout-account"
          :options="accountOptions"
          option-label="label"
          option-value="value"
          placeholder="Choose an account"
          :disabled="busy"
          data-test="takeout-account"
        />
      </div>

      <TakeoutDropZone v-if="phase === 'idle'" @add="addFiles" @rejected="rejected = $event" />

      <Message v-if="rejected.length > 0" severity="warn" data-test="takeout-rejected">
        Ignored {{ rejected.join(", ") }}: not a .tgz, .zip, .json or .csv file.
      </Message>

      <ul
        v-if="files.length > 0 && phase === 'idle'"
        class="takeout-files"
        data-test="takeout-files"
      >
        <li v-for="(file, index) in files" :key="`${file.name}:${file.size}`">
          <span>{{ file.name }}</span>
          <span class="cellar-muted">{{ formatBytes(file.size) }}</span>
          <Button
            label="Remove"
            size="small"
            text
            severity="secondary"
            data-action="remove-file"
            @click="removeFile(index)"
          />
        </li>
      </ul>

      <Message v-if="tooLarge" severity="error" data-test="takeout-too-large">
        These files add up to {{ formatBytes(totalBytes) }}, over the 2 GB upload limit. Upload the
        parts of a split export one at a time.
      </Message>

      <Message v-if="uploadError" severity="error" data-test="takeout-error">
        {{ uploadError.message }}
      </Message>

      <div v-if="phase === 'idle'" class="cellar-row">
        <Button
          label="Upload and import"
          data-action="upload"
          :disabled="!canUpload"
          @click="upload"
        />
        <span v-if="files.length > 0" class="cellar-muted">
          {{ pluralize(files.length, "file") }}, {{ formatBytes(totalBytes) }}
        </span>
      </div>

      <div v-if="phase === 'uploading'" class="cellar-stack" data-test="takeout-uploading">
        <span>Uploading {{ uploadPct }}%</span>
        <ProgressBar :value="uploadPct" :show-value="false" style="height: 0.5rem" />
        <div>
          <Button
            label="Cancel upload"
            size="small"
            severity="secondary"
            data-action="cancel-upload"
            @click="cancelUpload"
          />
        </div>
      </div>
    </section>

    <section
      v-if="preview"
      class="cellar-card cellar-stack"
      aria-labelledby="takeout-result-title"
      data-test="takeout-result"
      :data-phase="phase"
    >
      <h2 id="takeout-result-title" class="takeout-h2">What the export contains</h2>
      <TakeoutPreview :preview="preview" />

      <div v-if="phase === 'running'" class="cellar-stack" data-test="takeout-progress">
        <span>
          Importing {{ jobPct }}%<template v-if="jobMessage">: {{ jobMessage }}</template>
        </span>
        <ProgressBar :value="jobPct" :show-value="false" style="height: 0.5rem" />
      </div>

      <template v-if="phase === 'done' && job?.counts">
        <Message severity="success" data-test="takeout-done">Import finished.</Message>
        <TakeoutCounts :counts="job.counts" />
      </template>

      <Message v-if="phase === 'failed'" severity="error" data-test="takeout-failed">
        The import {{ job?.status === "cancelled" ? "was cancelled" : "failed" }}.
        <template v-if="job?.error">{{ job.error }}</template>
        The job's log on the Activity page has the details.
      </Message>

      <div v-if="phase === 'done' || phase === 'failed'">
        <Button label="Import another export" size="small" data-action="reset" @click="reset" />
      </div>
    </section>

    <TakeoutHistory ref="history" />
  </section>
</template>

<style scoped>
.takeout-h2 {
  margin: 0;
  font-size: 1rem;
  font-weight: 650;
}

.takeout-account {
  max-width: 28rem;
}

.takeout-files {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.88rem;
}

.takeout-files li {
  display: flex;
  gap: 0.6rem;
  align-items: center;
  flex-wrap: wrap;
}
</style>
