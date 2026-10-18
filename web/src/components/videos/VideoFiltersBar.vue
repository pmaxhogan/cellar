<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import Button from "primevue/button";
import InputNumber from "primevue/inputnumber";
import InputText from "primevue/inputtext";
import MultiSelect from "primevue/multiselect";
import Select from "primevue/select";
import { SOURCE_KINDS, STATUS_VALUES, VIDEO_TYPES } from "@cellar/shared";
import { emptyFilters, hasFilters, type VideoFilters } from "../../api/videos.ts";
import AppIcon from "../AppIcon.vue";
import ChannelPicker from "../rules/ChannelPicker.vue";
import { SOURCE_LABELS, TYPE_LABELS } from "./videoDisplay.ts";

/**
 * The filter bar above the videos table. Every change is emitted as a whole
 * new filter object; the search box is debounced so typing does not fire a
 * request per keystroke (Enter searches at once).
 */
const props = defineProps<{
  modelValue: VideoFilters;
  accounts: { id: number; label: string }[];
  locations: { id: number; label: string }[];
}>();
const emit = defineEmits<{ "update:modelValue": [VideoFilters] }>();

const SEARCH_DEBOUNCE_MS = 300;

const q = ref(props.modelValue.q);
const expanded = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;

function cancelTimer(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

function patch(change: Partial<VideoFilters>): void {
  emit("update:modelValue", { ...props.modelValue, q: q.value, ...change });
}

watch(
  () => props.modelValue.q,
  (next) => {
    if (next !== q.value.trim()) q.value = next;
  },
);

function onSearchInput(value: string | undefined): void {
  q.value = value ?? "";
  cancelTimer();
  timer = setTimeout(() => {
    timer = null;
    if (q.value.trim() !== props.modelValue.q.trim()) patch({ q: q.value });
  }, SEARCH_DEBOUNCE_MS);
}

function searchNow(): void {
  cancelTimer();
  patch({ q: q.value });
}

function reset(): void {
  cancelTimer();
  q.value = "";
  emit("update:modelValue", emptyFilters());
}

onBeforeUnmount(cancelTimer);

const SOURCE_OPTIONS = SOURCE_KINDS.map((value) => ({ value, label: SOURCE_LABELS[value] }));
const STATUS_OPTIONS = STATUS_VALUES.map((value) => ({ value, label: value }));
const TYPE_OPTIONS = VIDEO_TYPES.map((value) => ({ value, label: TYPE_LABELS[value] }));
const DOWNLOADED_OPTIONS = [
  { value: "yes", label: "Downloaded" },
  { value: "no", label: "Not downloaded" },
];
const PRI_OPTIONS = [
  { value: "-1", label: "Keep forever (-1)" },
  { value: "0", label: "Trashed (0)" },
  { value: "positive", label: "Reclaimable (> 0)" },
];

const active = computed(() => hasFilters({ ...props.modelValue, q: q.value }));

/** The duration inputs take minutes; the filter stores seconds. */
function minutes(seconds: number | null): number | null {
  return seconds === null ? null : Math.round(seconds / 60);
}

function seconds(value: number | null | undefined): number | null {
  return value === null || value === undefined || value < 0 ? null : Math.round(value * 60);
}

function dateValue(event: Event): string | null {
  const value = (event.target as HTMLInputElement).value;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}
</script>

<template>
  <div class="video-filters cellar-card" data-test="video-filters">
    <div class="video-filters__main">
      <span class="video-filters__search">
        <AppIcon name="search" :size="16" />
        <InputText
          :model-value="q"
          data-test="video-search"
          placeholder="Search titles, descriptions, channels and tags"
          aria-label="Search videos"
          @update:model-value="onSearchInput"
          @keyup.enter="searchNow"
        />
      </span>
      <MultiSelect
        :model-value="modelValue.source"
        :options="SOURCE_OPTIONS"
        option-label="label"
        option-value="value"
        placeholder="Any source"
        display="chip"
        :max-selected-labels="2"
        size="small"
        aria-label="Source"
        data-test="filter-source"
        @update:model-value="patch({ source: $event })"
      />
      <MultiSelect
        :model-value="modelValue.status"
        :options="STATUS_OPTIONS"
        option-label="label"
        option-value="value"
        placeholder="Any status"
        :max-selected-labels="2"
        size="small"
        aria-label="Status"
        data-test="filter-status"
        @update:model-value="patch({ status: $event })"
      />
      <Select
        :model-value="modelValue.downloaded"
        :options="DOWNLOADED_OPTIONS"
        option-label="label"
        option-value="value"
        placeholder="Downloaded or not"
        show-clear
        size="small"
        aria-label="Downloaded"
        data-test="filter-downloaded"
        @update:model-value="patch({ downloaded: $event ?? null })"
      />
      <Button
        :label="expanded ? 'Fewer filters' : 'More filters'"
        size="small"
        text
        data-test="filters-toggle"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      />
      <Button
        v-if="active"
        label="Clear filters"
        size="small"
        severity="secondary"
        text
        data-test="filters-reset"
        @click="reset"
      />
    </div>

    <div v-show="expanded" class="video-filters__more" data-test="filters-more">
      <div class="cellar-field">
        <label>Account</label>
        <Select
          :model-value="modelValue.account_id"
          :options="accounts"
          option-label="label"
          option-value="id"
          placeholder="Any account"
          show-clear
          size="small"
          aria-label="Account"
          data-test="filter-account"
          @update:model-value="patch({ account_id: $event ?? null })"
        />
      </div>
      <div class="cellar-field">
        <label>Channel</label>
        <ChannelPicker
          :model-value="modelValue.channel_id"
          data-test="filter-channel"
          @update:model-value="patch({ channel_id: typeof $event === 'string' ? $event : null })"
        />
      </div>
      <div class="cellar-field">
        <label>Type</label>
        <MultiSelect
          :model-value="modelValue.type"
          :options="TYPE_OPTIONS"
          option-label="label"
          option-value="value"
          placeholder="Any type"
          size="small"
          aria-label="Type"
          data-test="filter-type"
          @update:model-value="patch({ type: $event })"
        />
      </div>
      <div class="cellar-field">
        <label>Reclaim priority</label>
        <Select
          :model-value="modelValue.pri"
          :options="PRI_OPTIONS"
          option-label="label"
          option-value="value"
          placeholder="Any priority"
          show-clear
          size="small"
          aria-label="Reclaim priority"
          data-test="filter-pri"
          @update:model-value="patch({ pri: $event ?? null })"
        />
      </div>
      <div class="cellar-field">
        <label>Location</label>
        <Select
          :model-value="modelValue.location_id"
          :options="locations"
          option-label="label"
          option-value="id"
          placeholder="Any location"
          show-clear
          size="small"
          aria-label="Location"
          data-test="filter-location"
          @update:model-value="patch({ location_id: $event ?? null })"
        />
      </div>
      <div class="cellar-field">
        <label for="video-date-from">Uploaded from</label>
        <input
          id="video-date-from"
          class="p-inputtext p-component p-inputtext-sm"
          type="date"
          :value="modelValue.date_from ?? ''"
          data-test="filter-date-from"
          @change="patch({ date_from: dateValue($event) })"
        />
      </div>
      <div class="cellar-field">
        <label for="video-date-to">Uploaded to</label>
        <input
          id="video-date-to"
          class="p-inputtext p-component p-inputtext-sm"
          type="date"
          :value="modelValue.date_to ?? ''"
          data-test="filter-date-to"
          @change="patch({ date_to: dateValue($event) })"
        />
      </div>
      <div class="cellar-field">
        <label>Duration (minutes)</label>
        <span class="video-filters__range">
          <InputNumber
            :model-value="minutes(modelValue.min_duration)"
            :min="0"
            placeholder="min"
            size="small"
            input-class="video-filters__num"
            aria-label="Minimum duration in minutes"
            data-test="filter-min-duration"
            @update:model-value="patch({ min_duration: seconds($event) })"
          />
          <span class="cellar-muted">to</span>
          <InputNumber
            :model-value="minutes(modelValue.max_duration)"
            :min="0"
            placeholder="max"
            size="small"
            input-class="video-filters__num"
            aria-label="Maximum duration in minutes"
            data-test="filter-max-duration"
            @update:model-value="patch({ max_duration: seconds($event) })"
          />
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.video-filters {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.video-filters__main {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}

.video-filters__search {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  flex: 1 1 18rem;
  color: var(--p-text-muted-color);
}

.video-filters__search :deep(input) {
  width: 100%;
}

.video-filters__more {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
  gap: 0.75rem;
}

.video-filters__range {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

.video-filters__range :deep(.video-filters__num) {
  width: 5rem;
}
</style>
