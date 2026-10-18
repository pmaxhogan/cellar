<script setup lang="ts">
import EmptyState from "../components/EmptyState.vue";
import PageHeader from "../components/PageHeader.vue";
</script>

<template>
  <section>
    <PageHeader title="Charts" description="Storage, downloads and catalog growth over time." />
    <EmptyState
      icon="charts"
      title="No data to chart yet"
      description="Daily statistics start collecting once ingestion runs."
    />
  </section>
</template>
