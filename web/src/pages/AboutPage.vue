<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import Button from "primevue/button";
import Tag from "primevue/tag";
import { normalizeError, type ApiClientError } from "../api/client.ts";
import { useApi } from "../api/provide.ts";
import { getTools, type ToolsResponse } from "../api/tools.ts";
import { useEventsStore } from "../stores/events.ts";
import { useStatusStore } from "../stores/status.ts";
import { formatAbsolute, formatRelative } from "../lib/format.ts";
import { LOGO_URL } from "../lib/brand.ts";
import ErrorState from "../components/ErrorState.vue";
import PageHeader from "../components/PageHeader.vue";
import ToolVersionsCard from "../components/about/ToolVersionsCard.vue";

const api = useApi();
const statusStore = useStatusStore();
const events = useEventsStore();

const status = computed(() => statusStore.status);

/** A bare commit SHA is shortened for display; the full value sits in the title. */
const displayVersion = computed(() => {
  const raw = status.value?.version ?? "";
  return /^[0-9a-f]{20,}$/i.test(raw) ? raw.slice(0, 12) : raw;
});

const tools = computed(() => {
  const current = status.value;
  if (current === null) return [];
  return [
    { label: "yt-dlp", version: current.tools.ytdlp },
    { label: "ffmpeg", version: current.tools.ffmpeg },
  ];
});

/** The updater's view of the tools; null until /api/tools answers. */
const toolDetail = ref<ToolsResponse | null>(null);
const toolsError = ref<ApiClientError | null>(null);

async function loadTools(): Promise<void> {
  try {
    toolDetail.value = (await getTools(api)) ?? null;
    toolsError.value = null;
  } catch (cause) {
    toolsError.value = normalizeError(cause);
  }
}

function reload(): void {
  void statusStore.load(api);
  void loadTools();
}

const REPO = "https://github.com/pmaxhogan/cellar";
const LINKS = [
  { label: "Source code", href: REPO },
  { label: "Architecture and API", href: `${REPO}/blob/main/docs/ARCHITECTURE.md` },
  {
    label: "Cloudflare Access and tunnel setup",
    href: `${REPO}/blob/main/docs/setup-cloudflare.md`,
  },
  { label: "NAS deploy runbook", href: `${REPO}/blob/main/deploy/README.md` },
  { label: "Report a problem", href: `${REPO}/issues` },
];

onMounted(reload);
</script>

<template>
  <section>
    <PageHeader title="About" description="Versions, and how this instance is running.">
      <template #actions>
        <Button label="Refresh" size="small" severity="secondary" @click="reload" />
      </template>
    </PageHeader>

    <div class="about-hero cellar-card">
      <img :src="LOGO_URL" alt="" width="64" height="64" />
      <div>
        <h2>Cellar - a self-hosted YouTube archive.</h2>
        <p class="cellar-muted">
          Cellar ingests videos from linked accounts and channels, decides what to keep with ordered
          rules, downloads with yt-dlp and ffmpeg, and keeps the metadata history of everything it
          has ever seen.
        </p>
        <p class="about-hero__links">
          <a href="https://github.com/pmaxhogan/cellar" target="_blank" rel="noopener noreferrer">
            github.com/pmaxhogan/cellar
          </a>
        </p>
      </div>
    </div>

    <ErrorState
      :error="statusStore.error"
      title="Could not read the instance status"
      @retry="reload"
    />

    <div v-if="status" class="cellar-stack about-grid">
      <article class="cellar-card">
        <h3>Instance</h3>
        <dl class="about-facts">
          <div>
            <dt>Version</dt>
            <dd class="mono" data-fact="version" :title="status.version">{{ displayVersion }}</dd>
          </div>
          <div>
            <dt>Authentication</dt>
            <dd data-fact="auth">
              <Tag
                :value="status.insecureMode ? 'disabled' : 'enforced'"
                :severity="status.insecureMode ? 'danger' : 'success'"
              />
            </dd>
          </div>
          <div>
            <dt>Database</dt>
            <dd data-fact="db">
              <Tag
                :value="status.db.ok ? `ok, ${status.db.migrations} migrations` : 'error'"
                :severity="status.db.ok ? 'secondary' : 'danger'"
              />
            </dd>
          </div>
          <div>
            <dt>Started</dt>
            <dd :title="formatAbsolute(status.startedAt)">
              {{ formatRelative(status.startedAt, status.now) }}
            </dd>
          </div>
          <div>
            <dt>Live updates</dt>
            <dd>{{ events.state }}</dd>
          </div>
        </dl>
        <p v-if="status.insecureMode" class="cellar-note">
          INSECURE_ALLOW_PUBLIC_ACCESS is set: authentication is skipped and the server only listens
          on loopback. Never run an instance like this where others can reach it.
        </p>
      </article>

      <ToolVersionsCard v-if="toolDetail" v-model:tools="toolDetail" />
      <article v-else class="cellar-card">
        <h3>Tools</h3>
        <dl class="about-facts">
          <div v-for="tool in tools" :key="tool.label">
            <dt>{{ tool.label }}</dt>
            <dd class="mono" :data-tool="tool.label">
              <template v-if="tool.version !== null">{{ tool.version }}</template>
              <Tag v-else value="not found" severity="warn" />
            </dd>
          </div>
        </dl>
        <p v-if="toolsError" class="about-note" data-tools-error>
          Update details are unavailable: {{ toolsError.message }}
        </p>
      </article>

      <article class="cellar-card">
        <h3>Setup and docs</h3>
        <ul class="about-links">
          <li v-for="link in LINKS" :key="link.href">
            <a :href="link.href" target="_blank" rel="noopener noreferrer">{{ link.label }}</a>
          </li>
        </ul>
        <p class="about-note">
          The one-time owner steps (Cloudflare Access applications, the tunnel hostname, the Google
          OAuth client, and exporting cookies for each account) are tracked on the Trello card
          "cellar: dashboard steps (Access, tunnel, OAuth, cookies)" and written out in the setup
          docs above.
        </p>
      </article>
    </div>
    <p v-else-if="statusStore.error === null" class="cellar-muted">Reading instance status...</p>
  </section>
</template>

<style scoped>
.about-hero {
  display: flex;
  gap: 1.25rem;
  align-items: flex-start;
  margin-bottom: 1.25rem;
  max-width: 56rem;
}

.about-hero h2 {
  margin: 0 0 0.4rem;
  font-size: 1.15rem;
}

.about-hero p {
  margin: 0;
  line-height: 1.55;
  max-width: 66ch;
}

/* Two classes so this outranks the type selector's margin: 0 above. */
.about-hero .about-hero__links {
  margin-top: 0.5rem;
}

.about-hero__links a {
  color: var(--p-primary-color);
  text-decoration: none;
}

.about-hero__links a:hover {
  text-decoration: underline;
}

.about-grid {
  max-width: 56rem;
}

.cellar-card h3 {
  margin: 0 0 0.75rem;
  font-size: 0.8rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
}

.about-facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
  gap: 0.75rem 1.25rem;
  margin: 0;
}

.about-facts dt {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--p-text-muted-color);
}

.about-note {
  font-size: 0.82rem;
  color: var(--p-text-muted-color);
  margin: 0.6rem 0 0;
  line-height: 1.5;
}

.about-links {
  margin: 0;
  padding-left: 1.1rem;
  line-height: 1.7;
}

.about-links a {
  color: var(--p-primary-color);
  text-decoration: none;
}

.about-links a:hover {
  text-decoration: underline;
}

.about-facts dd {
  margin: 0.2rem 0 0;
  /* Grid cells must contain long values (a full commit SHA), not overflow. */
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
