<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch } from "vue";
import { RouterLink, routeLocationKey, routerKey } from "vue-router";
import Button from "primevue/button";
import Tag from "primevue/tag";
import { isVideoId, type MediaRow, type VideoDetail } from "@cellar/shared";
import { ABORTED_PROBLEM, normalizeError, type ApiClientError } from "../api/client.ts";
import { useApi } from "../api/provide.ts";
import {
  downloadVideoNow,
  getVideo,
  mediaUrl,
  metadataUrl,
  recheckVideo,
  trashVideos,
} from "../api/videos.ts";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import EmptyState from "../components/EmptyState.vue";
import ErrorState from "../components/ErrorState.vue";
import ListSkeleton from "../components/ListSkeleton.vue";
import PageHeader from "../components/PageHeader.vue";
import InspectPanel from "../components/inspect/InspectPanel.vue";
import RuleLink from "../components/inspect/RuleLink.vue";
import VideoHistory from "../components/videos/VideoHistory.vue";
import VideoMediaTable from "../components/videos/VideoMediaTable.vue";
import VideoPlayer from "../components/videos/VideoPlayer.vue";
import VideoShareLinks from "../components/videos/VideoShareLinks.vue";
import VideoStatsChart from "../components/videos/VideoStatsChart.vue";
import {
  formatDay,
  priorityLabel,
  sourceChip,
  TYPE_LABELS,
  videoStatus,
  watchUrl,
} from "../components/videos/videoDisplay.ts";
import {
  formatAbsolute,
  formatBytes,
  formatDuration,
  formatNumber,
  formatRelative,
} from "../lib/format.ts";
import { provideRuleLookups } from "../lib/rulesLookups.ts";
import { useToaster } from "../lib/toast.ts";

/**
 * One video: the player, downloads, metadata, where it came from, the files
 * on disk, its change history and counter chart, share links and the
 * per-video rule overrides, plus recheck, download-now and trash.
 */
const props = defineProps<{ id?: string }>();

const api = useApi();
const toast = useToaster();
const lookups = provideRuleLookups(api);
const hasRouter = inject(routerKey, null) !== null;
const route = inject(routeLocationKey, null);

const videoId = computed(() => {
  if (props.id !== undefined) return props.id;
  const raw = route?.params["id"];
  return typeof raw === "string" ? raw : "";
});

const detail = ref<VideoDetail | null>(null);
const loading = ref(false);
const error = ref<ApiClientError | null>(null);
const notFound = ref(false);
const descriptionOpen = ref(false);
const trashVisible = ref(false);
const trashBusy = ref(false);
const jobBusy = ref<"recheck" | "download" | null>(null);
let controller: AbortController | null = null;

async function load(): Promise<void> {
  controller?.abort();
  const id = videoId.value;
  if (!isVideoId(id)) {
    detail.value = null;
    notFound.value = true;
    return;
  }
  const mine = new AbortController();
  controller = mine;
  loading.value = true;
  try {
    detail.value = await getVideo(api, id, mine.signal);
    error.value = null;
    notFound.value = false;
  } catch (cause) {
    const normalized = normalizeError(cause);
    if (normalized.problem === ABORTED_PROBLEM) return;
    if (normalized.status === 404) {
      notFound.value = true;
      detail.value = null;
      error.value = null;
    } else {
      error.value = normalized;
    }
  } finally {
    if (controller === mine) {
      loading.value = false;
      controller = null;
    }
  }
}

watch(videoId, load, { immediate: true });
void lookups.ensureAccounts();
void lookups.ensureLocations();
onBeforeUnmount(() => controller?.abort());

const accountLabels = computed(
  () => new Map(lookups.accounts.value.map((row) => [row.id, row.label])),
);
const locationLabels = computed(
  () => new Map(lookups.locations.value.map((row) => [row.id, row.label])),
);

const status = computed(() => (detail.value === null ? null : videoStatus(detail.value)));

function currentOf(kind: MediaRow["kind"]): MediaRow | undefined {
  return detail.value?.media.find((row) => row.is_current && row.kind === kind);
}

const currentVideo = computed(() => currentOf("video"));
const currentAudio = computed(() => currentOf("audio"));

/** Where the effective reclaim priority came from. */
const priorityHint = computed<{ text: string; ruleId: number | null }>(() => {
  const current = detail.value;
  if (current === null || current.effective === null) {
    return { text: "not evaluated yet", ruleId: null };
  }
  const source = current.effective.provenance["reclaim_priority"];
  if (current.overrides !== null && "reclaim_priority" in current.overrides) {
    return { text: "set by this video's override", ruleId: null };
  }
  if (typeof source === "number") return { text: "set by", ruleId: source };
  return { text: "from the defaults", ruleId: null };
});

const formats = computed(() => {
  const summary = detail.value?.formats;
  if (summary === undefined) return "-";
  const parts: string[] = [];
  if (summary.max_height !== null) {
    parts.push(
      summary.max_fps === null
        ? `up to ${summary.max_height}p`
        : `up to ${summary.max_height}p${Math.round(summary.max_fps)}`,
    );
  }
  const codecs = [
    summary.has_av1 === true ? "AV1" : null,
    summary.has_vp9 === true ? "VP9" : null,
    summary.has_h264 === true ? "H.264" : null,
  ].filter((codec): codec is string => codec !== null);
  if (codecs.length > 0) parts.push(codecs.join(", "));
  if (summary.is_hdr === true) parts.push("HDR");
  return parts.length === 0 ? "-" : parts.join("; ");
});

function mediaSummary(row: MediaRow): string {
  const bits = [
    row.height === null ? null : `${row.height}p`,
    row.vcodec ?? row.acodec,
    formatBytes(row.size_bytes),
  ].filter((bit): bit is string => bit !== null && bit !== "");
  return bits.join(", ");
}

function ratio(value: number | null): string {
  return value === null ? "-" : `${Math.round(value * 1000) / 10}% likes`;
}

async function job(kind: "recheck" | "download"): Promise<void> {
  const id = videoId.value;
  jobBusy.value = kind;
  const what = kind === "recheck" ? "Recheck" : "Download";
  try {
    const result = await (kind === "recheck" ? recheckVideo(api, id) : downloadVideoNow(api, id));
    toast.success(
      result.deduped ? `${what} already queued` : `${what} queued`,
      `Job #${result.job_id}`,
    );
  } catch (cause) {
    if (normalizeError(cause).status === 501) {
      toast.warn(`${what} is not available yet`, "The server has no handler for this job type.");
    } else {
      toast.failure(`Could not queue the ${what.toLowerCase()}`, cause);
    }
  } finally {
    jobBusy.value = null;
  }
}

async function confirmTrash(): Promise<void> {
  trashBusy.value = true;
  try {
    await trashVideos(api, [videoId.value]);
    trashVisible.value = false;
    toast.success("Moved to trash", "The media is deleted; metadata and history stay.");
    void load();
  } catch (cause) {
    toast.failure("Could not trash this video", cause);
  } finally {
    trashBusy.value = false;
  }
}
</script>

<template>
  <section class="cellar-stack video-page">
    <EmptyState
      v-if="notFound"
      icon="videos"
      title="Video not found"
      :description="`Cellar has no video with the id ${videoId || '(none)'}. It may never have been ingested.`"
      data-test="video-not-found"
    >
      <RouterLink v-if="hasRouter" to="/">Back to videos</RouterLink>
      <a v-else href="/">Back to videos</a>
    </EmptyState>
    <ErrorState
      v-else-if="error && detail === null"
      :error="error"
      title="Could not load this video"
      @retry="load"
    />
    <ListSkeleton v-else-if="detail === null" :rows="5" label="Loading the video" />
    <template v-else>
      <PageHeader :title="detail.title ?? detail.id">
        <template #actions>
          <Button
            size="small"
            severity="secondary"
            label="Recheck now"
            :loading="jobBusy === 'recheck'"
            :disabled="jobBusy !== null"
            data-action="recheck"
            @click="job('recheck')"
          />
          <Button
            size="small"
            severity="secondary"
            label="Download now"
            :loading="jobBusy === 'download'"
            :disabled="jobBusy !== null"
            data-action="download-now"
            @click="job('download')"
          />
          <Button
            size="small"
            severity="danger"
            label="Trash"
            data-action="trash"
            @click="trashVisible = true"
          />
        </template>
      </PageHeader>

      <div class="video-facts" data-test="video-facts">
        <span v-if="detail.channel_id" data-test="video-channel">
          <RouterLink
            v-if="hasRouter"
            :to="{ name: 'videos', query: { channel_id: detail.channel_id } }"
            >{{ detail.channel_title ?? detail.channel_id }}</RouterLink
          >
          <a v-else :href="`/?channel_id=${detail.channel_id}`">{{
            detail.channel_title ?? detail.channel_id
          }}</a>
        </span>
        <span data-test="video-uploaded">Uploaded {{ formatDay(detail.upload_date) }}</span>
        <span data-test="video-duration">{{ formatDuration(detail.duration_s) }}</span>
        <Tag v-if="status" :value="status.label" :severity="status.severity" data-test="status" />
        <span data-test="video-priority">
          Priority <strong>{{ priorityLabel(detail.reclaim_priority) }}</strong>
          <span class="cellar-muted">
            ({{ priorityHint.text
            }}<template v-if="priorityHint.ruleId !== null">
              <RuleLink :rule-id="priorityHint.ruleId"
                >rule #{{ priorityHint.ruleId }}</RuleLink
              > </template
            >)
          </span>
        </span>
        <a :href="watchUrl(detail.id)" target="_blank" rel="noopener noreferrer" class="mono">{{
          detail.id
        }}</a>
      </div>

      <article class="cellar-card">
        <VideoPlayer
          :video-id="detail.id"
          :media="detail.media"
          :captions="detail.captions"
          :poster="detail.thumbnail_url"
        />
      </article>

      <article class="cellar-card" data-test="downloads">
        <h2>Downloads</h2>
        <div class="video-downloads">
          <a
            v-if="currentVideo"
            class="video-download"
            :href="mediaUrl(detail.id, currentVideo.id, true)"
            data-download="video"
            >Video <span class="cellar-muted">({{ mediaSummary(currentVideo) }})</span></a
          >
          <a
            v-if="currentAudio"
            class="video-download"
            :href="mediaUrl(detail.id, currentAudio.id, true)"
            data-download="audio"
            >Audio <span class="cellar-muted">({{ mediaSummary(currentAudio) }})</span></a
          >
          <a
            v-for="track in detail.captions"
            :key="track.lang"
            class="video-download"
            :href="mediaUrl(detail.id, track.media_id, true)"
            :data-download="`captions-${track.lang}`"
            >Captions ({{ track.lang }})</a
          >
          <a
            class="video-download"
            :href="metadataUrl(detail.id)"
            :download="`${detail.id}.metadata.json`"
            data-download="metadata"
            >Metadata JSON</a
          >
        </div>
        <p v-if="!currentVideo && !currentAudio" class="cellar-note" data-test="no-media">
          No video or audio file is stored right now; captions and metadata are kept regardless.
        </p>
      </article>

      <article class="cellar-card" data-test="metadata">
        <h2>Metadata</h2>
        <div v-if="detail.description" class="video-description">
          <p
            :class="{ 'video-description__text--clamped': !descriptionOpen }"
            class="video-description__text"
            data-test="description"
          >
            {{ detail.description }}
          </p>
          <Button
            size="small"
            text
            :label="descriptionOpen ? 'Show less' : 'Show the full description'"
            data-test="description-toggle"
            @click="descriptionOpen = !descriptionOpen"
          />
        </div>
        <p v-else class="cellar-muted">No description.</p>
        <div v-if="detail.tags.length > 0" class="video-tags" data-test="tags">
          <Tag v-for="tag in detail.tags" :key="tag" :value="tag" severity="secondary" />
        </div>
        <dl class="video-meta">
          <dt>Views</dt>
          <dd data-test="views">{{ formatNumber(detail.views) }}</dd>
          <dt>Likes</dt>
          <dd>{{ formatNumber(detail.likes) }}</dd>
          <dt>Comments</dt>
          <dd>{{ formatNumber(detail.comments) }}</dd>
          <dt>Like ratio (estimated)</dt>
          <dd>{{ ratio(detail.ryd_ratio) }}</dd>
          <dt>Type</dt>
          <dd>{{ detail.type === null ? "-" : (TYPE_LABELS[detail.type] ?? detail.type) }}</dd>
          <dt>Formats on YouTube</dt>
          <dd data-test="formats">{{ formats }}</dd>
          <dt>Captions on YouTube</dt>
          <dd>
            {{ detail.caption_available === null ? "-" : detail.caption_available ? "yes" : "no" }}
          </dd>
          <dt>Language</dt>
          <dd>{{ detail.default_language ?? "-" }}</dd>
          <dt>Last recheck</dt>
          <dd :title="formatAbsolute(detail.last_recheck_at)" data-test="last-recheck">
            {{ formatRelative(detail.last_recheck_at) }}
            <span v-if="detail.consecutive_recheck_failures > 0" class="video-warn">
              ({{ detail.consecutive_recheck_failures }} failed in a row)</span
            >
          </dd>
          <dt>Next recheck</dt>
          <dd :title="formatAbsolute(detail.next_recheck_at)" data-test="next-recheck">
            {{ detail.next_recheck_at === null ? "-" : formatRelative(detail.next_recheck_at) }}
          </dd>
          <dt>Recheck tier</dt>
          <dd data-test="recheck-tier">{{ detail.recheck_tier ?? "-" }}</dd>
          <dt>First seen</dt>
          <dd :title="formatAbsolute(detail.created_at)">
            {{ formatRelative(detail.created_at) }}
          </dd>
        </dl>
      </article>

      <article class="cellar-card" data-test="sources">
        <h2>Sources</h2>
        <ul v-if="detail.sources.length > 0" class="video-sources">
          <li v-for="(source, index) in detail.sources" :key="index" data-test="source">
            <Tag :value="sourceChip(source, accountLabels)" severity="secondary" />
            <span class="cellar-muted" :title="formatAbsolute(source.first_seen_at)">
              first seen {{ formatRelative(source.first_seen_at) }}
            </span>
          </li>
        </ul>
        <p v-else class="cellar-muted">Added by hand; no account source.</p>
      </article>

      <article class="cellar-card" data-test="media">
        <h2>Files</h2>
        <VideoMediaTable :video-id="detail.id" :media="detail.media" :locations="locationLabels" />
      </article>

      <article class="cellar-card">
        <h2>History</h2>
        <VideoHistory :video-id="detail.id" />
      </article>

      <article class="cellar-card">
        <h2>Views, likes and comments</h2>
        <VideoStatsChart :video-id="detail.id" />
      </article>

      <article class="cellar-card">
        <h2>Share links</h2>
        <VideoShareLinks :video-id="detail.id" :links="detail.share_links" @changed="load" />
      </article>

      <section data-test="overrides">
        <h2 class="video-page__section">Rules and overrides</h2>
        <InspectPanel :video-id="detail.id" />
      </section>
    </template>

    <ConfirmDialog
      :visible="trashVisible"
      title="Trash this video?"
      message="This sets priority 0 and deletes the media now; metadata, history and captions are kept."
      confirm-label="Trash"
      danger
      :busy="trashBusy"
      @update:visible="trashVisible = $event"
      @confirm="confirmTrash"
    />
  </section>
</template>

<style scoped>
.video-page h2 {
  margin: 0 0 0.6rem;
  font-size: 1rem;
}

.video-page__section {
  margin: 0.5rem 0 0.75rem;
}

.video-facts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem 1.1rem;
  margin-top: -0.5rem;
  font-size: 0.9rem;
}

.video-downloads {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.video-download {
  display: inline-flex;
  gap: 0.3rem;
  padding: 0.35rem 0.75rem;
  border-radius: 6px;
  border: 1px solid var(--p-content-border-color);
  color: var(--p-text-color);
  text-decoration: none;
  font-size: 0.88rem;
}

.video-download:hover {
  background: var(--p-content-hover-background);
}

.video-description__text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.9rem;
}

.video-description__text--clamped {
  display: -webkit-box;
  -webkit-line-clamp: 4;
  line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.video-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin: 0.5rem 0;
}

.video-meta {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.3rem 1rem;
  margin: 0.75rem 0 0;
  font-size: 0.9rem;
}

.video-meta dt {
  color: var(--p-text-muted-color);
}

.video-meta dd {
  margin: 0;
}

.video-warn {
  color: var(--cellar-error);
}

.video-sources {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.video-sources li {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.88rem;
}
</style>
