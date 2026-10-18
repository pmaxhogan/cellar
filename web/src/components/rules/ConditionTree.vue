<script setup lang="ts">
import { computed, provide, ref, watch } from "vue";
import { validateAst, type AstError, type ConditionNode, type Field } from "@cellar/shared";
import {
  changeField,
  changeOp,
  errorsByKey,
  moveNode,
  newGroup,
  newLeaf,
  removeNode,
  shiftNode,
  toAst,
  toUi,
  type UiGroup,
  type UiLeaf,
  type UiNode,
} from "../../lib/rulesTree.ts";
import { summarizeCondition } from "../../lib/ruleSummary.ts";
import { useRuleLookups } from "../../lib/rulesLookups.ts";
import ConditionGroup from "./ConditionGroup.vue";
import { conditionContextKey, type ConditionContext } from "./conditionContext.ts";

/**
 * The condition builder: owns an editable copy of the AST, validates it on
 * every change with the shared `validateAst`, and emits the stripped AST plus
 * the validation errors. Errors are shown inline on the node their JSON
 * pointer leads to.
 */
const props = withDefaults(
  defineProps<{ modelValue: ConditionNode | null; disabled?: boolean }>(),
  {
    disabled: false,
  },
);

const emit = defineEmits<{
  "update:modelValue": [ConditionNode];
  validity: [AstError[]];
}>();

const lookups = useRuleLookups();
const root = ref<UiGroup>(toUi(props.modelValue));
const dragging = ref<UiNode | null>(null);
let lastEmitted = JSON.stringify(toAst(root.value));

const ast = computed(() => toAst(root.value));
const result = computed(() => validateAst(ast.value));
const errors = computed(() => errorsByKey(root.value, result.value.errors));
const summary = computed(() => summarizeCondition(ast.value, lookups.labels.value));

watch(
  ast,
  (next) => {
    const text = JSON.stringify(next);
    emit("validity", result.value.errors);
    if (text === lastEmitted) return;
    lastEmitted = text;
    emit("update:modelValue", next);
  },
  { immediate: true },
);

watch(
  () => props.modelValue,
  (next) => {
    if (JSON.stringify(next) === lastEmitted) return;
    root.value = toUi(next);
  },
);

function rootGroup(): UiGroup {
  return root.value;
}

const ctx: ConditionContext = {
  root,
  errors,
  dragging,
  disabled: computed(() => props.disabled),
  setField: (leaf: UiLeaf, field: Field) => changeField(leaf, field),
  setOp: (leaf: UiLeaf, op: string) => changeOp(leaf, op),
  setValue: (leaf: UiLeaf, value: unknown) => {
    leaf.value = value;
  },
  setCi: (leaf: UiLeaf, ci: boolean) => {
    leaf.ci = ci;
  },
  setSource: (leaf: UiLeaf, source: string | null) => {
    if (source === null) delete leaf.source;
    else leaf.source = source;
  },
  setGroupOp: (group: UiGroup, op: "and" | "or") => {
    group.op = op;
  },
  setNot: (group: UiGroup, not: boolean) => {
    if (not) group.not = true;
    else delete group.not;
  },
  addLeaf: (group: UiGroup) => {
    group.children.push(newLeaf());
  },
  addGroup: (group: UiGroup) => {
    group.children.push(newGroup(group.op === "and" ? "or" : "and"));
  },
  remove: (node: UiNode) => {
    removeNode(rootGroup(), node);
  },
  dropInto: (group: UiGroup, before: UiNode | null) => {
    const node = dragging.value;
    dragging.value = null;
    if (node !== null) moveNode(rootGroup(), node, group, before);
  },
  shift: (node: UiNode, delta: -1 | 1) => {
    shiftNode(rootGroup(), node, delta);
  },
};

provide(conditionContextKey, ctx);

void lookups.ensureLocations();
void lookups.ensureAccounts();
</script>

<template>
  <div class="condition-tree" data-test="condition-tree">
    <p class="condition-tree__summary" data-test="condition-summary">
      <span class="cellar-muted">Matches:</span> {{ summary }}
    </p>
    <ConditionGroup :node="root" :depth="0" />
  </div>
</template>

<style scoped>
.condition-tree {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.condition-tree__summary {
  margin: 0;
  font-size: 0.85rem;
  overflow-wrap: anywhere;
}
</style>
