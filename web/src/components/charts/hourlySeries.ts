import type { StatsHourlyPoint, StatsHourlyResponse } from "@cellar/shared";
import type { ChartTheme } from "./chartTheme.ts";
import { seriesColor } from "./chartTheme.ts";
import { barDataset, baseOptions, type ChartConfig, type ValueFormat } from "./series.ts";

/**
 * Builders from a /api/stats/hourly response to chart configs. Buckets are
 * UTC hours on the wire and labelled in the browser's local time; every hour
 * is present (zero-filled by the server), so a zero is a real zero, not a gap.
 */

export const HOUR_AXIS_TITLE = "Hour (local time)";

/** Categorical slots for the done / failed job split (green, red). */
const DONE_SLOT = 2;
const FAILED_SLOT = 7;

/** Epoch ms -> `3 PM`, in the browser's time zone unless one is given. */
export function hourLabel(at: number, timeZone?: string): string {
  return new Date(at).toLocaleTimeString("en-US", {
    hour: "numeric",
    ...(timeZone === undefined ? {} : { timeZone }),
  });
}

/** One measure per hour as bars (downloads, bytes, videos added, ...). */
export function hourlyBarChart(
  response: StatsHourlyResponse,
  input: {
    label: string;
    yTitle: string;
    format?: ValueFormat;
    pick: (point: StatsHourlyPoint) => number;
  },
  theme: ChartTheme,
): ChartConfig {
  return {
    type: "bar",
    data: {
      labels: response.points.map((point) => hourLabel(point.hour)),
      datasets: [barDataset(input.label, response.points.map(input.pick), theme)],
    },
    options: baseOptions(theme, {
      format: input.format ?? "count",
      yTitle: input.yTitle,
      legend: false,
      xTitle: HOUR_AXIS_TITLE,
    }),
  };
}

/** Jobs finished per hour, done and failed stacked, with a legend. */
export function hourlyJobsChart(response: StatsHourlyResponse, theme: ChartTheme): ChartConfig {
  const options = baseOptions(theme, {
    format: "count",
    yTitle: "Jobs",
    legend: true,
    xTitle: HOUR_AXIS_TITLE,
  });
  const scales = options.scales ?? {};
  return {
    type: "bar",
    data: {
      labels: response.points.map((point) => hourLabel(point.hour)),
      datasets: [
        barDataset(
          "Done",
          response.points.map((point) => point.jobs_done),
          theme,
          seriesColor(theme, DONE_SLOT),
        ),
        barDataset(
          "Failed",
          response.points.map((point) => point.jobs_failed),
          theme,
          seriesColor(theme, FAILED_SLOT),
        ),
      ],
    },
    options: {
      ...options,
      scales: {
        ...scales,
        x: { ...scales.x, stacked: true },
        y: { ...scales.y, stacked: true },
      },
    },
  };
}
