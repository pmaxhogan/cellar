<script setup lang="ts">
import EmptyState from "../components/EmptyState.vue";
import PageHeader from "../components/PageHeader.vue";
</script>

<template>
  <section>
    <PageHeader
      title="Videos"
      description="Every archived and known video, with full-text search and filters."
    />
    <EmptyState
      icon="videos"
      title="No videos yet"
      description="Videos appear here once an account is linked and the first ingestion runs."
    />
  </section>
</template>
