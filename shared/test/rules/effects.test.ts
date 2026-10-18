import { describe, expect, it } from "vitest";
import {
  EFFECT_CONTROLS,
  EFFECT_GROUPS,
  EFFECT_KEYS,
  effectAllowedIn,
  effectDefaults,
  EffectiveSettingsSchema,
  effectRegistry,
  EffectsSchema,
  isAllowlistedYtdlpArg,
  RULE_KINDS,
} from "../../src/index.ts";

describe("effect registry", () => {
  it("has exactly the spec 4.3 keys", () => {
    expect([...EFFECT_KEYS].sort()).toEqual(
      [
        "include",
        "reclaim_priority",
        "location_id",
        "media_mode",
        "format_policy",
        "max_height",
        "max_fps",
        "transcode",
        "captions",
        "ytdlp",
        "download_accounts",
        "proxy",
        "delay_after_upload",
        "recheck_interval",
        "live",
        "notify",
      ].sort(),
    );
  });

  it("has the spec defaults", () => {
    expect(effectDefaults()).toEqual({
      include: true,
      reclaim_priority: -1,
      location_id: null,
      media_mode: "video",
      format_policy: "prefer_av1",
      max_height: null,
      max_fps: null,
      transcode: {
        mode: "if_not_av1",
        codec: "hevc_nvenc",
        quality: 28,
        preset: "p5",
        audio_codec: "copy",
      },
      captions: { enabled: true, languages: "all", auto_generated: true },
      ytdlp: {},
      download_accounts: "sourcing",
      proxy: "none",
      delay_after_upload: null,
      recheck_interval: "tiered",
      live: "vod_only",
      notify: { enabled: false, max_times: 1, channel: "push" },
    });
  });

  it("returns a fresh copy of the defaults each call", () => {
    const a = effectDefaults();
    a.transcode.quality = 1;
    a.captions.enabled = false;
    expect(effectDefaults().transcode.quality).toBe(28);
    expect(effectRegistry.captions.default.enabled).toBe(true);
  });

  it("every default validates against its own schema", () => {
    for (const key of EFFECT_KEYS) {
      expect(effectRegistry[key].schema.safeParse(effectRegistry[key].default).success).toBe(true);
    }
    expect(EffectiveSettingsSchema.parse(effectDefaults())).toEqual(effectDefaults());
  });

  it("forbids include in global and allows everything else everywhere", () => {
    for (const key of EFFECT_KEYS) {
      for (const kind of RULE_KINDS) {
        expect(effectAllowedIn(key, kind)).toBe(!(key === "include" && kind === "global"));
      }
    }
  });

  it("declares UI metadata for every key", () => {
    for (const key of EFFECT_KEYS) {
      const { ui } = effectRegistry[key];
      expect(EFFECT_CONTROLS).toContain(ui.control);
      expect(EFFECT_GROUPS).toContain(ui.group);
      expect(ui.label.length).toBeGreaterThan(0);
      expect(ui.description.length).toBeGreaterThan(0);
      if (ui.control === "select") expect(ui.options?.length).toBeGreaterThan(0);
    }
  });
});

describe("EffectsSchema (sparse)", () => {
  it("accepts an empty map and round-trips through JSON", () => {
    expect(EffectsSchema.parse({})).toEqual({});
    const effects = {
      reclaim_priority: 0,
      captions: { enabled: true, languages: ["en", "pt-BR"], auto_generated: false },
      download_accounts: [1, 2],
      proxy: "pool",
      delay_after_upload: "PT6H",
      recheck_interval: { days: 3 },
      ytdlp: { rate_limit_bytes_per_s: 1_000_000, extra_args_allowlisted: ["--retries=5"] },
    };
    const parsed = EffectsSchema.parse(effects);
    expect(EffectsSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("fills object subfield defaults", () => {
    expect(EffectsSchema.parse({ captions: { languages: ["en"] } }).captions).toEqual({
      enabled: true,
      languages: ["en"],
      auto_generated: true,
    });
    expect(EffectsSchema.parse({ notify: { enabled: true } }).notify).toEqual({
      enabled: true,
      max_times: 1,
      channel: "push",
    });
    expect(EffectsSchema.parse({ transcode: { mode: "always" } }).transcode).toEqual({
      mode: "always",
      codec: "hevc_nvenc",
      quality: 28,
      preset: "p5",
      audio_codec: "copy",
    });
  });

  it("accepts unlimited notify (max_times null)", () => {
    expect(
      EffectsSchema.parse({ notify: { enabled: true, max_times: null } }).notify?.max_times,
    ).toBeNull();
  });

  it.each([
    [{ unknown_key: 1 }],
    [{ reclaim_priority: -2 }],
    [{ reclaim_priority: 1.5 }],
    [{ media_mode: "audio" }],
    [{ format_policy: "prefer_hevc" }],
    [{ location_id: 0 }],
    [{ max_height: 0 }],
    [{ transcode: { codec: "x265" } }],
    [{ transcode: { quality: 64 } }],
    [{ transcode: { preset: "p5; rm -rf" } }],
    [{ transcode: { extra: true } }],
    [{ captions: { languages: [] } }],
    [{ captions: { languages: ["en us"] } }],
    [{ download_accounts: "all" }],
    [{ download_accounts: [] }],
    [{ proxy: ["1"] }],
    [{ delay_after_upload: "P1X" }],
    [{ recheck_interval: "weekly" }],
    [{ live: "always" }],
    [{ notify: { channel: "email" } }],
    [{ notify: { max_times: 0 } }],
    [{ ytdlp: { extra_args_allowlisted: ["--exec=rm"] } }],
    [{ ytdlp: { sleep_requests_min: 5, sleep_requests_max: 1 } }],
    [{ ytdlp: { format_override: "best video" } }],
    [{ ytdlp: { concurrent_fragments: 0 } }],
    [{ include: "yes" }],
  ])("rejects %j", (effects) => {
    expect(EffectsSchema.safeParse(effects).success).toBe(false);
  });
});

describe("EffectiveSettingsSchema", () => {
  it("requires every key", () => {
    const { notify: _notify, ...missing } = effectDefaults();
    expect(EffectiveSettingsSchema.safeParse(missing).success).toBe(false);
  });
});

describe("isAllowlistedYtdlpArg", () => {
  it.each(["--embed-metadata", "--retries=10", "--sponsorblock-remove=sponsor"])(
    "allows %s",
    (arg) => {
      expect(isAllowlistedYtdlpArg(arg)).toBe(true);
    },
  );

  it.each([
    "--exec=rm",
    "--cookies=/etc/passwd",
    "--proxy=http://x",
    "-o",
    "--retries 10",
    "--retries=",
    "embed-metadata",
  ])("rejects %s", (arg) => {
    expect(isAllowlistedYtdlpArg(arg)).toBe(false);
  });
});
