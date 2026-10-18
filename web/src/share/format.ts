/**
 * Formatters for the public share page. Deliberately not web/src/lib/format.ts:
 * importing an admin module would put it in a chunk both entries share.
 */

/** 125 -> "2:05", 3725 -> "1:02:05". */
export function formatDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Epoch ms -> "Feb 3, 2026" (UTC, like the stored upload date). */
export function formatDate(at: number | null): string | null {
  if (at === null || !Number.isFinite(at)) return null;
  return new Date(at).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function formatCount(value: number | null, singular: string, plural: string): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return `${value.toLocaleString("en-US")} ${value === 1 ? singular : plural}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}
