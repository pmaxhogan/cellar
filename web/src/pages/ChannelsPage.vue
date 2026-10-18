<script setup lang="ts">
import EmptyState from "../components/EmptyState.vue";
import PageHeader from "../components/PageHeader.vue";
</script>

<template>
  <section>
    <PageHeader title="Channels" description="Subscribed channels and channels added by hand." />
    <EmptyState
      icon="channels"
      title="No channels yet"
      description="Subscriptions are imported once an account is linked."
    />
  </section>
</template>
