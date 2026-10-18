<script setup lang="ts">
import { computed } from "vue";
import Button from "primevue/button";
import InputNumber from "primevue/inputnumber";
import InputText from "primevue/inputtext";
import { YTDLP_EXTRA_ARGS_ALLOWLIST, isAllowlistedYtdlpArg } from "@cellar/shared";

/**
 * The `ytdlp` effect. Every field is optional: an empty field is removed so
 * the global setting applies. Extra arguments must be allowlisted flags.
 */
const props = withDefaults(defineProps<{ modelValue: unknown; disabled?: boolean }>(), {
  disabled: false,
});
const emit = defineEmits<{ "update:modelValue": [Record<string, unknown>] }>();

const value = computed<Record<string, unknown>>(() =>
  props.modelValue !== null && typeof props.modelValue === "object"
    ? (props.modelValue as Record<string, unknown>)
    : {},
);
const args = computed<string[]>(() => {
  const list = value.value["extra_args_allowlisted"];
  return Array.isArray(list) ? list.map(String) : [];
});
const rateKib = computed(() => {
  const bytes = value.value["rate_limit_bytes_per_s"];
  return typeof bytes === "number" ? bytes / 1024 : null;
});

function num(field: string): number | null {
  const v = value.value[field];
  return typeof v === "number" ? v : null;
}

function set(field: string, v: unknown): void {
  const next = { ...value.value };
  const empty = v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
  if (empty) delete next[field];
  else next[field] = v;
  emit("update:modelValue", next);
}

function setRate(kib: number | null): void {
  set("rate_limit_bytes_per_s", kib === null ? null : Math.max(1, Math.round(kib * 1024)));
}

function setArg(index: number, text: string | undefined): void {
  const next = [...args.value];
  next[index] = (text ?? "").trim();
  set("extra_args_allowlisted", next);
}

function addArg(): void {
  emit("update:modelValue", {
    ...value.value,
    extra_args_allowlisted: [...args.value, "--embed-metadata"],
  });
}

function removeArg(index: number): void {
  set(
    "extra_args_allowlisted",
    args.value.filter((_, i) => i !== index),
  );
}
</script>

<template>
  <div class="ytdlp-form" data-test="ytdlp-form">
    <div class="ytdlp-form__grid">
      <label class="cellar-field">
        <span>Format override</span>
        <InputText
          :model-value="String(value['format_override'] ?? '')"
          size="small"
          class="mono"
          placeholder="policy default"
          :disabled="disabled"
          data-test="ytdlp-format"
          @update:model-value="(v: string | undefined) => set('format_override', v?.trim())"
        />
      </label>
      <label class="cellar-field">
        <span>Rate limit (KiB/s)</span>
        <InputNumber
          :model-value="rateKib"
          :min="1"
          :max-fraction-digits="2"
          placeholder="global setting"
          size="small"
          :disabled="disabled"
          data-test="ytdlp-rate"
          @update:model-value="setRate"
        />
      </label>
      <label class="cellar-field">
        <span>Sleep between requests, min (s)</span>
        <InputNumber
          :model-value="num('sleep_requests_min')"
          :min="0"
          :max="3600"
          :max-fraction-digits="2"
          placeholder="global setting"
          size="small"
          :disabled="disabled"
          data-test="ytdlp-sleep-min"
          @update:model-value="(v: number | null) => set('sleep_requests_min', v)"
        />
      </label>
      <label class="cellar-field">
        <span>Sleep between requests, max (s)</span>
        <InputNumber
          :model-value="num('sleep_requests_max')"
          :min="0"
          :max="3600"
          :max-fraction-digits="2"
          placeholder="global setting"
          size="small"
          :disabled="disabled"
          data-test="ytdlp-sleep-max"
          @update:model-value="(v: number | null) => set('sleep_requests_max', v)"
        />
      </label>
      <label class="cellar-field">
        <span>Concurrent fragments</span>
        <InputNumber
          :model-value="num('concurrent_fragments')"
          :min="1"
          :max="32"
          placeholder="global setting"
          size="small"
          :disabled="disabled"
          data-test="ytdlp-fragments"
          @update:model-value="(v: number | null) => set('concurrent_fragments', v)"
        />
      </label>
    </div>
    <div class="cellar-field">
      <span class="cellar-note"
        >Extra arguments (allowlisted flags only, as --flag or --flag=value)</span
      >
      <div v-for="(arg, index) in args" :key="index" class="ytdlp-form__arg">
        <InputText
          :model-value="arg"
          size="small"
          class="mono"
          :invalid="!isAllowlistedYtdlpArg(arg)"
          :aria-label="`Extra argument ${index + 1}`"
          :disabled="disabled"
          data-test="ytdlp-arg"
          @update:model-value="(v: string | undefined) => setArg(index, v)"
        />
        <span v-if="!isAllowlistedYtdlpArg(arg)" class="ytdlp-form__bad" data-test="ytdlp-arg-bad">
          not allowlisted
        </span>
        <Button
          label="Remove"
          size="small"
          text
          severity="danger"
          :disabled="disabled"
          data-test="ytdlp-arg-remove"
          @click="removeArg(index)"
        />
      </div>
      <Button
        label="Add argument"
        size="small"
        text
        class="ytdlp-form__add"
        :disabled="disabled"
        data-test="ytdlp-arg-add"
        @click="addArg"
      />
      <details class="cellar-note">
        <summary>Allowed flags</summary>
        <span class="mono">{{ YTDLP_EXTRA_ARGS_ALLOWLIST.join(" ") }}</span>
      </details>
    </div>
  </div>
</template>

<style scoped>
.ytdlp-form {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.ytdlp-form__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
  gap: 0.6rem;
}

.ytdlp-form__arg {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.ytdlp-form__bad {
  color: var(--cellar-error);
  font-size: 0.8rem;
}

.ytdlp-form__add {
  align-self: flex-start;
}
</style>
