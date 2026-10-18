<script setup lang="ts">
import { computed } from "vue";
import Panel from "primevue/panel";

/**
 * The owner's one-time setup, condensed from deploy/README.md. Collapsed once
 * any account exists; the steps matter most on an empty page.
 */
withDefaults(defineProps<{ collapsed?: boolean }>(), { collapsed: false });

const callbackUrl = computed(() => `${window.location.origin}/api/oauth/google/callback`);

const CONSOLE_URL = "https://console.cloud.google.com/apis/credentials";
const EXTENSION_URL =
  "https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc";
</script>

<template>
  <Panel header="How to link an account" toggleable :collapsed="collapsed" class="accounts-help">
    <ol class="accounts-help__steps">
      <li>
        <strong>Once: create the OAuth client.</strong> In the
        <a :href="CONSOLE_URL" target="_blank" rel="noopener noreferrer">Google Cloud console</a>,
        enable YouTube Data API v3, set the consent screen to External and publish it to Production
        (Testing mode expires the link every 7 days), then create a Web application client with the
        redirect URI <code data-test="callback-url">{{ callbackUrl }}</code
        >. Put the id and secret in the .env as GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET and
        redeploy.
      </li>
      <li>
        <strong>Per account: link Google.</strong> Add the account here and choose Link Google
        account. Sign in as that account and grant read-only YouTube access.
      </li>
      <li>
        <strong>Per account: export cookies.</strong> Open a private or incognito window, sign in to
        youtube.com as the same account and visit
        <a href="https://www.youtube.com/feed/history" target="_blank" rel="noopener noreferrer"
          >youtube.com/feed/history</a
        >. Export with the
        <a :href="EXTENSION_URL" target="_blank" rel="noopener noreferrer"
          >Get cookies.txt LOCALLY</a
        >
        extension in Netscape format (allow it in private windows first), then paste or upload the
        file under Add cookies.
      </li>
      <li>
        <strong>Close the private window without logging out.</strong> Logging out invalidates the
        exported cookies; closing the window just stops the browser from rotating them.
      </li>
    </ol>
  </Panel>
</template>

<style scoped>
.accounts-help__steps {
  margin: 0;
  padding-left: 1.2rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  line-height: 1.5;
  font-size: 0.9rem;
}

.accounts-help code {
  font-size: 0.82rem;
  overflow-wrap: anywhere;
}
</style>
