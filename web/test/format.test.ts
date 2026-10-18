import { describe, expect, it } from "vitest";
import {
  formatAbsolute,
  formatBytes,
  formatDuration,
  formatNumber,
  formatRelative,
  pluralize,
} from "../src/lib/format.ts";

describe("formatBytes", () => {
  it("renders 1024-based units with sensible precision", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.00 KB");
    expect(formatBytes(1536)).toBe("1.50 KB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10.0 MB");
    expect(formatBytes(150 * 1024 ** 3)).toBe("150 GB");
    expect(formatBytes(2 * 1024 ** 4)).toBe("2.00 TB");
  });

  it("caps at PB", () => {
    expect(formatBytes(2048 * 1024 ** 5)).toBe("2048 PB");
  });

  it("renders a dash for missing, negative and non-finite input", () => {
    for (const value of [null, undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatBytes(value)).toBe("-");
    }
  });
});

describe("formatDuration", () => {
  it("renders m:ss under an hour and h:mm:ss above", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(42)).toBe("0:42");
    expect(formatDuration(245)).toBe("4:05");
    expect(formatDuration(3600)).toBe("1:00:00");
    expect(formatDuration(3723)).toBe("1:02:03");
    expect(formatDuration(36_000 + 59)).toBe("10:00:59");
  });

  it("floors fractional seconds", () => {
    expect(formatDuration(59.9)).toBe("0:59");
  });

  it("renders a dash for missing, negative and non-finite input", () => {
    for (const value of [null, undefined, -5, Number.NaN]) {
      expect(formatDuration(value)).toBe("-");
    }
  });
});

describe("formatRelative", () => {
  const now = 1_700_000_000_000;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  it("says just now within 45 seconds either way", () => {
    expect(formatRelative(now, now)).toBe("just now");
    expect(formatRelative(now - 44_000, now)).toBe("just now");
    expect(formatRelative(now + 44_000, now)).toBe("just now");
  });

  it("walks up the units in the past", () => {
    expect(formatRelative(now - 50_000, now)).toBe("1 min ago");
    expect(formatRelative(now - 5 * minute, now)).toBe("5 min ago");
    expect(formatRelative(now - 3 * hour, now)).toBe("3 h ago");
    expect(formatRelative(now - 2 * day, now)).toBe("2 d ago");
    expect(formatRelative(now - 60 * day, now)).toBe("2 mo ago");
    expect(formatRelative(now - 3 * 365 * day, now)).toBe("3 y ago");
  });

  it("speaks of the future with in", () => {
    expect(formatRelative(now + 2 * hour, now)).toBe("in 2 h");
  });

  it("says never for missing input and defaults now to the clock", () => {
    expect(formatRelative(null)).toBe("never");
    expect(formatRelative(undefined)).toBe("never");
    expect(formatRelative(Number.NaN)).toBe("never");
    expect(formatRelative(Date.now())).toBe("just now");
  });
});

describe("formatAbsolute", () => {
  it("renders a locale timestamp, or never", () => {
    expect(formatAbsolute(1_700_000_000_000)).toBe(new Date(1_700_000_000_000).toLocaleString());
    expect(formatAbsolute(null)).toBe("never");
  });
});

describe("formatNumber and pluralize", () => {
  it("groups thousands in en-US regardless of locale", () => {
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(1234567)).toBe("1,234,567");
    expect(formatNumber(1234.567)).toBe("1,234.57");
    expect(formatNumber(-9876)).toBe("-9,876");
    expect(formatNumber(null)).toBe("-");
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe("-");
  });

  it("pluralizes with a formatted count", () => {
    expect(pluralize(1, "video")).toBe("1 video");
    expect(pluralize(0, "video")).toBe("0 videos");
    expect(pluralize(1200, "entry", "entries")).toBe("1,200 entries");
  });
});
