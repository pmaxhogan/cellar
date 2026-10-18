<script setup lang="ts">
import EmptyState from "../components/EmptyState.vue";
import PageHeader from "../components/PageHeader.vue";
</script>

<template>
  <section>
    <PageHeader
      title="Inspect"
      description="Paste any video URL or id to see which rules match it and the settings they produce."
    />
    <EmptyState
      icon="inspect"
      title="Nothing to inspect yet"
      description="Rule evaluation arrives with the rules engine."
    />
  </section>
</template>
