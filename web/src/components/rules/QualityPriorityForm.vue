<script setup lang="ts">
import { computed } from "vue";
import Button from "primevue/button";
import SelectButton from "primevue/selectbutton";
import { QualityPrioritySchema, type QualityPriority } from "@cellar/shared";

/**
 * The `quality_priority` effect: every resolution and frame rate tier ranked
 * with up/down buttons, plus which list is the outer sort key. The downloader
 * takes the highest-ranked combination YouTube offers.
 */
const props = withDefaults(defineProps<{ modelValue: unknown; disabled?: boolean }>(), {
  disabled: false,
});
const emit = defineEmits<{ "update:modelValue": [QualityPriority] }>();

const value = computed<QualityPriority>(() => {
  const parsed = QualityPrioritySchema.safeParse(props.modelValue);
  return parsed.success ? parsed.data : QualityPrioritySchema.parse({});
});

const PRIMARY_OPTIONS = [
  { label: "Resolution first", value: "resolution" },
  { label: "Frame rate first", value: "fps" },
];

type ListKey = "resolutions" | "fps";

const lists = computed(() => [
  {
    key: "resolutions" as const,
    title: "Resolutions",
    items: value.value.resolutions.map((tier) => ({ tier, label: `${tier}p` })),
  },
  {
    key: "fps" as const,
    title: "Frame rates",
    items: value.value.fps.map((tier) => ({
      tier,
      label: tier === 24 ? "24 fps or lower" : `${tier} fps`,
    })),
  },
]);

function move(key: ListKey, index: number, delta: -1 | 1): void {
  const next = [...value.value[key]];
  const target = index + delta;
  if (target < 0 || target >= next.length) return;
  [next[index], next[target]] = [next[target]!, next[index]!];
  emit("update:modelValue", { ...value.value, [key]: next });
}

function setPrimary(primary: QualityPriority["primary"]): void {
  emit("update:modelValue", { ...value.value, primary });
}
</script>

<template>
  <div class="quality-form" data-test="quality-form">
    <SelectButton
      :model-value="value.primary"
      :options="PRIMARY_OPTIONS"
      option-label="label"
      option-value="value"
      :allow-empty="false"
      :disabled="disabled"
      size="small"
      aria-label="Rank by"
      data-test="quality-primary"
      @update:model-value="setPrimary"
    />
    <div class="quality-form__lists">
      <ol
        v-for="list in lists"
        :key="list.key"
        class="quality-form__list"
        :aria-label="list.title"
        :data-test="`quality-${list.key}`"
      >
        <li class="quality-form__title cellar-muted">{{ list.title }}</li>
        <li
          v-for="(item, index) in list.items"
          :key="item.tier"
          class="quality-form__item"
          data-test="quality-item"
        >
          <span class="quality-form__rank cellar-muted">{{ index + 1 }}.</span>
          <span class="quality-form__label">{{ item.label }}</span>
          <Button
            label="Up"
            size="small"
            text
            :aria-label="`Move ${item.label} up`"
            :disabled="disabled || index === 0"
            data-test="quality-up"
            @click="move(list.key, index, -1)"
          />
          <Button
            label="Down"
            size="small"
            text
            :aria-label="`Move ${item.label} down`"
            :disabled="disabled || index === list.items.length - 1"
            data-test="quality-down"
            @click="move(list.key, index, 1)"
          />
        </li>
      </ol>
    </div>
    <span class="cellar-muted quality-form__note">
      The format policy breaks ties within a tier. A top tier without AV1 may be transcoded.
    </span>
  </div>
</template>

<style scoped>
.quality-form {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.quality-form__lists {
  display: flex;
  flex-wrap: wrap;
  gap: 1.5rem;
}

.quality-form__list {
  list-style: none;
  margin: 0;
  padding: 0;
  min-width: 12rem;
}

.quality-form__title {
  font-size: 0.85rem;
  margin-bottom: 0.25rem;
}

.quality-form__item {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.quality-form__rank {
  width: 1.75rem;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.quality-form__label {
  flex: 1;
  min-width: 6.5rem;
}

.quality-form__note {
  font-size: 0.85rem;
}
</style>
