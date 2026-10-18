import { describe, expect, it } from "vitest";
import type { TooltipItem } from "chart.js";
import { dayRange, getDailyStats, rangeWindow, utcDay } from "../../src/api/stats.ts";
import {
  chartTheme,
  seriesColor,
  SERIES_SLOTS,
  withAlpha,
} from "../../src/components/charts/chartTheme.ts";
import {
  apiUnitsChart,
  compactNumber,
  formatValue,
  hasPoints,
  lineChart,
  measureLocation,
  shortDay,
  storageChart,
  type ChartKind,
} from "../../src/components/charts/series.ts";
import { fakeServer, json } from "../helpers/fakeServer.ts";
import { makeDaily, point } from "./fixtures.ts";

const dark = chartTheme(true);
const light = chartTheme(false);

describe("day helpers", () => {
  it("builds inclusive UTC windows and day lists", () => {
    const now = Date.UTC(2026, 9, 18, 23, 30);
    expect(utcDay(now)).toBe("2026-10-18");
    expect(rangeWindow(30, now)).toEqual({ from: "2026-09-19", to: "2026-10-18" });
    expect(rangeWindow(1, now)).toEqual({ from: "2026-10-18", to: "2026-10-18" });
    expect(dayRange("2026-12-30", "2027-01-02")).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
    ]);
    expect(dayRange("2026-10-02", "2026-10-01")).toEqual([]);
  });

  it("sends the window and location to the daily endpoint", async () => {
    const fake = fakeServer().on("GET", "/api/stats/daily", () => json(makeDaily()));
    await getDailyStats(fake.api, { from: "2026-10-01", to: "2026-10-18", location: 3 });
    const query = fake.calls[0]!.query;
    expect([query.get("from"), query.get("to"), query.get("location_id")]).toEqual([
      "2026-10-01",
      "2026-10-18",
      "3",
    ]);
  });

  it("formats axis and tooltip values", () => {
    expect(compactNumber(0)).toBe("0");
    expect(compactNumber(1200)).toBe("1.2K");
    expect(formatValue(null, "count")).toBe("no data");
    expect(formatValue(2048, "bytes")).toBe("2.00 KB");
    expect(formatValue(12_345, "count")).toBe("12,345");
    expect(shortDay("2026-01-05")).toBe("Jan 5");
    expect(measureLocation("all")).toBe(0);
    expect(measureLocation(4)).toBe(4);
    expect(hasPoints(null)).toBe(false);
    expect(hasPoints(makeDaily({ points: [] }))).toBe(false);
  });
});

describe("theme", () => {
  it("selects separate steps per scheme from the preset", () => {
    expect(dark.accent).toBe("#e2738e");
    expect(light.accent).toBe("#8e2643");
    expect(dark.series).not.toEqual(light.series);
    expect(dark.accentWash).toBe("#e2738e1a");
    expect(withAlpha("#000000", 2)).toBe("#000000ff");
    expect(withAlpha("#000000", -1)).toBe("#00000000");
  });

  it("assigns slots in order and clamps past the last one", () => {
    expect(seriesColor(light, 0)).toBe("#2a78d6");
    expect(seriesColor(light, -3)).toBe("#2a78d6");
    expect(seriesColor(light, 40)).toBe(light.series[SERIES_SLOTS - 1]);
  });
});

describe("storage chart", () => {
  it("draws the all-locations row alone when no location has rows", () => {
    const response = makeDaily({ points: makeDaily().points.filter((p) => p.location_id === 0) });
    const chart = storageChart(response, "all", dark);
    expect(chart.data.datasets.map((dataset) => [dataset.label, dataset.data])).toEqual([
      ["All locations", [300, null, 900]],
    ]);
    // A single series gets an area wash and no legend box.
    expect((chart.data.datasets[0] as { fill?: unknown }).fill).toBe("origin");
    expect(chart.options.plugins?.legend?.display).toBe(false);
  });

  it("folds locations past the last slot into Other", () => {
    const locations = Array.from({ length: SERIES_SLOTS + 2 }, (_, index) => ({
      id: index + 1,
      label: `loc${String(index + 1)}`,
    }));
    const points = locations.map((location) =>
      point("2026-10-18", location.id, { bytes_used: location.id }),
    );
    const chart = storageChart(
      { from: "2026-10-18", to: "2026-10-18", points, locations },
      "all",
      light,
    );
    const labels = chart.data.datasets.map((dataset) => dataset.label);
    expect(labels).toHaveLength(SERIES_SLOTS);
    expect(labels.at(-1)).toBe("Other");
    // Locations 8, 9 and 10 fold together.
    expect(chart.data.datasets.at(-1)?.data).toEqual([8 + 9 + 10]);
    expect(chart.options.plugins?.legend?.display).toBe(true);
  });

  it("formats byte ticks and tooltips", () => {
    const chart = storageChart(makeDaily(), "all", dark);
    const y = chart.options.scales?.y as {
      ticks: { callback: (value: number | string) => string };
    };
    expect(y.ticks.callback(1024)).toBe("1.00 KB");
    const label = chart.options.plugins?.tooltip?.callbacks?.label as (
      item: TooltipItem<ChartKind>,
    ) => string;
    expect(label({ dataset: { label: "media" }, raw: 2048 } as TooltipItem<ChartKind>)).toBe(
      "media: 2.00 KB",
    );
    expect(label({ dataset: {}, raw: null } as unknown as TooltipItem<ChartKind>)).toBe(
      ": no data",
    );
  });
});

describe("count charts", () => {
  it("uses compact count ticks", () => {
    const chart = lineChart(
      makeDaily(),
      0,
      { label: "Videos", yTitle: "Videos", pick: (p) => p.catalog },
      light,
    );
    const y = chart.options.scales?.y as {
      ticks: { callback: (value: number | string) => string };
    };
    expect(y.ticks.callback(2500)).toBe("2.5K");
  });

  it("omits the budget line without a budget", () => {
    expect(apiUnitsChart(makeDaily(), null, dark).data.datasets).toHaveLength(1);
    expect(apiUnitsChart(makeDaily(), 0, dark).data.datasets).toHaveLength(1);
    const withBudget = apiUnitsChart(makeDaily(), 500, dark);
    expect(withBudget.data.datasets).toHaveLength(2);
    expect(withBudget.options.plugins?.legend?.display).toBe(true);
  });
});
