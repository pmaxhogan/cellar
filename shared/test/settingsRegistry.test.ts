import { describe, expect, it } from "vitest";
import {
  SETTING_KEYS,
  SettingsPatchSchema,
  SettingsSchema,
  THUMBNAIL_VARIANTS,
  applySettingsPatch,
  checkSettingsConsistency,
  defaultSettings,
  isSettingKey,
  resolveSettings,
  settingGroups,
  settingsRegistry,
} from "../src/settingsRegistry.ts";

const EXPECTED_DEFAULTS: Record<string, unknown> = {
  "eval.interval_minutes": 60,
  "ingest.history_minutes": 30,
  "ingest.watch_later_minutes": 30,
  "ingest.liked_minutes": 30,
  "ingest.subscriptions_hours": 6,
  "ingest.channel_uploads_minutes": 30,
  "ingest.channel_newest_n": 50,
  "ingest.manual_channel_full_scan_hours": 24,
  "quota.api_units_per_day": 10000,
  "quota.scrape_requests_per_hour": 120,
  "download.concurrency": 2,
  "transcode.concurrency": 1,
  "download.rate_limit_bytes_per_s": null,
  "download.account_gap_seconds": 30,
  "download.sleep_requests_min_s": 1,
  "download.sleep_requests_max_s": 3,
  "reaper.high_water_pct": 95,
  "reaper.low_water_pct": 90,
  "reaper.min_free_gb": 10,
  "recheck.daily_under_days": 30,
  "recheck.weekly_under_days": 365,
  "recheck.ryd_enabled": true,
  "notify.consecutive_download_failures": 3,
  "notify.rate_limit_hours": 6,
  "notify.storage_pressure_hours": 6,
  "notify.outage_hours": 6,
  "canary.max_per_hour": 1,
  "logs.job_retention_days": 14,
  "logs.job_retention_gb": 2,
  "logs.failed_job_retention_days": 60,
  "tools.auto_update": true,
  "tools.pot_provider_url": "http://bgutil:4416",
  "tools.js_runtime": "node",
  "selfcheck.interval_hours": 24,
  "bulk.warn_gb": 20,
  "thumbnails.variants": [
    "maxresdefault",
    "sddefault",
    "hqdefault",
    "mqdefault",
    "default",
    "hq720",
  ],
};

describe("settings registry", () => {
  it("declares exactly the specified keys with the specified defaults", () => {
    expect([...SETTING_KEYS].sort()).toEqual(Object.keys(EXPECTED_DEFAULTS).sort());
    expect(defaultSettings()).toEqual(EXPECTED_DEFAULTS);
  });

  it("gives every key UI metadata and a default that passes its own schema", () => {
    for (const key of SETTING_KEYS) {
      const def = settingsRegistry[key];
      expect(def.ui.label.length, key).toBeGreaterThan(0);
      expect(def.ui.description.length, key).toBeGreaterThan(0);
      expect(def.ui.group.length, key).toBeGreaterThan(0);
      expect(def.schema.safeParse(def.default).success, key).toBe(true);
    }
  });

  it("defaults are internally consistent", () => {
    expect(checkSettingsConsistency(defaultSettings())).toEqual({});
  });

  it("returns a fresh copy of array defaults", () => {
    const a = defaultSettings();
    a["thumbnails.variants"].push("default");
    expect(defaultSettings()["thumbnails.variants"]).toEqual([...THUMBNAIL_VARIANTS]);
  });

  it("recognises keys", () => {
    expect(isSettingKey("eval.interval_minutes")).toBe(true);
    expect(isSettingKey("nope")).toBe(false);
    expect(isSettingKey("toString")).toBe(false);
  });

  it("groups keys for the UI without losing any", () => {
    const groups = settingGroups();
    expect(groups.flatMap((g) => g.keys).sort()).toEqual([...SETTING_KEYS].sort());
    expect(groups.map((g) => g.group)).toContain("Ingestion");
  });
});

describe("SettingsSchema", () => {
  it("fills every default from an empty object", () => {
    expect(SettingsSchema.parse({})).toEqual(EXPECTED_DEFAULTS);
  });

  it("keeps supplied values", () => {
    const parsed = SettingsSchema.parse({ "download.concurrency": 4 });
    expect(parsed["download.concurrency"]).toBe(4);
    expect(parsed["transcode.concurrency"]).toBe(1);
  });

  it("rejects unknown keys and invalid values", () => {
    expect(SettingsSchema.safeParse({ bogus: 1 }).success).toBe(false);
    expect(SettingsSchema.safeParse({ "download.concurrency": 0 }).success).toBe(false);
    expect(SettingsSchema.safeParse({ "download.concurrency": 1.5 }).success).toBe(false);
    expect(SettingsSchema.safeParse({ "tools.js_runtime": "python" }).success).toBe(false);
  });

  it("enforces cross-key invariants", () => {
    const result = SettingsSchema.safeParse({ "reaper.low_water_pct": 96 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["reaper.low_water_pct"]);
    }
  });
});

describe("SettingsPatchSchema", () => {
  it("accepts sparse patches, including null to clear", () => {
    expect(SettingsPatchSchema.parse({})).toEqual({});
    expect(SettingsPatchSchema.parse({ "eval.interval_minutes": null })).toEqual({
      "eval.interval_minutes": null,
    });
    expect(SettingsPatchSchema.parse({ "download.rate_limit_bytes_per_s": 5_000_000 })).toEqual({
      "download.rate_limit_bytes_per_s": 5_000_000,
    });
  });

  it("does not inject defaults", () => {
    expect(Object.keys(SettingsPatchSchema.parse({ "bulk.warn_gb": 5 }))).toEqual(["bulk.warn_gb"]);
  });

  it("rejects unknown keys and bad values", () => {
    expect(SettingsPatchSchema.safeParse({ nope: 1 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ "reaper.high_water_pct": 101 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ "recheck.ryd_enabled": "yes" }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ "thumbnails.variants": [] }).success).toBe(false);
    expect(
      SettingsPatchSchema.safeParse({ "thumbnails.variants": ["hqdefault", "huge"] }).success,
    ).toBe(false);
    expect(SettingsPatchSchema.safeParse({ "tools.pot_provider_url": "bgutil:4416" }).success).toBe(
      false,
    );
  });

  it("accepts an empty PO token provider URL as disabled", () => {
    expect(SettingsPatchSchema.parse({ "tools.pot_provider_url": "" })).toEqual({
      "tools.pot_provider_url": "",
    });
    expect(SettingsPatchSchema.parse({ "tools.pot_provider_url": " http://pot:1/ " })).toEqual({
      "tools.pot_provider_url": "http://pot:1/",
    });
  });
});

describe("resolveSettings", () => {
  it("returns defaults for an empty store", () => {
    expect(resolveSettings({})).toEqual(EXPECTED_DEFAULTS);
  });

  it("overlays stored values", () => {
    const resolved = resolveSettings({
      "eval.interval_minutes": 15,
      "tools.auto_update": false,
      "thumbnails.variants": ["hqdefault"],
      "download.rate_limit_bytes_per_s": 1_000_000,
    });
    expect(resolved["eval.interval_minutes"]).toBe(15);
    expect(resolved["tools.auto_update"]).toBe(false);
    expect(resolved["thumbnails.variants"]).toEqual(["hqdefault"]);
    expect(resolved["download.rate_limit_bytes_per_s"]).toBe(1_000_000);
    expect(resolved["ingest.history_minutes"]).toBe(30);
  });

  it("falls back to the default for invalid or unknown stored values", () => {
    const resolved = resolveSettings({
      "eval.interval_minutes": "sixty",
      "download.concurrency": -1,
      "removed.setting": 5,
      "tools.js_runtime": undefined,
    });
    expect(resolved["eval.interval_minutes"]).toBe(60);
    expect(resolved["download.concurrency"]).toBe(2);
    expect(resolved["tools.js_runtime"]).toBe("node");
    expect("removed.setting" in resolved).toBe(false);
  });

  it("ignores inherited properties", () => {
    const proto = { "eval.interval_minutes": 5 };
    const sparse = Object.create(proto) as Record<string, unknown>;
    expect(resolveSettings(sparse)["eval.interval_minutes"]).toBe(60);
  });
});

describe("applySettingsPatch", () => {
  it("sets, replaces and clears keys without mutating the input", () => {
    const stored = { "eval.interval_minutes": 15, "bulk.warn_gb": 50 };
    const result = applySettingsPatch(stored, {
      "eval.interval_minutes": null,
      "bulk.warn_gb": 5,
      "download.concurrency": 3,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sparse).toEqual({ "bulk.warn_gb": 5, "download.concurrency": 3 });
      expect(result.resolved["eval.interval_minutes"]).toBe(60);
      expect(result.resolved["bulk.warn_gb"]).toBe(5);
    }
    expect(stored).toEqual({ "eval.interval_minutes": 15, "bulk.warn_gb": 50 });
  });

  it("clearing a key that was never set is a no-op", () => {
    const result = applySettingsPatch({}, { "reaper.min_free_gb": null });
    expect(result).toEqual({ ok: true, sparse: {}, resolved: defaultSettings() });
  });

  it("drops unknown keys already in the store", () => {
    const result = applySettingsPatch({ "removed.setting": 1 }, {});
    expect(result.ok && result.sparse).toEqual({});
  });

  it("reports per-key validation errors", () => {
    const result = applySettingsPatch({}, { "download.concurrency": 0, mystery: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.errors).sort()).toEqual(["download.concurrency", "mystery"]);
      expect(result.errors.mystery).toBe("Unknown setting");
    }
  });

  it("rejects a non-object patch", () => {
    expect(applySettingsPatch({}, "nope").ok).toBe(false);
    expect(applySettingsPatch({}, null).ok).toBe(false);
  });

  it("checks cross-key invariants against the merged result", () => {
    const stored = { "reaper.high_water_pct": 80 };
    const bad = applySettingsPatch(stored, { "reaper.low_water_pct": 85 });
    expect(bad).toEqual({
      ok: false,
      errors: { "reaper.low_water_pct": "Must be lower than the start-reaping threshold" },
    });

    const sleep = applySettingsPatch({}, { "download.sleep_requests_min_s": 5 });
    expect(sleep.ok).toBe(false);

    const recheck = applySettingsPatch({}, { "recheck.daily_under_days": 400 });
    expect(recheck.ok).toBe(false);

    const good = applySettingsPatch(stored, { "reaper.low_water_pct": 70 });
    expect(good.ok).toBe(true);
  });

  it("lets a nullable setting go back to null by clearing it", () => {
    const result = applySettingsPatch(
      { "download.rate_limit_bytes_per_s": 1000 },
      { "download.rate_limit_bytes_per_s": null },
    );
    expect(result.ok && result.resolved["download.rate_limit_bytes_per_s"]).toBeNull();
  });
});
