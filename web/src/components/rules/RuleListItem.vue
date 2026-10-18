<script setup lang="ts">
import { computed } from "vue";
import Button from "primevue/button";
import Tag from "primevue/tag";
import ToggleSwitch from "primevue/toggleswitch";
import type { RuleRow } from "@cellar/shared";
import { effectChips, summarizeCondition, type SummaryLabels } from "../../lib/ruleSummary.ts";

/**
 * One row of the rule list: enabled toggle, name, a one-line condition
 * summary and the effects as chips, plus edit / duplicate / delete and, for
 * custom rules, keyboard up/down moves. Drag events are the parent's job.
 */
const props = withDefaults(
  defineProps<{
    rule: RuleRow;
    labels: SummaryLabels;
    /** 1-based priority rank among custom rules; absent for the global rule. */
    rank?: number;
    canMoveUp?: boolean;
    canMoveDown?: boolean;
    busy?: boolean;
  }>(),
  { rank: undefined, canMoveUp: false, canMoveDown: false, busy: false },
);
const emit = defineEmits<{
  toggle: [boolean];
  edit: [];
  duplicate: [];
  remove: [];
  move: [-1 | 1];
}>();

const isGlobal = computed(() => props.rule.kind === "global");
const summary = computed(() =>
  isGlobal.value ? "every video" : summarizeCondition(props.rule.condition, props.labels),
);
const chips = computed(() => effectChips(props.rule.effects, props.labels));
</script>

<template>
  <div class="rule-item" :class="{ 'rule-item--disabled': !rule.enabled }" data-test="rule-item">
    <span v-if="!isGlobal" class="rule-item__handle" aria-hidden="true" title="Drag to reorder">
      ::
    </span>
    <span v-if="rank !== undefined" class="rule-item__rank" data-test="rule-rank">{{ rank }}</span>
    <ToggleSwitch
      :model-value="rule.enabled"
      :disabled="busy"
      :aria-label="`${rule.enabled ? 'Disable' : 'Enable'} ${rule.name}`"
      data-test="rule-toggle"
      @update:model-value="(v: boolean) => emit('toggle', v)"
    />
    <div class="rule-item__body">
      <button type="button" class="rule-item__name" data-test="rule-name" @click="emit('edit')">
        {{ rule.name }}
      </button>
      <p class="rule-item__summary" :title="summary" data-test="rule-summary">
        <span class="cellar-muted">When</span> {{ summary }}
      </p>
      <div class="rule-item__chips">
        <Tag
          v-for="chip in chips"
          :key="chip.key"
          severity="secondary"
          :value="`${chip.label}: ${chip.text}`"
          data-test="rule-chip"
        />
        <span v-if="chips.length === 0" class="cellar-note">No effects</span>
      </div>
    </div>
    <div class="rule-item__actions">
      <template v-if="!isGlobal">
        <Button
          label="Up"
          size="small"
          text
          severity="secondary"
          :disabled="!canMoveUp || busy"
          :aria-label="`Move ${rule.name} up (lower priority)`"
          data-test="rule-up"
          @click="emit('move', -1)"
        />
        <Button
          label="Down"
          size="small"
          text
          severity="secondary"
          :disabled="!canMoveDown || busy"
          :aria-label="`Move ${rule.name} down (higher priority)`"
          data-test="rule-down"
          @click="emit('move', 1)"
        />
      </template>
      <Button label="Edit" size="small" text data-test="rule-edit" @click="emit('edit')" />
      <template v-if="!isGlobal">
        <Button
          label="Duplicate"
          size="small"
          text
          severity="secondary"
          :disabled="busy"
          data-test="rule-duplicate"
          @click="emit('duplicate')"
        />
        <Button
          label="Delete"
          size="small"
          text
          severity="danger"
          :disabled="busy"
          data-test="rule-delete"
          @click="emit('remove')"
        />
      </template>
    </div>
  </div>
</template>

<style scoped>
.rule-item {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 0.75rem 0.9rem;
}

.rule-item--disabled .rule-item__body {
  opacity: 0.6;
}

.rule-item__handle {
  cursor: grab;
  user-select: none;
  font-weight: 700;
  color: var(--p-text-muted-color);
  padding-top: 0.15rem;
}

.rule-item__rank {
  min-width: 1.6rem;
  font-variant-numeric: tabular-nums;
  color: var(--p-text-muted-color);
  padding-top: 0.15rem;
}

.rule-item__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.rule-item__name {
  all: unset;
  cursor: pointer;
  font-weight: 600;
}

.rule-item__name:hover,
.rule-item__name:focus-visible {
  color: var(--p-primary-color);
  text-decoration: underline;
}

.rule-item__summary {
  margin: 0;
  font-size: 0.85rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rule-item__chips {
  display: flex;
  gap: 0.3rem;
  flex-wrap: wrap;
}

.rule-item__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
}
</style>
