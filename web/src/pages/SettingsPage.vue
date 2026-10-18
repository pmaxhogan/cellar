<script setup lang="ts">
import EmptyState from "../components/EmptyState.vue";
import PageHeader from "../components/PageHeader.vue";
</script>

<template>
  <section>
    <PageHeader title="Settings" description="Global defaults. Rules override these per video." />
    <EmptyState
      icon="settings"
      title="No settings yet"
      description="Settings appear here as the features they control land."
    />
  </section>
</template>
