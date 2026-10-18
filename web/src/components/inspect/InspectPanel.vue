<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import Button from "primevue/button";
import Tag from "primevue/tag";
import { EFFECT_KEYS, effectRegistry, type InspectResponse } from "@cellar/shared";
import { ABORTED_PROBLEM, normalizeError, type ApiClientError } from "../../api/client.ts";
import { useApi } from "../../api/provide.ts";
import { inspectVideo, setVideoOverrides } from "../../api/rules.ts";
import ConfirmDialog from "../ConfirmDialog.vue";
import ErrorState from "../ErrorState.vue";
import ListSkeleton from "../ListSkeleton.vue";
import EffectsEditor from "../rules/EffectsEditor.vue";
import { formatEffectValue } from "../../lib/ruleSummary.ts";
import { useRuleLookups } from "../../lib/rulesLookups.ts";
import { formatAbsolute } from "../../lib/format.ts";
import { useToaster } from "../../lib/toast.ts";

/**
 * Everything the rules decide about one video: the rules that match it in
 * priority order, the effective settings with the rule each value came from,
 * and an editor for the per-video override rule (PUT /api/videos/:id/overrides,
 * where null deletes the override). Used by the Inspect page and embeddable on
 * the video detail page. Needs a router for its rule links.
 */
const props = defineProps<{ videoId: string }>();
const emit = defineEmits<{ loaded: [InspectResponse] }>();

const api = useApi();
const toast = useToaster();
const lookups = useRuleLookups();

const data = ref<InspectResponse | null>(null);
const loading = ref(false);
const error = ref<ApiClientError | null>(null);
const overrides = ref<Record<string, unknown>>({});
const overridesValid = ref(true);
const saving = ref(false);
const confirmClear = ref(false);
let controller: AbortController | null = null;

const dirty = computed(
  () => JSON.stringify(overrides.value) !== JSON.stringify(data.value?.overrides ?? {}),
);
const ruleNames = computed(
  () => new Map((data.value?.matched ?? []).map((rule) => [rule.id, rule])),
);
const settings = computed(() => {
  const current = data.value;
  if (current === null) return [];
  return EFFECT_KEYS.filter((key) => key in current.effective).map((key) => {
    const source = current.provenance[key] ?? "default";
    const rule = source === "default" ? undefined : ruleNames.value.get(source);
    return {
      key,
      label: effectRegistry[key].ui.label,
      value: formatEffectValue(key, current.effective[key], lookups.labels.value),
      source,
      rule,
    };
  });
});

function adopt(next: InspectResponse): void {
  data.value = next;
  overrides.value = JSON.parse(JSON.stringify(next.overrides ?? {})) as Record<string, unknown>;
  emit("loaded", next);
}

async function load(): Promise<void> {
  controller?.abort();
  const mine = new AbortController();
  controller = mine;
  loading.value = true;
  error.value = null;
  try {
    adopt(await inspectVideo(api, props.videoId, mine.signal));
  } catch (cause) {
    const problem = normalizeError(cause);
    if (problem.problem === ABORTED_PROBLEM || mine.signal.aborted) return;
    error.value = problem;
    data.value = null;
  } finally {
    if (controller === mine) {
      loading.value = false;
      controller = null;
    }
  }
}

async function save(effects: Record<string, unknown> | null): Promise<void> {
  saving.value = true;
  try {
    adopt(await setVideoOverrides(api, props.videoId, effects));
    toast.success(effects === null ? "Overrides cleared" : "Overrides saved", props.videoId);
    confirmClear.value = false;
  } catch (cause) {
    toast.failure("Could not save the overrides", cause);
  } finally {
    saving.value = false;
  }
}

function saveOverrides(): void {
  const effects = overrides.value;
  void save(Object.keys(effects).length === 0 ? null : effects);
}

function ruleLink(id: number) {
  return { path: "/rules", query: { edit: String(id) } };
}

function kindLabel(kind: string): string {
  return kind === "global" ? "global" : kind === "video" ? "this video" : "custom";
}

watch(() => props.videoId, load, { immediate: true });
void lookups.ensureLocations();
void lookups.ensureAccounts();
void lookups.ensureProxies();
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <div class="inspect-panel" data-test="inspect-panel">
    <ListSkeleton v-if="loading && data === null" label="Evaluating rules" />
    <ErrorState
      v-else-if="error"
      :error="error"
      title="Could not inspect this video"
      @retry="load"
    />
    <div v-else-if="data" class="cellar-stack">
      <article class="cellar-card inspect-panel__video" data-test="inspect-video">
        <div>
          <h2>{{ data.title ?? "Untitled video" }}</h2>
          <p class="cellar-muted">
            <span v-if="data.channel_title">{{ data.channel_title }} - </span>
            <span class="mono">{{ data.video_id }}</span>
          </p>
          <p v-if="data.evaluated_at !== null" class="cellar-note">
            Evaluated {{ formatAbsolute(data.evaluated_at) }}
          </p>
        </div>
        <Tag
          :value="data.known ? 'known' : 'not in catalog'"
          :severity="data.known ? 'success' : 'warn'"
          data-test="inspect-known"
        />
      </article>
      <p v-if="!data.known" class="cellar-note" data-test="inspect-unknown">
        Cellar has not seen this video yet, so only rules that need no metadata can match. An
        override saved now applies once the video is ingested.
      </p>

      <article class="cellar-card">
        <h3>Matching rules</h3>
        <p class="cellar-note">In priority order: a later rule overrides the ones before it.</p>
        <ol class="inspect-panel__rules" data-test="inspect-matched">
          <li v-for="rule in data.matched" :key="rule.id" data-test="matched-rule">
            <RouterLink v-if="rule.kind !== 'video'" :to="ruleLink(rule.id)">
              {{ rule.name }}
            </RouterLink>
            <span v-else>{{ rule.name }}</span>
            <Tag :value="kindLabel(rule.kind)" severity="secondary" />
          </li>
          <li v-if="data.matched.length === 0" class="cellar-muted">No rules match.</li>
        </ol>
      </article>

      <article class="cellar-card">
        <h3>Effective settings</h3>
        <table class="inspect-panel__table" data-test="inspect-settings">
          <thead>
            <tr>
              <th scope="col">Setting</th>
              <th scope="col">Value</th>
              <th scope="col">Set by</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in settings" :key="row.key" :data-effect="row.key">
              <th scope="row">{{ row.label }}</th>
              <td data-test="setting-value">{{ row.value }}</td>
              <td data-test="setting-source">
                <span v-if="row.source === 'default'" class="cellar-muted">default</span>
                <a
                  v-else-if="row.rule?.kind === 'video'"
                  href="#inspect-overrides"
                  data-test="source-override"
                  >override</a
                >
                <RouterLink v-else :to="ruleLink(row.source)" data-test="source-link">
                  {{ row.rule?.name ?? `rule #${row.source}` }}
                </RouterLink>
              </td>
            </tr>
          </tbody>
        </table>
      </article>

      <article
        id="inspect-overrides"
        class="cellar-card cellar-stack"
        data-test="inspect-overrides"
      >
        <div>
          <h3>Overrides for this video</h3>
          <p class="cellar-note">
            The per-video rule has the highest priority. Only the settings set here override.
          </p>
        </div>
        <EffectsEditor
          v-model="overrides"
          kind="video"
          :disabled="saving"
          @validity="(valid: boolean) => (overridesValid = valid)"
        />
        <div class="inspect-panel__actions">
          <Button
            label="Clear overrides"
            severity="danger"
            text
            size="small"
            :disabled="data.overrides === null || saving"
            data-test="overrides-clear"
            @click="confirmClear = true"
          />
          <Button
            label="Save overrides"
            size="small"
            :loading="saving"
            :disabled="!dirty || !overridesValid"
            data-test="overrides-save"
            @click="saveOverrides"
          />
        </div>
      </article>
    </div>

    <ConfirmDialog
      :visible="confirmClear"
      title="Clear overrides"
      message="Remove every per-video override? The video goes back to whatever the global and custom rules decide."
      confirm-label="Clear"
      danger
      :busy="saving"
      @update:visible="(v: boolean) => (confirmClear = v)"
      @confirm="save(null)"
    />
  </div>
</template>

<style scoped>
.inspect-panel h2 {
  margin: 0 0 0.25rem;
  font-size: 1.1rem;
}

.inspect-panel h3 {
  margin: 0 0 0.35rem;
  font-size: 0.95rem;
}

.inspect-panel p {
  margin: 0;
}

.inspect-panel__video {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
}

.inspect-panel__rules {
  margin: 0.5rem 0 0;
  padding-left: 1.4rem;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.inspect-panel__rules li {
  display: list-item;
}

.inspect-panel__rules :deep(.p-tag) {
  margin-left: 0.5rem;
}

.inspect-panel__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}

.inspect-panel__table th,
.inspect-panel__table td {
  text-align: left;
  padding: 0.4rem 0.5rem;
  border-bottom: 1px solid var(--p-content-border-color);
  vertical-align: top;
}

.inspect-panel__table thead th {
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--p-text-muted-color);
}

.inspect-panel__table tbody th {
  font-weight: 500;
}

.inspect-panel__actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
</style>
