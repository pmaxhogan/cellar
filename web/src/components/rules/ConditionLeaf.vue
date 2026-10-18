<script setup lang="ts">
import { computed } from "vue";
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
import Select from "primevue/select";
import { FIELD_CATALOG, FIELDS, type Field, type FieldKind } from "@cellar/shared";
import { fieldInfo, operatorInfo, type UiLeaf } from "../../lib/rulesTree.ts";
import { humanize } from "../../lib/ruleSummary.ts";
import ConditionValue from "./ConditionValue.vue";
import { useConditionContext } from "./conditionContext.ts";

/**
 * One condition row: field -> operator -> value, plus the field's extra
 * parameters (the case-insensitive flag for text, the source for first_seen),
 * a drag handle, keyboard move buttons and remove. Errors whose JSON pointer
 * lands on this leaf are listed under it.
 */
const props = defineProps<{ node: UiLeaf }>();
const ctx = useConditionContext();

const KIND_LABELS: Record<FieldKind, string> = {
  id: "Who and where",
  set: "Sources",
  enum: "Categories",
  number: "Numbers",
  bool: "Flags",
  text: "Text",
  time: "Dates and ages",
};
const KIND_ORDER: FieldKind[] = ["set", "id", "enum", "time", "text", "number", "bool"];

const FIELD_OPTIONS = KIND_ORDER.map((kind) => ({
  label: KIND_LABELS[kind],
  items: FIELDS.filter((field) => FIELD_CATALOG[field].kind === kind).map((field) => ({
    label: FIELD_CATALOG[field].label,
    value: field,
  })),
})).filter((group) => group.items.length > 0);

const info = computed(() => fieldInfo(props.node.field));
const opOptions = computed(() =>
  info.value.operators.map((op) => ({ label: op.label, value: op.op })),
);
const valueKind = computed(() => operatorInfo(props.node.field, props.node.op)?.value);
const showCi = computed(() => info.value.caseFlag === true && valueKind.value !== undefined);
const sourceOptions = computed(() => [
  { label: "any source", value: null },
  ...info.value.options!.map((value) => ({ label: humanize(value), value })),
]);
const errors = computed(() => ctx.errors.value.get(props.node._key) ?? []);
const ciId = computed(() => `cond-ci-${props.node._key}`);

function onDragStart(event: DragEvent): void {
  ctx.dragging.value = props.node;
  event.dataTransfer?.setData("text/plain", String(props.node._key));
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  event.stopPropagation();
}

function onDragEnd(): void {
  ctx.dragging.value = null;
}
</script>

<template>
  <div class="cond-leaf" :class="{ 'cond-leaf--invalid': errors.length > 0 }" data-test="cond-leaf">
    <div class="cond-leaf__row">
      <span
        class="cond-handle"
        draggable="true"
        title="Drag to move this condition"
        aria-hidden="true"
        data-test="leaf-handle"
        @dragstart="onDragStart"
        @dragend="onDragEnd"
        >::</span
      >
      <Select
        :model-value="node.field"
        :options="FIELD_OPTIONS"
        option-label="label"
        option-value="value"
        option-group-label="label"
        option-group-children="items"
        filter
        size="small"
        class="cond-leaf__field"
        aria-label="Field"
        :disabled="ctx.disabled.value"
        data-test="leaf-field"
        @update:model-value="(v: Field) => ctx.setField(node, v)"
      />
      <Select
        v-if="info.sourceParam"
        :model-value="node.source ?? null"
        :options="sourceOptions"
        option-label="label"
        option-value="value"
        size="small"
        aria-label="Seen in source"
        :disabled="ctx.disabled.value"
        data-test="leaf-source"
        @update:model-value="(v: string | null) => ctx.setSource(node, v)"
      />
      <Select
        :model-value="node.op"
        :options="opOptions"
        option-label="label"
        option-value="value"
        size="small"
        class="cond-leaf__op"
        aria-label="Operator"
        :disabled="ctx.disabled.value"
        data-test="leaf-op"
        @update:model-value="(v: string) => ctx.setOp(node, v)"
      />
      <ConditionValue :node="node" />
      <span v-if="showCi" class="cond-leaf__ci">
        <Checkbox
          :model-value="node.ci === true"
          binary
          :input-id="ciId"
          :disabled="ctx.disabled.value"
          data-test="leaf-ci"
          @update:model-value="(v: boolean) => ctx.setCi(node, v)"
        />
        <label :for="ciId">any case</label>
      </span>
      <span class="cond-leaf__actions">
        <Button
          size="small"
          text
          severity="secondary"
          label="Up"
          aria-label="Move condition up"
          data-test="leaf-up"
          @click="ctx.shift(node, -1)"
        />
        <Button
          size="small"
          text
          severity="secondary"
          label="Down"
          aria-label="Move condition down"
          data-test="leaf-down"
          @click="ctx.shift(node, 1)"
        />
        <Button
          size="small"
          text
          severity="danger"
          label="Remove"
          aria-label="Remove condition"
          data-test="leaf-remove"
          @click="ctx.remove(node)"
        />
      </span>
    </div>
    <p v-if="info.description" class="cellar-note">{{ info.description }}</p>
    <ul v-if="errors.length > 0" class="cond-errors">
      <li v-for="error in errors" :key="error.pointer + error.message" data-test="leaf-error">
        <span class="mono">{{ error.pointer }}</span> {{ error.message }}
      </li>
    </ul>
  </div>
</template>

<style scoped>
.cond-leaf {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.45rem 0.55rem;
  border-radius: 8px;
  background: var(--p-content-hover-background);
}

.cond-leaf--invalid {
  outline: 1px solid var(--cellar-error-border);
}

.cond-leaf__row {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  flex-wrap: wrap;
}

.cond-leaf__field {
  min-width: 11rem;
}

.cond-leaf__op {
  min-width: 8rem;
}

.cond-leaf__ci {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.82rem;
}

.cond-leaf__actions {
  margin-left: auto;
  display: inline-flex;
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
