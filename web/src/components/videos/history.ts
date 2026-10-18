import type { VideoStatsPoint } from "@cellar/shared";
import { formatDuration, formatNumber } from "../../lib/format.ts";
import { formatDay } from "./videoDisplay.ts";

/**
 * Pure helpers for the detail page's history timeline and stats chart, kept
 * out of the components so the formatting rules are unit tested directly.
 * Which fields count as counters lives in @cellar/shared (COUNTER_FIELDS); the
 * server drops them from the timeline unless asked.
 */

export const FIELD_LABELS: Record<string, string> = {
  title: "Title",
  description: "Description",
  privacy: "Privacy",
  duration_s: "Length",
  tags: "Tags",
  tags_json: "Tags",
  type: "Type",
  upload_date: "Upload date",
  content_signature: "Content",
  live_status: "Live status",
  thumbnail: "Thumbnail",
  category_id: "Category",
  gone_since: "Gone since",
  views: "Views",
  likes: "Likes",
  comments: "Comments",
};

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field.replace(/_/g, " ");
}

/** Values longer than this are shown collapsed with the full text one click away. */
export const LONG_VALUE = 160;

/** One side of a change as text: numbers formatted, null as "(none)", objects as JSON. */
export function formatChangeValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "(none)";
  if (typeof value === "number") {
    if (field === "duration_s") return formatDuration(value);
    if (field === "upload_date" || field === "gone_since") return formatDay(value);
    return formatNumber(value);
  }
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.length === 0 ? "(none)" : value.join(", ");
  }
  return JSON.stringify(value);
}

// --- stats chart -------------------------------------------------------------

export const STATS_SERIES = [
  { key: "views", label: "Views", color: "#c2577a", axis: "y" },
  { key: "likes", label: "Likes", color: "#4f9dde", axis: "y1" },
  { key: "comments", label: "Comments", color: "#d9a03c", axis: "y1" },
] as const;

export interface StatsChartData {
  labels: string[];
  datasets: {
    label: string;
    data: (number | null)[];
    borderColor: string;
    backgroundColor: string;
    yAxisID: string;
    tension: number;
    spanGaps: boolean;
    pointRadius: number;
  }[];
}

/** Chart.js line data: views on the left axis, likes and comments on the right. */
export function statsChartData(points: readonly VideoStatsPoint[]): StatsChartData {
  const sorted = [...points].sort((a, b) => a.at - b.at);
  return {
    labels: sorted.map((point) => new Date(point.at).toISOString().slice(0, 10)),
    datasets: STATS_SERIES.map((series) => ({
      label: series.label,
      data: sorted.map((point) => point[series.key]),
      borderColor: series.color,
      backgroundColor: series.color,
      yAxisID: series.axis,
      tension: 0.25,
      spanGaps: true,
      pointRadius: sorted.length > 60 ? 0 : 2,
    })),
  };
}

/** Axes and legend colors follow the theme's text colors. */
export function statsChartOptions(textColor: string, gridColor: string): Record<string, unknown> {
  const ticks = { color: textColor };
  const grid = { color: gridColor };
  return {
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: { legend: { labels: { color: textColor } } },
    scales: {
      x: { ticks, grid },
      y: {
        position: "left",
        ticks,
        grid,
        title: { display: true, text: "Views", color: textColor },
      },
      y1: {
        position: "right",
        ticks,
        grid: { drawOnChartArea: false },
        title: { display: true, text: "Likes and comments", color: textColor },
      },
    },
  };
}
