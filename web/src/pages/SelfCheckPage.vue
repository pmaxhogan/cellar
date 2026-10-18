<script setup lang="ts">
import EmptyState from "../components/EmptyState.vue";
import PageHeader from "../components/PageHeader.vue";
</script>

<template>
  <section>
    <PageHeader
      title="Self-check"
      description="Checks that the tools, storage, accounts and access rules all work."
    />
    <EmptyState
      icon="selfcheck"
      title="No checks have run"
      description="The self-check suite arrives with the next release."
    />
  </section>
</template>
