<script setup lang="ts">
import { computed, ref, watch } from "vue";
import Select from "primevue/select";
import type { MediaRow } from "@cellar/shared";
import { captionsUrl, mediaUrl } from "../../api/videos.ts";

/**
 * In-browser playback of the current file: a <video> element (or <audio> for
 * an audio-only archive) with one <track> per stored caption language, a
 * playback speed menu and keyboard shortcuts while the player has focus:
 * space or k play and pause, left and right seek 5 s, j and l seek 10 s, up
 * and down change the volume, < and > change the speed.
 */
const props = defineProps<{
  videoId: string;
  media: MediaRow[];
  captions: { lang: string; media_id: number }[];
  poster: string | null;
}>();

interface SpeedOption {
  label: string;
  value: number;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const SPEED_OPTIONS: SpeedOption[] = SPEEDS.map((value) => ({ label: `${value}x`, value }));

const element = ref<HTMLMediaElement | null>(null);
const speed = ref(1);

const current = computed(() => {
  const row =
    props.media.find((candidate) => candidate.is_current && candidate.kind === "video") ??
    props.media.find((candidate) => candidate.is_current && candidate.kind === "audio");
  if (row === undefined) return null;
  return { row, audioOnly: row.kind === "audio", src: mediaUrl(props.videoId, row.id) };
});

/** Only the first English track is on by default; the rest are one click away. */
const defaultTrack = computed(() =>
  props.captions.findIndex((track) => /^en(?:[-_]|$)/i.test(track.lang)),
);

/**
 * The media element. Everything below runs from the speed menu or a key on the
 * player frame, both of which only exist while the element is mounted.
 */
function mediaElement(): HTMLMediaElement {
  return element.value as HTMLMediaElement;
}

function applySpeed(): void {
  mediaElement().playbackRate = speed.value;
}

watch(speed, applySpeed);

function setSpeed(value: number): void {
  speed.value = value;
}

function stepSpeed(direction: 1 | -1): void {
  const index = Math.min(SPEEDS.length - 1, Math.max(0, SPEEDS.indexOf(speed.value) + direction));
  setSpeed(SPEEDS[index] as number);
}

function seek(delta: number): void {
  const el = mediaElement();
  const max = Number.isFinite(el.duration) ? el.duration : Number.POSITIVE_INFINITY;
  el.currentTime = Math.min(max, Math.max(0, el.currentTime + delta));
}

function togglePlay(): void {
  const el = mediaElement();
  if (el.paused) {
    // A rejected play() (autoplay policy, no source yet) needs no handling here.
    void el.play().catch(() => undefined);
  } else {
    el.pause();
  }
}

function volume(delta: number): void {
  const el = mediaElement();
  el.volume = Math.min(1, Math.max(0, Math.round((el.volume + delta) * 10) / 10));
}

/** Keys typed into a field (or anything editable) inside the player are not shortcuts. */
function isTyping(target: EventTarget | null): boolean {
  return (target as Element).closest("input, textarea, select, [contenteditable='true']") !== null;
}

function onKey(event: KeyboardEvent): void {
  if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
  const actions: Record<string, () => void> = {
    " ": togglePlay,
    k: togglePlay,
    ArrowLeft: () => seek(-5),
    ArrowRight: () => seek(5),
    j: () => seek(-10),
    l: () => seek(10),
    ArrowUp: () => volume(0.1),
    ArrowDown: () => volume(-0.1),
    "<": () => stepSpeed(-1),
    ">": () => stepSpeed(1),
  };
  const action = actions[event.key];
  if (action === undefined) return;
  event.preventDefault();
  action();
}
</script>

<template>
  <div class="player" data-test="player">
    <div v-if="current" class="player__frame" tabindex="0" @keydown="onKey">
      <audio
        v-if="current.audioOnly"
        ref="element"
        class="player__audio"
        controls
        preload="metadata"
        :src="current.src"
        data-test="player-audio"
        @loadedmetadata="applySpeed"
      />
      <video
        v-else
        ref="element"
        class="player__video"
        controls
        preload="metadata"
        playsinline
        :poster="poster ?? undefined"
        :src="current.src"
        data-test="player-video"
        @loadedmetadata="applySpeed"
      >
        <track
          v-for="(track, index) in captions"
          :key="track.lang"
          kind="subtitles"
          :srclang="track.lang"
          :label="track.lang"
          :src="captionsUrl(videoId, track.lang)"
          :default="index === defaultTrack"
        />
      </video>
    </div>
    <div v-else class="player__none" data-test="player-none">
      <img v-if="poster" :src="poster" alt="" class="player__poster" />
      <p class="cellar-muted">No video or audio file is on disk for this video.</p>
    </div>
    <div v-if="current" class="player__controls">
      <label for="player-speed" class="cellar-note">Speed</label>
      <Select
        input-id="player-speed"
        :model-value="speed"
        :options="SPEED_OPTIONS"
        option-label="label"
        option-value="value"
        size="small"
        data-test="player-speed"
        @update:model-value="setSpeed"
      />
      <span class="cellar-note player__keys">
        Keys: space or k play, arrows seek 5 s and change volume, j and l seek 10 s, &lt; and &gt;
        change speed.
      </span>
    </div>
  </div>
</template>

<style scoped>
.player {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.player__frame {
  border-radius: 8px;
  overflow: hidden;
  background: #000;
}

.player__frame:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 2px;
}

.player__video {
  display: block;
  width: 100%;
  max-height: 70vh;
  background: #000;
}

.player__audio {
  display: block;
  width: 100%;
}

.player__none {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.5rem;
}

.player__poster {
  max-width: 24rem;
  width: 100%;
  border-radius: 8px;
}

.player__controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}

.player__keys {
  margin-left: auto;
}
</style>
