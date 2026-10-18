import { z } from "zod";

/**
 * Global settings registry (amber pattern, single scope). Every key declares
 * its zod schema, default and UI metadata here; adding a key is all it takes
 * for it to become storable in the `settings` table, validated by
 * `PUT /api/settings`, and rendered on the Settings page.
 *
 * Storage is sparse: the `settings` table only holds keys the owner changed.
 * `resolveSettings()` overlays those onto the registry defaults.
 */

/** How the web UI renders a setting. */
export type SettingControl = "toggle" | "number" | "select" | "text" | "list";

export interface SettingUi {
  readonly group: string;
  readonly label: string;
  readonly description: string;
  readonly control: SettingControl;
  readonly unit?: string;
  readonly min?: number;
  readonly max?: number;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  /** For `number` controls on nullable settings: what an empty field means. */
  readonly nullLabel?: string;
}

export interface SettingDefinition<S extends z.ZodType = z.ZodType> {
  readonly schema: S;
  readonly default: z.infer<S>;
  readonly ui: SettingUi;
}

function defineSetting<S extends z.ZodType>(def: SettingDefinition<S>): SettingDefinition<S> {
  return def;
}

const posInt = z.number().int().min(1);
const nonNegInt = z.number().int().min(0);
const percent = z.number().min(1).max(100);

/** Thumbnail variants YouTube serves under `i.ytimg.com/vi/<id>/<variant>.jpg`. */
export const THUMBNAIL_VARIANTS = [
  "maxresdefault",
  "sddefault",
  "hqdefault",
  "mqdefault",
  "default",
  "hq720",
] as const;

export const JS_RUNTIMES = ["node", "deno", "bun", "quickjs"] as const;

export const settingsRegistry = {
  "eval.interval_minutes": defineSetting({
    schema: posInt,
    default: 60,
    ui: {
      group: "Rules",
      label: "Full evaluation interval",
      description:
        "How often every video is re-evaluated against every rule. Changes are also evaluated as they happen; this is the safety net.",
      control: "number",
      min: 1,
      unit: "minutes",
    },
  }),

  "ingest.history_minutes": defineSetting({
    schema: posInt,
    default: 30,
    ui: {
      group: "Ingestion",
      label: "Watch history poll",
      description: "How often each account's watch history feed is scraped.",
      control: "number",
      min: 1,
      unit: "minutes",
    },
  }),
  "ingest.watch_later_minutes": defineSetting({
    schema: posInt,
    default: 30,
    ui: {
      group: "Ingestion",
      label: "Watch Later poll",
      description: "How often each account's Watch Later playlist is scraped.",
      control: "number",
      min: 1,
      unit: "minutes",
    },
  }),
  "ingest.liked_minutes": defineSetting({
    schema: posInt,
    default: 30,
    ui: {
      group: "Ingestion",
      label: "Liked videos poll",
      description: "How often each account's liked videos are read from the API.",
      control: "number",
      min: 1,
      unit: "minutes",
    },
  }),
  "ingest.subscriptions_hours": defineSetting({
    schema: posInt,
    default: 6,
    ui: {
      group: "Ingestion",
      label: "Subscriptions list refresh",
      description: "How often each account's subscription list is re-read from the API.",
      control: "number",
      min: 1,
      unit: "hours",
    },
  }),
  "ingest.channel_uploads_minutes": defineSetting({
    schema: posInt,
    default: 30,
    ui: {
      group: "Ingestion",
      label: "Channel uploads poll",
      description: "How often subscribed and manual channels are checked for new uploads.",
      control: "number",
      min: 1,
      unit: "minutes",
    },
  }),
  "ingest.channel_newest_n": defineSetting({
    schema: z.number().int().min(1).max(500),
    default: 50,
    ui: {
      group: "Ingestion",
      label: "Uploads per channel poll",
      description: "How many of a channel's newest uploads each poll reads.",
      control: "number",
      min: 1,
      max: 500,
      unit: "videos",
    },
  }),
  "ingest.manual_channel_full_scan_hours": defineSetting({
    schema: posInt,
    default: 24,
    ui: {
      group: "Ingestion",
      label: "Manual channel full scan",
      description:
        "How often manually added channels get a full catalog scan until caught up. Runs on leftover API budget only.",
      control: "number",
      min: 1,
      unit: "hours",
    },
  }),

  "quota.api_units_per_day": defineSetting({
    schema: posInt,
    default: 10000,
    ui: {
      group: "Quota",
      label: "API units per day",
      description:
        "YouTube Data API budget per day. Google's default project quota is 10,000 units.",
      control: "number",
      min: 1,
      unit: "units",
    },
  }),
  "quota.scrape_requests_per_hour": defineSetting({
    schema: posInt,
    default: 120,
    ui: {
      group: "Quota",
      label: "Scrape requests per account per hour",
      description: "Self-imposed budget for cookie-authenticated yt-dlp requests per account.",
      control: "number",
      min: 1,
      unit: "requests",
    },
  }),

  "download.concurrency": defineSetting({
    schema: z.number().int().min(1).max(16),
    default: 2,
    ui: {
      group: "Downloads",
      label: "Concurrent downloads",
      description: "How many yt-dlp downloads may run at the same time.",
      control: "number",
      min: 1,
      max: 16,
      unit: "downloads",
    },
  }),
  "transcode.concurrency": defineSetting({
    schema: z.number().int().min(1).max(8),
    default: 1,
    ui: {
      group: "Downloads",
      label: "Concurrent transcodes",
      description: "How many ffmpeg transcodes may run at the same time.",
      control: "number",
      min: 1,
      max: 8,
      unit: "transcodes",
    },
  }),
  "download.rate_limit_bytes_per_s": defineSetting({
    schema: posInt.nullable(),
    default: null,
    ui: {
      group: "Downloads",
      label: "Download speed limit",
      description: "Per-download cap passed to yt-dlp --limit-rate. Empty means no cap.",
      control: "number",
      min: 1,
      unit: "bytes/s",
      nullLabel: "No limit",
    },
  }),
  "download.account_gap_seconds": defineSetting({
    schema: nonNegInt,
    default: 30,
    ui: {
      group: "Downloads",
      label: "Minimum gap per account",
      description: "Minimum time between two downloads that use the same account's cookies.",
      control: "number",
      min: 0,
      unit: "seconds",
    },
  }),
  "download.sleep_requests_min_s": defineSetting({
    schema: z.number().min(0),
    default: 1,
    ui: {
      group: "Downloads",
      label: "Request sleep (min)",
      description: "Lower bound for yt-dlp --sleep-requests between HTTP requests.",
      control: "number",
      min: 0,
      unit: "seconds",
    },
  }),
  "download.sleep_requests_max_s": defineSetting({
    schema: z.number().min(0),
    default: 3,
    ui: {
      group: "Downloads",
      label: "Request sleep (max)",
      description: "Upper bound for the randomised sleep between HTTP requests.",
      control: "number",
      min: 0,
      unit: "seconds",
    },
  }),

  "reaper.high_water_pct": defineSetting({
    schema: percent,
    default: 95,
    ui: {
      group: "Storage",
      label: "Start reaping at",
      description: "A location is reaped once its usage reaches this share of its quota.",
      control: "number",
      min: 1,
      max: 100,
      unit: "%",
    },
  }),
  "reaper.low_water_pct": defineSetting({
    schema: percent,
    default: 90,
    ui: {
      group: "Storage",
      label: "Reap down to",
      description: "Reaping stops once usage falls to this share of the quota.",
      control: "number",
      min: 1,
      max: 100,
      unit: "%",
    },
  }),
  "reaper.min_free_gb": defineSetting({
    schema: z.number().min(0),
    default: 10,
    ui: {
      group: "Storage",
      label: "Minimum free space",
      description: "Also reap when the filesystem under a location has less free space than this.",
      control: "number",
      min: 0,
      unit: "GB",
    },
  }),

  "recheck.daily_under_days": defineSetting({
    schema: posInt,
    default: 30,
    ui: {
      group: "Rechecks",
      label: "Daily recheck window",
      description: "Videos younger than this are rechecked daily.",
      control: "number",
      min: 1,
      unit: "days",
    },
  }),
  "recheck.weekly_under_days": defineSetting({
    schema: posInt,
    default: 365,
    ui: {
      group: "Rechecks",
      label: "Weekly recheck window",
      description: "Videos younger than this (and past the daily window) are rechecked weekly.",
      control: "number",
      min: 1,
      unit: "days",
    },
  }),
  "recheck.ryd_enabled": defineSetting({
    schema: z.boolean(),
    default: true,
    ui: {
      group: "Rechecks",
      label: "Return YouTube Dislike lookups",
      description: "Fetch estimated dislike counts on each recheck (rate-limited, cached).",
      control: "toggle",
    },
  }),

  "notify.consecutive_download_failures": defineSetting({
    schema: posInt,
    default: 3,
    ui: {
      group: "Notifications",
      label: "Download failure threshold",
      description: "Notify after this many consecutive download failures across distinct videos.",
      control: "number",
      min: 1,
      unit: "failures",
    },
  }),
  "notify.rate_limit_hours": defineSetting({
    schema: posInt,
    default: 6,
    ui: {
      group: "Notifications",
      label: "Repeat interval",
      description:
        "Each notification type is sent at most once per this window unless acknowledged.",
      control: "number",
      min: 1,
      unit: "hours",
    },
  }),
  "notify.storage_pressure_hours": defineSetting({
    schema: posInt,
    default: 6,
    ui: {
      group: "Notifications",
      label: "Storage pressure repeat",
      description: "Minimum time between storage pressure notifications.",
      control: "number",
      min: 1,
      unit: "hours",
    },
  }),
  "notify.outage_hours": defineSetting({
    schema: posInt,
    default: 6,
    ui: {
      group: "Notifications",
      label: "Outage repeat",
      description: "Minimum time between YouTube or API outage notifications.",
      control: "number",
      min: 1,
      unit: "hours",
    },
  }),
  "canary.max_per_hour": defineSetting({
    schema: posInt,
    default: 1,
    ui: {
      group: "Notifications",
      label: "Canary downloads per hour",
      description: "Upper bound on known-good canary downloads used to confirm a yt-dlp outage.",
      control: "number",
      min: 1,
      unit: "per hour",
    },
  }),

  "logs.job_retention_days": defineSetting({
    schema: posInt,
    default: 14,
    ui: {
      group: "Logs",
      label: "Job log retention",
      description: "How long per-job logs and response bodies are kept.",
      control: "number",
      min: 1,
      unit: "days",
    },
  }),
  "logs.job_retention_gb": defineSetting({
    schema: z.number().positive(),
    default: 2,
    ui: {
      group: "Logs",
      label: "Job log size cap",
      description: "Oldest job logs are pruned once the total exceeds this size.",
      control: "number",
      min: 0,
      unit: "GB",
    },
  }),
  "logs.failed_job_retention_days": defineSetting({
    schema: posInt,
    default: 60,
    ui: {
      group: "Logs",
      label: "Failed job log retention",
      description: "How long logs of failed jobs are kept.",
      control: "number",
      min: 1,
      unit: "days",
    },
  }),

  "tools.auto_update": defineSetting({
    schema: z.boolean(),
    default: true,
    ui: {
      group: "Tools",
      label: "Auto-update yt-dlp and ffmpeg",
      description: "Check daily for new releases and swap them in after verification.",
      control: "toggle",
    },
  }),
  "tools.pot_provider_url": defineSetting({
    // An empty string disables the provider. `null` is reserved for "clear the
    // override" in patches, so it cannot double as "disabled".
    schema: z
      .string()
      .trim()
      .regex(/^(https?:\/\/\S+)?$/, "Must be an http(s) URL, or empty to disable"),
    default: "http://bgutil:4416",
    ui: {
      group: "Tools",
      label: "PO token provider",
      description:
        "URL of the bgutil PO token provider sidecar. Empty disables the provider. The server may substitute an env default.",
      control: "text",
    },
  }),
  "tools.js_runtime": defineSetting({
    schema: z.enum(JS_RUNTIMES),
    default: "node",
    ui: {
      group: "Tools",
      label: "yt-dlp JS runtime",
      description: "JavaScript runtime yt-dlp uses to solve YouTube player challenges.",
      control: "select",
      options: JS_RUNTIMES.map((value) => ({ value, label: value })),
    },
  }),
  "tools.ffmpeg_release_tag": defineSetting({
    // Interpolated into the GitHub release URL, so only tag-safe characters.
    schema: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._-]+$/, "Must be a release tag such as autobuild-2025-12-31-14-28"),
    default: "autobuild-2025-12-31-14-28",
    ui: {
      group: "Tools",
      label: "ffmpeg release tag",
      description:
        "BtbN FFmpeg-Builds release the updater installs. Builds from early 2026 on need NVIDIA driver 610 or newer for NVENC (API 13.1); the default is the newest build that still encodes on older drivers. Set it to latest to follow the newest build.",
      control: "text",
    },
  }),

  "selfcheck.interval_hours": defineSetting({
    schema: posInt,
    default: 24,
    ui: {
      group: "Self-check",
      label: "Self-check interval",
      description: "How often the full self-check runs (it also runs at boot and on demand).",
      control: "number",
      min: 1,
      unit: "hours",
    },
  }),

  "bulk.warn_gb": defineSetting({
    schema: z.number().min(0),
    default: 20,
    ui: {
      group: "Bulk download",
      label: "Size warning",
      description: "Warn before a bulk download larger than this. There is no hard cap.",
      control: "number",
      min: 0,
      unit: "GB",
    },
  }),

  "thumbnails.variants": defineSetting({
    schema: z.array(z.enum(THUMBNAIL_VARIANTS)).min(1),
    default: [...THUMBNAIL_VARIANTS],
    ui: {
      group: "Thumbnails",
      label: "Thumbnail variants",
      description: "Which thumbnail variants are fetched, hashed and kept on change.",
      control: "list",
      options: THUMBNAIL_VARIANTS.map((value) => ({ value, label: value })),
    },
  }),
} as const;

export type SettingsRegistry = typeof settingsRegistry;
export type SettingKey = keyof SettingsRegistry;

/** The fully merged, typed settings object. */
export type ResolvedSettings = {
  -readonly [K in SettingKey]: z.infer<SettingsRegistry[K]["schema"]>;
};

/** A sparse settings patch. `null` clears a stored override back to the default. */
export type SettingsPatch = {
  -readonly [K in SettingKey]?: ResolvedSettings[K] | null;
};

export const SETTING_KEYS = Object.keys(settingsRegistry) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(settingsRegistry, key);
}

/** Settings keys grouped for the UI, in registry order. */
export function settingGroups(): { group: string; keys: SettingKey[] }[] {
  const groups = new Map<string, SettingKey[]>();
  for (const key of SETTING_KEYS) {
    const group = settingsRegistry[key].ui.group;
    const list = groups.get(group) ?? [];
    list.push(key);
    groups.set(group, list);
  }
  return [...groups].map(([group, keys]) => ({ group, keys }));
}

function cloneDefault<T>(value: T): T {
  return Array.isArray(value) ? ([...value] as T) : value;
}

/** A fresh object holding every registry default. */
export function defaultSettings(): ResolvedSettings {
  const out: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    out[key] = cloneDefault(settingsRegistry[key].default);
  }
  return out as ResolvedSettings;
}

/**
 * Cross-key invariants a single-key schema cannot express. Returns one message
 * per offending key; an empty object means consistent.
 */
export function checkSettingsConsistency(settings: ResolvedSettings): Record<string, string> {
  const errors: Record<string, string> = {};
  if (settings["reaper.low_water_pct"] >= settings["reaper.high_water_pct"]) {
    errors["reaper.low_water_pct"] = "Must be lower than the start-reaping threshold";
  }
  if (settings["download.sleep_requests_min_s"] > settings["download.sleep_requests_max_s"]) {
    errors["download.sleep_requests_min_s"] = "Must not exceed the maximum request sleep";
  }
  if (settings["recheck.daily_under_days"] > settings["recheck.weekly_under_days"]) {
    errors["recheck.daily_under_days"] = "Must not exceed the weekly recheck window";
  }
  return errors;
}

function buildFullShape(): { [K in SettingKey]: z.ZodType } {
  const shape: Record<string, z.ZodType> = {};
  for (const key of SETTING_KEYS) {
    const def = settingsRegistry[key];
    shape[key] = (def.schema as z.ZodType).default(() => cloneDefault(def.default) as never);
  }
  return shape as { [K in SettingKey]: z.ZodType };
}

function buildPatchShape(): { [K in SettingKey]: z.ZodType } {
  const shape: Record<string, z.ZodType> = {};
  for (const key of SETTING_KEYS) {
    shape[key] = (settingsRegistry[key].schema as z.ZodType).nullable().optional();
  }
  return shape as { [K in SettingKey]: z.ZodType };
}

/**
 * The complete settings object. Parsing `{}` yields every default; unknown keys
 * are rejected. Cross-key invariants are enforced.
 */
export const SettingsSchema: z.ZodType<ResolvedSettings> = z
  .strictObject(buildFullShape())
  .superRefine((value, ctx) => {
    const errors = checkSettingsConsistency(value as ResolvedSettings);
    for (const [key, message] of Object.entries(errors)) {
      ctx.addIssue({ code: "custom", path: [key], message });
    }
  }) as unknown as z.ZodType<ResolvedSettings>;

/**
 * The body of `PUT /api/settings`: a sparse map, unknown keys rejected, every
 * value validated, `null` meaning "clear the stored override". For a nullable
 * setting whose default is itself null (`download.rate_limit_bytes_per_s`),
 * clearing and setting to null are the same thing.
 */
export const SettingsPatchSchema: z.ZodType<SettingsPatch> = z.strictObject(
  buildPatchShape(),
) as unknown as z.ZodType<SettingsPatch>;

/**
 * Overlay stored sparse values onto the registry defaults. Unknown keys and
 * values that no longer validate (a stale row after a schema change) fall back
 * to the default instead of failing, so a bad row can never stop the server.
 * Pair with `checkSettingsConsistency` when the caller wants to report them.
 */
export function resolveSettings(sparse: Readonly<Record<string, unknown>>): ResolvedSettings {
  const out = defaultSettings() as Record<string, unknown>;
  for (const key of SETTING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(sparse, key)) {
      continue;
    }
    const raw = sparse[key];
    if (raw === undefined) {
      continue;
    }
    const parsed = settingsRegistry[key].schema.safeParse(raw);
    if (parsed.success) {
      out[key] = parsed.data;
    }
  }
  return out as ResolvedSettings;
}

export type ApplySettingsPatchResult =
  | { ok: true; sparse: Partial<ResolvedSettings>; resolved: ResolvedSettings }
  | { ok: false; errors: Record<string, string> };

/**
 * Apply a validated patch to the stored sparse map: `null` removes the key,
 * anything else replaces it. The merged result is checked for cross-key
 * consistency before it is accepted. The input map is not mutated.
 */
export function applySettingsPatch(
  sparse: Readonly<Record<string, unknown>>,
  patch: unknown,
): ApplySettingsPatchResult {
  const parsed = SettingsPatchSchema.safeParse(patch);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      if (issue.code === "unrecognized_keys") {
        for (const key of issue.keys) {
          errors[key] = "Unknown setting";
        }
        continue;
      }
      const key = String(issue.path[0] ?? "_");
      errors[key] ??= issue.message;
    }
    return { ok: false, errors };
  }

  const next: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(sparse, key) && sparse[key] !== undefined) {
      next[key] = sparse[key];
    }
  }
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value === null) {
      delete next[key];
    } else if (value !== undefined) {
      next[key] = value;
    }
  }

  const resolved = resolveSettings(next);
  const errors = checkSettingsConsistency(resolved);
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, sparse: next as Partial<ResolvedSettings>, resolved };
}
