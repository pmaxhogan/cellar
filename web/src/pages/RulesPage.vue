<script setup lang="ts">
import { computed, inject, onMounted, ref } from "vue";
import { routeLocationKey } from "vue-router";
import Button from "primevue/button";
import Drawer from "primevue/drawer";
import type { RuleRow } from "@cellar/shared";
import { normalizeError, type ApiClientError } from "../api/client.ts";
import { useApi } from "../api/provide.ts";
import {
  createRule,
  deleteRule,
  draftFromRow,
  listRules,
  reorderRules,
  updateRule,
} from "../api/rules.ts";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import EmptyState from "../components/EmptyState.vue";
import ErrorState from "../components/ErrorState.vue";
import ListSkeleton from "../components/ListSkeleton.vue";
import PageHeader from "../components/PageHeader.vue";
import RuleEditor from "../components/rules/RuleEditor.vue";
import RuleListItem from "../components/rules/RuleListItem.vue";
import { channelIdsIn } from "../lib/ruleSummary.ts";
import { provideRuleLookups } from "../lib/rulesLookups.ts";
import { moveItem, nextPosition, sortedCustom } from "../lib/rulesOrder.ts";
import { useToaster } from "../lib/toast.ts";

/**
 * The rule list: the global rule pinned on top, then the custom rules in
 * ascending priority (a rule further down overrides the ones above it).
 * Custom rules reorder by dragging or with the Up / Down buttons; every move
 * is persisted with PUT /api/rules/order. Editing opens a full-screen drawer.
 * `?edit=<id>` (used by the Inspect page) opens a rule straight away.
 */
const api = useApi();
const toast = useToaster();
const lookups = provideRuleLookups(api);
const route = inject(routeLocationKey, null);

const rows = ref<RuleRow[]>([]);
const loading = ref(true);
const error = ref<ApiClientError | null>(null);
const busy = ref(false);

const globalRule = computed(() => rows.value.find((row) => row.kind === "global") ?? null);
const custom = computed(() => sortedCustom(rows.value));

const editorOpen = ref(false);
const editing = ref<RuleRow | null>(null);
const editorKey = ref(0);
const deleting = ref<RuleRow | null>(null);
const deleteBusy = ref(false);

const dragIndex = ref<number | null>(null);
const overIndex = ref<number | null>(null);

const editorTitle = computed(() =>
  editing.value === null ? "New rule" : `Edit rule: ${editing.value.name}`,
);

function resolveChannelTitles(list: RuleRow[]): void {
  const ids = new Set<string>();
  for (const row of list) channelIdsIn(row.condition, ids);
  for (const id of [...ids].slice(0, 25)) {
    if (!lookups.channelTitles.has(id)) void lookups.searchChannels(id).catch(() => undefined);
  }
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    rows.value = await listRules(api);
    error.value = null;
    resolveChannelTitles(rows.value);
  } catch (cause) {
    error.value = normalizeError(cause);
  } finally {
    loading.value = false;
  }
}

function openEditor(rule: RuleRow | null): void {
  editing.value = rule;
  editorKey.value += 1;
  editorOpen.value = true;
}

function onSaved(row: RuleRow): void {
  editorOpen.value = false;
  toast.success(editing.value === null ? "Rule created" : "Rule saved", row.name);
  void load();
}

async function toggle(rule: RuleRow, enabled: boolean): Promise<void> {
  busy.value = true;
  try {
    const saved = await updateRule(api, rule.id, { ...draftFromRow(rule), enabled });
    rows.value = rows.value.map((row) => (row.id === rule.id ? saved : row));
  } catch (cause) {
    toast.failure("Could not update the rule", cause);
  } finally {
    busy.value = false;
  }
}

async function duplicate(rule: RuleRow): Promise<void> {
  busy.value = true;
  try {
    const copy = await createRule(api, {
      ...draftFromRow(rule),
      name: `${rule.name} (copy)`.slice(0, 200),
      position: nextPosition(rows.value),
    });
    toast.success("Rule duplicated", copy.name);
    await load();
  } catch (cause) {
    toast.failure("Could not duplicate the rule", cause);
  } finally {
    busy.value = false;
  }
}

async function confirmDelete(rule: RuleRow): Promise<void> {
  deleteBusy.value = true;
  try {
    await deleteRule(api, rule.id);
    rows.value = rows.value.filter((row) => row.id !== rule.id);
    toast.success("Rule deleted", rule.name);
    deleting.value = null;
  } catch (cause) {
    toast.failure("Could not delete the rule", cause);
  } finally {
    deleteBusy.value = false;
  }
}

/** Moves a custom rule from one list index to another and persists the order. */
async function move(from: number, to: number): Promise<void> {
  // The Up / Down buttons are disabled at the ends and moveItem clamps.
  if (from === to) return;
  const before = rows.value;
  const ordered = moveItem(custom.value, from, to);
  // Optimistic: renumber positions locally so the list redraws at once.
  const positions = new Map(ordered.map((row, index) => [row.id, index + 1]));
  rows.value = rows.value.map((row) =>
    positions.has(row.id) ? { ...row, position: positions.get(row.id)! } : row,
  );
  busy.value = true;
  try {
    const saved = await reorderRules(
      api,
      ordered.map((row) => row.id),
    );
    if (saved.length > 0) rows.value = saved;
  } catch (cause) {
    rows.value = before;
    toast.failure("Could not save the new order", cause);
  } finally {
    busy.value = false;
  }
}

function onDragStart(event: DragEvent, index: number): void {
  dragIndex.value = index;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(index));
  }
}

function onDragOver(event: DragEvent, index: number): void {
  if (dragIndex.value === null) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  overIndex.value = index;
}

function onDrop(event: DragEvent, index: number): void {
  const from = dragIndex.value;
  event.preventDefault();
  dragIndex.value = null;
  overIndex.value = null;
  if (from !== null) void move(from, index);
}

function onDragEnd(): void {
  dragIndex.value = null;
  overIndex.value = null;
}

onMounted(async () => {
  void lookups.ensureLocations();
  void lookups.ensureAccounts();
  void lookups.ensureProxies();
  await load();
  const id = Number(route?.query["edit"]);
  const target = rows.value.find((row) => row.id === id);
  if (target !== undefined) openEditor(target);
});
</script>

<template>
  <section class="rules-page">
    <PageHeader
      title="Rules"
      description="Ordered rules decide what is downloaded, at what quality, and for how long it is kept."
    >
      <template #actions>
        <Button label="New rule" size="small" data-test="new-rule" @click="openEditor(null)" />
      </template>
    </PageHeader>

    <ListSkeleton v-if="loading && rows.length === 0" label="Loading rules" />
    <ErrorState v-else-if="error" :error="error" title="Could not load the rules" @retry="load" />
    <div v-else class="cellar-stack">
      <article v-if="globalRule" class="cellar-card rules-page__global" data-test="global-rule">
        <h2 class="rules-page__heading">Global defaults</h2>
        <RuleListItem
          :rule="globalRule"
          :labels="lookups.labels.value"
          :busy="busy"
          @toggle="(v: boolean) => toggle(globalRule!, v)"
          @edit="openEditor(globalRule)"
        />
      </article>

      <article class="cellar-card">
        <h2 class="rules-page__heading">Custom rules</h2>
        <p class="cellar-note" data-test="priority-hint">
          Higher in the list = lower priority. A matching rule overrides only the effects it sets,
          and a rule further down overrides the rules above it. Drag the handle or use Up / Down to
          reorder.
        </p>
        <EmptyState
          v-if="custom.length === 0"
          icon="rules"
          title="No custom rules"
          description="Every video gets the global defaults. Add a rule to change what happens to the videos it matches."
        >
          <Button label="New rule" size="small" @click="openEditor(null)" />
        </EmptyState>
        <ol v-else class="rules-page__list" data-test="custom-rules">
          <li
            v-for="(rule, index) in custom"
            :key="rule.id"
            class="rules-page__row"
            :class="{
              'rules-page__row--dragging': dragIndex === index,
              'rules-page__row--over': overIndex === index && dragIndex !== index,
            }"
            draggable="true"
            :data-rule-id="rule.id"
            data-test="custom-rule"
            @dragstart="onDragStart($event, index)"
            @dragover="onDragOver($event, index)"
            @drop="onDrop($event, index)"
            @dragend="onDragEnd"
          >
            <RuleListItem
              :rule="rule"
              :labels="lookups.labels.value"
              :rank="index + 1"
              :can-move-up="index > 0"
              :can-move-down="index < custom.length - 1"
              :busy="busy"
              @toggle="(v: boolean) => toggle(rule, v)"
              @edit="openEditor(rule)"
              @duplicate="duplicate(rule)"
              @remove="deleting = rule"
              @move="(delta: -1 | 1) => move(index, index + delta)"
            />
          </li>
        </ol>
      </article>
    </div>

    <Drawer
      v-model:visible="editorOpen"
      position="full"
      :header="editorTitle"
      class="rules-page__drawer"
      data-test="rule-drawer"
    >
      <RuleEditor
        v-if="editorOpen"
        :key="editorKey"
        :rule="editing"
        :next-position="nextPosition(rows)"
        @saved="onSaved"
        @cancel="editorOpen = false"
      />
    </Drawer>

    <ConfirmDialog
      :visible="deleting !== null"
      title="Delete rule"
      :message="`Delete the rule '${deleting?.name ?? ''}'? Videos it matched fall back to the remaining rules at the next evaluation.`"
      confirm-label="Delete"
      danger
      :busy="deleteBusy"
      @update:visible="deleting = null"
      @confirm="confirmDelete(deleting!)"
    />
  </section>
</template>

<style scoped>
.rules-page__heading {
  margin: 0 0 0.35rem;
  font-size: 1rem;
}

.rules-page__global {
  border-left: 3px solid var(--p-primary-color);
}

.rules-page__list {
  list-style: none;
  margin: 0.75rem 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.rules-page__row {
  border-top: 1px solid var(--p-content-border-color);
}

.rules-page__row--dragging {
  opacity: 0.45;
}

.rules-page__row--over {
  box-shadow: inset 0 2px 0 var(--p-primary-color);
}
</style>
