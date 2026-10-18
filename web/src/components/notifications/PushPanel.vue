<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import Button from "primevue/button";
import Tag from "primevue/tag";
import { useApi } from "../../api/provide.ts";
import { sendTestNotification } from "../../api/notifications.ts";
import {
  PushError,
  browserPushEnv,
  currentSubscription,
  pushSupported,
  subscribePush,
  unsubscribePush,
  type PushEnv,
} from "../../lib/push.ts";
import { useToaster } from "../../lib/toast.ts";

/**
 * Web Push setup for this browser. The env prop exists for tests; the app
 * always uses the real browser APIs.
 */
const props = defineProps<{ env?: PushEnv }>();

const api = useApi();
const toast = useToaster();
const env = props.env ?? browserPushEnv();

const supported = pushSupported(env);
/** null while the current subscription is being read. */
const subscribed = ref<boolean | null>(supported ? null : false);
const busy = ref<"subscribe" | "unsubscribe" | "test" | null>(null);
const problem = ref<string | null>(null);

const permission = computed(() => env.notification?.permission ?? "default");

async function refresh(): Promise<void> {
  if (!supported) return;
  try {
    subscribed.value = (await currentSubscription(env)) !== null;
    problem.value = null;
  } catch (cause) {
    subscribed.value = false;
    problem.value = describe(cause);
  }
}

function describe(cause: unknown): string {
  if (cause instanceof PushError) return cause.message;
  if (cause instanceof Error && cause.message !== "") return cause.message;
  return "The browser refused the push subscription.";
}

async function subscribe(): Promise<void> {
  busy.value = "subscribe";
  try {
    await subscribePush(api, env);
    subscribed.value = true;
    problem.value = null;
    toast.success("Push notifications enabled", "This browser will receive Cellar alerts.");
  } catch (cause) {
    problem.value = describe(cause);
    toast.failure("Could not enable push notifications", cause);
  } finally {
    busy.value = null;
  }
}

async function unsubscribe(): Promise<void> {
  busy.value = "unsubscribe";
  try {
    await unsubscribePush(api, env);
    subscribed.value = false;
    problem.value = null;
    toast.success("Push notifications disabled for this browser");
  } catch (cause) {
    problem.value = describe(cause);
    toast.failure("Could not unsubscribe", cause);
  } finally {
    busy.value = null;
  }
}

async function sendTest(): Promise<void> {
  busy.value = "test";
  try {
    await sendTestNotification(api);
    toast.info("Test notification sent", "It should arrive on every subscribed browser.");
  } catch (cause) {
    toast.failure("Could not send a test notification", cause);
  } finally {
    busy.value = null;
  }
}

onMounted(() => {
  void refresh();
});
</script>

<template>
  <article class="cellar-card push-panel" aria-labelledby="push-heading">
    <div class="push-panel__head">
      <h2 id="push-heading">Push notifications</h2>
      <Tag v-if="!supported" value="not supported" severity="secondary" data-push-state />
      <Tag v-else-if="subscribed === null" value="checking" severity="secondary" data-push-state />
      <Tag v-else-if="subscribed" value="subscribed" severity="success" data-push-state />
      <Tag v-else value="not subscribed" severity="secondary" data-push-state />
    </div>

    <p v-if="!supported" class="cellar-muted push-panel__lead" data-push-unsupported>
      This browser cannot receive Web Push notifications. On iPhone and iPad, push only works for a
      web app on the home screen: open Cellar in Safari, choose Share, then Add to Home Screen, and
      enable notifications from the home screen icon.
    </p>
    <p v-else class="cellar-muted push-panel__lead">
      Get errors and notable events on this device even when Cellar is closed. Each browser
      subscribes separately.
    </p>

    <div class="cellar-row">
      <Button
        v-if="supported && subscribed !== true"
        label="Enable push notifications"
        size="small"
        :loading="busy === 'subscribe'"
        :disabled="busy !== null || subscribed === null"
        data-action="subscribe"
        @click="subscribe"
      />
      <Button
        v-if="supported && subscribed === true"
        label="Unsubscribe"
        size="small"
        severity="secondary"
        outlined
        :loading="busy === 'unsubscribe'"
        :disabled="busy !== null"
        data-action="unsubscribe"
        @click="unsubscribe"
      />
      <Button
        label="Send test notification"
        size="small"
        severity="secondary"
        :loading="busy === 'test'"
        :disabled="busy !== null"
        data-action="test"
        @click="sendTest"
      />
    </div>

    <p v-if="problem" class="push-panel__problem" role="alert" data-push-problem>{{ problem }}</p>
    <p v-if="supported && permission === 'denied'" class="push-panel__problem">
      Notifications are blocked for this site. Allow them in the browser's site settings, then
      enable push again.
    </p>

    <ul class="cellar-note push-panel__notes">
      <li>
        Cellar sits behind Cloudflare Access. The browser loads the service worker (/sw.js) and
        sends the subscription with your Access session cookie, so if enabling fails, reload the
        page to renew the Access session and try again. Delivering a push does not need the cookie.
      </li>
      <li>
        iPhone and iPad (iOS 16.4 and later) only allow push for web apps added to the home screen.
        Use Share, then Add to Home Screen, and subscribe from there.
      </li>
    </ul>
  </article>
</template>

<style scoped>
.push-panel {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.push-panel__head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.push-panel__head h2 {
  margin: 0;
  font-size: 1rem;
}

.push-panel__lead {
  margin: 0;
  line-height: 1.5;
  max-width: 72ch;
}

.push-panel__problem {
  margin: 0;
  color: var(--cellar-error);
  font-size: 0.88rem;
}

.push-panel__notes {
  margin: 0;
  padding-left: 1.1rem;
  line-height: 1.5;
  max-width: 80ch;
}

.push-panel__notes li + li {
  margin-top: 0.3rem;
}
</style>
