<script setup lang="ts">
import { computed, onMounted } from "vue";
import InputNumber from "primevue/inputnumber";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import { AUDIO_CODECS, TRANSCODE_MODES } from "@cellar/shared";
import { visibleCodecs } from "../../lib/rulesEffects.ts";
import { humanize } from "../../lib/ruleSummary.ts";
import { useRuleLookups } from "../../lib/rulesLookups.ts";

/**
 * The `transcode` effect: mode, codec, quality, preset and audio. NVENC
 * codecs are offered unless GET /api/status says the GPU lacks them.
 */
const props = withDefaults(defineProps<{ modelValue: unknown; disabled?: boolean }>(), {
  disabled: false,
});
const emit = defineEmits<{ "update:modelValue": [Record<string, unknown>] }>();

const lookups = useRuleLookups();
onMounted(() => void lookups.ensureCodecs());

const value = computed<Record<string, unknown>>(() =>
  props.modelValue !== null && typeof props.modelValue === "object"
    ? (props.modelValue as Record<string, unknown>)
    : {},
);
const off = computed(() => value.value["mode"] === "none");

const MODE_LABELS: Record<string, string> = {
  none: "Never",
  if_not_av1: "Only when not AV1",
  always: "Always",
};
const modeOptions = TRANSCODE_MODES.map((mode) => ({ label: MODE_LABELS[mode], value: mode }));
const codecOptions = computed(() =>
  visibleCodecs(lookups.codecs.value, value.value["codec"]).map((codec) => ({
    label: humanize(codec),
    value: codec,
  })),
);
const audioOptions = AUDIO_CODECS.map((codec) => ({ label: codec, value: codec }));

function set(field: string, v: unknown): void {
  const next = { ...value.value };
  if (v === null || v === undefined || v === "") delete next[field];
  else next[field] = v;
  emit("update:modelValue", next);
}
</script>

<template>
  <div class="effect-form" data-test="transcode-form">
    <label class="cellar-field">
      <span>Transcode</span>
      <Select
        :model-value="value['mode'] ?? 'if_not_av1'"
        :options="modeOptions"
        option-label="label"
        option-value="value"
        size="small"
        :disabled="disabled"
        data-test="transcode-mode"
        @update:model-value="(v: string) => set('mode', v)"
      />
    </label>
    <template v-if="!off">
      <label class="cellar-field">
        <span>Codec</span>
        <Select
          :model-value="value['codec'] ?? 'hevc_nvenc'"
          :options="codecOptions"
          option-label="label"
          option-value="value"
          size="small"
          :disabled="disabled"
          data-test="transcode-codec"
          @update:model-value="(v: string) => set('codec', v)"
        />
      </label>
      <label class="cellar-field">
        <span>Quality (CQ / CRF)</span>
        <InputNumber
          :model-value="typeof value['quality'] === 'number' ? value['quality'] : 28"
          :min="0"
          :max="63"
          size="small"
          :disabled="disabled"
          data-test="transcode-quality"
          @update:model-value="(v: number | null) => set('quality', v)"
        />
      </label>
      <label class="cellar-field">
        <span>Preset</span>
        <InputText
          :model-value="String(value['preset'] ?? 'p5')"
          size="small"
          :disabled="disabled"
          data-test="transcode-preset"
          @update:model-value="(v: string | undefined) => set('preset', v)"
        />
      </label>
      <label class="cellar-field">
        <span>Max video bitrate (kbps)</span>
        <InputNumber
          :model-value="
            typeof value['max_video_bitrate_kbps'] === 'number'
              ? value['max_video_bitrate_kbps']
              : null
          "
          :min="50"
          :max="500000"
          placeholder="no cap"
          size="small"
          :disabled="disabled"
          data-test="transcode-bitrate"
          @update:model-value="(v: number | null) => set('max_video_bitrate_kbps', v)"
        />
      </label>
      <label class="cellar-field">
        <span>Audio</span>
        <Select
          :model-value="value['audio_codec'] ?? 'copy'"
          :options="audioOptions"
          option-label="label"
          option-value="value"
          size="small"
          :disabled="disabled"
          data-test="transcode-audio"
          @update:model-value="(v: string) => set('audio_codec', v)"
        />
      </label>
      <label v-if="value['audio_codec'] !== 'copy'" class="cellar-field">
        <span>Audio bitrate (kbps)</span>
        <InputNumber
          :model-value="
            typeof value['audio_bitrate_kbps'] === 'number' ? value['audio_bitrate_kbps'] : null
          "
          :min="8"
          :max="1024"
          placeholder="encoder default"
          size="small"
          :disabled="disabled"
          data-test="transcode-audio-bitrate"
          @update:model-value="(v: number | null) => set('audio_bitrate_kbps', v)"
        />
      </label>
    </template>
  </div>
</template>

<style scoped>
.effect-form {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
  gap: 0.6rem;
}
</style>
