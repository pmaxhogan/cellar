<script setup lang="ts">
import EmptyState from "../components/EmptyState.vue";
import PageHeader from "../components/PageHeader.vue";
</script>

<template>
  <section>
    <PageHeader
      title="Rules"
      description="Ordered rules decide what is downloaded, at what quality, and for how long it is kept."
    />
    <EmptyState
      icon="rules"
      title="No rules yet"
      description="The default rule set is installed with the rules engine."
    />
  </section>
</template>
