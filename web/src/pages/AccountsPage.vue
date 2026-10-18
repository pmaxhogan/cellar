<script setup lang="ts">
import EmptyState from "../components/EmptyState.vue";
import PageHeader from "../components/PageHeader.vue";
</script>

<template>
  <section>
    <PageHeader
      title="Accounts"
      description="Linked YouTube accounts, their cookies and their API quota."
    />
    <EmptyState
      icon="accounts"
      title="No accounts linked"
      description="Linking an account with Google sign-in arrives in the next release."
    />
  </section>
</template>
