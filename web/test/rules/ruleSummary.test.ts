import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, EFFECT_KEYS, effectDefaults } from "@cellar/shared";
import {
  channelIdsIn,
  effectChips,
  formatEffectValue,
  formatInstant,
  formatRuleDuration,
  formatSeconds,
  humanize,
  summarizeCondition,
  summarizeLeaf,
} from "../../src/lib/ruleSummary.ts";

const leaf = (field: string, op: string, value: unknown, extra: Record<string, unknown> = {}) => ({
  type: "cond",
  field,
  op,
  value,
  ...extra,
});

describe("formatRuleDuration", () => {
  it("renders ISO strings with every unit", () => {
    expect(formatRuleDuration("P14D")).toBe("14 days");
    expect(formatRuleDuration("P2M")).toBe("2 months");
    expect(formatRuleDuration("P1Y")).toBe("1 year");
    expect(formatRuleDuration("P2W")).toBe("2 weeks");
    expect(formatRuleDuration("P1Y2M3DT4H5M6S")).toBe(
      "1 year 2 months 3 days 4 hours 5 minutes 6 seconds",
    );
    expect(formatRuleDuration("PT1M")).toBe("1 minute");
  });

  it("renders the object form", () => {
    expect(formatRuleDuration({ months: 2 })).toBe("2 months");
    expect(formatRuleDuration({ years: 1, days: 1, hours: 3 })).toBe("1 year 1 day 3 hours");
    expect(formatRuleDuration({})).toBe("0 days");
  });

  it("passes unreadable input through", () => {
    expect(formatRuleDuration("soon")).toBe("soon");
    expect(formatRuleDuration(5)).toBe("5");
  });
});

describe("formatSeconds and formatInstant", () => {
  it("formats seconds compactly", () => {
    expect(formatSeconds(0)).toBe("0s");
    expect(formatSeconds(45)).toBe("45s");
    expect(formatSeconds(600)).toBe("10m");
    expect(formatSeconds(5400)).toBe("1h 30m");
    expect(formatSeconds(3723)).toBe("1h 2m 3s");
    expect(formatSeconds("x")).toBe("x");
  });

  it("formats instants in UTC, dropping a midnight time", () => {
    expect(formatInstant("2026-01-31T00:00:00.000Z")).toBe("2026-01-31");
    expect(formatInstant("2026-01-31T14:05:00Z")).toBe("2026-01-31 14:05 UTC");
    expect(formatInstant(Date.UTC(2025, 5, 1, 9, 30))).toBe("2025-06-01 09:30 UTC");
    expect(formatInstant("nope")).toBe("nope");
  });

  it("humanizes identifiers", () => {
    expect(humanize("watch_later")).toBe("watch later");
  });
});

describe("summarizeCondition", () => {
  it("summarizes the shipped default rules", () => {
    const [global, subs, watched, liked, guard, captions, keep, notify] = DEFAULT_RULES;
    expect(summarizeCondition(global!.condition)).toBe("all videos");
    expect(summarizeCondition(subs!.condition)).toBe(
      "Source has only subscription, channel AND (First seen (subscription) older than 14 days OR First seen (channel) older than 14 days)",
    );
    expect(summarizeCondition(watched!.condition)).toContain(
      "Source has none of liked, watch later AND Source has any of history",
    );
    expect(summarizeCondition(liked!.condition)).toContain("older than 2 years");
    expect(summarizeCondition(guard!.condition)).toContain(
      "Upload date before install minus 7 days",
    );
    expect(summarizeCondition(captions!.condition)).toBe("all videos");
    expect(summarizeCondition(keep!.condition)).toBe("Status is any of unlisted, gone");
    expect(summarizeCondition(notify!.condition)).toBe("Status is gone");
  });

  it("handles empty groups, NOT and single children", () => {
    expect(summarizeCondition({ type: "group", op: "or", children: [] })).toBe("no videos");
    expect(summarizeCondition({ type: "group", op: "and", not: true, children: [] })).toBe(
      "NOT all videos",
    );
    const one = { type: "group", op: "and", children: [leaf("is_hdr", "eq", true)] };
    expect(summarizeCondition(one)).toBe("HDR is yes");
    const notOr = {
      type: "group",
      op: "or",
      not: true,
      children: [leaf("downloaded", "eq", false), leaf("views", "gt", 10)],
    };
    expect(summarizeCondition(notOr)).toBe("NOT (Downloaded is no OR Views > 10)");
    expect(summarizeCondition(undefined)).toBe("all videos");
    expect(summarizeCondition("junk")).toBe("(invalid)");
  });

  it("renders every value kind", () => {
    const labels = {
      accounts: new Map([[3, "Main account"]]),
      locations: new Map([[2, "Big disk"]]),
      channels: new Map([["UCxxxxxxxxxxxxxxxxxxxxxx", "Some channel"]]),
    };
    const cases: [Record<string, unknown>, string][] = [
      [leaf("account", "eq", 3), "Account is Main account"],
      [leaf("account", "in", [3, 9]), "Account is any of Main account, #9"],
      [leaf("account", "eq", null), "Account is (none)"],
      [leaf("channel", "eq", "UCxxxxxxxxxxxxxxxxxxxxxx"), "Channel is Some channel"],
      [leaf("channel", "in", ["UCother"]), "Channel is any of UCother"],
      [leaf("channel", "eq", ""), "Channel is (none)"],
      [leaf("current_location", "eq", 2), "Current location is Big disk"],
      [leaf("type", "eq", "short"), "Type is short"],
      [leaf("type", "in", []), "Type is any of (none)"],
      [leaf("duration_s", "lt", 90), "Duration (seconds) < 1m 30s"],
      [leaf("duration_s", "between", [60, 3600]), "Duration (seconds) between 1m and 1h"],
      [leaf("views", "between", [1, 2]), "Views between 1 and 2"],
      [leaf("views", "between", "bad"), "Views between bad"],
      [leaf("title", "contains", "live", { ci: true }), 'Title contains "live" (any case)'],
      [leaf("tags", "regex", "^a+$"), "Tags matches regex /^a+$/"],
      [leaf("last_seen", "age_lt", { days: 3 }), "Last seen newer than 3 days"],
      [leaf("now", "after", "2026-02-01T00:00:00Z"), "Now after 2026-02-01"],
      [leaf("downloaded_at", "is_null", true), "Downloaded at is empty"],
      [leaf("downloaded_at", "is_null", false), "Downloaded at is set"],
      [leaf("first_seen", "age_gt", "P1D"), "First seen (any source) older than 1 day"],
      [
        leaf("first_seen", "age_gt", "P1D", { source: "watch_later" }),
        "First seen (watch later) older than 1 day",
      ],
      [leaf("is_hdr", "eq", "maybe"), "HDR is maybe"],
      [leaf("mystery", "eq", 1), "mystery eq"],
      [leaf("views", "nope", 1), "Views nope 1"],
    ];
    for (const [node, text] of cases) expect(summarizeLeaf(node, labels)).toBe(text);
  });
});

describe("effectChips and formatEffectValue", () => {
  it("renders a chip for every registry default", () => {
    const chips = effectChips(effectDefaults());
    expect(chips.map((chip) => chip.key)).toEqual(EFFECT_KEYS);
    const text = Object.fromEntries(chips.map((chip) => [chip.key, chip.text]));
    expect(text).toMatchObject({
      include: "yes",
      reclaim_priority: "never delete",
      location_id: "First enabled location",
      media_mode: "video",
      format_policy: "prefer av1",
      max_height: "No limit",
      quality_priority: "Codec first (format policy decides)",
      transcode: "hevc nvenc, q28, p5, if not AV1",
      captions: "all languages, auto",
      ytdlp: "global settings",
      download_accounts: "sourcing accounts",
      proxy: "no proxy",
      delay_after_upload: "No delay",
      recheck_interval: "tiered by age",
      live: "vod only",
      notify: "off",
    });
  });

  it("formats the set values a rule would carry", () => {
    const labels = {
      locations: new Map([[1, "NAS"]]),
      accounts: new Map([[4, "Alt"]]),
      proxies: new Map([[2, "Home"]]),
    };
    expect(formatEffectValue("include", false)).toBe("no (excluded)");
    expect(formatEffectValue("reclaim_priority", 0)).toBe("delete now");
    expect(formatEffectValue("reclaim_priority", 3)).toBe("reap order 3");
    expect(formatEffectValue("location_id", 1, labels)).toBe("NAS");
    expect(formatEffectValue("location_id", 9, labels)).toBe("#9");
    expect(formatEffectValue("max_height", 1080)).toBe("1080p");
    expect(formatEffectValue("max_fps", 30)).toBe("30 fps");
    const ranked = {
      primary: "resolution",
      resolutions: [1080, 1440, 720, 2160, 480, 360, 240, 144, 4320],
      fps: [60, 30, 50, 48, 25, 24],
    };
    expect(formatEffectValue("quality_priority", ranked)).toBe(
      "1080p, 1440p, 720p...; 60, 30, 50 fps...",
    );
    expect(
      formatEffectValue("quality_priority", { primary: "fps", resolutions: [720], fps: [30] }),
    ).toBe("30 fps; 720p");
    expect(formatEffectValue("quality_priority", "odd")).toBe("odd");
    expect(formatEffectValue("transcode", { mode: "none" })).toBe("off");
    expect(
      formatEffectValue("transcode", { mode: "if_not_av1", max_height: 720, max_fps: 30 }),
    ).toBe("hevc nvenc, q28, max 720p, max 30 fps, if not AV1");
    expect(formatEffectValue("transcode", { mode: "always", codec: "av1_svt", quality: 30 })).toBe(
      "av1 svt, q30, always",
    );
    expect(formatEffectValue("captions", { enabled: false })).toBe("off");
    expect(
      formatEffectValue("captions", {
        enabled: true,
        languages: ["en", "de"],
        auto_generated: false,
      }),
    ).toBe("en, de, manual only");
    expect(
      formatEffectValue("ytdlp", {
        format_override: "bv*+ba",
        rate_limit_bytes_per_s: 1048576,
        sleep_requests_min: 1,
        concurrent_fragments: 4,
        extra_args_allowlisted: ["--no-mtime"],
      }),
    ).toBe("format bv*+ba, 1.00 MB/s, sleep 1-?s, 4 fragments, 1 extra arg");
    expect(formatEffectValue("download_accounts", "any")).toBe("any account");
    expect(formatEffectValue("download_accounts", [4, 5], labels)).toBe("Alt, #5");
    expect(formatEffectValue("proxy", "pool")).toBe("proxy pool");
    expect(formatEffectValue("proxy", [2], labels)).toBe("Home");
    expect(formatEffectValue("delay_after_upload", { hours: 6 })).toBe("6 hours");
    expect(formatEffectValue("recheck_interval", "P7D")).toBe("every 7 days");
    expect(formatEffectValue("notify", { enabled: true, max_times: null })).toBe("unlimited");
    expect(formatEffectValue("notify", { enabled: true, max_times: 1 })).toBe("once");
    expect(formatEffectValue("notify", { enabled: true, max_times: 5 })).toBe("up to 5 times");
    expect(formatEffectValue("live", "record_live")).toBe("record live");
    expect(formatEffectValue("bogus", { a: 1 })).toBe('{"a":1}');
    expect(formatEffectValue("captions", "weird")).toBe("weird");
    expect(formatEffectValue("include", "x")).toBe("x");
  });

  it("skips unset and unknown keys and tolerates non-objects", () => {
    expect(effectChips({ reclaim_priority: 0, nonsense: 1 })).toEqual([
      { key: "reclaim_priority", label: "Reclaim priority", text: "delete now" },
    ]);
    expect(effectChips(null)).toEqual([]);
  });
});

describe("channelIdsIn", () => {
  it("collects channel ids from nested leaves", () => {
    const node = {
      type: "group",
      op: "or",
      children: [
        leaf("channel", "eq", "UCa"),
        { type: "group", op: "and", children: [leaf("channel", "in", ["UCb", "UCa", ""])] },
        leaf("title", "eq", "UCz"),
      ],
    };
    expect([...channelIdsIn(node)]).toEqual(["UCa", "UCb"]);
    expect(channelIdsIn(null).size).toBe(0);
  });
});

describe("summary fallbacks", () => {
  it("renders partial and malformed values without throwing", () => {
    expect(summarizeLeaf({ type: "cond", field: "views", op: "nope" })).toBe("Views nope");
    expect(summarizeCondition({ type: "group", op: "and", children: "x" })).toBe("all videos");
    expect(formatEffectValue("proxy", "weird_mode")).toBe("weird mode");
    expect(formatEffectValue("transcode", { mode: "always" })).toBe("hevc nvenc, q28, always");
    expect(formatEffectValue("ytdlp", { sleep_requests_max: 3 })).toBe("sleep ?-3s");
    expect(formatEffectValue("notify", { enabled: true, max_times: "x" })).toBe("once");
    expect(formatEffectValue("reclaim_priority", null)).toBe("none");
    expect(formatEffectValue("transcode", "x")).toBe("x");
    expect(formatEffectValue("ytdlp", "x")).toBe("x");
    expect(formatEffectValue("notify", "x")).toBe("x");
    expect(formatEffectValue("media_mode", "odd_mode")).toBe("odd mode");
  });
});
