import { describe, expect, it } from "vitest";
import { SETTING_KEYS, THUMBNAIL_VARIANTS, resolveSettings, type SettingKey } from "@cellar/shared";
import {
  buildPatch,
  defaultValue,
  dirtyKeys,
  draftFrom,
  formatSettingValue,
  isIntegerSetting,
  isNullableSetting,
  sameValue,
  serverFieldErrors,
  validateDraft,
  type Draft,
  type Overrides,
} from "../../src/api/settings.ts";

function draftOf(overrides: Overrides, edits: Partial<Record<SettingKey, unknown>> = {}): Draft {
  return { ...draftFrom(resolveSettings(overrides)), ...edits } as Draft;
}

const none = new Set<SettingKey>();

describe("setting kinds", () => {
  it("tells integer settings from fractional ones by probing the schema", () => {
    const fractional = SETTING_KEYS.filter(
      (key) => !isIntegerSetting(key) && key !== "tools.pot_provider_url",
    ).filter((key) => typeof defaultValue(key) === "number" || defaultValue(key) === null);
    expect(fractional.sort()).toEqual(
      [
        "bulk.warn_gb",
        "download.sleep_requests_max_s",
        "download.sleep_requests_min_s",
        "logs.job_retention_gb",
        "reaper.high_water_pct",
        "reaper.low_water_pct",
        "reaper.min_free_gb",
      ].sort(),
    );
    expect(isIntegerSetting("download.concurrency")).toBe(true);
    expect(isIntegerSetting("download.rate_limit_bytes_per_s")).toBe(true);
    expect(isIntegerSetting("recheck.ryd_enabled")).toBe(false);
  });

  it("knows the only nullable number", () => {
    expect(SETTING_KEYS.filter(isNullableSetting)).toEqual(["download.rate_limit_bytes_per_s"]);
  });

  it("compares arrays by value", () => {
    expect(sameValue(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameValue(["a"], ["a", "b"])).toBe(false);
    expect(sameValue(1, 1)).toBe(true);
    expect(sameValue(null, 0)).toBe(false);
  });

  it("returns a fresh copy of an array default", () => {
    const value = defaultValue("thumbnails.variants") as string[];
    value.pop();
    expect(defaultValue("thumbnails.variants")).toEqual([...THUMBNAIL_VARIANTS]);
  });
});

describe("patch semantics", () => {
  it("is empty when nothing changed", () => {
    const overrides = { "download.concurrency": 4 };
    expect(dirtyKeys(draftOf(overrides), overrides, none)).toEqual([]);
    expect(buildPatch(draftOf(overrides), overrides, none)).toEqual({});
  });

  it("sends a changed value", () => {
    const draft = draftOf({}, { "download.concurrency": 3, "recheck.ryd_enabled": false });
    expect(buildPatch(draft, {}, none)).toEqual({
      "download.concurrency": 3,
      "recheck.ryd_enabled": false,
    });
  });

  it("clears an override when edited back to the default", () => {
    const overrides = { "download.concurrency": 4 };
    const draft = draftOf(overrides, { "download.concurrency": 2 });
    expect(buildPatch(draft, overrides, none)).toEqual({ "download.concurrency": null });
  });

  it("clears a reset key, even when its stored value equals the default", () => {
    const overrides = { "download.concurrency": 2 };
    const cleared = new Set<SettingKey>(["download.concurrency"]);
    expect(dirtyKeys(draftOf(overrides), overrides, cleared)).toEqual(["download.concurrency"]);
    expect(buildPatch(draftOf(overrides), overrides, cleared)).toEqual({
      "download.concurrency": null,
    });
  });

  it("ignores a reset of a key with no override", () => {
    const cleared = new Set<SettingKey>(["download.concurrency"]);
    expect(buildPatch(draftOf({}), {}, cleared)).toEqual({});
  });

  it("sends list values whole", () => {
    const draft = draftOf({}, { "thumbnails.variants": ["maxresdefault", "hqdefault"] });
    expect(buildPatch(draft, {}, none)).toEqual({
      "thumbnails.variants": ["maxresdefault", "hqdefault"],
    });
  });

  it("treats null on the nullable rate limit as a clear", () => {
    const overrides = { "download.rate_limit_bytes_per_s": 1_000_000 };
    const draft = draftOf(overrides, { "download.rate_limit_bytes_per_s": null });
    expect(buildPatch(draft, overrides, none)).toEqual({
      "download.rate_limit_bytes_per_s": null,
    });
    const set = draftOf({}, { "download.rate_limit_bytes_per_s": 500_000 });
    expect(buildPatch(set, {}, none)).toEqual({ "download.rate_limit_bytes_per_s": 500_000 });
  });
});

describe("validateDraft", () => {
  it("passes a valid patch through", () => {
    const draft = draftOf({}, { "eval.interval_minutes": 15 });
    expect(validateDraft(draft, {}, none)).toEqual({
      ok: true,
      patch: { "eval.interval_minutes": 15 },
    });
  });

  it("never lets an empty number become a reset", () => {
    const overrides = { "download.concurrency": 4 };
    const draft = draftOf(overrides, { "download.concurrency": null });
    expect(validateDraft(draft, overrides, none)).toEqual({
      ok: false,
      errors: { "download.concurrency": "Enter a value." },
    });
  });

  it("checks min, max and whole numbers", () => {
    const draft = draftOf(
      {},
      {
        "download.concurrency": 17,
        "eval.interval_minutes": 0,
        "ingest.channel_newest_n": 2.5,
        "download.sleep_requests_max_s": 2.5,
      },
    );
    const result = validateDraft(draft, {}, none);
    expect(result).toEqual({
      ok: false,
      errors: {
        "download.concurrency": "Must be at most 16.",
        "eval.interval_minutes": "Must be at least 1.",
        "ingest.channel_newest_n": "Must be a whole number.",
      },
    });
  });

  it("asks for a number or the switch on the nullable rate limit", () => {
    const draft = draftOf({}, { "download.rate_limit_bytes_per_s": Number.NaN });
    const result = validateDraft(draft, {}, none);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors["download.rate_limit_bytes_per_s"]).toBe(
        "Enter a value, or switch No limit back on.",
      );
    }
  });

  it("applies the shared cross-key invariants", () => {
    const draft = draftOf({}, { "reaper.low_water_pct": 96 });
    const result = validateDraft(draft, {}, none);
    expect(result).toEqual({
      ok: false,
      errors: { "reaper.low_water_pct": "Must be lower than the start-reaping threshold" },
    });
  });

  it("applies the shared zod schemas", () => {
    const draft = draftOf(
      {},
      { "tools.pot_provider_url": "ftp://nope", "thumbnails.variants": [] },
    );
    const result = validateDraft(draft, {}, none);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors["tools.pot_provider_url"]).toBe(
        "Must be an http(s) URL, or empty to disable",
      );
      expect(result.errors["thumbnails.variants"]).toBeDefined();
    }
  });

  it("skips field checks for reset keys", () => {
    const overrides = { "download.concurrency": 4 };
    const cleared = new Set<SettingKey>(["download.concurrency"]);
    expect(validateDraft(draftOf(overrides), overrides, cleared)).toEqual({
      ok: true,
      patch: { "download.concurrency": null },
    });
  });
});

describe("serverFieldErrors", () => {
  it("reads errors from details.errors or details itself, known keys only", () => {
    expect(serverFieldErrors(null)).toEqual({});
    expect(
      serverFieldErrors({ errors: { "download.concurrency": "Too high", nope: "x" } }),
    ).toEqual({ "download.concurrency": "Too high" });
    expect(serverFieldErrors({ "eval.interval_minutes": "Bad", other: 3 })).toEqual({
      "eval.interval_minutes": "Bad",
    });
  });
});

describe("formatSettingValue", () => {
  it("renders each kind of default", () => {
    expect(formatSettingValue("download.concurrency", 2)).toBe("2 downloads");
    expect(formatSettingValue("download.rate_limit_bytes_per_s", null)).toBe("No limit");
    expect(formatSettingValue("recheck.ryd_enabled", true)).toBe("on");
    expect(formatSettingValue("recheck.ryd_enabled", false)).toBe("off");
    expect(formatSettingValue("thumbnails.variants", ["a", "b"])).toBe("a, b");
    expect(formatSettingValue("tools.pot_provider_url", "")).toBe("empty");
    expect(formatSettingValue("tools.js_runtime", "node")).toBe("node");
    expect(formatSettingValue("tools.js_runtime", undefined)).toBe("none");
  });
});
