/** Display helpers. Pure functions so the component tests can assert on them. */

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/** Human-readable byte size, 1024-based. Null and negative render as a dash. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

/**
 * Media length from whole seconds: "0:42", "4:05", "1:02:03". Hours appear only
 * when needed, minutes are never padded at the front, seconds always are.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return "-";
  }
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  if (h === 0) return `${m}:${ss}`;
  return `${h}:${String(m).padStart(2, "0")}:${ss}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * Coarse relative time: "just now", "5 min ago", "in 2 h", "3 y ago".
 * Deliberately low-resolution; second-level precision would only ever be wrong
 * on a page that refreshes on its own schedule.
 */
export function formatRelative(at: number | null | undefined, now = Date.now()): string {
  if (at === null || at === undefined || !Number.isFinite(at)) return "never";
  const delta = at - now;
  const magnitude = Math.abs(delta);
  if (magnitude < 45_000) return "just now";

  const [amount, unit] =
    magnitude < HOUR
      ? [Math.max(1, Math.round(magnitude / MINUTE)), "min"]
      : magnitude < DAY
        ? [Math.round(magnitude / HOUR), "h"]
        : magnitude < MONTH
          ? [Math.round(magnitude / DAY), "d"]
          : magnitude < YEAR
            ? [Math.round(magnitude / MONTH), "mo"]
            : [Math.round(magnitude / YEAR), "y"];

  return delta < 0 ? `${amount} ${unit} ago` : `in ${amount} ${unit}`;
}

/** Full timestamp for tooltips and detail views. */
export function formatAbsolute(at: number | null | undefined): string {
  if (at === null || at === undefined || !Number.isFinite(at)) return "never";
  return new Date(at).toLocaleString();
}

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** Thousands separators, fixed to en-US so the UI does not shift by locale. */
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return NUMBER.format(value);
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatNumber(count)} ${count === 1 ? singular : plural}`;
}
