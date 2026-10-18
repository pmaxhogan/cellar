import { describe, expect, it } from "vitest";
import {
  addDuration,
  durationParts,
  instantMs,
  parseIsoDuration,
  RuleDurationSchema,
  RuleInstantSchema,
} from "../../src/index.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;

describe("parseIsoDuration", () => {
  it.each([
    ["P14D", { months: 0, ms: 14 * DAY }],
    ["P2M", { months: 2, ms: 0 }],
    ["P2Y", { months: 24, ms: 0 }],
    ["P7D", { months: 0, ms: 7 * DAY }],
    ["P2W", { months: 0, ms: 14 * DAY }],
    ["PT1H", { months: 0, ms: HOUR }],
    ["PT2M", { months: 0, ms: 120_000 }],
    ["PT30S", { months: 0, ms: 30_000 }],
    ["P1Y2M3DT4H5M6S", { months: 14, ms: 3 * DAY + 4 * HOUR + 5 * 60_000 + 6000 }],
  ])("parses %s", (text, expected) => {
    expect(parseIsoDuration(text)).toEqual(expected);
  });

  it.each(["", "P", "PT", "P1DT", "14D", "P1.5D", "P-1D", "p14d", "P999999D", "P1H"])(
    "rejects %s",
    (text) => {
      expect(parseIsoDuration(text)).toBeNull();
    },
  );
});

describe("durationParts", () => {
  it("normalises the object form", () => {
    expect(durationParts({ years: 2 })).toEqual({ months: 24, ms: 0 });
    expect(durationParts({ months: 2, days: 1, hours: 3 })).toEqual({
      months: 2,
      ms: DAY + 3 * HOUR,
    });
  });

  it("throws on an unvalidated bad string", () => {
    expect(() => durationParts("nope")).toThrow(/invalid ISO-8601 duration/);
  });
});

describe("addDuration", () => {
  it("adds fixed days and hours exactly", () => {
    const t = Date.UTC(2026, 2, 1, 6);
    expect(addDuration(t, { days: 14 })).toBe(t + 14 * DAY);
    expect(addDuration(t, { hours: 5 })).toBe(t + 5 * HOUR);
    expect(addDuration(t, "P1DT1H", -1)).toBe(t - DAY - HOUR);
  });

  it("adds calendar months and years", () => {
    expect(addDuration(Date.UTC(2026, 7, 18, 12), { months: 2 })).toBe(Date.UTC(2026, 9, 18, 12));
    expect(addDuration(Date.UTC(2024, 9, 18), { years: 2 })).toBe(Date.UTC(2026, 9, 18));
    expect(addDuration(Date.UTC(2026, 9, 18), "P2M", -1)).toBe(Date.UTC(2026, 7, 18));
  });

  it("clamps to the end of a shorter month", () => {
    expect(addDuration(Date.UTC(2026, 0, 31, 9), { months: 1 })).toBe(Date.UTC(2026, 1, 28, 9));
    expect(addDuration(Date.UTC(2024, 0, 31), { months: 1 })).toBe(Date.UTC(2024, 1, 29));
    expect(addDuration(Date.UTC(2024, 1, 29), { years: 1 })).toBe(Date.UTC(2025, 1, 28));
    expect(addDuration(Date.UTC(2026, 2, 31), { months: 1 }, -1)).toBe(Date.UTC(2026, 1, 28));
  });

  it("crosses year boundaries in both directions", () => {
    expect(addDuration(Date.UTC(2026, 10, 15), { months: 3 })).toBe(Date.UTC(2027, 1, 15));
    expect(addDuration(Date.UTC(2026, 1, 15), { months: 3 }, -1)).toBe(Date.UTC(2025, 10, 15));
  });

  it("handles instants before 1970", () => {
    const t = Date.UTC(1969, 11, 31, 23, 30);
    expect(addDuration(t, { months: 1 })).toBe(Date.UTC(1970, 0, 31, 23, 30));
  });

  it("applies months before the fixed part", () => {
    expect(addDuration(Date.UTC(2026, 0, 31), "P1M1D")).toBe(Date.UTC(2026, 2, 1));
  });

  it("accepts pre-normalised parts", () => {
    expect(addDuration(0, { months: 0, ms: 5 })).toBe(5);
  });
});

describe("RuleDurationSchema", () => {
  it("accepts ISO strings and objects", () => {
    expect(RuleDurationSchema.parse("P14D")).toBe("P14D");
    expect(RuleDurationSchema.parse({ months: 2 })).toEqual({ months: 2 });
  });

  it.each([{}, { weeks: 1 }, { days: -1 }, { days: 1.5 }, "P", "14 days", 14])(
    "rejects %j",
    (value) => {
      expect(RuleDurationSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe("RuleInstantSchema", () => {
  it("accepts epoch ms and ISO datetimes with Z or an offset", () => {
    expect(instantMs(RuleInstantSchema.parse(1_700_000_000_000))).toBe(1_700_000_000_000);
    expect(instantMs(RuleInstantSchema.parse("2026-01-01T00:00:00Z"))).toBe(Date.UTC(2026, 0, 1));
    expect(instantMs(RuleInstantSchema.parse("2026-01-01T06:00:00+06:00"))).toBe(
      Date.UTC(2026, 0, 1),
    );
  });

  it.each(["2026-01-01", "yesterday", 1.5, "2026-01-01T00:00:00"])("rejects %j", (value) => {
    expect(RuleInstantSchema.safeParse(value).success).toBe(false);
  });
});
