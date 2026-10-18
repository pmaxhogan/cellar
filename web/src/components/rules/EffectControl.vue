<script setup lang="ts">
import { computed, onMounted } from "vue";
import Checkbox from "primevue/checkbox";
import InputNumber from "primevue/inputnumber";
import Select from "primevue/select";
import SelectButton from "primevue/selectbutton";
import ToggleSwitch from "primevue/toggleswitch";
import {
  effectRegistry,
  QualityPrioritySchema,
  type EffectKey,
  type EffectOption,
} from "@cellar/shared";
import { formatEffectValue } from "../../lib/ruleSummary.ts";
import { useRuleLookups } from "../../lib/rulesLookups.ts";
import AgeDurationInput from "./AgeDurationInput.vue";
import CaptionsForm from "./CaptionsForm.vue";
import IdListChoice from "./IdListChoice.vue";
import NotifyForm from "./NotifyForm.vue";
import QualityPriorityForm from "./QualityPriorityForm.vue";
import TranscodeForm from "./TranscodeForm.vue";
import YtdlpForm from "./YtdlpForm.vue";

/** The input for one set effect, switched on the registry's `ui.control`. */
const props = withDefaults(
  defineProps<{ effectKey: EffectKey; modelValue: unknown; disabled?: boolean }>(),
  { disabled: false },
);
const emit = defineEmits<{ "update:modelValue": [unknown] }>();

const lookups = useRuleLookups();
const ui = computed(() => effectRegistry[props.effectKey].ui);
const control = computed(() => ui.value.control);
const nullId = computed(() => `effect-null-${props.effectKey}`);
const hint = computed(() =>
  formatEffectValue(props.effectKey, props.modelValue, lookups.labels.value),
);

const locationOptions = computed(() => [
  { label: ui.value.nullLabel, value: null },
  ...lookups.locations.value.map((row) => ({
    label: row.enabled ? row.label : `${row.label} (disabled)`,
    value: row.id,
  })),
]);
const accountOptions = computed(() =>
  lookups.accounts.value.map((row) => ({ label: row.label, value: row.id })),
);
const proxyOptions = computed(() =>
  lookups.proxies.value.map((row) => ({
    label: row.enabled ? row.label : `${row.label} (disabled)`,
    value: row.id,
  })),
);
const RECHECK_OPTIONS = [
  { label: "Tiered by age", value: "tiered" },
  { label: "Fixed interval", value: "fixed" },
];

onMounted(() => {
  if (control.value === "location") void lookups.ensureLocations();
  if (control.value === "accounts") void lookups.ensureAccounts();
  if (control.value === "proxy") void lookups.ensureProxies();
});

function set(value: unknown): void {
  emit("update:modelValue", value);
}

function defaultQuality(): unknown {
  return QualityPrioritySchema.parse({});
}

function setNullable(isNull: boolean, fallback: unknown): void {
  set(isNull ? null : fallback);
}
</script>

<template>
  <div class="effect-control" :data-control="control" data-test="effect-control">
    <span v-if="control === 'toggle'" class="effect-control__inline">
      <ToggleSwitch
        :model-value="modelValue === true"
        :disabled="disabled"
        :aria-label="ui.label"
        data-test="effect-toggle"
        @update:model-value="set"
      />
      <span>{{ hint }}</span>
    </span>

    <span v-else-if="control === 'int'" class="effect-control__inline">
      <span v-if="ui.nullLabel" class="effect-control__inline">
        <Checkbox
          :model-value="modelValue === null"
          binary
          :input-id="nullId"
          :disabled="disabled"
          data-test="effect-null"
          @update:model-value="(v: boolean) => setNullable(v, ui.min)"
        />
        <label :for="nullId">{{ ui.nullLabel }}</label>
      </span>
      <InputNumber
        v-if="modelValue !== null"
        :model-value="typeof modelValue === 'number' ? modelValue : null"
        :min="ui.min"
        :max="ui.max"
        :disabled="disabled"
        size="small"
        :aria-label="ui.label"
        data-test="effect-int"
        @update:model-value="set"
      />
      <span class="cellar-muted" data-test="effect-hint">{{ hint }}</span>
    </span>

    <Select
      v-else-if="control === 'select'"
      :model-value="modelValue"
      :options="ui.options as EffectOption[]"
      option-label="label"
      option-value="value"
      :disabled="disabled"
      size="small"
      :aria-label="ui.label"
      data-test="effect-select"
      @update:model-value="set"
    />

    <Select
      v-else-if="control === 'location'"
      :model-value="modelValue"
      :options="locationOptions"
      option-label="label"
      option-value="value"
      :disabled="disabled"
      size="small"
      :aria-label="ui.label"
      data-test="effect-location"
      @update:model-value="set"
    />

    <TranscodeForm
      v-else-if="control === 'transcode'"
      :model-value="modelValue"
      :disabled="disabled"
      @update:model-value="set"
    />

    <CaptionsForm
      v-else-if="control === 'captions'"
      :model-value="modelValue"
      :disabled="disabled"
      @update:model-value="set"
    />

    <span v-else-if="control === 'quality'" class="effect-control__stack">
      <span class="effect-control__inline">
        <Checkbox
          :model-value="modelValue === null"
          binary
          :input-id="nullId"
          :disabled="disabled"
          data-test="effect-null"
          @update:model-value="(v: boolean) => setNullable(v, defaultQuality())"
        />
        <label :for="nullId">{{ ui.nullLabel }}</label>
      </span>
      <QualityPriorityForm
        v-if="modelValue !== null"
        :model-value="modelValue"
        :disabled="disabled"
        @update:model-value="set"
      />
    </span>

    <YtdlpForm
      v-else-if="control === 'ytdlp'"
      :model-value="modelValue"
      :disabled="disabled"
      @update:model-value="set"
    />

    <IdListChoice
      v-else-if="control === 'accounts'"
      :model-value="modelValue"
      :modes="[
        { label: 'Sourcing accounts', value: 'sourcing' },
        { label: 'Any account', value: 'any' },
      ]"
      :options="accountOptions"
      list-label="Specific accounts"
      empty-message="No accounts linked"
      :disabled="disabled"
      @update:model-value="set"
    />

    <IdListChoice
      v-else-if="control === 'proxy'"
      :model-value="modelValue"
      :modes="[
        { label: 'No proxy', value: 'none' },
        { label: 'Proxy pool', value: 'pool' },
      ]"
      :options="proxyOptions"
      list-label="Specific proxies"
      empty-message="No proxies configured"
      :disabled="disabled"
      @update:model-value="set"
    />

    <span v-else-if="control === 'duration'" class="effect-control__inline">
      <span class="effect-control__inline">
        <Checkbox
          :model-value="modelValue === null"
          binary
          :input-id="nullId"
          :disabled="disabled"
          data-test="effect-null"
          @update:model-value="(v: boolean) => setNullable(v, { days: 1 })"
        />
        <label :for="nullId">{{ ui.nullLabel }}</label>
      </span>
      <AgeDurationInput
        v-if="modelValue !== null"
        :model-value="modelValue"
        :disabled="disabled"
        @update:model-value="set"
      />
    </span>

    <span v-else-if="control === 'recheck'" class="effect-control__inline">
      <SelectButton
        :model-value="modelValue === 'tiered' ? 'tiered' : 'fixed'"
        :options="RECHECK_OPTIONS"
        option-label="label"
        option-value="value"
        :allow-empty="false"
        :disabled="disabled"
        size="small"
        data-test="effect-recheck"
        @update:model-value="(v: string) => set(v === 'tiered' ? 'tiered' : { days: 7 })"
      />
      <AgeDurationInput
        v-if="modelValue !== 'tiered'"
        :model-value="modelValue"
        :disabled="disabled"
        @update:model-value="set"
      />
    </span>

    <NotifyForm
      v-else-if="control === 'notify'"
      :model-value="modelValue"
      :disabled="disabled"
      @update:model-value="set"
    />
  </div>
</template>

<style scoped>
.effect-control__inline {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  flex-wrap: wrap;
}

.effect-control__stack {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
</style>
