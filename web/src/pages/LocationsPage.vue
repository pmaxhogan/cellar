<script setup lang="ts">
import EmptyState from "../components/EmptyState.vue";
import PageHeader from "../components/PageHeader.vue";
</script>

<template>
  <section>
    <PageHeader
      title="Locations"
      description="Where media is stored, and how much room each location has left."
    />
    <EmptyState
      icon="locations"
      title="No storage locations"
      description="Storage locations can be added once the media pipeline lands."
    />
  </section>
</template>
