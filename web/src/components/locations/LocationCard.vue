<script setup lang="ts">
import Button from "primevue/button";
import Tag from "primevue/tag";
import type { LocationView } from "../../api/locations.ts";
import UsageBar from "./UsageBar.vue";

withDefaults(defineProps<{ location: LocationView; busy?: boolean; refreshing?: boolean }>(), {
  busy: false,
  refreshing: false,
});

defineEmits<{
  edit: [LocationView];
  toggle: [LocationView];
  remove: [LocationView];
  refresh: [LocationView];
}>();
</script>

<template>
  <article class="cellar-card location-card" :data-location="location.id">
    <header class="location-card__head">
      <div>
        <h2>{{ location.label }}</h2>
        <code class="location-card__path" data-fact="path">{{ location.container_path }}</code>
      </div>
      <span class="cellar-row location-card__tags">
        <Tag
          data-fact="enabled"
          :value="location.enabled ? 'Enabled' : 'Disabled'"
          :severity="location.enabled ? 'success' : 'secondary'"
        />
        <Tag
          data-fact="mounted"
          :value="location.mounted ? 'Mounted' : 'Not mounted'"
          :severity="location.mounted ? 'info' : 'danger'"
          :title="
            location.mounted
              ? 'The path is a mount inside the container.'
              : 'Nothing is mounted at this path. Add the bind mount to the compose file.'
          "
        />
      </span>
    </header>

    <UsageBar
      :used="location.used_bytes"
      :quota="location.quota_bytes"
      :fs-free="location.fs_free_bytes"
      :fs-total="location.fs_total_bytes"
    />

    <div class="cellar-row">
      <Button
        data-action="edit"
        size="small"
        severity="secondary"
        label="Edit"
        :disabled="busy"
        @click="$emit('edit', location)"
      />
      <Button
        data-action="toggle"
        size="small"
        severity="secondary"
        text
        :label="location.enabled ? 'Disable' : 'Enable'"
        :loading="busy"
        @click="$emit('toggle', location)"
      />
      <Button
        data-action="refresh"
        size="small"
        severity="secondary"
        text
        label="Refresh usage"
        :loading="refreshing"
        @click="$emit('refresh', location)"
      />
      <Button
        data-action="remove"
        size="small"
        severity="danger"
        text
        label="Delete"
        :disabled="busy"
        @click="$emit('remove', location)"
      />
    </div>
  </article>
</template>

<style scoped>
.location-card {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.location-card__head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  flex-wrap: wrap;
}

.location-card__head h2 {
  margin: 0 0 0.2rem;
  font-size: 1.05rem;
}

.location-card__path {
  font-size: 0.82rem;
  color: var(--p-text-muted-color);
}

.location-card__tags {
  gap: 0.35rem;
}
</style>
