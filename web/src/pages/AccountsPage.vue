<script setup lang="ts">
import { getCurrentInstance, onBeforeUnmount, onMounted, ref } from "vue";
import Button from "primevue/button";
import {
  deleteAccount,
  listAccounts,
  oauthErrorMessage,
  startGoogleLink,
  updateAccount,
  type AccountView,
} from "../api/accounts.ts";
import { normalizeError, type ApiClientError } from "../api/client.ts";
import { useApi } from "../api/provide.ts";
import { useToaster } from "../lib/toast.ts";
import AccountCard from "../components/accounts/AccountCard.vue";
import AccountFormDialog from "../components/accounts/AccountFormDialog.vue";
import AccountsHelp from "../components/accounts/AccountsHelp.vue";
import CookiesDialog from "../components/accounts/CookiesDialog.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import EmptyState from "../components/EmptyState.vue";
import ErrorState from "../components/ErrorState.vue";
import ListSkeleton from "../components/ListSkeleton.vue";
import PageHeader from "../components/PageHeader.vue";

const api = useApi();
const toast = useToaster();
// Reached through the app rather than useRoute() so the page still mounts
// (without the query handling) where no router is installed.
const router = getCurrentInstance()?.proxy?.$router ?? null;

const accounts = ref<AccountView[]>([]);
const loading = ref(true);
const loaded = ref(false);
const error = ref<ApiClientError | null>(null);
const busyId = ref<number | null>(null);

const formVisible = ref(false);
const editing = ref<AccountView | null>(null);
const cookiesVisible = ref(false);
const cookiesFor = ref<AccountView | null>(null);
const removing = ref<AccountView | null>(null);
const removeBusy = ref(false);

let inflight: AbortController | null = null;

async function load(): Promise<void> {
  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;
  loading.value = true;
  try {
    accounts.value = await listAccounts(api, controller.signal);
    error.value = null;
    loaded.value = true;
  } catch (cause) {
    const normalized = normalizeError(cause);
    if (normalized.problem === "aborted") return;
    error.value = normalized;
  } finally {
    if (inflight === controller) {
      loading.value = false;
      inflight = null;
    }
  }
}

function replaceRow(account: AccountView): void {
  const index = accounts.value.findIndex((row) => row.id === account.id);
  if (index === -1) accounts.value = [...accounts.value, account];
  else accounts.value = accounts.value.map((row) => (row.id === account.id ? account : row));
}

/** One-shot query params set by the OAuth callback redirect. */
async function consumeOAuthResult(): Promise<void> {
  if (router === null) return;
  const query = router.currentRoute.value.query;
  const linked = typeof query.linked === "string" ? query.linked : null;
  const failed = typeof query.error === "string" ? query.error : null;
  if (linked === null && failed === null) return;

  if (linked !== null) {
    const account = accounts.value.find((row) => String(row.id) === linked);
    const name = account?.label ?? "The account";
    toast.success(
      "Google account linked",
      account !== undefined && !account.has_cookies
        ? `${name} is linked. Add its cookies.txt next.`
        : `${name} is linked.`,
    );
  }
  if (failed !== null) {
    toast.warn("Linking did not finish", oauthErrorMessage(failed));
  }

  const rest = { ...query };
  delete rest.linked;
  delete rest.error;
  await router.replace({ query: rest });
}

onMounted(async () => {
  await load();
  await consumeOAuthResult();
});

onBeforeUnmount(() => inflight?.abort());

function openCreate(): void {
  editing.value = null;
  formVisible.value = true;
}

function openEdit(account: AccountView): void {
  editing.value = account;
  formVisible.value = true;
}

function openCookies(account: AccountView): void {
  cookiesFor.value = account;
  cookiesVisible.value = true;
}

function onSaved(account: AccountView, how: "created" | "updated"): void {
  replaceRow(account);
  toast.success(how === "created" ? "Account added" : "Account saved", account.label);
}

function link(account: AccountView): void {
  startGoogleLink(api, account.id);
}

async function toggle(account: AccountView): Promise<void> {
  const enable = account.status === "disabled";
  busyId.value = account.id;
  try {
    const updated = await updateAccount(api, account.id, {
      status: enable ? "pending" : "disabled",
    });
    replaceRow(updated);
    toast.success(enable ? "Account enabled" : "Account disabled", updated.label);
  } catch (cause) {
    toast.failure(enable ? "Could not enable" : "Could not disable", cause);
  } finally {
    busyId.value = null;
  }
}

async function confirmRemove(): Promise<void> {
  const target = removing.value;
  if (target === null) return;
  removeBusy.value = true;
  try {
    await deleteAccount(api, target.id);
    accounts.value = accounts.value.filter((row) => row.id !== target.id);
    removing.value = null;
    toast.success("Account deleted", target.label);
  } catch (cause) {
    toast.failure("Could not delete the account", cause);
  } finally {
    removeBusy.value = false;
  }
}
</script>

<template>
  <section class="cellar-stack">
    <PageHeader
      title="Accounts"
      description="Google accounts cellar reads from. Each needs a Google link (API) and a cookie jar (history, Watch Later and downloads)."
    >
      <template #actions>
        <Button data-action="add-account" label="Add account" size="small" @click="openCreate" />
      </template>
    </PageHeader>

    <AccountsHelp :collapsed="accounts.length > 0" />

    <ListSkeleton v-if="loading && !loaded" label="Loading accounts" />
    <ErrorState v-else-if="error" :error="error" title="Could not load accounts" @retry="load" />
    <EmptyState
      v-else-if="accounts.length === 0"
      icon="accounts"
      title="No accounts yet"
      description="Add an account, link it with Google, then give it a cookies.txt export."
    >
      <Button label="Add account" size="small" @click="openCreate" />
    </EmptyState>
    <div v-else class="accounts-list">
      <AccountCard
        v-for="account in accounts"
        :key="account.id"
        :account="account"
        :busy="busyId === account.id"
        @link="link"
        @cookies="openCookies"
        @edit="openEdit"
        @toggle="toggle"
        @remove="removing = $event"
      />
    </div>

    <AccountFormDialog v-model:visible="formVisible" :account="editing" @saved="onSaved" />
    <CookiesDialog v-model:visible="cookiesVisible" :account="cookiesFor" @saved="replaceRow" />
    <ConfirmDialog
      :visible="removing !== null"
      title="Delete account?"
      :message="`Delete ${removing?.label ?? 'this account'}? Its stored Google grant and cookie jar are destroyed.`"
      confirm-label="Delete"
      danger
      :busy="removeBusy"
      @update:visible="!$event && (removing = null)"
      @confirm="confirmRemove"
    />
  </section>
</template>

<style scoped>
.accounts-list {
  display: grid;
  gap: 1rem;
}
</style>
