import { z } from "zod";
import { cloneJson } from "./clone.ts";
import { RuleDurationSchema } from "./time.ts";

/**
 * Rule effects registry (spec 4.3). Every effect key declares its zod schema,
 * its default (the value used when no rule sets it), which rule kinds may set
 * it, and UI metadata the admin rule editor switches on.
 *
 * Object-valued effects (`transcode`, `captions`, `ytdlp`, `notify`) replace
 * wholesale when a rule sets them; only top-level keys merge. Their subfields
 * carry zod defaults so a sparse object parses to a complete one.
 */

export const RULE_KINDS = ["global", "custom", "video"] as const;
export const RuleKindSchema = z.enum(RULE_KINDS);
export type RuleKind = z.infer<typeof RuleKindSchema>;

/** Positive integer row id (accounts, locations, proxies, rules). */
export const RowIdSchema = z.int().positive();

export const EFFECT_CONTROLS = [
  "toggle",
  "int",
  "select",
  "location",
  "transcode",
  "captions",
  "ytdlp",
  "accounts",
  "proxy",
  "duration",
  "recheck",
  "notify",
] as const;
export type EffectControl = (typeof EFFECT_CONTROLS)[number];

export const EFFECT_GROUPS = ["storage", "media", "download", "metadata", "notifications"] as const;
export type EffectGroup = (typeof EFFECT_GROUPS)[number];

export interface EffectOption {
  value: string;
  label: string;
}

export interface EffectUi {
  group: EffectGroup;
  label: string;
  description: string;
  control: EffectControl;
  /** Choices for `select` controls. */
  options?: readonly EffectOption[];
  /** Bounds for `int` controls. */
  min?: number;
  max?: number;
  /** Label for the null value of a nullable effect ("No limit", "First enabled location"). */
  nullLabel?: string;
}

export interface EffectDef<S extends z.ZodType = z.ZodType> {
  schema: S;
  default: z.output<S>;
  allowedIn: readonly RuleKind[];
  ui: EffectUi;
}

const ALL_KINDS: readonly RuleKind[] = RULE_KINDS;

function effect<S extends z.ZodType>(def: EffectDef<S>): EffectDef<S> {
  return def;
}

export const MEDIA_MODES = ["video", "audio_only", "captions_only", "metadata_only"] as const;
export const FORMAT_POLICIES = ["prefer_av1", "prefer_vp9", "prefer_h264", "best"] as const;
export const TRANSCODE_MODES = ["none", "if_not_av1", "always"] as const;
export const TRANSCODE_CODECS = ["hevc_nvenc", "h264_nvenc", "av1_svt", "av1_nvenc"] as const;
export const AUDIO_CODECS = ["copy", "aac", "opus"] as const;
export const LIVE_MODES = ["vod_only", "record_live"] as const;
export const NOTIFY_CHANNELS = ["push"] as const;

/**
 * yt-dlp flags a rule may pass through `ytdlp.extra_args_allowlisted`, as
 * `--flag` or `--flag=value`. Nothing that executes commands, reads or writes
 * arbitrary paths, or carries credentials (cookies, proxies) is listed.
 */
export const YTDLP_EXTRA_ARGS_ALLOWLIST = [
  "--embed-metadata",
  "--no-embed-metadata",
  "--embed-chapters",
  "--no-embed-chapters",
  "--embed-thumbnail",
  "--no-embed-thumbnail",
  "--embed-subs",
  "--no-embed-subs",
  "--no-mtime",
  "--sponsorblock-mark",
  "--sponsorblock-remove",
  "--geo-bypass",
  "--no-geo-bypass",
  "--xff",
  "--retries",
  "--fragment-retries",
  "--extractor-retries",
  "--socket-timeout",
  "--throttled-rate",
  "--http-chunk-size",
  "--force-ipv4",
  "--force-ipv6",
  "--hls-use-mpegts",
  "--check-formats",
  "--no-check-formats",
  "--merge-output-format",
  "--remux-video",
  "--extractor-args",
  "--live-from-start",
  "--no-live-from-start",
] as const;

const YTDLP_ARG_RE = /^(--[a-z0-9-]+)(?:=[^\s\0]{1,200})?$/;

/** True when an extra yt-dlp argument is `--flag` or `--flag=value` for an allowlisted flag. */
export function isAllowlistedYtdlpArg(arg: string): boolean {
  const m = YTDLP_ARG_RE.exec(arg);
  return m !== null && (YTDLP_EXTRA_ARGS_ALLOWLIST as readonly string[]).includes(m[1]!);
}

const LANGUAGE_RE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8})*$/;

export const TranscodeSchema = z.strictObject({
  mode: z.enum(TRANSCODE_MODES).default("if_not_av1"),
  /** `av1_nvenc` is only usable when the GPU supports it; the server checks. */
  codec: z.enum(TRANSCODE_CODECS).default("hevc_nvenc"),
  /** CQ for NVENC codecs, CRF for SVT-AV1. */
  quality: z.int().min(0).max(63).default(28),
  preset: z
    .string()
    .regex(/^[A-Za-z0-9]{1,16}$/)
    .default("p5"),
  max_video_bitrate_kbps: z.int().min(50).max(500_000).optional(),
  audio_codec: z.enum(AUDIO_CODECS).default("copy"),
  audio_bitrate_kbps: z.int().min(8).max(1024).optional(),
});
export type Transcode = z.infer<typeof TranscodeSchema>;

export const CaptionsSchema = z.strictObject({
  enabled: z.boolean().default(true),
  languages: z
    .union([z.literal("all"), z.array(z.string().regex(LANGUAGE_RE)).min(1).max(100)])
    .default("all"),
  auto_generated: z.boolean().default(true),
});
export type Captions = z.infer<typeof CaptionsSchema>;

export const YtdlpOptionsSchema = z
  .strictObject({
    format_override: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^\s\0]+$/)
      .optional(),
    rate_limit_bytes_per_s: z.int().positive().optional(),
    sleep_requests_min: z.number().min(0).max(3600).optional(),
    sleep_requests_max: z.number().min(0).max(3600).optional(),
    concurrent_fragments: z.int().min(1).max(32).optional(),
    extra_args_allowlisted: z
      .array(
        z.string().refine(isAllowlistedYtdlpArg, { message: "yt-dlp argument is not allowlisted" }),
      )
      .max(32)
      .optional(),
  })
  .refine(
    (o) =>
      o.sleep_requests_min === undefined ||
      o.sleep_requests_max === undefined ||
      o.sleep_requests_min <= o.sleep_requests_max,
    {
      message: "sleep_requests_min must not exceed sleep_requests_max",
      path: ["sleep_requests_max"],
    },
  );
export type YtdlpOptions = z.infer<typeof YtdlpOptionsSchema>;

export const NotifySchema = z.strictObject({
  enabled: z.boolean().default(false),
  /** Times to notify per video; null = unlimited. */
  max_times: z.int().min(1).max(1000).nullable().default(1),
  channel: z.enum(NOTIFY_CHANNELS).default("push"),
});
export type Notify = z.infer<typeof NotifySchema>;

/** `sourcing` = accounts whose sources found the video; `any` = any linked account. */
export const DownloadAccountsSchema = z.union([
  z.enum(["sourcing", "any"]),
  z.array(RowIdSchema).min(1).max(100),
]);
/** `none`, `pool` (all enabled proxies, round-robin) or specific proxy ids. */
export const ProxySchema = z.union([
  z.enum(["none", "pool"]),
  z.array(RowIdSchema).min(1).max(100),
]);

function options(values: readonly string[]): EffectOption[] {
  return values.map((value) => ({ value, label: value.replace(/_/g, " ") }));
}

export const effectRegistry = {
  include: effect({
    schema: z.boolean(),
    default: true,
    allowedIn: ["custom", "video"],
    ui: {
      group: "storage",
      label: "Include",
      description: "Archive matching videos. Excluded videos are never downloaded.",
      control: "toggle",
    },
  }),
  reclaim_priority: effect({
    schema: z.int().min(-1),
    default: -1,
    allowedIn: ALL_KINDS,
    ui: {
      group: "storage",
      label: "Reclaim priority",
      description:
        "-1 never delete; 0 delete now and never re-download; higher values are reaped lowest first when a location is full.",
      control: "int",
      min: -1,
    },
  }),
  location_id: effect({
    schema: RowIdSchema.nullable(),
    default: null,
    allowedIn: ALL_KINDS,
    ui: {
      group: "storage",
      label: "Storage location",
      description: "Where the media is stored. A changed location moves existing media.",
      control: "location",
      nullLabel: "First enabled location",
    },
  }),
  media_mode: effect({
    schema: z.enum(MEDIA_MODES),
    default: "video",
    allowedIn: ALL_KINDS,
    ui: {
      group: "media",
      label: "Media",
      description: "Download video, audio only, captions only, or metadata only.",
      control: "select",
      options: options(MEDIA_MODES),
    },
  }),
  format_policy: effect({
    schema: z.enum(FORMAT_POLICIES),
    default: "prefer_av1",
    allowedIn: ALL_KINDS,
    ui: {
      group: "media",
      label: "Format policy",
      description: "Which YouTube video codec to prefer when downloading.",
      control: "select",
      options: options(FORMAT_POLICIES),
    },
  }),
  max_height: effect({
    schema: z.int().positive().max(8640).nullable(),
    default: null,
    allowedIn: ALL_KINDS,
    ui: {
      group: "media",
      label: "Max resolution",
      description: "Highest video height to download, in pixels.",
      control: "int",
      min: 1,
      max: 8640,
      nullLabel: "No limit",
    },
  }),
  max_fps: effect({
    schema: z.int().positive().max(480).nullable(),
    default: null,
    allowedIn: ALL_KINDS,
    ui: {
      group: "media",
      label: "Max frame rate",
      description: "Highest frame rate to download.",
      control: "int",
      min: 1,
      max: 480,
      nullLabel: "No limit",
    },
  }),
  transcode: effect({
    schema: TranscodeSchema,
    default: {
      mode: "if_not_av1",
      codec: "hevc_nvenc",
      quality: 28,
      preset: "p5",
      audio_codec: "copy",
    },
    allowedIn: ALL_KINDS,
    ui: {
      group: "media",
      label: "Transcode",
      description: "Re-encode after download (by default only when YouTube had no AV1).",
      control: "transcode",
    },
  }),
  captions: effect({
    schema: CaptionsSchema,
    default: { enabled: true, languages: "all", auto_generated: true },
    allowedIn: ALL_KINDS,
    ui: {
      group: "media",
      label: "Captions",
      description: "Caption languages to download, and whether to include auto-generated ones.",
      control: "captions",
    },
  }),
  live: effect({
    schema: z.enum(LIVE_MODES),
    default: "vod_only",
    allowedIn: ALL_KINDS,
    ui: {
      group: "media",
      label: "Livestreams",
      description: "Wait for the VOD, or record livestreams while live.",
      control: "select",
      options: options(LIVE_MODES),
    },
  }),
  ytdlp: effect({
    schema: YtdlpOptionsSchema,
    default: {},
    allowedIn: ALL_KINDS,
    ui: {
      group: "download",
      label: "yt-dlp options",
      description: "Format override, rate limit, request sleeps, fragments and allowlisted flags.",
      control: "ytdlp",
    },
  }),
  download_accounts: effect({
    schema: DownloadAccountsSchema,
    default: "sourcing",
    allowedIn: ALL_KINDS,
    ui: {
      group: "download",
      label: "Download accounts",
      description: "Which accounts' cookies download the video (round-robin).",
      control: "accounts",
    },
  }),
  proxy: effect({
    schema: ProxySchema,
    default: "none",
    allowedIn: ALL_KINDS,
    ui: {
      group: "download",
      label: "Proxy",
      description: "No proxy, the whole proxy pool, or specific proxies (round-robin).",
      control: "proxy",
    },
  }),
  delay_after_upload: effect({
    schema: RuleDurationSchema.nullable(),
    default: null,
    allowedIn: ALL_KINDS,
    ui: {
      group: "download",
      label: "Delay after upload",
      description: "Wait this long after the upload date before downloading.",
      control: "duration",
      nullLabel: "No delay",
    },
  }),
  recheck_interval: effect({
    schema: z.union([z.literal("tiered"), RuleDurationSchema]),
    default: "tiered",
    allowedIn: ALL_KINDS,
    ui: {
      group: "metadata",
      label: "Metadata recheck",
      description: "How often metadata is rechecked: tiered by age, or a fixed interval.",
      control: "recheck",
    },
  }),
  notify: effect({
    schema: NotifySchema,
    default: { enabled: false, max_times: 1, channel: "push" },
    allowedIn: ALL_KINDS,
    ui: {
      group: "notifications",
      label: "Notify",
      description: "Push-notify when a video matches, up to N times per video (or unlimited).",
      control: "notify",
    },
  }),
} as const;

export type EffectRegistry = typeof effectRegistry;
export type EffectKey = keyof EffectRegistry;

export const EFFECT_KEYS = Object.keys(effectRegistry) as EffectKey[];

type EffectShape = { [K in EffectKey]: EffectRegistry[K]["schema"] };
const effectShape = Object.fromEntries(
  EFFECT_KEYS.map((k) => [k, effectRegistry[k].schema]),
) as EffectShape;

/** Fully-resolved settings for one video: every effect key present. */
export const EffectiveSettingsSchema = z.strictObject(effectShape);
export type EffectiveSettings = z.output<typeof EffectiveSettingsSchema>;

/** Sparse map of effect key to value, as stored in `rules.effects_json`. */
export const EffectsSchema = EffectiveSettingsSchema.partial();
export type Effects = z.output<typeof EffectsSchema>;
export type EffectsInput = z.input<typeof EffectsSchema>;

/** True when a rule of `kind` may set `key` (only `include` is restricted: not global). */
export function effectAllowedIn(key: EffectKey, kind: RuleKind): boolean {
  return effectRegistry[key].allowedIn.includes(kind);
}

/** A fresh copy of the registry defaults. */
export function effectDefaults(): EffectiveSettings {
  return cloneJson(
    Object.fromEntries(EFFECT_KEYS.map((k) => [k, effectRegistry[k].default])),
  ) as EffectiveSettings;
}
