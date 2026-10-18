<script setup lang="ts">
import { computed } from "vue";
import type { TakeoutCounts } from "@cellar/shared";
import { skipReasonLabel } from "../../api/takeout.ts";
import { formatDuration, formatNumber } from "../../lib/format.ts";

/** The counts of one finished import, as a compact definition list. */
const props = defineProps<{ counts: TakeoutCounts }>();

const facts = computed(() => {
  const c = props.counts;
  const rows: { key: string; label: string; value: string }[] = [
    {
      key: "history",
      label: "History entries",
      value: `${formatNumber(c.history)} (${formatNumber(c.history_videos)} videos)`,
    },
    { key: "watch_later", label: "Watch later", value: formatNumber(c.watch_later) },
    { key: "liked", label: "Liked videos", value: formatNumber(c.liked) },
    { key: "subscriptions", label: "Subscriptions", value: formatNumber(c.subscriptions) },
    { key: "new_videos", label: "New videos", value: formatNumber(c.new_videos) },
    { key: "new_sources", label: "New sources", value: formatNumber(c.new_sources) },
  ];
  if (c.playlists_ignored > 0) {
    rows.push({
      key: "playlists_ignored",
      label: "Other playlists (not imported)",
      value: `${formatNumber(c.playlists_ignored)} (${formatNumber(c.playlist_videos_ignored)} videos)`,
    });
  }
  rows.push({
    key: "recheck",
    label: "Rechecks queued",
    value: c.recheck_jobs === null ? "waiting for the recheck job" : formatNumber(c.recheck_jobs),
  });
  rows.push({
    key: "duration",
    label: "Took",
    value: formatDuration(Math.max(1, Math.round(c.duration_ms / 1000))),
  });
  return rows;
});

const skipped = computed(() =>
  Object.entries(props.counts.skipped)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${formatNumber(count)} ${skipReasonLabel(reason).toLowerCase()}`)
    .join(", "),
);
</script>

<template>
  <dl class="takeout-counts" data-test="takeout-counts">
    <template v-for="fact in facts" :key="fact.key">
      <dt>{{ fact.label }}</dt>
      <dd :data-count="fact.key">{{ fact.value }}</dd>
    </template>
    <template v-if="skipped !== ''">
      <dt>Skipped</dt>
      <dd data-count="skipped">{{ skipped }}</dd>
    </template>
  </dl>
</template>

<style scoped>
.takeout-counts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.25rem 1rem;
  margin: 0;
  font-size: 0.88rem;
}

.takeout-counts dt {
  color: var(--p-text-muted-color);
}

.takeout-counts dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}
</style>
