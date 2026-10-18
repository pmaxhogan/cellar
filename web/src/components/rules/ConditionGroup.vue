<script setup lang="ts">
import { computed, ref } from "vue";
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
import SelectButton from "primevue/selectbutton";
import type { UiGroup, UiNode } from "../../lib/rulesTree.ts";
import ConditionLeaf from "./ConditionLeaf.vue";
import { useConditionContext } from "./conditionContext.ts";

/**
 * One AND/OR group with its NOT flag and children. Children are drop targets
 * for the row being dragged (dropping on a row inserts before it; the strip
 * at the end of a group appends). Nested groups render recursively.
 */
const props = defineProps<{ node: UiGroup; depth: number }>();

const ctx = useConditionContext();
const OP_OPTIONS = [
  { label: "AND", value: "and" },
  { label: "OR", value: "or" },
];

const isRoot = computed(() => props.depth === 0);
const errors = computed(() => ctx.errors.value.get(props.node._key) ?? []);
const dropTarget = ref<number | "end" | null>(null);
const emptyHint = computed(() =>
  props.node.op === "and"
    ? "An empty AND group matches every video."
    : "An empty OR group matches no videos.",
);
const notId = computed(() => `cond-not-${props.node._key}`);

function onDragStart(event: DragEvent): void {
  ctx.dragging.value = props.node;
  event.dataTransfer?.setData("text/plain", String(props.node._key));
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  event.stopPropagation();
}

function onDragEnd(): void {
  ctx.dragging.value = null;
}

function onDragOver(event: DragEvent, target: number | "end"): void {
  if (ctx.dragging.value === null) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  dropTarget.value = target;
}

function onDrop(event: DragEvent, before: UiNode | null): void {
  if (ctx.dragging.value === null) return;
  event.preventDefault();
  event.stopPropagation();
  dropTarget.value = null;
  ctx.dropInto(props.node, before);
}
</script>

<template>
  <div
    class="cond-group"
    :class="{ 'cond-group--nested': !isRoot, 'cond-group--not': node.not }"
    data-test="cond-group"
    :data-depth="depth"
  >
    <div class="cond-group__head">
      <span
        v-if="!isRoot"
        class="cond-handle"
        draggable="true"
        title="Drag to move this group"
        aria-hidden="true"
        data-test="group-handle"
        @dragstart="onDragStart"
        @dragend="onDragEnd"
        >::</span
      >
      <SelectButton
        :model-value="node.op"
        :options="OP_OPTIONS"
        option-label="label"
        option-value="value"
        :allow-empty="false"
        :disabled="ctx.disabled.value"
        size="small"
        aria-label="Combine children with"
        data-test="group-op"
        @update:model-value="(v: 'and' | 'or') => ctx.setGroupOp(node, v)"
      />
      <span class="cond-group__not">
        <Checkbox
          :model-value="node.not === true"
          binary
          :input-id="notId"
          :disabled="ctx.disabled.value"
          data-test="group-not"
          @update:model-value="(v: boolean) => ctx.setNot(node, v)"
        />
        <label :for="notId">NOT</label>
      </span>
      <span class="cond-group__spacer" />
      <Button
        label="Condition"
        size="small"
        text
        :disabled="ctx.disabled.value"
        data-test="add-leaf"
        @click="ctx.addLeaf(node)"
      />
      <Button
        label="Group"
        size="small"
        text
        :disabled="ctx.disabled.value"
        data-test="add-group"
        @click="ctx.addGroup(node)"
      />
      <template v-if="!isRoot">
        <Button
          size="small"
          text
          severity="secondary"
          label="Up"
          aria-label="Move group up"
          data-test="group-up"
          @click="ctx.shift(node, -1)"
        />
        <Button
          size="small"
          text
          severity="secondary"
          label="Down"
          aria-label="Move group down"
          data-test="group-down"
          @click="ctx.shift(node, 1)"
        />
        <Button
          size="small"
          text
          severity="danger"
          label="Remove"
          aria-label="Remove group"
          data-test="group-remove"
          @click="ctx.remove(node)"
        />
      </template>
    </div>

    <ul v-if="errors.length > 0" class="cond-errors">
      <li v-for="error in errors" :key="error.pointer + error.message" data-test="group-error">
        {{ error.message }}
      </li>
    </ul>

    <div class="cond-group__children">
      <p v-if="node.children.length === 0" class="cellar-note" data-test="empty-group">
        {{ emptyHint }}
      </p>
      <div
        v-for="(child, index) in node.children"
        :key="child._key"
        class="cond-slot"
        :class="{ 'cond-slot--target': dropTarget === index }"
        data-test="cond-slot"
        @dragover="onDragOver($event, index)"
        @dragleave="dropTarget = null"
        @drop="onDrop($event, child)"
      >
        <span v-if="index > 0" class="cond-joiner">{{ node.op.toUpperCase() }}</span>
        <ConditionGroup v-if="child.type === 'group'" :node="child" :depth="depth + 1" />
        <ConditionLeaf v-else :node="child" />
      </div>
      <div
        v-if="ctx.dragging.value !== null"
        class="cond-dropzone"
        :class="{ 'cond-dropzone--target': dropTarget === 'end' }"
        data-test="drop-end"
        @dragover="onDragOver($event, 'end')"
        @dragleave="dropTarget = null"
        @drop="onDrop($event, null)"
      >
        Drop here to move into this group
      </div>
    </div>
  </div>
</template>

<style scoped>
.cond-group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.cond-group--nested {
  border: 1px solid var(--p-content-border-color);
  border-left: 3px solid var(--p-primary-color);
  border-radius: 8px;
  padding: 0.6rem 0.7rem;
}

.cond-group--not {
  border-left-color: var(--cellar-warn);
}

.cond-group__head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.cond-group__not {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.85rem;
  font-weight: 600;
}

.cond-group__spacer {
  flex: 1;
}

.cond-group__children {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.cond-slot {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  border-top: 2px solid transparent;
}

.cond-slot--target {
  border-top-color: var(--p-primary-color);
}

.cond-joiner {
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--p-text-muted-color);
}

.cond-dropzone {
  border: 1px dashed var(--p-content-border-color);
  border-radius: 6px;
  padding: 0.4rem;
  font-size: 0.8rem;
  text-align: center;
  color: var(--p-text-muted-color);
}

.cond-dropzone--target {
  border-color: var(--p-primary-color);
  color: var(--p-text-color);
}

.cond-handle {
  cursor: grab;
  user-select: none;
  font-weight: 700;
  color: var(--p-text-muted-color);
  padding: 0 0.25rem;
}

.cond-errors {
  margin: 0;
  padding-left: 1.1rem;
  color: var(--cellar-error);
  font-size: 0.82rem;
}
</style>
