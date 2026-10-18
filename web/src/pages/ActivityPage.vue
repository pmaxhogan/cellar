<script setup lang="ts">
import EmptyState from "../components/EmptyState.vue";
import PageHeader from "../components/PageHeader.vue";
</script>

<template>
  <section>
    <PageHeader
      title="Activity"
      description="Jobs, their logs, and what the scheduler is doing right now."
    />
    <EmptyState
      icon="activity"
      title="No activity yet"
      description="Jobs appear here as soon as the scheduler starts work."
    />
  </section>
</template>
