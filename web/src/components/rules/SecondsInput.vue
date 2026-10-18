<script setup lang="ts">
import { computed } from "vue";
import InputNumber from "primevue/inputnumber";
import { joinSeconds, splitSeconds } from "../../lib/rulesTree.ts";

/** Whole seconds edited as hours, minutes and seconds (for `duration_s`). */
const props = withDefaults(defineProps<{ modelValue: unknown; disabled?: boolean }>(), {
  disabled: false,
});
const emit = defineEmits<{ "update:modelValue": [number] }>();

const parts = computed(() =>
  splitSeconds(typeof props.modelValue === "number" ? props.modelValue : 0),
);

function set(unit: "h" | "m" | "s", value: number | null): void {
  emit("update:modelValue", joinSeconds({ ...parts.value, [unit]: value ?? 0 }));
}
</script>

<template>
  <span class="seconds-input" data-test="seconds-input">
    <InputNumber
      :model-value="parts.h"
      :min="0"
      :disabled="disabled"
      size="small"
      suffix=" h"
      aria-label="Hours"
      input-class="seconds-input__field"
      data-test="seconds-h"
      @update:model-value="(v: number | null) => set('h', v)"
    />
    <InputNumber
      :model-value="parts.m"
      :min="0"
      :max="59"
      :disabled="disabled"
      size="small"
      suffix=" m"
      aria-label="Minutes"
      input-class="seconds-input__field"
      data-test="seconds-m"
      @update:model-value="(v: number | null) => set('m', v)"
    />
    <InputNumber
      :model-value="parts.s"
      :min="0"
      :max="59"
      :disabled="disabled"
      size="small"
      suffix=" s"
      aria-label="Seconds"
      input-class="seconds-input__field"
      data-test="seconds-s"
      @update:model-value="(v: number | null) => set('s', v)"
    />
  </span>
</template>

<style scoped>
.seconds-input {
  display: inline-flex;
  gap: 0.25rem;
}

.seconds-input :deep(.seconds-input__field) {
  width: 4.2rem;
}
</style>
