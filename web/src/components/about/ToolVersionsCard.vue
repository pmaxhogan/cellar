<script setup lang="ts">
import { computed, ref } from "vue";
import Button from "primevue/button";
import Tag from "primevue/tag";
import { useApi } from "../../api/provide.ts";
import {
  TOOL_LABELS,
  TOOL_NAMES,
  rollbackTool,
  updateAvailable,
  updateTools,
  type ToolName,
  type ToolsResponse,
} from "../../api/tools.ts";
import { formatAbsolute, formatRelative } from "../../lib/format.ts";
import { useToaster } from "../../lib/toast.ts";
import ConfirmDialog from "../ConfirmDialog.vue";

/**
 * yt-dlp and ffmpeg versions as the updater sees them: what runs now, what it
 * replaced (the rollback target), what the image shipped, and the newest
 * release the last check found. Every action answers with the new state.
 */
const props = defineProps<{ tools: ToolsResponse }>();
const emit = defineEmits<{ "update:tools": [ToolsResponse] }>();

const api = useApi();
const toast = useToaster();

type Busy = "check" | `update:${ToolName}` | `rollback:${ToolName}`;
const busy = ref<Busy | null>(null);
const rollbackTarget = ref<ToolName | null>(null);

const rows = computed(() =>
  TOOL_NAMES.map((name) => ({
    name,
    label: TOOL_LABELS[name],
    versions: props.tools[name],
    available: updateAvailable(props.tools[name]),
  })),
);

async function checkForUpdates(): Promise<void> {
  busy.value = "check";
  try {
    const next = await updateTools(api, {});
    emit("update:tools", next);
    const newer = TOOL_NAMES.filter((name) => updateAvailable(next[name]));
    if (newer.length === 0) toast.success("Tools are up to date");
    else toast.info("Updates available", newer.map((name) => TOOL_LABELS[name]).join(", "));
  } catch (cause) {
    toast.failure("Could not check for updates", cause);
  } finally {
    busy.value = null;
  }
}

async function updateNow(name: ToolName): Promise<void> {
  busy.value = `update:${name}`;
  try {
    const next = await updateTools(api, { tool: name, force: true });
    emit("update:tools", next);
    toast.success(`${TOOL_LABELS[name]} updated`, next[name].current ?? undefined);
  } catch (cause) {
    toast.failure(`Could not update ${TOOL_LABELS[name]}`, cause);
  } finally {
    busy.value = null;
  }
}

async function confirmRollback(): Promise<void> {
  const name = rollbackTarget.value;
  if (name === null) return;
  busy.value = `rollback:${name}`;
  try {
    const next = await rollbackTool(api, name);
    emit("update:tools", next);
    toast.success(`${TOOL_LABELS[name]} rolled back`, next[name].current ?? undefined);
    rollbackTarget.value = null;
  } catch (cause) {
    toast.failure(`Could not roll back ${TOOL_LABELS[name]}`, cause);
  } finally {
    busy.value = null;
  }
}

function onRollbackVisible(open: boolean): void {
  if (!open) rollbackTarget.value = null;
}

const rollbackMessage = computed(() => {
  const name = rollbackTarget.value;
  if (name === null) return "";
  const versions = props.tools[name];
  return `Cellar will switch ${TOOL_LABELS[name]} from ${versions.current ?? "the current build"} back to ${versions.previous ?? "the previous build"}.`;
});
</script>

<template>
  <article class="cellar-card tool-versions">
    <div class="tool-versions__head">
      <h3>Tools</h3>
      <Button
        label="Check for updates"
        size="small"
        severity="secondary"
        :loading="busy === 'check'"
        :disabled="busy !== null"
        data-tool-action="check"
        @click="checkForUpdates"
      />
    </div>

    <div class="tool-versions__scroll">
      <table class="tool-versions__table">
        <thead>
          <tr>
            <th scope="col">Tool</th>
            <th scope="col">Current</th>
            <th scope="col">Previous</th>
            <th scope="col">Baseline</th>
            <th scope="col">Latest</th>
            <th scope="col">Checked</th>
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.name" :data-tool-row="row.name">
            <th scope="row">{{ row.label }}</th>
            <td class="mono" data-version="current">
              <template v-if="row.versions.current !== null">{{ row.versions.current }}</template>
              <Tag v-else value="not found" severity="warn" />
            </td>
            <td class="mono" data-version="previous">{{ row.versions.previous ?? "-" }}</td>
            <td class="mono" data-version="baseline">{{ row.versions.baseline ?? "-" }}</td>
            <td class="mono" data-version="latest">
              {{ row.versions.latest ?? "-" }}
              <Tag v-if="row.available" value="update available" severity="info" />
            </td>
            <td :title="formatAbsolute(row.versions.checked_at)" data-version="checked">
              {{ formatRelative(row.versions.checked_at) }}
            </td>
            <td class="tool-versions__actions">
              <Button
                label="Update now"
                size="small"
                :severity="row.available ? undefined : 'secondary'"
                :outlined="!row.available"
                :loading="busy === `update:${row.name}`"
                :disabled="busy !== null"
                :title="
                  row.available
                    ? `Install ${row.versions.latest}`
                    : 'Download and install the newest release now'
                "
                data-tool-action="update"
                @click="updateNow(row.name)"
              />
              <Button
                label="Roll back"
                size="small"
                severity="secondary"
                text
                :loading="busy === `rollback:${row.name}`"
                :disabled="busy !== null || row.versions.previous === null"
                :title="
                  row.versions.previous === null
                    ? 'There is no previous build to roll back to'
                    : `Switch back to ${row.versions.previous}`
                "
                data-tool-action="rollback"
                @click="rollbackTarget = row.name"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <dl class="tool-versions__facts">
      <div>
        <dt>JS runtime</dt>
        <dd class="mono" data-fact="js-runtime">{{ tools.js_runtime ?? "none detected" }}</dd>
      </div>
      <div>
        <dt>PO-token provider</dt>
        <dd class="mono" data-fact="pot-provider">{{ tools.pot_provider_url ?? "not set" }}</dd>
      </div>
    </dl>
    <p class="cellar-note">
      A daily check fetches newer yt-dlp and ffmpeg builds. The previous build is kept so an update
      that breaks downloads can be rolled back.
    </p>

    <ConfirmDialog
      :visible="rollbackTarget !== null"
      title="Roll back this tool?"
      :message="rollbackMessage"
      confirm-label="Roll back"
      danger
      :busy="busy !== null"
      @update:visible="onRollbackVisible"
      @confirm="confirmRollback"
    />
  </article>
</template>

<style scoped>
.tool-versions__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}

.tool-versions__head h3 {
  margin: 0;
  font-size: 0.8rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
}

.tool-versions__scroll {
  overflow-x: auto;
}

.tool-versions__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88rem;
}

.tool-versions__table th,
.tool-versions__table td {
  padding: 0.45rem 0.6rem;
  border-bottom: 1px solid var(--p-content-border-color);
  text-align: left;
  vertical-align: middle;
}

.tool-versions__table thead th {
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--p-text-muted-color);
}

.tool-versions__table td.mono {
  white-space: nowrap;
}

.tool-versions__actions {
  white-space: nowrap;
  text-align: right;
}

.tool-versions__facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: 0.75rem 1.25rem;
  margin: 1rem 0 0.5rem;
}

.tool-versions__facts dt {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--p-text-muted-color);
}

.tool-versions__facts dd {
  margin: 0.2rem 0 0;
  overflow-wrap: anywhere;
}
</style>
