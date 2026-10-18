<script setup lang="ts">
import Chart from "primevue/chart";
import type { ChartConfig } from "./series.ts";

/**
 * One chart in a card: a title naming what is plotted (so a single series
 * needs no legend), the canvas with an accessible name, and an optional note.
 * The numbers behind every chart are in the page's data table.
 */
defineProps<{ title: string; description?: string; config: ChartConfig; chartId: string }>();
</script>

<template>
  <article class="chart-card" :data-chart="chartId">
    <header class="chart-card__header">
      <h2 :id="`chart-${chartId}-title`">{{ title }}</h2>
      <p v-if="description">{{ description }}</p>
    </header>
    <div class="chart-card__plot">
      <Chart
        :type="config.type"
        :data="config.data"
        :options="config.options"
        :canvas-props="{ role: 'img', 'aria-labelledby': `chart-${chartId}-title` }"
      />
    </div>
    <slot />
  </article>
</template>

<style scoped>
.chart-card {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  min-width: 0;
  padding: 1rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.6rem;
  background: var(--p-content-background);
}

.chart-card__header h2 {
  margin: 0;
  font-size: 0.98rem;
  font-weight: 600;
}

.chart-card__header p {
  margin: 0.2rem 0 0;
  font-size: 0.82rem;
  color: var(--p-text-muted-color);
}

.chart-card__plot {
  position: relative;
  height: 15rem;
}

.chart-card__plot :deep(.p-chart) {
  position: relative;
  height: 100%;
}
</style>
