import { describe, expect, it } from "vitest";
import { getHourlyStats, RANGE_HOURLY, RANGE_OPTIONS } from "../../src/api/stats.ts";
import { chartTheme, seriesColor } from "../../src/components/charts/chartTheme.ts";
import {
  HOUR_AXIS_TITLE,
  hourLabel,
  hourlyBarChart,
  hourlyJobsChart,
} from "../../src/components/charts/hourlySeries.ts";
import { fakeServer, json } from "../helpers/fakeServer.ts";
import { makeHourly } from "./fixtures.ts";

const dark = chartTheme(true);

describe("hourLabel", () => {
  const at = Date.UTC(2026, 9, 18, 15);

  it("labels a UTC bucket in the given time zone", () => {
    expect(hourLabel(at, "UTC")).toBe("3 PM");
    expect(hourLabel(at, "America/Chicago")).toBe("10 AM");
    // A half-hour zone shows the local hour the bucket starts in.
    expect(hourLabel(at, "Asia/Kolkata")).toBe("8 PM");
  });

  it("defaults to the browser's zone", () => {
    expect(hourLabel(at)).toBe(new Date(at).toLocaleTimeString("en-US", { hour: "numeric" }));
  });
});

describe("range options", () => {
  it("offers 24 hours first, as a peer of the day ranges", () => {
    expect(RANGE_OPTIONS.map((option) => option.label)).toEqual([
      "24 hours",
      "30 days",
      "90 days",
      "365 days",
    ]);
    expect(RANGE_OPTIONS[0]?.value).toBe(RANGE_HOURLY);
  });
});

describe("hourly charts", () => {
  it("draws one bar per hour, zeros included, on an hour axis", () => {
    const response = makeHourly();
    const chart = hourlyBarChart(
      response,
      { label: "Downloads", yTitle: "Downloads", pick: (point) => point.downloads },
      dark,
    );
    expect(chart.type).toBe("bar");
    expect(chart.data.labels).toHaveLength(24);
    expect(chart.data.labels?.[0]).toBe(hourLabel(response.from));
    const data = chart.data.datasets[0]?.data ?? [];
    expect(data).toHaveLength(24);
    expect(data[0]).toBe(2);
    expect(data[1]).toBe(0);
    expect(data[23]).toBe(1);
    const scales = chart.options.scales as { x: { title: { text: string } } };
    expect(scales.x.title.text).toBe(HOUR_AXIS_TITLE);
    expect(chart.options.plugins?.legend?.display).toBe(false);
  });

  it("formats a bytes measure on the y axis", () => {
    const chart = hourlyBarChart(
      makeHourly(),
      {
        label: "Bytes",
        yTitle: "Bytes",
        format: "bytes",
        pick: (point) => point.download_bytes,
      },
      dark,
    );
    const y = (chart.options.scales as { y: { ticks: { callback: (v: number) => string } } }).y;
    expect(y.ticks.callback(2048)).toMatch(/KB|KiB/);
  });

  it("stacks done and failed jobs in their own colors", () => {
    const chart = hourlyJobsChart(makeHourly(), dark);
    expect(chart.data.datasets.map((dataset) => [dataset.label, dataset.data[0]])).toEqual([
      ["Done", 3],
      ["Failed", 1],
    ]);
    expect(chart.data.datasets[0]?.backgroundColor).toBe(seriesColor(dark, 2));
    expect(chart.data.datasets[1]?.backgroundColor).toBe(seriesColor(dark, 7));
    const scales = chart.options.scales as { x: { stacked: boolean }; y: { stacked: boolean } };
    expect(scales.x.stacked).toBe(true);
    expect(scales.y.stacked).toBe(true);
    expect(chart.options.plugins?.legend?.display).toBe(true);
  });
});

describe("getHourlyStats", () => {
  it("asks for 24 hours and drops the location for all locations", async () => {
    const fake = fakeServer().on("GET", "/api/stats/hourly", () => json(makeHourly()));
    await getHourlyStats(fake.api, { location: "all" });
    await getHourlyStats(fake.api, { location: 2, hours: 6 });
    const [all, one] = fake.callsTo("GET", "/api/stats/hourly");
    expect(all?.query.get("hours")).toBe("24");
    expect(all?.query.has("location_id")).toBe(false);
    expect(one?.query.get("hours")).toBe("6");
    expect(one?.query.get("location_id")).toBe("2");
  });
});
