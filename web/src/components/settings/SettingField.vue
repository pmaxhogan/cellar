<script setup lang="ts">
import { computed, ref, watch } from "vue";
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
import InputNumber from "primevue/inputnumber";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import Tag from "primevue/tag";
import ToggleSwitch from "primevue/toggleswitch";
import { settingsRegistry, type SettingKey } from "@cellar/shared";
import {
  defaultValue,
  formatSettingValue,
  isIntegerSetting,
  isNullableSetting,
} from "../../api/settings.ts";
import { formatBytes } from "../../lib/format.ts";

/**
 * One registry key, rendered by its `ui.control`. The value shown is the
 * draft: the stored override, else the default, else whatever the owner just
 * typed. Validation lives on the page; this only reports what it is given.
 */
const props = withDefaults(
  defineProps<{
    settingKey: SettingKey;
    modelValue: unknown;
    modified?: boolean;
    dirty?: boolean;
    canReset?: boolean;
    error?: string | null;
    disabled?: boolean;
  }>(),
  { modified: false, dirty: false, canReset: false, error: null, disabled: false },
);
const emit = defineEmits<{ "update:modelValue": [unknown]; reset: [] }>();

const def = computed(() => settingsRegistry[props.settingKey]);
const ui = computed(() => def.value.ui);
const inputId = computed(() => `setting-${props.settingKey.replace(/[^a-z0-9]+/gi, "-")}`);
const integer = computed(() => isIntegerSetting(props.settingKey));
const nullable = computed(() => isNullableSetting(props.settingKey));
const defaultText = computed(() =>
  formatSettingValue(props.settingKey, defaultValue(props.settingKey)),
);

function update(value: unknown): void {
  emit("update:modelValue", value);
}

// Nullable numbers: the switch means "null"; the last number typed comes back
// when it is switched off again.
// NaN stands for "limit on, no number yet": null would read as the switch.
function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
const lastNumber = ref<number | null>(finite(props.modelValue));
watch(
  () => props.modelValue,
  (value) => {
    if (finite(value) !== null) lastNumber.value = finite(value);
  },
);
const isNull = computed(() => props.modelValue === null);
function setNull(on: boolean): void {
  update(on ? null : (lastNumber.value ?? Number.NaN));
}

const numberValue = computed(() => finite(props.modelValue));
function onNumber(value: number | null): void {
  update(value === null && nullable.value ? Number.NaN : value);
}
const bytesHint = computed(() =>
  ui.value.unit === "bytes/s" && numberValue.value !== null
    ? `${formatBytes(numberValue.value)}/s`
    : null,
);

const listValue = computed(() => (Array.isArray(props.modelValue) ? props.modelValue : []));
function toggleOption(option: string, on: boolean): void {
  const chosen = new Set(listValue.value as string[]);
  if (on) chosen.add(option);
  else chosen.delete(option);
  // Keep the registry's option order so the patch is stable.
  const order = (ui.value.options ?? []).map((candidate) => candidate.value);
  update(order.filter((candidate) => chosen.has(candidate)));
}
</script>

<template>
  <div class="setting-field" :data-setting="settingKey" :class="{ 'has-error': error }">
    <div class="setting-field__text">
      <div class="setting-field__label">
        <label :for="inputId">{{ ui.label }}</label>
        <Tag
          v-if="modified"
          data-test="modified"
          value="Modified"
          severity="info"
          title="An override is stored for this setting."
        />
        <Tag v-if="dirty" data-test="unsaved" value="Unsaved" severity="warn" />
      </div>
      <p class="setting-field__description">{{ ui.description }}</p>
      <p class="setting-field__default" data-test="default">Default: {{ defaultText }}</p>
    </div>

    <div class="setting-field__control">
      <template v-if="ui.control === 'toggle'">
        <ToggleSwitch
          :model-value="modelValue === true"
          :input-id="inputId"
          :disabled="disabled"
          @update:model-value="update($event)"
        />
      </template>

      <template v-else-if="ui.control === 'number'">
        <div v-if="nullable" class="cellar-row setting-field__null">
          <ToggleSwitch
            :model-value="isNull"
            :input-id="`${inputId}-null`"
            :disabled="disabled"
            data-test="null-switch"
            @update:model-value="setNull($event)"
          />
          <label :for="`${inputId}-null`">{{ ui.nullLabel }}</label>
        </div>
        <div v-if="!nullable || !isNull" class="cellar-row setting-field__number">
          <InputNumber
            :model-value="numberValue"
            :input-id="inputId"
            :min="ui.min"
            :max="ui.max"
            :min-fraction-digits="0"
            :max-fraction-digits="integer ? 0 : 3"
            :invalid="error !== null"
            :disabled="disabled"
            @update:model-value="onNumber($event)"
          />
          <span v-if="ui.unit" class="cellar-muted setting-field__unit">{{ ui.unit }}</span>
        </div>
        <p v-if="bytesHint && !isNull" class="cellar-note" data-test="bytes-hint">
          {{ bytesHint }}
        </p>
      </template>

      <template v-else-if="ui.control === 'select'">
        <Select
          :model-value="modelValue"
          :input-id="inputId"
          :options="ui.options ? [...ui.options] : []"
          option-label="label"
          option-value="value"
          :disabled="disabled"
          @update:model-value="update($event)"
        />
      </template>

      <template v-else-if="ui.control === 'text'">
        <InputText
          :id="inputId"
          :model-value="typeof modelValue === 'string' ? modelValue : ''"
          :invalid="error !== null"
          :disabled="disabled"
          spellcheck="false"
          @update:model-value="update($event ?? '')"
        />
      </template>

      <template v-else-if="ui.control === 'list'">
        <div :id="inputId" class="setting-field__options" role="group">
          <label v-for="option in ui.options" :key="option.value" class="cellar-row">
            <Checkbox
              :model-value="listValue.includes(option.value)"
              binary
              :disabled="disabled"
              :data-option="option.value"
              @update:model-value="toggleOption(option.value, $event)"
            />
            <span>{{ option.label }}</span>
          </label>
        </div>
      </template>

      <small v-if="error" class="setting-field__error" data-test="error">{{ error }}</small>
      <Button
        v-if="canReset"
        data-action="reset"
        label="Reset to default"
        size="small"
        severity="secondary"
        text
        :disabled="disabled"
        @click="emit('reset')"
      />
    </div>
  </div>
</template>

<style scoped>
.setting-field {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
  gap: 0.6rem 1.5rem;
  padding: 0.9rem 0;
  border-top: 1px solid var(--p-content-border-color);
}

.setting-field:first-of-type {
  border-top: none;
}

.setting-field__label {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
  font-weight: 550;
}

.setting-field__description,
.setting-field__default {
  margin: 0.25rem 0 0;
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
  line-height: 1.45;
}

.setting-field__default {
  font-size: 0.78rem;
}

.setting-field__control {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.4rem;
}

.setting-field__options {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
  gap: 0.35rem 0.8rem;
  width: 100%;
}

.setting-field__options label {
  gap: 0.4rem;
  font-size: 0.88rem;
}

.setting-field__error {
  color: var(--cellar-error);
}

@media (max-width: 800px) {
  .setting-field {
    grid-template-columns: 1fr;
  }
}
</style>
