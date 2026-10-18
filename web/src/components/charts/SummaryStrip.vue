<script setup lang="ts">
import { computed } from "vue";
import type { StatsLocationBytes, StatsSummary } from "@cellar/shared";
import { usageSummary } from "../../api/locations.ts";
import { formatBytes, formatNumber } from "../../lib/format.ts";
import MeterBar, { type MeterTone } from "./MeterBar.vue";
import StatTile from "./StatTile.vue";

/** The summary strip above the charts: live counts, storage and the API budget. */
const props = defineProps<{ summary: StatsSummary }>();

/** API usage turns warn at this share of the budget and danger once it is spent. */
const API_WARN_PCT = 80;

const TONE_WORDS: Record<MeterTone, string> = {
  ok: "",
  warn: "nearing the limit",
  danger: "at the limit",
};

const apiPercent = computed(() =>
  props.summary.api_units_budget > 0
    ? (props.summary.api_units_today / props.summary.api_units_budget) * 100
    : 0,
);

const apiTone = computed<MeterTone>(() =>
  apiPercent.value >= 100 ? "danger" : apiPercent.value >= API_WARN_PCT ? "warn" : "ok",
);

const apiDetail = computed(() => {
  const base = `${apiPercent.value.toFixed(0)}% of ${formatNumber(props.summary.api_units_budget)} a day`;
  const word = TONE_WORDS[apiTone.value];
  return word === "" ? base : `${base}, ${word}`;
});

/** Enabled locations, plus disabled ones that still hold files. */
const storage = computed(() =>
  props.summary.bytes_by_location.filter((location) => location.enabled || location.bytes_used > 0),
);

function storageTone(location: StatsLocationBytes): MeterTone {
  return usageSummary(location.bytes_used, location.quota_bytes).tone;
}

function storageDetail(location: StatsLocationBytes): string {
  const summary = usageSummary(location.bytes_used, location.quota_bytes);
  const suffix = location.enabled ? "" : " (disabled)";
  if (summary.percent === null) return `No quota set${suffix}`;
  const word = TONE_WORDS[summary.tone];
  const base = `${summary.percent.toFixed(1)}% of ${formatBytes(location.quota_bytes)} quota`;
  return `${word === "" ? base : `${base}, ${word}`}${suffix}`;
}

const downloadsDetail = computed(
  () =>
    `${formatNumber(props.summary.downloads_7d)} downloads in 7 days, ` +
    `${formatNumber(props.summary.downloads_30d)} in 30`,
);
</script>

<template>
  <section class="summary-strip" aria-label="Summary">
    <StatTile
      label="Catalog"
      :value="formatNumber(summary.videos)"
      detail="Videos cellar knows about"
      data-tile="catalog"
    />
    <StatTile
      label="Downloaded"
      :value="formatNumber(summary.downloaded)"
      :detail="downloadsDetail"
      data-tile="downloaded"
    />
    <StatTile
      label="Gone"
      :value="formatNumber(summary.gone)"
      detail="Private or removed on YouTube"
      data-tile="gone"
    />
    <StatTile
      v-for="location in storage"
      :key="location.id"
      :label="`Storage: ${location.label}`"
      :value="formatBytes(location.bytes_used)"
      :detail="storageDetail(location)"
      :data-tile="`storage-${location.id}`"
    >
      <MeterBar
        v-if="location.quota_bytes > 0"
        :value="location.bytes_used"
        :max="location.quota_bytes"
        :tone="storageTone(location)"
        :label="`Storage used on ${location.label}`"
      />
    </StatTile>
    <StatTile
      label="API units today"
      :value="`${formatNumber(summary.api_units_today)} / ${formatNumber(summary.api_units_budget)}`"
      :detail="apiDetail"
      data-tile="api"
    >
      <MeterBar
        :value="summary.api_units_today"
        :max="summary.api_units_budget"
        :tone="apiTone"
        label="API units used today"
      />
    </StatTile>
  </section>
</template>

<style scoped>
.summary-strip {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(12.5rem, 1fr));
  gap: 0.75rem;
  margin-bottom: 1.25rem;
}
</style>
