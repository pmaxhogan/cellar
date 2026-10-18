import {
  EFFECT_KEYS,
  FIELD_CATALOG,
  effectRegistry,
  type EffectKey,
  type Field,
  type FieldInfo,
} from "@cellar/shared";
import { formatBytes } from "./format.ts";

/**
 * Human-readable renderings of rule conditions and effects, used by the rule
 * list, the rule editor and the Inspect page. Pure functions over plain JSON
 * so they also render half-edited or slightly invalid trees without throwing.
 */

/** Display names for ids a condition or effect refers to. Missing ids render as `#id`. */
export interface SummaryLabels {
  accounts?: ReadonlyMap<number, string>;
  locations?: ReadonlyMap<number, string>;
  proxies?: ReadonlyMap<number, string>;
  channels?: ReadonlyMap<string, string>;
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** Underscored identifiers read better with spaces: `watch_later` -> `watch later`. */
export function humanize(value: unknown): string {
  return String(value).replace(/_/g, " ");
}

const ISO_PARTS_RE =
  /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;
const ISO_UNITS = ["year", "month", "week", "day", "hour", "minute", "second"] as const;

/**
 * A rule duration (ISO-8601 string or `{ years, months, days, hours }`) as
 * "2 months", "1 year 6 months", "14 days". Unreadable input renders as-is.
 */
export function formatRuleDuration(value: unknown): string {
  const parts: string[] = [];
  if (typeof value === "string") {
    const m = ISO_PARTS_RE.exec(value);
    if (m === null) return value;
    ISO_UNITS.forEach((unit, i) => {
      const raw = m[i + 1];
      if (raw !== undefined) parts.push(plural(Number(raw), unit));
    });
  } else if (isObject(value)) {
    for (const unit of ["year", "month", "day", "hour"] as const) {
      const n = value[`${unit}s`];
      if (typeof n === "number") parts.push(plural(n, unit));
    }
  } else {
    return String(value);
  }
  return parts.length === 0 ? "0 days" : parts.join(" ");
}

/** Whole seconds as a compact `1h 30m`, `45s`, `2h`. */
export function formatSeconds(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value);
  const total = Math.max(0, Math.round(value));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const out: string[] = [];
  if (h > 0) out.push(`${h}h`);
  if (m > 0) out.push(`${m}m`);
  if (s > 0 || out.length === 0) out.push(`${s}s`);
  return out.join(" ");
}

/** An absolute instant (epoch ms or ISO datetime) as `2026-01-31 14:05 UTC`, or the date alone at midnight. */
export function formatInstant(value: unknown): string {
  const ms =
    typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) return String(value);
  const iso = new Date(ms).toISOString();
  const date = iso.slice(0, 10);
  const time = iso.slice(11, 16);
  return time === "00:00" ? date : `${date} ${time} UTC`;
}

function quote(text: unknown): string {
  return `"${String(text)}"`;
}

function idLabel(map: ReadonlyMap<number, string> | undefined, id: unknown): string {
  if (typeof id === "number") return map?.get(id) ?? `#${id}`;
  return "(none)";
}

function channelLabel(labels: SummaryLabels, id: unknown): string {
  if (typeof id !== "string" || id === "") return "(none)";
  return labels.channels?.get(id) ?? id;
}

function list(value: unknown, item: (v: unknown) => string): string {
  if (!Array.isArray(value) || value.length === 0) return "(none)";
  return value.map(item).join(", ");
}

function leafValue(info: FieldInfo, leaf: Json, labels: SummaryLabels): string {
  const op = info.operators.find((candidate) => candidate.op === leaf["op"]);
  const value = leaf["value"];
  const field = info.field;
  switch (op?.value) {
    case "account_id":
      return idLabel(labels.accounts, value);
    case "account_ids":
      return list(value, (v) => idLabel(labels.accounts, v));
    case "channel_id":
      return channelLabel(labels, value);
    case "channel_ids":
      return list(value, (v) => channelLabel(labels, v));
    case "location_id":
      return idLabel(labels.locations, value);
    case "enum":
      return humanize(value);
    case "enum_list":
    case "source_list":
      return list(value, humanize);
    case "number":
      return field === "duration_s" ? formatSeconds(value) : String(value);
    case "number_range": {
      if (!Array.isArray(value)) return String(value);
      const fmt = field === "duration_s" ? formatSeconds : (v: unknown) => String(v);
      return `${fmt(value[0])} and ${fmt(value[1])}`;
    }
    case "bool":
      return value === true ? "yes" : value === false ? "no" : String(value);
    case "text":
      return quote(value);
    case "regex":
      return `/${String(value)}/`;
    case "duration":
      return formatRuleDuration(value);
    case "instant":
      return formatInstant(value);
    default:
      return value === undefined ? "" : JSON.stringify(value);
  }
}

/** One leaf as text, e.g. `Source has only subscription, channel`. */
export function summarizeLeaf(leaf: Json, labels: SummaryLabels = {}): string {
  const info = FIELD_CATALOG[leaf["field"] as Field] as FieldInfo | undefined;
  if (info === undefined) return `${String(leaf["field"])} ${String(leaf["op"])}`;
  let subject = info.label;
  if (info.sourceParam === true) {
    subject +=
      typeof leaf["source"] === "string" ? ` (${humanize(leaf["source"])})` : " (any source)";
  }
  if (leaf["op"] === "is_null") {
    return `${subject} ${leaf["value"] === false ? "is set" : "is empty"}`;
  }
  const op = info.operators.find((candidate) => candidate.op === leaf["op"]);
  const opLabel = op?.label ?? String(leaf["op"]);
  const text = `${subject} ${opLabel} ${leafValue(info, leaf, labels)}`.trimEnd();
  return info.caseFlag === true && leaf["ci"] === true ? `${text} (any case)` : text;
}

function summarizeNode(node: unknown, labels: SummaryLabels, nested: boolean): string {
  if (!isObject(node)) return "(invalid)";
  if (node["type"] === "cond") return summarizeLeaf(node, labels);
  const children = Array.isArray(node["children"]) ? node["children"] : [];
  const op = node["op"] === "or" ? "or" : "and";
  let text: string;
  if (children.length === 0) {
    text = op === "and" ? "all videos" : "no videos";
  } else if (children.length === 1) {
    text = summarizeNode(children[0], labels, node["not"] === true || nested);
  } else {
    const joined = children
      .map((child) => summarizeNode(child, labels, true))
      .join(op === "and" ? " AND " : " OR ");
    text = nested || node["not"] === true ? `(${joined})` : joined;
  }
  return node["not"] === true ? `NOT ${text}` : text;
}

/**
 * A condition AST as one line: groups join with AND / OR, nested groups are
 * parenthesised, NOT prefixes a negated group. A null condition (the global
 * rule) and an empty AND both read "all videos".
 */
export function summarizeCondition(node: unknown, labels: SummaryLabels = {}): string {
  if (node === null || node === undefined) return "all videos";
  return summarizeNode(node, labels, false);
}

/** Every channel id a condition mentions, for resolving display titles. */
export function channelIdsIn(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (!isObject(node)) return out;
  if (node["type"] === "group") {
    if (Array.isArray(node["children"]))
      for (const child of node["children"]) channelIdsIn(child, out);
    return out;
  }
  if (node["field"] === "channel") {
    const value = node["value"];
    for (const id of Array.isArray(value) ? value : [value]) {
      if (typeof id === "string" && id !== "") out.add(id);
    }
  }
  return out;
}

function idListOrMode(
  value: unknown,
  modes: Record<string, string>,
  map: ReadonlyMap<number, string> | undefined,
): string {
  if (typeof value === "string") return modes[value] ?? humanize(value);
  return list(value, (v) => idLabel(map, v));
}

function formatTranscode(v: Json): string {
  if (v["mode"] === "none") return "off";
  const parts = [humanize(v["codec"] ?? "hevc_nvenc"), `q${String(v["quality"] ?? 28)}`];
  if (v["preset"] !== undefined) parts.push(String(v["preset"]));
  parts.push(v["mode"] === "always" ? "always" : "if not AV1");
  return parts.join(", ");
}

function formatCaptions(v: Json): string {
  if (v["enabled"] === false) return "off";
  const langs = v["languages"];
  const text = Array.isArray(langs) ? langs.join(", ") : "all languages";
  return v["auto_generated"] === false ? `${text}, manual only` : `${text}, auto`;
}

function formatYtdlp(v: Json): string {
  const parts: string[] = [];
  if (typeof v["format_override"] === "string") parts.push(`format ${v["format_override"]}`);
  if (typeof v["rate_limit_bytes_per_s"] === "number") {
    parts.push(`${formatBytes(v["rate_limit_bytes_per_s"])}/s`);
  }
  if (v["sleep_requests_min"] !== undefined || v["sleep_requests_max"] !== undefined) {
    parts.push(
      `sleep ${String(v["sleep_requests_min"] ?? "?")}-${String(v["sleep_requests_max"] ?? "?")}s`,
    );
  }
  if (typeof v["concurrent_fragments"] === "number") {
    parts.push(plural(v["concurrent_fragments"], "fragment"));
  }
  const extra = v["extra_args_allowlisted"];
  if (Array.isArray(extra) && extra.length > 0) parts.push(plural(extra.length, "extra arg"));
  return parts.length === 0 ? "global settings" : parts.join(", ");
}

function formatNotify(v: Json): string {
  if (v["enabled"] !== true) return "off";
  const max = v["max_times"];
  if (max === null) return "unlimited";
  const times = typeof max === "number" ? max : 1;
  return times === 1 ? "once" : `up to ${times} times`;
}

/** One effect value as short text, e.g. `reclaim_priority 0` -> `delete now`. */
export function formatEffectValue(key: string, value: unknown, labels: SummaryLabels = {}): string {
  const def = (effectRegistry as Record<string, (typeof effectRegistry)[EffectKey]>)[key];
  if (def === undefined) return JSON.stringify(value);
  const ui = def.ui;
  if (value === null) return ui.nullLabel ?? "none";
  switch (key) {
    case "include":
      return value === true ? "yes" : value === false ? "no (excluded)" : String(value);
    case "reclaim_priority":
      if (value === -1) return "never delete";
      if (value === 0) return "delete now";
      return `reap order ${String(value)}`;
    case "location_id":
      return idLabel(labels.locations, value);
    case "max_height":
      return `${String(value)}p`;
    case "max_fps":
      return `${String(value)} fps`;
    case "transcode":
      return isObject(value) ? formatTranscode(value) : String(value);
    case "captions":
      return isObject(value) ? formatCaptions(value) : String(value);
    case "ytdlp":
      return isObject(value) ? formatYtdlp(value) : String(value);
    case "download_accounts":
      return idListOrMode(
        value,
        { sourcing: "sourcing accounts", any: "any account" },
        labels.accounts,
      );
    case "proxy":
      return idListOrMode(value, { none: "no proxy", pool: "proxy pool" }, labels.proxies);
    case "delay_after_upload":
      return formatRuleDuration(value);
    case "recheck_interval":
      return value === "tiered" ? "tiered by age" : `every ${formatRuleDuration(value)}`;
    case "notify":
      return isObject(value) ? formatNotify(value) : String(value);
    default: {
      const option = ui.options?.find((candidate) => candidate.value === value);
      return option?.label ?? humanize(value);
    }
  }
}

export interface EffectChip {
  key: EffectKey;
  label: string;
  text: string;
}

/** The effects a rule sets, in registry order, as `{ label, text }` chips. Unknown keys are skipped. */
export function effectChips(effects: unknown, labels: SummaryLabels = {}): EffectChip[] {
  if (!isObject(effects)) return [];
  return EFFECT_KEYS.filter((key) => effects[key] !== undefined).map((key) => ({
    key,
    label: effectRegistry[key].ui.label,
    text: formatEffectValue(key, effects[key], labels),
  }));
}
