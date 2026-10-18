<script setup lang="ts">
import EmptyState from "../components/EmptyState.vue";
import PageHeader from "../components/PageHeader.vue";
</script>

<template>
  <section>
    <PageHeader
      title="Notifications"
      description="The inbox of errors and notable events, and push notification setup."
    />
    <EmptyState
      icon="notifications"
      title="No notifications"
      description="Errors and notable events will collect here."
    />
  </section>
</template>
