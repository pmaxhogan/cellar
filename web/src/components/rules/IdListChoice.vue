<script setup lang="ts">
import { computed } from "vue";
import MultiSelect from "primevue/multiselect";
import SelectButton from "primevue/selectbutton";

/**
 * A value that is either a named mode (`sourcing` / `any`, `none` / `pool`)
 * or an explicit list of row ids: the `download_accounts` and `proxy` effects.
 */
const LIST = "__list";

const props = withDefaults(
  defineProps<{
    modelValue: unknown;
    modes: { label: string; value: string }[];
    options: { label: string; value: number }[];
    listLabel: string;
    emptyMessage?: string;
    disabled?: boolean;
  }>(),
  { emptyMessage: "Nothing to choose from", disabled: false },
);
const emit = defineEmits<{ "update:modelValue": [string | number[]] }>();

const choices = computed(() => [...props.modes, { label: props.listLabel, value: LIST }]);
const mode = computed(() => (Array.isArray(props.modelValue) ? LIST : String(props.modelValue)));
// Only read while the value is a list (the MultiSelect renders in list mode only).
const ids = computed(() =>
  (props.modelValue as unknown[]).filter((v): v is number => typeof v === "number"),
);

function setMode(next: string): void {
  if (next === LIST) {
    // An empty list is invalid; the editor flags it until something is chosen.
    const first = props.options[0];
    emit("update:modelValue", first === undefined ? [] : [first.value]);
  } else {
    emit("update:modelValue", next);
  }
}
</script>

<template>
  <div class="id-list-choice" data-test="id-list-choice">
    <SelectButton
      :model-value="mode"
      :options="choices"
      option-label="label"
      option-value="value"
      :allow-empty="false"
      :disabled="disabled"
      size="small"
      data-test="id-list-mode"
      @update:model-value="setMode"
    />
    <MultiSelect
      v-if="mode === LIST"
      :model-value="ids"
      :options="options"
      option-label="label"
      option-value="value"
      display="chip"
      :placeholder="listLabel"
      :empty-message="emptyMessage"
      :disabled="disabled"
      size="small"
      data-test="id-list-ids"
      @update:model-value="(v: number[]) => emit('update:modelValue', v)"
    />
  </div>
</template>

<style scoped>
.id-list-choice {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}
</style>
