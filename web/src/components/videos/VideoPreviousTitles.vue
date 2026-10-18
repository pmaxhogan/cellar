<script setup lang="ts">
import { computed } from "vue";
import type { VideoDetail } from "@cellar/shared";
import { formatAbsolute } from "../../lib/format.ts";
import { formatDay } from "./videoDisplay.ts";

/**
 * The video's earlier titles under its current one, most recent first. The
 * first few show inline; any older ones sit behind a "N more" disclosure.
 */
const props = defineProps<{ titles: VideoDetail["previous_titles"] }>();

/** Titles shown before the rest collapse. */
const SHOWN = 3;

const shown = computed(() => props.titles.slice(0, SHOWN));
const older = computed(() => props.titles.slice(SHOWN));
</script>

<template>
  <div v-if="titles.length > 0" class="previous-titles" data-test="previous-titles">
    <span class="cellar-muted">Previously titled:</span>
    <ul class="previous-titles__list">
      <li
        v-for="entry in shown"
        :key="`${entry.changed_at}-${entry.title}`"
        data-test="previous-title"
      >
        {{ entry.title }}
        <span class="cellar-muted" :title="formatAbsolute(entry.changed_at)"
          >(until {{ formatDay(entry.changed_at) }})</span
        >
      </li>
    </ul>
    <details v-if="older.length > 0" class="previous-titles__more" data-test="previous-titles-more">
      <summary>{{ older.length }} more</summary>
      <ul class="previous-titles__list">
        <li
          v-for="entry in older"
          :key="`${entry.changed_at}-${entry.title}`"
          data-test="previous-title-older"
        >
          {{ entry.title }}
          <span class="cellar-muted" :title="formatAbsolute(entry.changed_at)"
            >(until {{ formatDay(entry.changed_at) }})</span
          >
        </li>
      </ul>
    </details>
  </div>
</template>

<style scoped>
.previous-titles {
  font-size: 0.88rem;
  margin-top: -0.25rem;
}

.previous-titles__list {
  list-style: none;
  margin: 0.15rem 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.previous-titles__list li {
  word-break: break-word;
}

.previous-titles__more summary {
  cursor: pointer;
  color: var(--p-text-muted-color);
  margin-top: 0.15rem;
}
</style>
