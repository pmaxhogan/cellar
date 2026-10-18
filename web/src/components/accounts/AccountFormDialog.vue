<script setup lang="ts">
import { computed, ref, watch } from "vue";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import InputNumber from "primevue/inputnumber";
import InputText from "primevue/inputtext";
import Message from "primevue/message";
import { settingsRegistry } from "@cellar/shared";
import {
  createAccount,
  startGoogleLink,
  updateAccount,
  type AccountUpdate,
  type AccountView,
} from "../../api/accounts.ts";
import { normalizeError, type ApiClientError } from "../../api/client.ts";
import { useApi } from "../../api/provide.ts";

/**
 * Create an account (label only) or edit one (label and scrape budget).
 * Creating ends on a second step that offers the Google link straight away,
 * because an account is useless until it is linked.
 */
const props = defineProps<{ visible: boolean; account: AccountView | null }>();
const emit = defineEmits<{
  "update:visible": [boolean];
  saved: [AccountView, "created" | "updated"];
}>();

const api = useApi();

const label = ref("");
const budget = ref<number | null>(null);
const busy = ref(false);
const error = ref<ApiClientError | null>(null);
const created = ref<AccountView | null>(null);

const editing = computed(() => props.account !== null);
const knownBudget = computed(() => props.account?.scrape_budget_per_hour);
const globalBudget = settingsRegistry["quota.scrape_requests_per_hour"].default;

watch(
  () => props.visible,
  (open) => {
    if (!open) return;
    label.value = props.account?.label ?? "";
    budget.value = props.account?.scrape_budget_per_hour ?? null;
    error.value = null;
    created.value = null;
  },
);

const labelError = computed(() =>
  label.value.trim() === "" ? "Give the account a label, such as the person's name." : null,
);

/**
 * The budget goes into the PUT only when the owner changed it. An empty field
 * on an account whose budget the server reported clears it back to the global
 * default; an empty field on one it did not report sends nothing.
 */
function budgetPatch(): Pick<AccountUpdate, "scrape_budget_per_hour"> {
  if (budget.value !== null) {
    return budget.value === knownBudget.value ? {} : { scrape_budget_per_hour: budget.value };
  }
  return knownBudget.value === undefined || knownBudget.value === null
    ? {}
    : { scrape_budget_per_hour: null };
}

async function submit(): Promise<void> {
  if (labelError.value !== null) return;
  busy.value = true;
  error.value = null;
  try {
    if (props.account === null) {
      const account = await createAccount(api, label.value.trim());
      created.value = account;
      emit("saved", account, "created");
    } else {
      const patch: AccountUpdate = { ...budgetPatch() };
      if (label.value.trim() !== props.account.label) patch.label = label.value.trim();
      const account = await updateAccount(api, props.account.id, patch);
      emit("saved", account, "updated");
      emit("update:visible", false);
    }
  } catch (cause) {
    error.value = normalizeError(cause);
  } finally {
    busy.value = false;
  }
}

function linkNow(): void {
  if (created.value !== null) startGoogleLink(api, created.value.id);
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    :header="editing ? 'Edit account' : 'Add account'"
    :style="{ width: 'min(30rem, 92vw)' }"
    :closable="!busy"
    @update:visible="emit('update:visible', $event)"
  >
    <div v-if="created" class="cellar-stack" data-test="account-created">
      <p>
        <strong>{{ created.label }}</strong> was added. Link its Google account now: you will be
        sent to Google's consent screen and brought back here.
      </p>
      <p class="cellar-note">
        After linking, add the account's cookies.txt so history, Watch Later and downloads work.
      </p>
    </div>

    <form v-else class="cellar-stack" @submit.prevent="submit">
      <div class="cellar-field">
        <label for="account-label">Label</label>
        <InputText
          id="account-label"
          v-model="label"
          autocomplete="off"
          :invalid="error !== null && labelError !== null"
          :disabled="busy"
        />
      </div>
      <div v-if="editing" class="cellar-field">
        <label for="account-budget">Scrape budget (requests per hour)</label>
        <InputNumber
          v-model="budget"
          input-id="account-budget"
          :min="1"
          :use-grouping="false"
          :placeholder="`Global default (${globalBudget})`"
          :disabled="busy"
        />
        <p class="cellar-note">
          Leave empty to use the global setting. Cookie-authenticated yt-dlp requests above this are
          deferred.
        </p>
      </div>
      <Message v-if="error" severity="error" data-test="account-form-error">
        {{ error.message }}
      </Message>
    </form>

    <template #footer>
      <template v-if="created">
        <Button label="Later" severity="secondary" text @click="emit('update:visible', false)" />
        <Button data-action="link-now" label="Link Google account" @click="linkNow" />
      </template>
      <template v-else>
        <Button
          label="Cancel"
          severity="secondary"
          text
          :disabled="busy"
          @click="emit('update:visible', false)"
        />
        <Button
          data-action="save-account"
          :label="editing ? 'Save' : 'Add account'"
          :loading="busy"
          :disabled="labelError !== null"
          @click="submit"
        />
      </template>
    </template>
  </Dialog>
</template>
