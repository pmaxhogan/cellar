<script setup lang="ts">
import { computed } from "vue";
import { groupResults, type CheckLevel, type CheckRow } from "../../api/checks.ts";
import AppIcon from "../AppIcon.vue";

/** One self-check run as a status grid, one card per group of checks. */
const props = defineProps<{ row: CheckRow }>();

const groups = computed(() => groupResults(props.row.results));

const ICONS: Record<CheckLevel, string> = {
  ok: "check",
  warn: "alert",
  fail: "alert",
  skip: "pause",
};

function tookLabel(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
</script>

<template>
  <div class="check-grid">
    <article
      v-for="group in groups"
      :key="group.key"
      class="check-group cellar-card"
      :class="`level-${group.level}`"
      :data-group="group.key"
      :data-level="group.level"
    >
      <h3>
        <AppIcon :name="ICONS[group.level]" :size="15" />
        {{ group.label }}
      </h3>
      <ul>
        <li
          v-for="result in group.results"
          :key="result.key"
          class="check-result"
          :class="`level-${result.level}`"
          :data-check="result.key"
          :data-level="result.level"
        >
          <div class="check-result__head">
            <span class="check-result__level">{{ result.level }}</span>
            <span class="check-result__label">{{ result.label }}</span>
            <span class="check-result__took cellar-muted">{{ tookLabel(result.took_ms) }}</span>
          </div>
          <p v-if="result.detail" class="check-result__detail">{{ result.detail }}</p>
        </li>
      </ul>
    </article>
    <p v-if="groups.length === 0" class="cellar-muted">This run recorded no checks.</p>
  </div>
</template>

<style scoped>
.check-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(19rem, 1fr));
  gap: 0.9rem;
}

.check-group {
  border-top-width: 3px;
}

.check-group.level-ok {
  border-top-color: var(--cellar-success);
}

.check-group.level-warn {
  border-top-color: var(--cellar-warn);
}

.check-group.level-fail {
  border-top-color: var(--cellar-error);
}

.check-group.level-skip {
  border-top-color: var(--p-text-muted-color);
}

.check-group h3 {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin: 0 0 0.6rem;
  font-size: 0.8rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.check-group.level-ok h3 {
  color: var(--cellar-success);
}

.check-group.level-warn h3 {
  color: var(--cellar-warn);
}

.check-group.level-fail h3 {
  color: var(--cellar-error);
}

.check-group.level-skip h3 {
  color: var(--p-text-muted-color);
}

.check-group ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.check-result__head {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}

.check-result__level {
  flex: none;
  min-width: 2.6rem;
  padding: 0.05rem 0.35rem;
  border-radius: 5px;
  font-size: 0.7rem;
  font-weight: 650;
  text-align: center;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.check-result.level-ok .check-result__level {
  color: var(--cellar-success);
  background: var(--cellar-success-bg);
}

.check-result.level-warn .check-result__level {
  color: var(--cellar-warn);
  background: var(--cellar-warn-bg);
}

.check-result.level-fail .check-result__level {
  color: var(--cellar-error);
  background: var(--cellar-error-bg);
}

.check-result.level-skip .check-result__level {
  color: var(--p-text-muted-color);
  background: var(--p-content-hover-background);
}

.check-result__label {
  flex: 1;
  min-width: 0;
  font-weight: 550;
}

.check-result__took {
  flex: none;
  font-size: 0.75rem;
}

.check-result__detail {
  margin: 0.2rem 0 0;
  padding-left: 3.1rem;
  font-size: 0.83rem;
  color: var(--p-text-muted-color);
  overflow-wrap: anywhere;
}
</style>
