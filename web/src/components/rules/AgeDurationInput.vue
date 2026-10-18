<script setup lang="ts">
import { computed } from "vue";
import InputNumber from "primevue/inputnumber";
import InputText from "primevue/inputtext";
import { formatRuleDuration } from "../../lib/ruleSummary.ts";
import { toDurationObject, type DurationObjectValue } from "../../lib/rulesTree.ts";

/**
 * A rule duration edited as `{ years, months, days, hours }` with a compact
 * summary ("2 months"). ISO strings that only use those units are shown in the
 * same editor and saved back as the object form; an ISO string with minutes or
 * seconds keeps a raw ISO text field so nothing is lost.
 */
const props = withDefaults(defineProps<{ modelValue: unknown; disabled?: boolean }>(), {
  disabled: false,
});
const emit = defineEmits<{ "update:modelValue": [DurationObjectValue | string] }>();

const UNITS = [
  { key: "years", suffix: " y", label: "Years" },
  { key: "months", suffix: " mo", label: "Months" },
  { key: "days", suffix: " d", label: "Days" },
  { key: "hours", suffix: " h", label: "Hours" },
] as const;

const object = computed(() => toDurationObject(props.modelValue));
const summary = computed(() => formatRuleDuration(props.modelValue));

function set(unit: keyof DurationObjectValue, value: number | null): void {
  // Only the unit inputs call this, and they render only when the value is an object.
  const next: DurationObjectValue = { ...object.value! };
  if (value === null) delete next[unit];
  else next[unit] = value;
  emit("update:modelValue", next);
}
</script>

<template>
  <span class="age-input" data-test="age-input">
    <template v-if="object !== null">
      <InputNumber
        v-for="unit in UNITS"
        :key="unit.key"
        :model-value="object[unit.key] ?? null"
        :min="0"
        :max="100000"
        :suffix="unit.suffix"
        :placeholder="unit.suffix.trim()"
        :aria-label="unit.label"
        :disabled="disabled"
        size="small"
        input-class="age-input__field"
        :data-test="`age-${unit.key}`"
        @update:model-value="(v: number | null) => set(unit.key, v)"
      />
    </template>
    <InputText
      v-else
      :model-value="String(modelValue)"
      size="small"
      aria-label="ISO-8601 duration"
      :disabled="disabled"
      data-test="age-iso"
      @update:model-value="(v: string | undefined) => emit('update:modelValue', v ?? '')"
    />
    <span class="age-input__summary cellar-muted" data-test="age-summary">{{ summary }}</span>
  </span>
</template>

<style scoped>
.age-input {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  flex-wrap: wrap;
}

.age-input :deep(.age-input__field) {
  width: 4.6rem;
}

.age-input__summary {
  font-size: 0.82rem;
  margin-left: 0.25rem;
}
</style>
