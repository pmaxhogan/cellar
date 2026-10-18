<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import InputText from "primevue/inputtext";
import SelectButton from "primevue/selectbutton";
import {
  DEFAULT_FILENAME_TEMPLATE,
  type BulkDownloadEstimate,
  type BulkKind,
  type VideoRow,
} from "@cellar/shared";
import { ABORTED_PROBLEM, normalizeError, type ApiClientError } from "../../api/client.ts";
import { useApi } from "../../api/provide.ts";
import { estimateBulkDownload } from "../../api/videos.ts";
import {
  BULK_KIND_OPTIONS,
  FIELD_HINTS,
  TEMPLATE_FIELDS,
  previewNames,
  submitZipDownload,
  templateProblem,
} from "../../lib/bulkDownload.ts";
import {
  downloadToFolder,
  pickDirectory,
  supportsDirectoryPicker,
  type FolderItem,
} from "../../lib/folderDownload.ts";
import { formatBytes, pluralize } from "../../lib/format.ts";
import { useToaster } from "../../lib/toast.ts";

/**
 * Bulk download of a selection: pick what to download and how to name it, see
 * how big it is, then either post a form for a streamed ZIP (the browser
 * writes it to disk) or, where the File System Access API exists, write each
 * file into a folder the user picks.
 */
const props = defineProps<{
  visible: boolean;
  ids: readonly string[];
  /** The first selected video, for the filename preview. */
  sample: VideoRow | null;
}>();
const emit = defineEmits<{ "update:visible": [boolean] }>();

const api = useApi();
const toast = useToaster();

const kind = ref<BulkKind>("video");
const template = ref(DEFAULT_FILENAME_TEMPLATE);
const estimate = ref<BulkDownloadEstimate | null>(null);
const estimating = ref(false);
const estimateError = ref<ApiClientError | null>(null);
const folderItems = ref<FolderItem[]>([]);
const folderRunning = ref(false);
const folderSummary = ref<string | null>(null);
let estimateController: AbortController | null = null;
let folderController: AbortController | null = null;

const problem = computed(() => templateProblem(template.value));
const preview = computed(() =>
  props.sample === null ? [] : previewNames(template.value, props.sample, kind.value),
);
const canFolder = computed(() => props.visible && supportsDirectoryPicker());
const nothingToSend = computed(() => estimate.value !== null && estimate.value.files === 0);
const blocked = computed(
  () =>
    props.ids.length === 0 ||
    problem.value !== null ||
    estimating.value ||
    nothingToSend.value ||
    folderRunning.value,
);
const kindHint = computed(
  () => BULK_KIND_OPTIONS.find((option) => option.value === kind.value)?.hint ?? "",
);
const doneCount = computed(() => folderItems.value.filter((item) => item.state === "done").length);

async function runEstimate(): Promise<void> {
  estimateController?.abort();
  if (!props.visible || props.ids.length === 0) return;
  const controller = new AbortController();
  estimateController = controller;
  estimating.value = true;
  estimateError.value = null;
  try {
    estimate.value = await estimateBulkDownload(api, props.ids, kind.value, controller.signal);
  } catch (cause) {
    const normalized = normalizeError(cause);
    if (normalized.problem === ABORTED_PROBLEM) return;
    estimate.value = null;
    estimateError.value = normalized;
  } finally {
    if (estimateController === controller) {
      estimating.value = false;
      estimateController = null;
    }
  }
}

watch(
  () => [props.visible, props.ids, kind.value] as const,
  ([visible]) => {
    if (visible) {
      void runEstimate();
    } else {
      estimateController?.abort();
    }
  },
  { immediate: true },
);

function close(): void {
  if (folderRunning.value) return;
  emit("update:visible", false);
}

function downloadZip(): void {
  if (blocked.value) return;
  submitZipDownload({ ids: props.ids, kind: kind.value, template: template.value });
  toast.info(
    "Download started",
    "The browser saves the ZIP as it streams. Large selections can take a while to begin.",
  );
  emit("update:visible", false);
}

async function saveToFolder(): Promise<void> {
  if (blocked.value) return;
  const directory = await pickDirectory();
  if (directory === null) return;
  const controller = new AbortController();
  folderController = controller;
  folderRunning.value = true;
  folderItems.value = [];
  folderSummary.value = null;
  try {
    const result = await downloadToFolder({
      api,
      ids: props.ids,
      kind: kind.value,
      template: template.value,
      directory,
      signal: controller.signal,
      onProgress: (items) => {
        folderItems.value = items;
      },
    });
    folderItems.value = result.items;
    const parts = [`${pluralize(result.written, "file")} written to ${directory.name}`];
    if (result.failed > 0) parts.push(`${pluralize(result.failed, "file")} failed`);
    if (result.cancelled) parts.push("canceled");
    folderSummary.value = `${parts.join(", ")}.`;
    if (result.cancelled) {
      toast.warn("Folder download canceled", folderSummary.value);
    } else if (result.failed > 0) {
      toast.warn("Folder download finished with errors", folderSummary.value);
    } else {
      toast.success("Folder download finished", folderSummary.value);
    }
  } catch (cause) {
    toast.failure("Folder download failed", cause);
  } finally {
    folderRunning.value = false;
    folderController = null;
  }
}

function cancelFolder(): void {
  folderController?.abort();
}

function fieldToken(field: string): string {
  return `{${field}}`;
}

function insertField(field: string): void {
  template.value = `${template.value}${fieldToken(field)}`;
}

function itemLabel(item: FolderItem): string {
  switch (item.state) {
    case "done":
      return formatBytes(item.bytes);
    case "writing":
      return item.size === null
        ? formatBytes(item.bytes)
        : `${formatBytes(item.bytes)} of ${formatBytes(item.size)}`;
    case "skipped":
      return "no files";
    case "failed":
      return item.error ?? "failed";
    case "pending":
      return "waiting";
  }
}

onBeforeUnmount(() => {
  estimateController?.abort();
  folderController?.abort();
});
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    header="Download selection"
    :style="{ width: 'min(44rem, 94vw)' }"
    :closable="!folderRunning"
    data-test="bulk-dialog"
    @update:visible="(value: boolean) => (value ? emit('update:visible', true) : close())"
  >
    <div class="bulk cellar-stack">
      <p class="cellar-muted bulk__count" data-test="bulk-count">
        {{ pluralize(ids.length, "video") }} selected.
      </p>

      <div class="cellar-field">
        <label>What to download</label>
        <SelectButton
          v-model="kind"
          :options="BULK_KIND_OPTIONS"
          option-label="label"
          option-value="value"
          :allow-empty="false"
          :disabled="folderRunning"
          aria-label="What to download"
          data-test="bulk-kind"
        />
        <small class="cellar-note">{{ kindHint }}</small>
      </div>

      <div class="cellar-field">
        <label for="bulk-template">Filename template</label>
        <InputText
          id="bulk-template"
          v-model="template"
          :invalid="problem !== null"
          :disabled="folderRunning"
          autocomplete="off"
          spellcheck="false"
          data-test="bulk-template"
        />
        <small v-if="problem" class="bulk__error" data-test="bulk-template-problem">{{
          problem
        }}</small>
        <div class="bulk__fields" data-test="bulk-fields">
          <button
            v-for="field in TEMPLATE_FIELDS"
            :key="field"
            type="button"
            class="bulk__field"
            :title="FIELD_HINTS[field]"
            :data-field="field"
            :disabled="folderRunning"
            @click="insertField(field)"
          >
            {{ fieldToken(field) }}
          </button>
        </div>
        <div v-if="preview.length > 0" class="bulk__preview" data-test="bulk-preview">
          <span class="cellar-note">Preview for the first video:</span>
          <code v-for="name in preview" :key="name" data-test="bulk-preview-name">{{ name }}</code>
        </div>
      </div>

      <div class="bulk__estimate" data-test="bulk-estimate">
        <span v-if="estimating" class="cellar-muted">Estimating size...</span>
        <span v-else-if="estimateError" class="bulk__error" data-test="bulk-estimate-error">
          Could not estimate the size: {{ estimateError.message }}
          <Button label="Retry" size="small" text @click="runEstimate" />
        </span>
        <template v-else-if="estimate">
          <span data-test="bulk-estimate-text">
            {{ pluralize(estimate.files, "file") }}, {{ formatBytes(estimate.bytes) }}
          </span>
          <span v-if="nothingToSend" class="bulk__error" data-test="bulk-nothing">
            None of the selected videos has a file of this kind on disk.
          </span>
        </template>
      </div>
      <div v-if="estimate?.warn" class="bulk__warn" role="alert" data-test="bulk-warn">
        <strong>Warning:</strong> this download is larger than the configured warning size. There is
        no cap, but make sure the destination has room for {{ formatBytes(estimate.bytes) }}.
      </div>

      <div v-if="folderItems.length > 0" class="bulk__progress" data-test="bulk-progress">
        <p class="cellar-note">
          {{ doneCount }} of {{ pluralize(folderItems.length, "file") }} written<span
            v-if="folderRunning"
            >...</span
          >
        </p>
        <ul>
          <li
            v-for="(item, index) in folderItems"
            :key="`${index}-${item.name}`"
            :data-state="item.state"
            data-test="bulk-progress-item"
          >
            <span class="bulk__name">{{ item.name }}</span>
            <span class="cellar-muted">{{ itemLabel(item) }}</span>
          </li>
        </ul>
        <p v-if="folderSummary" class="cellar-note" data-test="bulk-summary">
          {{ folderSummary }}
        </p>
      </div>
    </div>

    <template #footer>
      <Button
        v-if="folderRunning"
        label="Cancel download"
        severity="danger"
        text
        data-test="bulk-cancel"
        @click="cancelFolder"
      />
      <Button v-else label="Close" severity="secondary" text @click="close" />
      <Button
        v-if="canFolder"
        label="Save to folder"
        severity="secondary"
        :disabled="blocked"
        :loading="folderRunning"
        data-test="bulk-folder"
        @click="saveToFolder"
      />
      <Button label="Download ZIP" :disabled="blocked" data-test="bulk-zip" @click="downloadZip" />
    </template>
  </Dialog>
</template>

<style scoped>
.bulk__count {
  margin: 0;
}

.bulk__fields {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin-top: 0.35rem;
}

.bulk__field {
  font: inherit;
  font-family: ui-monospace, "SFMono-Regular", "Cascadia Mono", Menlo, monospace;
  font-size: 0.78rem;
  padding: 0.15rem 0.45rem;
  border-radius: 999px;
  border: 1px solid var(--p-content-border-color);
  background: var(--p-content-background);
  color: var(--p-text-color);
  cursor: pointer;
}

.bulk__field:hover:not(:disabled) {
  background: var(--p-content-hover-background);
}

.bulk__preview {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  margin-top: 0.5rem;
}

.bulk__preview code {
  font-size: 0.82rem;
  word-break: break-all;
}

.bulk__estimate {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: center;
}

.bulk__warn {
  padding: 0.6rem 0.8rem;
  border-radius: 6px;
  border: 1px solid var(--cellar-error);
  color: var(--p-text-color);
  background: color-mix(in srgb, var(--cellar-error) 12%, transparent);
}

.bulk__error {
  color: var(--cellar-error);
}

.bulk__progress ul {
  list-style: none;
  margin: 0.35rem 0 0;
  padding: 0;
  max-height: 14rem;
  overflow: auto;
  font-size: 0.85rem;
}

.bulk__progress li {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.2rem 0;
  border-bottom: 1px solid var(--p-content-border-color);
}

.bulk__progress li[data-state="failed"] .cellar-muted {
  color: var(--cellar-error);
}

.bulk__name {
  word-break: break-all;
}
</style>
