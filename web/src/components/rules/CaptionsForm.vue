<script setup lang="ts">
import { computed, ref, useId, watch } from "vue";
import Checkbox from "primevue/checkbox";
import InputText from "primevue/inputtext";
import Tag from "primevue/tag";
import ToggleSwitch from "primevue/toggleswitch";

/**
 * The `captions` effect: on/off, "all" languages or an explicit list (typed
 * comma separated, shown as chips), and whether auto-generated captions count.
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
const languages = computed<string[] | null>(() => {
  const langs = value.value["languages"];
  return Array.isArray(langs) ? langs.map(String) : null;
});
const allId = useId();
const allLanguages = computed(() => languages.value === null);

function parse(text: string): string[] {
  return text
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

const text = ref((languages.value ?? []).join(", "));
watch(languages, (next) => {
  if (next !== null && parse(text.value).join(",") !== next.join(",")) {
    text.value = next.join(", ");
  }
});

function set(field: string, v: unknown): void {
  emit("update:modelValue", { ...value.value, [field]: v });
}

function setAll(all: boolean): void {
  if (all) {
    set("languages", "all");
    return;
  }
  const list = parse(text.value);
  if (list.length === 0) text.value = "en";
  set("languages", list.length === 0 ? ["en"] : list);
}

function onText(next: string | undefined): void {
  text.value = next ?? "";
  set("languages", parse(text.value));
}
</script>

<template>
  <div class="captions-form" data-test="captions-form">
    <span class="captions-form__row">
      <ToggleSwitch
        :model-value="value['enabled'] !== false"
        :disabled="disabled"
        aria-label="Download captions"
        data-test="captions-enabled"
        @update:model-value="(v: boolean) => set('enabled', v)"
      />
      <span>Download captions</span>
    </span>
    <template v-if="value['enabled'] !== false">
      <span class="captions-form__row">
        <Checkbox
          :model-value="allLanguages"
          binary
          :input-id="allId"
          :disabled="disabled"
          data-test="captions-all"
          @update:model-value="setAll"
        />
        <label :for="allId">All languages</label>
      </span>
      <span v-if="!allLanguages" class="captions-form__row">
        <InputText
          :model-value="text"
          size="small"
          placeholder="en, de, pt-BR"
          aria-label="Caption languages"
          :disabled="disabled"
          data-test="captions-languages"
          @update:model-value="onText"
        />
        <Tag
          v-for="lang in languages ?? []"
          :key="lang"
          :value="lang"
          severity="secondary"
          data-test="captions-chip"
        />
      </span>
      <span class="captions-form__row">
        <ToggleSwitch
          :model-value="value['auto_generated'] !== false"
          :disabled="disabled"
          aria-label="Include auto-generated captions"
          data-test="captions-auto"
          @update:model-value="(v: boolean) => set('auto_generated', v)"
        />
        <span>Include auto-generated captions</span>
      </span>
    </template>
  </div>
</template>

<style scoped>
.captions-form {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.captions-form__row {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  flex-wrap: wrap;
}
</style>
