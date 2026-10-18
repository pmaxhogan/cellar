<script setup lang="ts">
import { computed } from "vue";
import Tag from "primevue/tag";
import { ACCOUNT_STATUS, type AccountStatus } from "../../api/accounts.ts";

const props = defineProps<{ status: AccountStatus }>();
const meta = computed(() => ACCOUNT_STATUS[props.status]);
</script>

<template>
  <Tag
    class="account-status"
    :data-status="status"
    :value="meta.label"
    :severity="meta.severity"
    :title="meta.hint"
  />
</template>
