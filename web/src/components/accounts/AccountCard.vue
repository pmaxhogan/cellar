<script setup lang="ts">
import { computed } from "vue";
import Button from "primevue/button";
import type { AccountView } from "../../api/accounts.ts";
import { formatAbsolute, formatRelative } from "../../lib/format.ts";
import AccountStatusBadge from "./AccountStatusBadge.vue";

const props = withDefaults(defineProps<{ account: AccountView; busy?: boolean }>(), {
  busy: false,
});

defineEmits<{
  link: [AccountView];
  cookies: [AccountView];
  edit: [AccountView];
  toggle: [AccountView];
  remove: [AccountView];
}>();

/** Anything that shows a past Google grant makes the action a re-link. */
const linkedBefore = computed(
  () =>
    props.account.email !== null ||
    props.account.last_api_ok_at !== null ||
    props.account.status === "auth_lost",
);
const disabled = computed(() => props.account.status === "disabled");
</script>

<template>
  <article class="cellar-card account-card" :data-account="account.id">
    <header class="account-card__head">
      <div class="account-card__title">
        <h2>{{ account.label }}</h2>
        <p class="cellar-muted" data-fact="email">
          {{ account.email ?? "Not linked to Google yet" }}
        </p>
      </div>
      <AccountStatusBadge :status="account.status" />
    </header>

    <dl class="account-card__facts">
      <div>
        <dt>Channel id</dt>
        <dd data-fact="channel">{{ account.channel_id ?? "-" }}</dd>
      </div>
      <div>
        <dt>Cookie jar</dt>
        <dd data-fact="cookies">{{ account.has_cookies ? "Stored" : "None" }}</dd>
      </div>
      <div>
        <dt>API last worked</dt>
        <dd data-fact="api-ok" :title="formatAbsolute(account.last_api_ok_at)">
          {{ formatRelative(account.last_api_ok_at) }}
        </dd>
      </div>
      <div>
        <dt>Cookies last worked</dt>
        <dd data-fact="cookie-ok" :title="formatAbsolute(account.last_cookie_ok_at)">
          {{ formatRelative(account.last_cookie_ok_at) }}
        </dd>
      </div>
      <div v-if="account.scrape_budget_per_hour !== undefined">
        <dt>Scrape budget</dt>
        <dd data-fact="budget">
          {{
            account.scrape_budget_per_hour === null
              ? "Global default"
              : `${account.scrape_budget_per_hour} requests/hour`
          }}
        </dd>
      </div>
    </dl>

    <div class="cellar-row account-card__actions">
      <Button
        data-action="link"
        size="small"
        :label="linkedBefore ? 'Re-link Google' : 'Link Google account'"
        :disabled="busy"
        @click="$emit('link', account)"
      />
      <Button
        data-action="cookies"
        size="small"
        severity="secondary"
        :label="account.has_cookies ? 'Replace cookies' : 'Add cookies'"
        :disabled="busy"
        @click="$emit('cookies', account)"
      />
      <Button
        data-action="edit"
        size="small"
        severity="secondary"
        text
        label="Edit"
        :disabled="busy"
        @click="$emit('edit', account)"
      />
      <Button
        data-action="toggle"
        size="small"
        severity="secondary"
        text
        :label="disabled ? 'Enable' : 'Disable'"
        :loading="busy"
        @click="$emit('toggle', account)"
      />
      <Button
        data-action="remove"
        size="small"
        severity="danger"
        text
        label="Delete"
        :disabled="busy"
        @click="$emit('remove', account)"
      />
    </div>
  </article>
</template>

<style scoped>
.account-card {
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
}

.account-card__head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
}

.account-card__title h2 {
  margin: 0;
  font-size: 1.05rem;
}

.account-card__title p {
  margin: 0.2rem 0 0;
  font-size: 0.88rem;
}

.account-card__facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
  gap: 0.6rem 1.2rem;
  margin: 0;
}

.account-card__facts dt {
  font-size: 0.78rem;
  color: var(--p-text-muted-color);
}

.account-card__facts dd {
  margin: 0.1rem 0 0;
  font-size: 0.9rem;
  overflow-wrap: anywhere;
}
</style>
