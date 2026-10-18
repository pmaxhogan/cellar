<script setup lang="ts">
import Tag from "primevue/tag";
import type { MediaRow } from "@cellar/shared";
import { mediaUrl } from "../../api/videos.ts";
import { formatAbsolute, formatBytes, formatRelative } from "../../lib/format.ts";

/** Every stored file of a video, current and older versions, as the server lists them. */
defineProps<{
  videoId: string;
  media: MediaRow[];
  locations: ReadonlyMap<number, string>;
}>();

function codec(row: MediaRow): string {
  const parts = [row.vcodec, row.acodec].filter(
    (part): part is string => part !== null && part !== "" && part !== "none",
  );
  return parts.length === 0 ? "-" : parts.join(" + ");
}

function picture(row: MediaRow): string {
  if (row.height === null) return "-";
  return row.fps === null ? `${row.height}p` : `${row.height}p${Math.round(row.fps)}`;
}

function kindLabel(row: MediaRow): string {
  return row.kind === "captions" && row.lang !== null ? `captions (${row.lang})` : row.kind;
}
</script>

<template>
  <p v-if="media.length === 0" class="cellar-muted" data-test="media-empty">
    No files stored for this video.
  </p>
  <div v-else class="media-wrap">
    <table class="media-table" data-test="media-table">
      <thead>
        <tr>
          <th scope="col">Kind</th>
          <th scope="col">Version</th>
          <th scope="col">Location</th>
          <th scope="col">Size</th>
          <th scope="col">Codec</th>
          <th scope="col">Picture</th>
          <th scope="col">Downloaded</th>
          <th scope="col">Transcoded from</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in media" :key="row.id" :data-media="row.id">
          <td>
            <a :href="mediaUrl(videoId, row.id, true)" :title="row.rel_path">{{
              kindLabel(row)
            }}</a>
          </td>
          <td>
            v{{ row.version }}
            <Tag v-if="row.is_current" value="current" severity="success" data-test="current" />
          </td>
          <td>
            {{
              row.location_id === null
                ? "metadata"
                : (locations.get(row.location_id) ?? `#${row.location_id}`)
            }}
          </td>
          <td>{{ formatBytes(row.size_bytes) }}</td>
          <td class="mono">{{ codec(row) }}</td>
          <td>{{ picture(row) }}</td>
          <td :title="row.downloaded_at === null ? undefined : formatAbsolute(row.downloaded_at)">
            {{ row.downloaded_at === null ? "-" : formatRelative(row.downloaded_at) }}
          </td>
          <td class="mono">{{ row.transcoded_from ?? "-" }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.media-wrap {
  overflow-x: auto;
}

.media-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88rem;
}

.media-table th,
.media-table td {
  text-align: left;
  padding: 0.35rem 0.5rem;
  border-bottom: 1px solid var(--p-content-border-color);
  white-space: nowrap;
}

.media-table thead th {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--p-text-muted-color);
}

.media-table :deep(.p-tag) {
  margin-left: 0.35rem;
}
</style>
