<script setup lang="ts">
import EmptyState from "../components/EmptyState.vue";
import PageHeader from "../components/PageHeader.vue";
</script>

<template>
  <section>
    <PageHeader
      title="Share links"
      description="Public links to individual videos. Revoke any of them here."
    />
    <EmptyState
      icon="shares"
      title="No share links"
      description="Links you share from a video page are listed here."
    />
  </section>
</template>
