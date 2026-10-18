import { beforeEach, describe, expect, it } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, h, ref } from "vue";
import Select from "primevue/select";
import { EffectsSchema, type RuleKind } from "@cellar/shared";
import EffectsEditor from "../../src/components/rules/EffectsEditor.vue";
import { flush } from "../helpers/dom.ts";
import { mountGlobals } from "../helpers/mount.ts";
import { fakeApi, type FakeApi } from "./fakeApi.ts";
import { byTest, propOf } from "./wrappers.ts";

beforeEach(() => {
  setActivePinia(createPinia());
});

function lookupApi(status: unknown = { version: "t" }): FakeApi {
  return fakeApi({
    "GET /api/status": status,
    "GET /api/locations": {
      rows: [
        {
          id: 3,
          label: "Archive",
          container_path: "/media/archive",
          quota_bytes: 0,
          enabled: false,
          used_bytes: 0,
          fs_free_bytes: null,
          mounted: true,
          created_at: 1,
          updated_at: 1,
        },
      ],
    },
    "GET /api/accounts": {
      rows: [
        {
          id: 8,
          label: "Alt",
          email: null,
          channel_id: null,
          status: "ok",
          has_cookies: true,
          scrape_budget_per_hour: null,
          last_api_ok_at: null,
          last_cookie_ok_at: null,
          created_at: 1,
        },
      ],
    },
    "GET /api/proxies": {
      rows: [
        {
          id: 5,
          label: "Home",
          url_redacted: "http://***@home",
          enabled: true,
          fail_count: 0,
          skipped_until: null,
        },
      ],
    },
  });
}

async function mountEditor(
  initial: Record<string, unknown>,
  kind: RuleKind = "custom",
  fake: FakeApi = lookupApi(),
) {
  const model = ref<Record<string, unknown>>(initial);
  const valid = ref<boolean | null>(null);
  const Host = defineComponent({
    setup() {
      return () =>
        h(EffectsEditor, {
          modelValue: model.value,
          kind,
          "onUpdate:modelValue": (v: Record<string, unknown>) => (model.value = v),
          onValidity: (v: boolean) => (valid.value = v),
        });
    },
  });
  const wrapper = mount(Host, { global: mountGlobals({ api: fake.api }) });
  await flush();
  return { wrapper, model, valid, fake };
}

async function emitOn(wrapper: VueWrapper, test: string, value: unknown, index = 0) {
  byTest(wrapper, test, index).vm.$emit("update:modelValue", value);
  await flush();
}

function addOptions(wrapper: VueWrapper): string[] {
  const select = wrapper.findComponent(Select);
  const groups = select.props("options") as { items: { key: string }[] }[];
  return groups.flatMap((group) => group.items.map((item) => item.key));
}

describe("EffectsEditor: sparse semantics", () => {
  it("starts empty, adds a key with its default and unsets it to inherit", async () => {
    const { wrapper, model, valid } = await mountEditor({});
    expect(wrapper.find("[data-test='effects-empty']").exists()).toBe(true);
    expect(addOptions(wrapper)).toContain("include");
    await emitOn(wrapper, "effect-add", "captions");
    expect(model.value).toEqual({
      captions: { enabled: true, languages: "all", auto_generated: true },
    });
    expect(addOptions(wrapper)).not.toContain("captions");
    await emitOn(wrapper, "effect-add", null);
    expect(Object.keys(model.value)).toEqual(["captions"]);
    await wrapper.find("[data-test='effect-unset']").trigger("click");
    await flush();
    expect(model.value).toEqual({});
    expect(valid.value).toBe(true);
  });

  it("never offers include on the global rule and flags it if present", async () => {
    const { wrapper, valid } = await mountEditor({ include: false }, "global");
    expect(addOptions(wrapper)).not.toContain("include");
    expect(wrapper.find("[data-test='effect-error']").text()).toBe(
      "A global rule cannot set this.",
    );
    expect(valid.value).toBe(false);
  });

  it("only lists keys that are set, in registry order", async () => {
    const { wrapper } = await mountEditor({ notify: { enabled: true }, reclaim_priority: 0 });
    const keys = wrapper.findAll("[data-effect]").map((row) => row.attributes("data-effect"));
    expect(keys).toEqual(["reclaim_priority", "notify"]);
  });
});

describe("EffectsEditor: controls", () => {
  it("edits toggles, ints, selects and nullable ints", async () => {
    const { wrapper, model } = await mountEditor({
      include: true,
      reclaim_priority: -1,
      media_mode: "video",
      max_height: null,
    });
    await emitOn(wrapper, "effect-toggle", false);
    await emitOn(wrapper, "effect-int", 0);
    expect(wrapper.find("[data-effect='reclaim_priority'] [data-test='effect-hint']").text()).toBe(
      "delete now",
    );
    await emitOn(wrapper, "effect-select", "audio_only");
    await wrapper
      .find("[data-effect='max_height'] [data-test='effect-null'] input")
      .setValue(false);
    await flush();
    expect(model.value["max_height"]).toBe(1);
    await emitOn(wrapper, "effect-int", 1080, 1);
    expect(model.value).toEqual({
      include: false,
      reclaim_priority: 0,
      media_mode: "audio_only",
      max_height: 1080,
    });
    await wrapper.find("[data-effect='max_height'] [data-test='effect-null'] input").setValue(true);
    await flush();
    expect(model.value["max_height"]).toBeNull();
    expect(EffectsSchema.safeParse(model.value).success).toBe(true);
  });

  it("picks a location, with the null option for the first location", async () => {
    const { wrapper, model } = await mountEditor({ location_id: null });
    const select = byTest(wrapper, "effect-location");
    const options = propOf(select, "options") as { label: string; value: number | null }[];
    expect(options).toEqual([
      { label: "First enabled location", value: null },
      { label: "Archive (disabled)", value: 3 },
    ]);
    await emitOn(wrapper, "effect-location", 3);
    expect(model.value).toEqual({ location_id: 3 });
  });

  it("edits the transcode sub-form and hides NVENC codecs the server lacks", async () => {
    const { wrapper, model } = await mountEditor(
      { transcode: { mode: "if_not_av1", codec: "av1_svt", quality: 28, preset: "p5" } },
      "custom",
      lookupApi({ gpu: { nvenc: false } }),
    );
    const codecs = propOf(byTest(wrapper, "transcode-codec"), "options") as {
      value: string;
    }[];
    expect(codecs.map((c) => c.value)).toEqual(["av1_svt"]);
    await emitOn(wrapper, "transcode-quality", 30);
    await emitOn(wrapper, "transcode-preset", "8");
    await emitOn(wrapper, "transcode-bitrate", 4000);
    await emitOn(wrapper, "transcode-max-height", 720);
    await emitOn(wrapper, "transcode-max-fps", 30);
    await emitOn(wrapper, "transcode-audio", "opus");
    await emitOn(wrapper, "transcode-audio-bitrate", 96);
    expect(model.value["transcode"]).toEqual({
      mode: "if_not_av1",
      codec: "av1_svt",
      quality: 30,
      preset: "8",
      max_video_bitrate_kbps: 4000,
      max_height: 720,
      max_fps: 30,
      audio_codec: "opus",
      audio_bitrate_kbps: 96,
    });
    await emitOn(wrapper, "transcode-bitrate", null);
    expect(model.value["transcode"]).not.toHaveProperty("max_video_bitrate_kbps");
    await emitOn(wrapper, "transcode-mode", "none");
    expect(wrapper.find("[data-test='transcode-codec']").exists()).toBe(false);
    expect(EffectsSchema.safeParse(model.value).success).toBe(true);
  });

  it("offers every codec when the status response says nothing about NVENC", async () => {
    const { wrapper, model } = await mountEditor({ transcode: { mode: "always" } });
    const codecs = propOf(byTest(wrapper, "transcode-codec"), "options") as {
      value: string;
    }[];
    expect(codecs.map((c) => c.value)).toEqual([
      "hevc_nvenc",
      "h264_nvenc",
      "av1_svt",
      "av1_nvenc",
    ]);
    await emitOn(wrapper, "transcode-codec", "h264_nvenc");
    expect(model.value["transcode"]).toEqual({ mode: "always", codec: "h264_nvenc" });
  });

  it("edits the quality ranking: enable, reorder, switch primary, back to codec first", async () => {
    const { wrapper, model } = await mountEditor({ quality_priority: null });
    expect(wrapper.find("[data-test='quality-form']").exists()).toBe(false);
    await wrapper.find("[data-test='effect-null'] input").setValue(false);
    await flush();
    expect(model.value["quality_priority"]).toEqual({
      primary: "resolution",
      resolutions: [4320, 2160, 1440, 1080, 720, 480, 360, 240, 144],
      fps: [60, 50, 48, 30, 25, 24],
    });
    const resolutions = wrapper.find("[data-test='quality-resolutions']");
    // 1080p is fourth; three moves up put it first.
    for (let i = 3; i > 0; i--) {
      await resolutions.findAll("[data-test='quality-up']")[i]!.trigger("click");
      await flush();
    }
    expect((model.value["quality_priority"] as { resolutions: number[] }).resolutions).toEqual([
      1080, 4320, 2160, 1440, 720, 480, 360, 240, 144,
    ]);
    const fps = wrapper.find("[data-test='quality-fps']");
    await fps.findAll("[data-test='quality-down']")[0]!.trigger("click");
    await flush();
    expect((model.value["quality_priority"] as { fps: number[] }).fps).toEqual([
      50, 60, 48, 30, 25, 24,
    ]);
    // The ends cannot move past the edge.
    expect(fps.findAll("[data-test='quality-up']")[0]!.attributes("disabled")).toBeDefined();
    expect(fps.findAll("[data-test='quality-down']")[5]!.attributes("disabled")).toBeDefined();
    expect(fps.text()).toContain("24 fps or lower");
    await emitOn(wrapper, "quality-primary", "fps");
    expect(model.value["quality_priority"]).toMatchObject({ primary: "fps" });
    await wrapper.find("[data-test='effect-null'] input").setValue(true);
    await flush();
    expect(model.value["quality_priority"]).toBeNull();
  });

  it("edits captions: all languages, a typed list with chips, auto-generated, off", async () => {
    const { wrapper, model } = await mountEditor({
      captions: { enabled: true, languages: "all", auto_generated: true },
    });
    await wrapper.find("[data-test='captions-all'] input").setValue(false);
    await flush();
    expect(model.value["captions"]).toMatchObject({ languages: ["en"] });
    await emitOn(wrapper, "captions-languages", "en, de pt-BR");
    expect(model.value["captions"]).toMatchObject({ languages: ["en", "de", "pt-BR"] });
    expect(wrapper.findAll("[data-test='captions-chip']").map((t) => t.text())).toEqual([
      "en",
      "de",
      "pt-BR",
    ]);
    await emitOn(wrapper, "captions-languages", "");
    expect(wrapper.find("[data-test='effect-error']").exists()).toBe(true);
    await emitOn(wrapper, "captions-languages", "fr");
    await emitOn(wrapper, "captions-auto", false);
    expect(model.value["captions"]).toEqual({
      enabled: true,
      languages: ["fr"],
      auto_generated: false,
    });
    await wrapper.find("[data-test='captions-all'] input").setValue(true);
    await flush();
    expect(model.value["captions"]).toMatchObject({ languages: "all" });
    await emitOn(wrapper, "captions-enabled", false);
    expect(wrapper.find("[data-test='captions-all']").exists()).toBe(false);
    expect(model.value["captions"]).toMatchObject({ enabled: false });
  });

  it("edits yt-dlp options and flags arguments outside the allowlist", async () => {
    const { wrapper, model, valid } = await mountEditor({ ytdlp: {} });
    await emitOn(wrapper, "ytdlp-format", " bv*+ba ");
    await emitOn(wrapper, "ytdlp-rate", 512);
    await emitOn(wrapper, "ytdlp-sleep-min", 1);
    await emitOn(wrapper, "ytdlp-sleep-max", 4);
    await emitOn(wrapper, "ytdlp-fragments", 3);
    await wrapper.find("[data-test='ytdlp-arg-add']").trigger("click");
    await flush();
    expect(model.value["ytdlp"]).toEqual({
      format_override: "bv*+ba",
      rate_limit_bytes_per_s: 524288,
      sleep_requests_min: 1,
      sleep_requests_max: 4,
      concurrent_fragments: 3,
      extra_args_allowlisted: ["--embed-metadata"],
    });
    await emitOn(wrapper, "ytdlp-arg", "--exec=rm");
    expect(wrapper.find("[data-test='ytdlp-arg-bad']").exists()).toBe(true);
    expect(valid.value).toBe(false);
    await wrapper.find("[data-test='ytdlp-arg-remove']").trigger("click");
    await emitOn(wrapper, "ytdlp-rate", null);
    await emitOn(wrapper, "ytdlp-format", "");
    await flush();
    expect(model.value["ytdlp"]).toEqual({
      sleep_requests_min: 1,
      sleep_requests_max: 4,
      concurrent_fragments: 3,
    });
    expect(valid.value).toBe(true);
    await emitOn(wrapper, "ytdlp-sleep-min", 9);
    expect(wrapper.find("[data-test='effect-error']").text()).toContain("sleep_requests_max");
  });

  it("switches download accounts between modes and an explicit list", async () => {
    const { wrapper, model } = await mountEditor({ download_accounts: "sourcing" });
    await emitOn(wrapper, "id-list-mode", "__list");
    expect(model.value["download_accounts"]).toEqual([8]);
    await emitOn(wrapper, "id-list-ids", []);
    expect(wrapper.find("[data-test='effect-error']").exists()).toBe(true);
    await emitOn(wrapper, "id-list-mode", "any");
    expect(model.value["download_accounts"]).toBe("any");
  });

  it("switches proxies between none, the pool and specific proxies", async () => {
    const { wrapper, model } = await mountEditor({ proxy: "none" });
    await emitOn(wrapper, "id-list-mode", "pool");
    expect(model.value["proxy"]).toBe("pool");
    await emitOn(wrapper, "id-list-mode", "__list");
    expect(model.value["proxy"]).toEqual([5]);
    const ids = propOf(byTest(wrapper, "id-list-ids"), "options");
    expect(ids).toEqual([{ label: "Home", value: 5 }]);
  });

  it("edits delay after upload and the recheck interval as durations", async () => {
    const { wrapper, model } = await mountEditor({
      delay_after_upload: null,
      recheck_interval: "tiered",
    });
    await wrapper
      .find("[data-effect='delay_after_upload'] [data-test='effect-null'] input")
      .setValue(false);
    await flush();
    expect(model.value["delay_after_upload"]).toEqual({ days: 1 });
    await emitOn(wrapper, "age-hours", 6);
    expect(model.value["delay_after_upload"]).toEqual({ days: 1, hours: 6 });
    await emitOn(wrapper, "effect-recheck", "fixed");
    expect(model.value["recheck_interval"]).toEqual({ days: 7 });
    await emitOn(wrapper, "age-days", 3, 1);
    expect(model.value["recheck_interval"]).toEqual({ days: 3 });
    await emitOn(wrapper, "effect-recheck", "tiered");
    expect(model.value["recheck_interval"]).toBe("tiered");
    expect(EffectsSchema.safeParse(model.value).success).toBe(true);
  });

  it("edits notify: enabled, a count, or unlimited", async () => {
    const { wrapper, model } = await mountEditor({
      notify: { enabled: false, max_times: 1, channel: "push" },
    });
    await emitOn(wrapper, "notify-enabled", true);
    await emitOn(wrapper, "notify-max", 3);
    expect(model.value["notify"]).toEqual({ enabled: true, max_times: 3, channel: "push" });
    await wrapper.find("[data-test='notify-unlimited'] input").setValue(true);
    await flush();
    expect(model.value["notify"]).toMatchObject({ max_times: null });
    expect(wrapper.find("[data-test='notify-max']").exists()).toBe(false);
    await wrapper.find("[data-test='notify-unlimited'] input").setValue(false);
    await flush();
    expect(model.value["notify"]).toMatchObject({ max_times: 1 });
  });
});
