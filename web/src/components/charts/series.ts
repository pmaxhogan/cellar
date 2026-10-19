import type { ChartData, ChartOptions, TooltipItem } from "chart.js";
import type { StatsDailyPoint, StatsDailyResponse } from "@cellar/shared";
import { dayRange, type LocationFilter } from "../../api/stats.ts";
import { formatBytes, formatNumber } from "../../lib/format.ts";
import { seriesColor, SERIES_SLOTS, withAlpha, type ChartTheme } from "./chartTheme.ts";

/**
 * Pure builders from a /api/stats/daily response to PrimeVue Chart (chart.js)
 * configs. Kept out of the components so tests can assert on the datasets.
 *
 * Mark specs (dataviz skill): 2px lines with no resting markers, bars capped
 * at 24px with a 4px rounded data end and a square baseline, a 2px surface gap
 * between bars, hairline solid gridlines, no dual axes. Days with no rollup
 * row are null, so a gap reads as "no data" rather than zero.
 */

export type ChartKind = "line" | "bar";
export type Series = (number | null)[];

export interface ChartConfig {
  type: ChartKind;
  data: ChartData<ChartKind, Series, string>;
  options: ChartOptions<ChartKind>;
}

export type ValueFormat = "bytes" | "count";

const ALL_LOCATIONS_ID = 0;
const MAX_X_TICKS = 8;
const MAX_Y_TICKS = 6;

const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** Axis ticks: 0 / 950 / 1.2K / 3M. */
export function compactNumber(value: number): string {
  return COMPACT.format(value);
}

export function formatValue(value: number | null, format: ValueFormat): string {
  if (value === null) return "no data";
  return format === "bytes" ? formatBytes(value) : formatNumber(value);
}

/** `2026-10-18` -> `Oct 18`, read in UTC like the rollup. */
export function shortDay(day: string): string {
  const at = new Date(`${day}T00:00:00Z`);
  return at.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function seriesFor(
  days: readonly string[],
  points: readonly StatsDailyPoint[],
  locationId: number,
  pick: (point: StatsDailyPoint) => number,
): Series {
  const byDay = new Map<string, StatsDailyPoint>();
  for (const point of points) {
    if (point.location_id === locationId) byDay.set(point.day, point);
  }
  return days.map((day) => {
    const point = byDay.get(day);
    return point === undefined ? null : pick(point);
  });
}

/** The location row a single-measure chart reads: the filter, or all locations. */
export function measureLocation(filter: LocationFilter): number {
  return filter === "all" ? ALL_LOCATIONS_ID : filter;
}

export function baseOptions(
  theme: ChartTheme,
  input: { format: ValueFormat; yTitle: string; legend: boolean; xTitle?: string },
): ChartOptions<ChartKind> {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: {
        display: input.legend,
        position: "top",
        align: "start",
        labels: { color: theme.muted, usePointStyle: true, boxWidth: 8, boxHeight: 8 },
      },
      tooltip: {
        backgroundColor: theme.tooltip,
        titleColor: theme.text,
        bodyColor: theme.text,
        borderColor: theme.grid,
        borderWidth: 1,
        usePointStyle: true,
        callbacks: {
          label: (item: TooltipItem<ChartKind>) =>
            `${item.dataset.label ?? ""}: ${formatValue(item.raw as number | null, input.format)}`,
        },
      },
    },
    scales: {
      x: {
        title: { display: true, text: input.xTitle ?? "Day (UTC)", color: theme.muted },
        grid: { display: false },
        border: { color: theme.axis },
        ticks: {
          color: theme.muted,
          maxTicksLimit: MAX_X_TICKS,
          maxRotation: 0,
          autoSkip: true,
        },
      },
      y: {
        beginAtZero: true,
        title: { display: true, text: input.yTitle, color: theme.muted },
        grid: { color: theme.grid, lineWidth: 1 },
        border: { display: false },
        ticks: {
          color: theme.muted,
          maxTicksLimit: MAX_Y_TICKS,
          precision: 0,
          callback: (value: number | string) =>
            input.format === "bytes" ? formatBytes(Number(value)) : compactNumber(Number(value)),
        },
      },
    },
  };
}

function lineDataset(
  label: string,
  data: Series,
  color: string,
  fill: string | false,
  theme: ChartTheme,
) {
  return {
    type: "line" as const,
    label,
    data,
    borderColor: color,
    backgroundColor: fill === false ? color : fill,
    fill: fill === false ? false : "origin",
    borderWidth: 2,
    borderJoinStyle: "round" as const,
    borderCapStyle: "round" as const,
    tension: 0,
    pointRadius: 0,
    pointHoverRadius: 4,
    // The 2px surface ring keeps the hover dot legible where lines cross.
    pointHoverBorderWidth: 2,
    pointHoverBorderColor: theme.surface,
    pointBackgroundColor: color,
    spanGaps: false,
  };
}

export function barDataset(
  label: string,
  data: Series,
  theme: ChartTheme,
  color: string = theme.accent,
) {
  return {
    type: "bar" as const,
    label,
    data,
    backgroundColor: color,
    hoverBackgroundColor: color,
    borderColor: theme.surface,
    borderWidth: { left: 1, right: 1, top: 0, bottom: 0 },
    borderRadius: { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 },
    borderSkipped: "start" as const,
    maxBarThickness: 24,
    categoryPercentage: 0.9,
    barPercentage: 0.9,
  };
}

export interface StorageSeries {
  id: number;
  label: string;
  color: string;
}

/**
 * Storage used per location. "all" draws one line per location that has rows
 * (colors by the location's position in the full list, so a filter never
 * repaints one); past the last slot locations fold into "Other". A specific
 * location draws just that line. With no per-location rows the all-locations
 * row is drawn alone.
 */
export function storageChart(
  response: StatsDailyResponse,
  filter: LocationFilter,
  theme: ChartTheme,
): ChartConfig {
  const days = dayRange(response.from, response.to);
  const present = new Set(response.points.map((point) => point.location_id));
  const order = response.locations.map((location) => location.id);
  const pick = (point: StatsDailyPoint): number => point.bytes_used;

  const lines: { label: string; data: Series; color: string }[] = [];
  const wanted =
    filter === "all"
      ? response.locations.filter((location) => present.has(location.id))
      : response.locations.filter((location) => location.id === filter);

  const other: Series = days.map(() => null);
  let folded = 0;
  for (const location of wanted) {
    const slot = order.indexOf(location.id);
    const data = seriesFor(days, response.points, location.id, pick);
    if (filter === "all" && slot >= SERIES_SLOTS - 1 && wanted.length > SERIES_SLOTS) {
      folded += 1;
      data.forEach((value, index) => {
        if (value !== null) other[index] = (other[index] ?? 0) + value;
      });
      continue;
    }
    lines.push({ label: location.label, data, color: seriesColor(theme, slot) });
  }
  if (folded > 0) {
    lines.push({ label: "Other", data: other, color: seriesColor(theme, SERIES_SLOTS - 1) });
  }
  if (lines.length === 0 && filter === "all") {
    lines.push({
      label: "All locations",
      data: seriesFor(days, response.points, ALL_LOCATIONS_ID, pick),
      color: theme.accent,
    });
  }

  const single = lines.length === 1;
  return {
    type: "line",
    data: {
      labels: days.map(shortDay),
      datasets: lines.map((line) =>
        lineDataset(
          line.label,
          line.data,
          line.color,
          single ? withAlpha(line.color, 0.1) : false,
          theme,
        ),
      ),
    },
    options: baseOptions(theme, { format: "bytes", yTitle: "Storage used", legend: !single }),
  };
}

/** One measure of one location row as a bar chart (downloads, API units). */
export function barChart(
  response: StatsDailyResponse,
  locationId: number,
  input: { label: string; yTitle: string; pick: (point: StatsDailyPoint) => number },
  theme: ChartTheme,
): ChartConfig {
  const days = dayRange(response.from, response.to);
  return {
    type: "bar",
    data: {
      labels: days.map(shortDay),
      datasets: [
        barDataset(input.label, seriesFor(days, response.points, locationId, input.pick), theme),
      ],
    },
    options: baseOptions(theme, { format: "count", yTitle: input.yTitle, legend: false }),
  };
}

/** One measure of one location row as a line (catalog growth, gone count). */
export function lineChart(
  response: StatsDailyResponse,
  locationId: number,
  input: { label: string; yTitle: string; pick: (point: StatsDailyPoint) => number },
  theme: ChartTheme,
): ChartConfig {
  const days = dayRange(response.from, response.to);
  const data = seriesFor(days, response.points, locationId, input.pick);
  return {
    type: "line",
    data: {
      labels: days.map(shortDay),
      datasets: [lineDataset(input.label, data, theme.accent, theme.accentWash, theme)],
    },
    options: baseOptions(theme, { format: "count", yTitle: input.yTitle, legend: false }),
  };
}

/** API units per day with the daily budget as a dashed reference line. */
export function apiUnitsChart(
  response: StatsDailyResponse,
  budget: number | null,
  theme: ChartTheme,
): ChartConfig {
  const chart = barChart(
    response,
    ALL_LOCATIONS_ID,
    { label: "API units", yTitle: "API units", pick: (point) => point.api_units },
    theme,
  );
  if (budget === null || budget <= 0) return chart;
  const days = dayRange(response.from, response.to);
  const reference = {
    ...lineDataset(
      "Daily budget",
      days.map(() => budget),
      theme.reference,
      false,
      theme,
    ),
    borderDash: [6, 4],
    borderWidth: 1.5,
    pointHoverRadius: 0,
    order: -1,
  };
  return {
    ...chart,
    data: { ...chart.data, datasets: [...chart.data.datasets, reference] },
    options: baseOptions(theme, { format: "count", yTitle: "API units", legend: true }),
  };
}

/** True when the response carries at least one rollup row. */
export function hasPoints(response: StatsDailyResponse | null): boolean {
  return response !== null && response.points.length > 0;
}
