<script setup lang="ts">
/** A stat tile: sentence-case label, one prominent value, an optional detail line. */
defineProps<{ label: string; value: string; detail?: string }>();
</script>

<template>
  <div class="stat-tile">
    <span class="stat-tile__label">{{ label }}</span>
    <span class="stat-tile__value" data-value>{{ value }}</span>
    <slot />
    <span v-if="detail" class="stat-tile__detail" data-detail>{{ detail }}</span>
  </div>
</template>

<style scoped>
.stat-tile {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-width: 0;
  padding: 0.85rem 1rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.6rem;
  background: var(--p-content-background);
}

.stat-tile__label {
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
}

.stat-tile__value {
  font-size: 1.45rem;
  font-weight: 600;
  line-height: 1.15;
  color: var(--p-text-color);
  overflow-wrap: anywhere;
}

.stat-tile__detail {
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
}
</style>
