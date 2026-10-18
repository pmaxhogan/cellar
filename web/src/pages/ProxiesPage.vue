<script setup lang="ts">
import EmptyState from "../components/EmptyState.vue";
import PageHeader from "../components/PageHeader.vue";
</script>

<template>
  <section>
    <PageHeader
      title="Proxies"
      description="Outbound proxies that downloads can be routed through."
    />
    <EmptyState
      icon="proxies"
      title="No proxies"
      description="Downloads connect directly until a proxy is added."
    />
  </section>
</template>
