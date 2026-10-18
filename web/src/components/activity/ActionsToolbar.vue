<script setup lang="ts">
import { ref } from "vue";
import Button from "primevue/button";
import { normalizeError } from "../../api/client.ts";
import { useApi } from "../../api/provide.ts";
import { ACTIONS, isNotImplemented, runAction, type ActionInfo } from "../../api/actions.ts";
import { useToaster } from "../../lib/toast.ts";

/** The manual scheduler actions. Each queues a job and reports its id. */
const emit = defineEmits<{ queued: [jobId: number] }>();

const api = useApi();
const toast = useToaster();

const running = ref<Set<string>>(new Set());
/** Actions the server answered 501 for: the route exists, the handler does not. */
const unavailable = ref<Set<string>>(new Set());

function setRunning(name: string, on: boolean): void {
  const next = new Set(running.value);
  if (on) next.add(name);
  else next.delete(name);
  running.value = next;
}

async function run(action: ActionInfo): Promise<void> {
  setRunning(action.name, true);
  try {
    const result = await runAction(api, action.name);
    toast.success(`${action.label} queued`, `Job #${result.job_id}`);
    emit("queued", result.job_id);
  } catch (cause) {
    const error = normalizeError(cause);
    if (isNotImplemented(error)) {
      unavailable.value = new Set(unavailable.value).add(action.name);
      toast.warn(
        `${action.label} is not available yet`,
        "This server does not run that action in this release.",
      );
    } else {
      toast.failure(`${action.label} failed`, error);
    }
  } finally {
    setRunning(action.name, false);
  }
}

function title(action: ActionInfo): string {
  return unavailable.value.has(action.name)
    ? `${action.description} Not available yet on this server.`
    : action.description;
}
</script>

<template>
  <div class="actions-toolbar" role="toolbar" aria-label="Scheduler actions">
    <Button
      v-for="action in ACTIONS"
      :key="action.name"
      :label="action.label"
      size="small"
      :severity="unavailable.has(action.name) ? 'secondary' : undefined"
      :outlined="unavailable.has(action.name)"
      :loading="running.has(action.name)"
      :disabled="running.has(action.name)"
      :title="title(action)"
      :data-run-action="action.name"
      :data-unavailable="unavailable.has(action.name) ? 'true' : undefined"
      @click="run(action)"
    />
  </div>
</template>

<style scoped>
.actions-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 1rem;
}
</style>
