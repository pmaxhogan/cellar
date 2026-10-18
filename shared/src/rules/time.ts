import { z } from "zod";

/**
 * Durations and instants used by rule conditions and effects.
 *
 * All calendar math is UTC. Years and months are calendar units (adding one
 * month to Jan 31 clamps to the last day of February); weeks, days, hours,
 * minutes and seconds are fixed lengths.
 */

/** Largest value accepted for any single duration component. */
export const MAX_DURATION_COMPONENT = 100_000;

/** JS Date range limit, in epoch ms. */
const MAX_EPOCH_MS = 8_640_000_000_000_000;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const SECOND_MS = 1_000;

/** Normalised duration: calendar months plus a fixed number of milliseconds. */
export interface DurationParts {
  months: number;
  ms: number;
}

const ISO_DURATION_RE =
  /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/**
 * Parses an ISO-8601 duration (`P14D`, `P2M`, `P2Y`, `PT1H`, `P1Y2M3DT4H5M6S`,
 * `P2W`). Returns null when the string is not a valid duration. Fractions are
 * not supported. Note `P2M` is two months and `PT2M` is two minutes.
 */
export function parseIsoDuration(text: string): DurationParts | null {
  const m = ISO_DURATION_RE.exec(text);
  if (!m) return null;
  const [, y, mo, w, d, h, mi, s] = m;
  if ([y, mo, w, d, h, mi, s].every((part) => part === undefined)) return null;
  // A bare "T" with no time components is invalid ("P1DT").
  if (text.includes("T") && [h, mi, s].every((part) => part === undefined)) return null;
  const nums = [y, mo, w, d, h, mi, s].map((part) => (part === undefined ? 0 : Number(part)));
  if (nums.some((n) => n > MAX_DURATION_COMPONENT)) return null;
  const [years = 0, months = 0, weeks = 0, days = 0, hours = 0, minutes = 0, seconds = 0] = nums;
  return {
    months: years * 12 + months,
    ms:
      weeks * 7 * DAY_MS +
      days * DAY_MS +
      hours * HOUR_MS +
      minutes * MINUTE_MS +
      seconds * SECOND_MS,
  };
}

const component = z.int().min(0).max(MAX_DURATION_COMPONENT);

/** Object form of a duration: `{ days?, months?, years?, hours? }`, at least one key. */
export const DurationObjectSchema = z
  .strictObject({
    years: component.optional(),
    months: component.optional(),
    days: component.optional(),
    hours: component.optional(),
  })
  .refine(
    (o) =>
      o.years !== undefined ||
      o.months !== undefined ||
      o.days !== undefined ||
      o.hours !== undefined,
    { message: "duration needs at least one of years, months, days, hours" },
  );
export type DurationObject = z.infer<typeof DurationObjectSchema>;

/** ISO-8601 duration string such as `P14D`. */
export const IsoDurationSchema = z
  .string()
  .max(64)
  .refine((s) => parseIsoDuration(s) !== null, { message: "invalid ISO-8601 duration" });

/** A rule duration: ISO-8601 duration string or `{ days?, months?, years?, hours? }`. */
export const RuleDurationSchema = z.union([IsoDurationSchema, DurationObjectSchema]);
export type RuleDuration = z.infer<typeof RuleDurationSchema>;

/** Normalises a duration. Throws on an invalid string; validate with the schema first. */
export function durationParts(d: RuleDuration): DurationParts {
  if (typeof d === "string") {
    const parsed = parseIsoDuration(d);
    if (!parsed) throw new Error(`invalid ISO-8601 duration: ${d}`);
    return parsed;
  }
  return {
    months: (d.years ?? 0) * 12 + (d.months ?? 0),
    ms: (d.days ?? 0) * DAY_MS + (d.hours ?? 0) * HOUR_MS,
  };
}

function addMonthsClamped(at: number, months: number): number {
  const date = new Date(at);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const dayOfMonth = date.getUTCDate();
  const timeOfDay = ((at % DAY_MS) + DAY_MS) % DAY_MS;
  const total = month + months;
  const targetYear = year + Math.floor(total / 12);
  const targetMonth = ((total % 12) + 12) % 12;
  const target = new Date(0);
  // Day 0 of the following month is the last day of the target month.
  target.setUTCFullYear(targetYear, targetMonth + 1, 0);
  const lastDay = target.getUTCDate();
  target.setUTCFullYear(targetYear, targetMonth, Math.min(dayOfMonth, lastDay));
  return target.getTime() + timeOfDay;
}

/**
 * Adds (sign 1) or subtracts (sign -1) a duration to an epoch-ms instant.
 * Calendar months are applied first, then the fixed part.
 */
export function addDuration(at: number, d: RuleDuration | DurationParts, sign: 1 | -1 = 1): number {
  const parts = isDurationParts(d) ? d : durationParts(d);
  const shifted = parts.months === 0 ? at : addMonthsClamped(at, sign * parts.months);
  return shifted + sign * parts.ms;
}

function isDurationParts(d: RuleDuration | DurationParts): d is DurationParts {
  return typeof d === "object" && "ms" in d;
}

/** An absolute instant: epoch ms or an ISO-8601 datetime with `Z` or an offset. */
export const RuleInstantSchema = z.union([
  z.int().min(-MAX_EPOCH_MS).max(MAX_EPOCH_MS),
  z.iso.datetime({ offset: true }),
]);
export type RuleInstant = z.infer<typeof RuleInstantSchema>;

/** Converts a validated instant to epoch ms. */
export function instantMs(v: RuleInstant): number {
  return typeof v === "number" ? v : Date.parse(v);
}
