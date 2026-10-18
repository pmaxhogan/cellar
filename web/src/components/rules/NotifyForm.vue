<script setup lang="ts">
import { computed, useId } from "vue";
import Checkbox from "primevue/checkbox";
import InputNumber from "primevue/inputnumber";
import ToggleSwitch from "primevue/toggleswitch";

/** The `notify` effect: on/off and how many times per video (or unlimited). Delivery is Web Push. */
const props = withDefaults(defineProps<{ modelValue: unknown; disabled?: boolean }>(), {
  disabled: false,
});
const emit = defineEmits<{ "update:modelValue": [Record<string, unknown>] }>();

const value = computed<Record<string, unknown>>(() =>
  props.modelValue !== null && typeof props.modelValue === "object"
    ? (props.modelValue as Record<string, unknown>)
    : {},
);
const unlimitedId = useId();
const unlimited = computed(() => value.value["max_times"] === null);

function set(field: string, v: unknown): void {
  emit("update:modelValue", { ...value.value, [field]: v });
}
</script>

<template>
  <div class="notify-form" data-test="notify-form">
    <span class="notify-form__row">
      <ToggleSwitch
        :model-value="value['enabled'] === true"
        :disabled="disabled"
        aria-label="Notify"
        data-test="notify-enabled"
        @update:model-value="(v: boolean) => set('enabled', v)"
      />
      <span>Send a push notification</span>
    </span>
    <span v-if="value['enabled'] === true" class="notify-form__row">
      <Checkbox
        :model-value="unlimited"
        binary
        :input-id="unlimitedId"
        :disabled="disabled"
        data-test="notify-unlimited"
        @update:model-value="(v: boolean) => set('max_times', v ? null : 1)"
      />
      <label :for="unlimitedId">Unlimited</label>
      <template v-if="!unlimited">
        <InputNumber
          :model-value="typeof value['max_times'] === 'number' ? value['max_times'] : 1"
          :min="1"
          :max="1000"
          size="small"
          aria-label="Times per video"
          :disabled="disabled"
          data-test="notify-max"
          @update:model-value="(v: number | null) => set('max_times', v ?? 1)"
        />
        <span class="cellar-muted">times per video</span>
      </template>
    </span>
  </div>
</template>

<style scoped>
.notify-form {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.notify-form__row {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  flex-wrap: wrap;
}
</style>
