<script setup lang="ts">
import EmptyState from "../components/EmptyState.vue";
import PageHeader from "../components/PageHeader.vue";
</script>

<template>
  <section>
    <PageHeader
      title="Video"
      description="Player, metadata, history and the files on disk for one video."
    />
    <EmptyState
      icon="videos"
      title="Video details are coming"
      description="This page fills in once the catalog exists."
    />
  </section>
</template>
