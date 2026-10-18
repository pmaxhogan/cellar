<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import AutoComplete from "primevue/autocomplete";
import { isChannelId } from "@cellar/shared";
import { useRuleLookups } from "../../lib/rulesLookups.ts";

/**
 * Channel autocomplete against `GET /api/channels?q=`. The value is the
 * channel id (or ids with `multiple`); the title is what the user sees. A
 * pasted `UC...` id is accepted as-is on blur.
 */
interface Option {
  id: string;
  label: string;
}

const props = withDefaults(
  defineProps<{ modelValue: unknown; multiple?: boolean; disabled?: boolean }>(),
  { multiple: false, disabled: false },
);
const emit = defineEmits<{ "update:modelValue": [string | string[] | null] }>();

const lookups = useRuleLookups();
const suggestions = ref<Option[]>([]);

function option(id: string): Option {
  return { id, label: lookups.channelTitles.get(id) ?? id };
}

function ids(): string[] {
  if (props.multiple) {
    return Array.isArray(props.modelValue)
      ? props.modelValue.filter((v): v is string => typeof v === "string")
      : [];
  }
  return typeof props.modelValue === "string" && props.modelValue !== "" ? [props.modelValue] : [];
}

function fromModel(): Option | Option[] | string | null {
  const list = ids().map(option);
  return props.multiple ? list : (list[0] ?? null);
}

const local = ref<Option | Option[] | string | null>(fromModel());

watch(
  () => [props.modelValue, lookups.channelTitles.size],
  () => {
    if (typeof local.value === "string" && !props.multiple) return;
    local.value = fromModel();
  },
  { deep: true },
);

onMounted(() => {
  // Resolve titles for ids saved in the rule; the search matches ids too.
  for (const id of ids()) {
    if (!lookups.channelTitles.has(id)) void lookups.searchChannels(id).catch(() => undefined);
  }
});

async function search(query: string): Promise<void> {
  try {
    const rows = await lookups.searchChannels(query);
    suggestions.value = rows.map((row) => option(row.id));
  } catch {
    suggestions.value = [];
  }
}

function onUpdate(value: unknown): void {
  if (props.multiple) {
    const list = Array.isArray(value) ? (value as Option[]) : [];
    local.value = list;
    emit(
      "update:modelValue",
      list.map((entry) => entry.id),
    );
    return;
  }
  if (value !== null && typeof value === "object") {
    local.value = value as Option;
    emit("update:modelValue", (value as Option).id);
    return;
  }
  local.value = typeof value === "string" ? value : null;
  if (value === null || value === "") emit("update:modelValue", null);
}

function onBlur(): void {
  const text = local.value;
  if (typeof text === "string" && isChannelId(text.trim())) {
    local.value = option(text.trim());
    emit("update:modelValue", text.trim());
  }
}
</script>

<template>
  <AutoComplete
    :model-value="local"
    :suggestions="suggestions"
    option-label="label"
    :multiple="multiple"
    :disabled="disabled"
    :delay="250"
    :min-length="1"
    size="small"
    placeholder="Search channels"
    aria-label="Channel"
    data-test="channel-picker"
    @complete="(e: { query: string }) => search(e.query)"
    @update:model-value="onUpdate"
    @blur="onBlur"
  />
</template>
