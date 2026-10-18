<script setup lang="ts">
import { computed } from "vue";
import DatePicker from "primevue/datepicker";
import InputNumber from "primevue/inputnumber";
import InputText from "primevue/inputtext";
import MultiSelect from "primevue/multiselect";
import Select from "primevue/select";
import SelectButton from "primevue/selectbutton";
import ToggleSwitch from "primevue/toggleswitch";
import { fieldInfo, operatorInfo, type UiLeaf } from "../../lib/rulesTree.ts";
import { humanize } from "../../lib/ruleSummary.ts";
import { useRuleLookups } from "../../lib/rulesLookups.ts";
import AgeDurationInput from "./AgeDurationInput.vue";
import ChannelPicker from "./ChannelPicker.vue";
import SecondsInput from "./SecondsInput.vue";
import { useConditionContext } from "./conditionContext.ts";

/** The value input for one leaf, chosen by the operator's value kind in FIELD_CATALOG. */
const props = defineProps<{ node: UiLeaf }>();
const ctx = useConditionContext();
const lookups = useRuleLookups();

const info = computed(() => fieldInfo(props.node.field));
const kind = computed(() => operatorInfo(props.node.field, props.node.op)?.value);
const disabled = computed(() => ctx.disabled.value);
const isSeconds = computed(() => props.node.field === "duration_s");

const enumOptions = computed(() =>
  info.value.options!.map((value) => ({ label: humanize(value), value })),
);
const accountOptions = computed(() =>
  lookups.accounts.value.map((row) => ({ label: row.label, value: row.id })),
);
const locationOptions = computed(() =>
  lookups.locations.value.map((row) => ({ label: row.label, value: row.id })),
);
const NULL_OPTIONS = [
  { label: "empty", value: true },
  { label: "set", value: false },
];

const range = computed<[unknown, unknown]>(() =>
  Array.isArray(props.node.value) ? [props.node.value[0], props.node.value[1]] : [0, 0],
);

const instant = computed(() => {
  const v = props.node.value;
  const ms = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? new Date(ms) : null;
});

function set(value: unknown): void {
  ctx.setValue(props.node, value);
}

function setRange(index: 0 | 1, value: unknown): void {
  const next: unknown[] = [...range.value];
  next[index] = value;
  set(next);
}

function setInstant(value: unknown): void {
  set(value instanceof Date ? value.toISOString() : null);
}
</script>

<template>
  <span class="cond-value" :data-kind="kind" data-test="leaf-value">
    <template v-if="kind === 'number'">
      <SecondsInput
        v-if="isSeconds"
        :model-value="node.value"
        :disabled="disabled"
        @update:model-value="set"
      />
      <InputNumber
        v-else
        :model-value="typeof node.value === 'number' ? node.value : null"
        :disabled="disabled"
        :max-fraction-digits="4"
        size="small"
        aria-label="Value"
        data-test="value-number"
        @update:model-value="set"
      />
    </template>

    <template v-else-if="kind === 'number_range'">
      <template v-if="isSeconds">
        <SecondsInput
          :model-value="range[0]"
          :disabled="disabled"
          @update:model-value="(v: number) => setRange(0, v)"
        />
        <span class="cellar-muted">and</span>
        <SecondsInput
          :model-value="range[1]"
          :disabled="disabled"
          @update:model-value="(v: number) => setRange(1, v)"
        />
      </template>
      <template v-else>
        <InputNumber
          :model-value="typeof range[0] === 'number' ? range[0] : null"
          :disabled="disabled"
          :max-fraction-digits="4"
          size="small"
          aria-label="Minimum"
          data-test="value-min"
          @update:model-value="(v: number | null) => setRange(0, v)"
        />
        <span class="cellar-muted">and</span>
        <InputNumber
          :model-value="typeof range[1] === 'number' ? range[1] : null"
          :disabled="disabled"
          :max-fraction-digits="4"
          size="small"
          aria-label="Maximum"
          data-test="value-max"
          @update:model-value="(v: number | null) => setRange(1, v)"
        />
      </template>
    </template>

    <span v-else-if="kind === 'bool'" class="cond-value__bool">
      <ToggleSwitch
        :model-value="node.value === true"
        :disabled="disabled"
        aria-label="Value"
        data-test="value-bool"
        @update:model-value="set"
      />
      <span>{{ node.value === true ? "yes" : "no" }}</span>
    </span>

    <SelectButton
      v-else-if="kind === 'null_flag'"
      :model-value="node.value"
      :options="NULL_OPTIONS"
      option-label="label"
      option-value="value"
      :allow-empty="false"
      :disabled="disabled"
      size="small"
      data-test="value-null"
      @update:model-value="set"
    />

    <InputText
      v-else-if="kind === 'text'"
      :model-value="String(node.value ?? '')"
      :disabled="disabled"
      size="small"
      aria-label="Text"
      data-test="value-text"
      @update:model-value="set"
    />

    <span v-else-if="kind === 'regex'" class="cond-value__regex">
      <InputText
        :model-value="String(node.value ?? '')"
        :disabled="disabled"
        size="small"
        class="mono"
        aria-label="Regular expression"
        placeholder="pattern"
        data-test="value-regex"
        @update:model-value="set"
      />
      <span class="cellar-note" data-test="regex-hint">
        JavaScript regex without slashes or flags; tick "any case" to ignore case.
      </span>
    </span>

    <AgeDurationInput
      v-else-if="kind === 'duration'"
      :model-value="node.value"
      :disabled="disabled"
      @update:model-value="set"
    />

    <DatePicker
      v-else-if="kind === 'instant'"
      :model-value="instant"
      show-time
      hour-format="24"
      show-icon
      :disabled="disabled"
      size="small"
      aria-label="Date and time"
      data-test="value-instant"
      @update:model-value="setInstant"
    />

    <Select
      v-else-if="kind === 'enum'"
      :model-value="node.value"
      :options="enumOptions"
      option-label="label"
      option-value="value"
      :disabled="disabled"
      size="small"
      aria-label="Value"
      data-test="value-enum"
      @update:model-value="set"
    />

    <MultiSelect
      v-else-if="kind === 'enum_list' || kind === 'source_list'"
      :model-value="Array.isArray(node.value) ? node.value : []"
      :options="enumOptions"
      option-label="label"
      option-value="value"
      display="chip"
      :disabled="disabled"
      size="small"
      placeholder="Choose"
      aria-label="Values"
      data-test="value-enum-list"
      @update:model-value="set"
    />

    <Select
      v-else-if="kind === 'account_id'"
      :model-value="node.value"
      :options="accountOptions"
      option-label="label"
      option-value="value"
      :disabled="disabled"
      size="small"
      placeholder="Account"
      empty-message="No accounts linked"
      data-test="value-account"
      @update:model-value="set"
    />

    <MultiSelect
      v-else-if="kind === 'account_ids'"
      :model-value="Array.isArray(node.value) ? node.value : []"
      :options="accountOptions"
      option-label="label"
      option-value="value"
      display="chip"
      :disabled="disabled"
      size="small"
      placeholder="Accounts"
      empty-message="No accounts linked"
      data-test="value-accounts"
      @update:model-value="set"
    />

    <Select
      v-else-if="kind === 'location_id'"
      :model-value="node.value"
      :options="locationOptions"
      option-label="label"
      option-value="value"
      :disabled="disabled"
      size="small"
      placeholder="Location"
      empty-message="No locations registered"
      data-test="value-location"
      @update:model-value="set"
    />

    <ChannelPicker
      v-else-if="kind === 'channel_id' || kind === 'channel_ids'"
      :model-value="node.value"
      :multiple="kind === 'channel_ids'"
      :disabled="disabled"
      @update:model-value="set"
    />
  </span>
</template>

<style scoped>
.cond-value {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  flex-wrap: wrap;
}

.cond-value__bool,
.cond-value__regex {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
}
</style>
