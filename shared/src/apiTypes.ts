import { z } from "zod";

/**
 * Wire contract for GET /api/status. Owned by the server, consumed by the admin
 * SPA's StatusPill and InsecureBanner. Extend, never rename, fields.
 */
export const StatusResponseSchema = z.object({
  version: z.string(),
  /** True when INSECURE_ALLOW_PUBLIC_ACCESS=1 (no auth, loopback bind). */
  insecureMode: z.boolean(),
  startedAt: z.number().int(),
  now: z.number().int(),
  db: z.object({
    ok: z.boolean(),
    migrations: z.number().int(),
  }),
  tools: z.object({
    ytdlp: z.string().nullable(),
    ffmpeg: z.string().nullable(),
  }),
});
export type StatusResponse = z.infer<typeof StatusResponseSchema>;

/** Every 4xx/5xx JSON body has this shape. */
export const ApiErrorSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ---------------------------------------------------------------------------
// Paged lists: every list endpoint returns this envelope.
// ---------------------------------------------------------------------------
export function pagedSchema<T extends z.ZodTypeAny>(row: T) {
  return z.object({
    rows: z.array(row),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    perPage: z.number().int().positive(),
  });
}

// ---------------------------------------------------------------------------
// Rules API (/api/rules). Rule rows are the shared RuleSchema plus timestamps.
//   GET    /api/rules                 -> { rows: RuleRow[] } (global first, custom by position, no video rules)
//   POST   /api/rules                 <- RuleDraft (kind custom)        -> RuleRow
//   PUT    /api/rules/:id             <- RuleDraft (same kind)          -> RuleRow
//   DELETE /api/rules/:id             (custom only)                      -> 204
//   PUT    /api/rules/order           <- { ids: number[] } (custom ids in new ascending position order) -> { rows }
//   POST   /api/rules/preview         <- { condition } -> RulePreview
//   GET    /api/inspect?id=<identifier> -> InspectResponse
//   PUT    /api/videos/:id/overrides  <- { effects: Effects | null } (null deletes the video rule) -> InspectResponse
// ---------------------------------------------------------------------------
export const RuleRowSchema = z.object({
  id: z.number().int(),
  kind: z.enum(["global", "custom", "video"]),
  video_id: z.string().nullable(),
  position: z.number().int(),
  name: z.string(),
  enabled: z.boolean(),
  condition: z.unknown().nullable(),
  effects: z.record(z.string(), z.unknown()),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type RuleRow = z.infer<typeof RuleRowSchema>;

export const RulesListResponseSchema = z.object({ rows: z.array(RuleRowSchema) });
export type RulesListResponse = z.infer<typeof RulesListResponseSchema>;

export const RulePreviewSchema = z.object({
  count: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  sample: z.array(
    z.object({ id: z.string(), title: z.string(), channel_title: z.string().nullable() }),
  ),
});
export type RulePreview = z.infer<typeof RulePreviewSchema>;

export const InspectResponseSchema = z.object({
  video_id: z.string(),
  known: z.boolean(),
  title: z.string().nullable(),
  channel_title: z.string().nullable(),
  matched: z.array(
    z.object({
      id: z.number().int(),
      kind: z.enum(["global", "custom", "video"]),
      name: z.string(),
      position: z.number().int(),
    }),
  ),
  effective: z.record(z.string(), z.unknown()),
  provenance: z.record(z.string(), z.union([z.number().int(), z.literal("default")])),
  overrides: z.record(z.string(), z.unknown()).nullable(),
  evaluated_at: z.number().int().nullable(),
});
export type InspectResponse = z.infer<typeof InspectResponseSchema>;

// ---------------------------------------------------------------------------
// Settings API (/api/settings): GET returns the sparse overrides, PUT takes a
// SettingsPatch (null clears a key) and returns the new sparse overrides.
// ---------------------------------------------------------------------------
export const SettingsResponseSchema = z.object({
  overrides: z.record(z.string(), z.unknown()),
});
export type SettingsResponse = z.infer<typeof SettingsResponseSchema>;

// ---------------------------------------------------------------------------
// Channel autocomplete used by the rule builder: GET /api/channels?q=<text>&limit=10
// ---------------------------------------------------------------------------
export const ChannelRowSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  handle: z.string().nullable(),
  thumbnail_url: z.string().nullable(),
  subscribed: z.boolean(),
  manual: z.boolean(),
  video_count: z.number().int().nonnegative(),
});
export type ChannelRow = z.infer<typeof ChannelRowSchema>;
export const ChannelsListResponseSchema = pagedSchema(ChannelRowSchema);
export type ChannelsListResponse = z.infer<typeof ChannelsListResponseSchema>;

// ---------------------------------------------------------------------------
// Locations API (/api/locations): CRUD, used by the rule builder's location picker.
// ---------------------------------------------------------------------------
export const LocationRowSchema = z.object({
  id: z.number().int(),
  label: z.string(),
  container_path: z.string(),
  quota_bytes: z.number().int().nonnegative(),
  enabled: z.boolean(),
  used_bytes: z.number().int().nonnegative(),
  fs_free_bytes: z.number().int().nonnegative().nullable(),
  mounted: z.boolean(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type LocationRow = z.infer<typeof LocationRowSchema>;
export const LocationsListResponseSchema = z.object({ rows: z.array(LocationRowSchema) });

// Account rows (sparse, enough for pickers): GET /api/accounts -> { rows }
export const AccountRowSchema = z.object({
  id: z.number().int(),
  label: z.string(),
  email: z.string().nullable(),
  channel_id: z.string().nullable(),
  status: z.enum(["pending", "ok", "auth_lost", "cookies_invalid", "disabled"]),
  has_cookies: z.boolean(),
  /** null = the global quota.scrape_requests_per_hour applies. */
  scrape_budget_per_hour: z.number().int().nonnegative().nullable(),
  last_api_ok_at: z.number().int().nullable(),
  last_cookie_ok_at: z.number().int().nullable(),
  created_at: z.number().int(),
});
export type AccountRow = z.infer<typeof AccountRowSchema>;
export const AccountsListResponseSchema = z.object({ rows: z.array(AccountRowSchema) });

// Proxy rows: GET /api/proxies -> { rows } (URL never returned, only a redacted label)
export const ProxyRowSchema = z.object({
  id: z.number().int(),
  label: z.string(),
  url_redacted: z.string(),
  enabled: z.boolean(),
  fail_count: z.number().int().nonnegative(),
  skipped_until: z.number().int().nullable(),
});
export type ProxyRow = z.infer<typeof ProxyRowSchema>;
export const ProxiesListResponseSchema = z.object({ rows: z.array(ProxyRowSchema) });

// --- wave1B ---
// Jobs, activity and notifications (server/src/jobs, domain/activity.ts,
// domain/notifications.ts).
//   GET  /api/jobs?page&perPage&status&type   -> JobsListResponse
//   GET  /api/jobs/:id                         -> JobRow
//   GET  /api/jobs/:id/log                     -> JobLogFilesResponse
//   GET  /api/jobs/:id/log/:name               -> text/plain (a .gz file is served decompressed)
//   POST /api/jobs/:id/cancel                  -> JobRow
//   POST /api/jobs/:id/retry                   -> JobRow
//   GET  /api/activity?page&perPage&level&kind&video_id -> ActivityListResponse
//   POST /api/actions/:name                    -> 202 ActionResponse | 501 { code: "not_implemented" }
//   GET  /api/notifications?page&perPage&unacked -> NotificationsListResponse
//   POST /api/notifications/:id/ack            -> NotificationRow
//   POST /api/notifications/ack-all            -> AckAllResponse
//   GET  /api/notifications/vapid-public-key   -> VapidPublicKeyResponse
//   POST /api/notifications/subscribe          <- PushSubscriptionInput -> 204
//   DELETE /api/notifications/subscribe        <- PushUnsubscribeInput -> 204
//   POST /api/notifications/test               -> NotifyResult
// SSE (/api/events): job.queued | job.started | job.progress | job.done | job.failed |
// job.cancelled carry a JobEventPayload; "activity" carries an ActivityRow;
// "notification" carries { id, type, title }.
// ---------------------------------------------------------------------------
export const JOB_STATUSES = ["queued", "running", "done", "failed", "cancelled"] as const;
export const JobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobRowSchema = z.object({
  id: z.number().int(),
  type: z.string(),
  status: JobStatusSchema,
  /** Higher runs first. */
  priority: z.number().int(),
  account_id: z.number().int().nullable(),
  video_id: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  max_attempts: z.number().int().positive(),
  run_after: z.number().int(),
  started_at: z.number().int().nullable(),
  finished_at: z.number().int().nullable(),
  error: z.string().nullable(),
  created_at: z.number().int(),
});
export type JobRow = z.infer<typeof JobRowSchema>;
export const JobsListResponseSchema = pagedSchema(JobRowSchema);
export type JobsListResponse = z.infer<typeof JobsListResponseSchema>;

const pageParam = z.coerce.number().int().positive().default(1);
const perPageParam = z.coerce.number().int().positive().max(200).default(50);

export const JobsQuerySchema = z.object({
  page: pageParam,
  perPage: perPageParam,
  status: JobStatusSchema.optional(),
  type: z.string().min(1).max(100).optional(),
});
export type JobsQuery = z.infer<typeof JobsQuerySchema>;

export const JobLogFilesResponseSchema = z.object({
  files: z.array(z.object({ name: z.string(), size: z.number().int().nonnegative() })),
});
export type JobLogFilesResponse = z.infer<typeof JobLogFilesResponseSchema>;

export const JobEventPayloadSchema = z.object({
  id: z.number().int(),
  type: z.string(),
  videoId: z.string().nullable(),
  accountId: z.number().int().nullable().optional(),
  pct: z.number().optional(),
  message: z.string().optional(),
  error: z.string().optional(),
  willRetry: z.boolean().optional(),
  runAfter: z.number().int().optional(),
});
export type JobEventPayload = z.infer<typeof JobEventPayloadSchema>;

export const ACTION_NAMES = [
  "refresh-all",
  "eval-now",
  "reap-now",
  "ingest-now",
  "selfcheck",
  "tools-update",
] as const;
export const ActionNameSchema = z.enum(ACTION_NAMES);
export type ActionName = z.infer<typeof ActionNameSchema>;
export const ActionResponseSchema = z.object({ job_id: z.number().int() });
export type ActionResponse = z.infer<typeof ActionResponseSchema>;

export const ACTIVITY_LEVELS = ["debug", "info", "warn", "error"] as const;
export const ActivityLevelSchema = z.enum(ACTIVITY_LEVELS);
export type ActivityLevel = z.infer<typeof ActivityLevelSchema>;

export const ActivityRowSchema = z.object({
  id: z.number().int(),
  at: z.number().int(),
  level: ActivityLevelSchema,
  kind: z.string(),
  message: z.string(),
  video_id: z.string().nullable(),
  job_id: z.number().int().nullable(),
  data: z.unknown().nullable(),
});
export type ActivityRow = z.infer<typeof ActivityRowSchema>;
export const ActivityListResponseSchema = pagedSchema(ActivityRowSchema);
export type ActivityListResponse = z.infer<typeof ActivityListResponseSchema>;

export const ActivityQuerySchema = z.object({
  page: pageParam,
  perPage: perPageParam,
  level: ActivityLevelSchema.optional(),
  kind: z.string().min(1).max(100).optional(),
  video_id: z.string().min(1).max(64).optional(),
});
export type ActivityQuery = z.infer<typeof ActivityQuerySchema>;

export const NotificationRowSchema = z.object({
  id: z.number().int(),
  type: z.string(),
  title: z.string(),
  body: z.string(),
  data: z.unknown().nullable(),
  video_id: z.string().nullable(),
  created_at: z.number().int(),
  acked_at: z.number().int().nullable(),
  pushed_at: z.number().int().nullable(),
});
export type NotificationRow = z.infer<typeof NotificationRowSchema>;
export const NotificationsListResponseSchema = pagedSchema(NotificationRowSchema);
export type NotificationsListResponse = z.infer<typeof NotificationsListResponseSchema>;

export const NotificationsQuerySchema = z.object({
  page: pageParam,
  perPage: perPageParam,
  unacked: z
    .enum(["true", "false", "1", "0"])
    .transform((value) => value === "true" || value === "1")
    .optional(),
});
export type NotificationsQuery = z.infer<typeof NotificationsQuerySchema>;

export const AckAllResponseSchema = z.object({ acked: z.number().int().nonnegative() });
export type AckAllResponse = z.infer<typeof AckAllResponseSchema>;

export const VapidPublicKeyResponseSchema = z.object({ key: z.string() });
export type VapidPublicKeyResponse = z.infer<typeof VapidPublicKeyResponseSchema>;

/** Browser push services a subscription endpoint may point at (exact hosts). */
export const PUSH_SERVICE_HOSTS: readonly string[] = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
];
/** Host suffixes of push services that shard by subdomain. */
export const PUSH_SERVICE_HOST_SUFFIXES: readonly string[] = [
  ".notify.windows.com",
  ".push.apple.com",
];

/**
 * True when `endpoint` is an https URL on the default port, without
 * credentials, whose host is a known browser push service. The server
 * POSTs to this URL, so anything else would be a request-forgery primitive.
 *
 * Hand-rolled like idParser (shared has no URL global). The authority must be
 * a plain DNS name: any port, userinfo, percent escape, backslash or other
 * character outside [a-z0-9.-] is refused, so what passes here is read the
 * same way by the WHATWG parser web-push uses.
 */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  const match = /^https:\/\/([^/?#]*)(?:[/?#]|$)/i.exec(endpoint);
  const authority = match?.[1]?.toLowerCase();
  if (authority === undefined || !/^[a-z0-9.-]+$/.test(authority)) {
    return false;
  }
  const host = authority.replace(/\.$/, "");
  return (
    PUSH_SERVICE_HOSTS.includes(host) ||
    PUSH_SERVICE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  );
}

/** The browser's PushSubscription.toJSON(). expirationTime is accepted and ignored. */
export const PushSubscriptionInputSchema = z.object({
  endpoint: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .refine(isAllowedPushEndpoint, "Not a known browser push service endpoint."),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(512),
  }),
});
export type PushSubscriptionInput = z.infer<typeof PushSubscriptionInputSchema>;

export const PushUnsubscribeInputSchema = z.object({ endpoint: z.string().min(1).max(2048) });
export type PushUnsubscribeInput = z.infer<typeof PushUnsubscribeInputSchema>;

export const NotifyResultSchema = z.discriminatedUnion("sent", [
  z.object({ sent: z.literal(true), id: z.number().int(), pushed: z.number().int() }),
  z.object({ sent: z.literal(false), reason: z.literal("rate_limited") }),
]);
export type NotifyResult = z.infer<typeof NotifyResultSchema>;
// --- end wave1B ---
// --- wave1C ---
// ---------------------------------------------------------------------------
// Self-check (/api/checks) and tool updates (/api/tools).
//   GET  /api/checks?limit=N  -> ChecksListResponse (newest first, limit <= 200, default 20)
//   GET  /api/checks/latest   -> LatestCheckResponse
//   POST /api/checks/run      -> CheckRow (trigger "manual")
//   GET  /api/tools           -> ToolsResponse
//   POST /api/tools/update    <- ToolUpdateRequest   -> ToolsResponse (with outcomes)
//   POST /api/tools/rollback  <- ToolRollbackRequest -> ToolsResponse
// ---------------------------------------------------------------------------
export const CHECK_LEVELS = ["ok", "warn", "fail", "skip"] as const;
export const CheckLevelSchema = z.enum(CHECK_LEVELS);
export type CheckLevel = z.infer<typeof CheckLevelSchema>;

export const CHECK_TRIGGERS = ["boot", "schedule", "manual"] as const;
export const CheckTriggerSchema = z.enum(CHECK_TRIGGERS);
export type CheckTrigger = z.infer<typeof CheckTriggerSchema>;

export const CheckResultSchema = z.object({
  /** Stable machine key, e.g. `data.free_space` or `location.1.writable`. */
  key: z.string(),
  label: z.string(),
  level: CheckLevelSchema,
  detail: z.string(),
  /** A headline measurement (free bytes, a version string, skew ms). */
  value: z.union([z.string(), z.number()]).optional(),
  took_ms: z.number().int().nonnegative(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const CheckRowSchema = z.object({
  id: z.number().int(),
  run_at: z.number().int(),
  trigger: CheckTriggerSchema,
  /** True when no result is at level `fail`. */
  ok: z.boolean(),
  results: z.array(CheckResultSchema),
});
export type CheckRow = z.infer<typeof CheckRowSchema>;

export const ChecksQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(20),
});
export type ChecksQuery = z.infer<typeof ChecksQuerySchema>;

export const ChecksListResponseSchema = z.object({ rows: z.array(CheckRowSchema) });
export type ChecksListResponse = z.infer<typeof ChecksListResponseSchema>;

export const LatestCheckResponseSchema = z.object({ row: CheckRowSchema.nullable() });
export type LatestCheckResponse = z.infer<typeof LatestCheckResponseSchema>;

export const UPDATABLE_TOOLS = ["ytdlp", "ffmpeg"] as const;
export const UpdatableToolSchema = z.enum(UPDATABLE_TOOLS);
export type UpdatableTool = z.infer<typeof UpdatableToolSchema>;

/**
 * One tool's update state. For yt-dlp `latest` is the newest release tag. BtbN
 * ffmpeg builds carry no version in their release metadata, so for ffmpeg
 * `latest` is the newest build asset's `updated_at` and `asset_updated_at` is
 * the one installed; `update_available` hides that difference from the UI.
 */
export const ToolVersionsSchema = z.object({
  /** Version string of the binary in /data/bin. */
  current: z.string().nullable(),
  /** Version kept as `<tool>.prev` for rollback. */
  previous: z.string().nullable(),
  /** Version the image shipped (/opt/cellar/bin). */
  baseline: z.string().nullable(),
  latest: z.string().nullable(),
  /** Epoch ms of the last release check, successful or not. */
  checked_at: z.number().int().nullable(),
  /** Epoch ms of the last swap (update or rollback). */
  updated_at: z.number().int().nullable(),
  update_available: z.boolean(),
  /** The last check's failure, null after a clean check. */
  last_error: z.string().nullable(),
  /** After a rollback the release rolled away from is not reinstalled until forced. */
  rolled_back_from: z.string().nullable(),
  /** ffmpeg only: the installed build asset's `updated_at`. */
  asset_updated_at: z.string().nullable().optional(),
});
export type ToolVersionsInfo = z.infer<typeof ToolVersionsSchema>;

/**
 * `blocked`: a staged ffmpeg verified but could not use NVENC where the
 * installed one can (a build too new for the driver), so it was not swapped
 * in. Not retried for the same build until forced.
 */
export const TOOL_UPDATE_STATUSES = [
  "updated",
  "up_to_date",
  "available",
  "skipped",
  "blocked",
  "failed",
] as const;
export const ToolUpdateStatusSchema = z.enum(TOOL_UPDATE_STATUSES);
export type ToolUpdateStatus = z.infer<typeof ToolUpdateStatusSchema>;

export const ToolUpdateOutcomeSchema = z.object({
  tool: UpdatableToolSchema,
  status: ToolUpdateStatusSchema,
  detail: z.string(),
});
export type ToolUpdateOutcome = z.infer<typeof ToolUpdateOutcomeSchema>;

export const ToolsResponseSchema = z.object({
  ytdlp: ToolVersionsSchema,
  ffmpeg: ToolVersionsSchema,
  js_runtime: z.string().nullable(),
  pot_provider_url: z.string(),
  auto_update: z.boolean(),
  /** The BtbN release the ffmpeg updater follows (`tools.ffmpeg_release_tag`). */
  ffmpeg_release_tag: z.string(),
  /** Present on POST /update: what each tool's check did. */
  outcomes: z.array(ToolUpdateOutcomeSchema).optional(),
});
export type ToolsResponse = z.infer<typeof ToolsResponseSchema>;

export const ToolUpdateRequestSchema = z.object({
  tool: UpdatableToolSchema.optional(),
  /** Re-download even when the installed release already matches. */
  force: z.boolean().optional(),
});
export type ToolUpdateRequest = z.infer<typeof ToolUpdateRequestSchema>;

export const ToolRollbackRequestSchema = z.object({ tool: UpdatableToolSchema });
export type ToolRollbackRequest = z.infer<typeof ToolRollbackRequestSchema>;

// --- wave2C ---
// Videos (server/src/domain/videos.ts, videoFiles.ts, bulk.ts; routes/videos.ts).
//   GET  /api/videos?VideosListQuery                 -> VideosListResponse
//   GET  /api/videos/:id                             -> VideoDetail
//   GET  /api/videos/:id/history?page&perPage&field  -> VideoHistoryResponse
//   GET  /api/videos/:id/stats?from&to               -> VideoStatsResponse
//   GET  /api/videos/:id/media/:mediaId[?download=1] -> the file (HTTP Range, HEAD)
//   GET  /api/videos/:id/captions/:lang              -> text/vtt
//   GET  /api/videos/:id/thumbnail/:variant[?sha=]   -> image/jpeg ("best" = fallback chain)
//   GET  /api/videos/:id/metadata.json               -> the stored info.json, else VideoDetail
//   POST /api/videos/:id/download-now                -> 202 VideoJobResponse | 501 not_implemented
//   POST /api/videos/:id/recheck                     -> 202 VideoJobResponse | 501 not_implemented
//   POST /api/videos/trash                  <- TrashRequest -> 202 TrashResponse | 501
//   POST /api/videos/bulk-download/estimate <- BulkDownloadEstimateRequest -> BulkDownloadEstimate
//   POST /api/videos/bulk-download          <- BulkDownloadRequest (JSON or form) -> application/zip
// Query lists (`source`, `status`, `type`) accept `a=x&a=y` or `a=x,y`. Dates accept epoch ms
// or YYYY-MM-DD (UTC; a bare `date_to` / `to` covers that whole day).
// ---------------------------------------------------------------------------
import { SourceKindSchema, STATUS_VALUES, VideoTypeSchema } from "./rules/ast.ts";

export const VIDEO_SORT_KEYS = [
  "upload_date",
  "first_seen",
  "title",
  "views",
  "likes",
  "duration_s",
  "size",
  "reclaim_priority",
  "last_recheck",
] as const;
export const VideoSortSchema = z.enum(VIDEO_SORT_KEYS);
export type VideoSort = z.infer<typeof VideoSortSchema>;

export const VIDEO_PER_PAGE = [25, 50, 100, 200] as const;
export const VIDEO_PRI_FILTERS = ["-1", "0", "positive"] as const;
export const BULK_KINDS = ["video", "audio", "captions", "all"] as const;
export const BulkKindSchema = z.enum(BULK_KINDS);
export type BulkKind = z.infer<typeof BulkKindSchema>;

/** Most ids one trash or bulk-download request may carry. */
export const MAX_BULK_IDS = 10_000;

const VideoIdSchema = z.string().regex(/^[A-Za-z0-9_-]{11}$/, "Not a video id.");

/** `a=x&a=y`, `a=x,y` and `a=x` all read as a list; empty items are dropped. */
function queryList<T extends z.ZodTypeAny>(item: T) {
  return z.preprocess((value) => {
    if (value === undefined) {
      return undefined;
    }
    const parts = (Array.isArray(value) ? value : [value])
      .flatMap((part) => String(part).split(","))
      .map((part) => part.trim())
      .filter((part) => part !== "");
    return parts.length === 0 ? undefined : parts;
  }, z.array(item).max(50).optional());
}

const queryBool = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1")
  .optional();

const DAY_MS = 86_400_000;

/** Epoch ms, or a YYYY-MM-DD date (UTC). `endOfDay` moves a bare date to its last ms. */
function queryInstant(endOfDay: boolean) {
  return z.preprocess((value) => {
    if (typeof value !== "string") {
      return value;
    }
    const text = value.trim();
    if (/^-?\d+$/.test(text)) {
      return Number(text);
    }
    const start = /^\d{4}-\d{2}-\d{2}$/.test(text) ? Date.parse(`${text}T00:00:00Z`) : NaN;
    if (Number.isNaN(start)) {
      return value;
    }
    return endOfDay ? start + DAY_MS - 1 : start;
  }, z.number().int().optional());
}

export const VideosListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce
    .number()
    .int()
    .refine((value) => (VIDEO_PER_PAGE as readonly number[]).includes(value), {
      message: "perPage must be 25, 50, 100 or 200.",
    })
    .default(50),
  /** Omitted with `q` set: rank by relevance (bm25). Omitted without `q`: upload_date. */
  sort: VideoSortSchema.optional(),
  dir: z.enum(["asc", "desc"]).default("desc"),
  /** Full text search over title, description, channel title and tags. */
  q: z.string().max(500).optional(),
  source: queryList(SourceKindSchema),
  account_id: z.coerce.number().int().positive().optional(),
  channel_id: z.string().min(1).max(64).optional(),
  status: queryList(z.enum(STATUS_VALUES)),
  downloaded: queryBool,
  location_id: z.coerce.number().int().positive().optional(),
  type: queryList(VideoTypeSchema),
  /** upload_date bounds, inclusive. */
  date_from: queryInstant(false),
  date_to: queryInstant(true),
  /** duration_s bounds in seconds, inclusive. */
  min_duration: z.coerce.number().int().nonnegative().optional(),
  max_duration: z.coerce.number().int().nonnegative().optional(),
  /** Effective reclaim priority: -1 (keep forever), 0 (trashed) or positive. */
  pri: z.enum(VIDEO_PRI_FILTERS).optional(),
});
export type VideosListQuery = z.infer<typeof VideosListQuerySchema>;
export type VideosListQueryInput = z.input<typeof VideosListQuerySchema>;

export const VideoSourceRefSchema = z.object({
  account_id: z.number().int().nullable(),
  source: z.string(),
  first_seen_at: z.number().int(),
});
export type VideoSourceRef = z.infer<typeof VideoSourceRefSchema>;

export const VideoRowSchema = z.object({
  id: z.string(),
  channel_id: z.string().nullable(),
  channel_title: z.string().nullable(),
  title: z.string().nullable(),
  upload_date: z.number().int().nullable(),
  published_at: z.number().int().nullable(),
  duration_s: z.number().int().nullable(),
  /** video | short | livestream | premiere. Free text so a new value never breaks a client. */
  type: z.string().nullable(),
  /** public | unlisted | private | removed | unavailable. */
  privacy: z.string().nullable(),
  gone_since: z.number().int().nullable(),
  views: z.number().int().nullable(),
  likes: z.number().int().nullable(),
  comments: z.number().int().nullable(),
  /** Estimated (Return YouTube Dislike). */
  ryd_ratio: z.number().nullable(),
  caption_available: z.boolean().nullable(),
  max_height: z.number().int().nullable(),
  has_av1: z.boolean().nullable(),
  sources: z.array(VideoSourceRefSchema),
  /** True when a current video or audio file exists. */
  downloaded: z.boolean(),
  /** Bytes of the current video and audio files. */
  media_size_bytes: z.number().int().nonnegative(),
  /** Where the current file lives, else where the rules want it (video_effective). */
  location_id: z.number().int().nullable(),
  /** From video_effective; null until the video has been evaluated. */
  reclaim_priority: z.number().int().nullable(),
  include: z.boolean().nullable(),
  /** Server route of the best stored thumbnail (content addressed); null when none is stored. */
  thumbnail_url: z.string().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type VideoRow = z.infer<typeof VideoRowSchema>;
export const VideosListResponseSchema = pagedSchema(VideoRowSchema);
export type VideosListResponse = z.infer<typeof VideosListResponseSchema>;

export const VideoFormatsSummarySchema = z.object({
  max_height: z.number().int().nullable(),
  max_fps: z.number().nullable(),
  has_av1: z.boolean().nullable(),
  has_vp9: z.boolean().nullable(),
  has_h264: z.boolean().nullable(),
  is_hdr: z.boolean().nullable(),
});
export type VideoFormatsSummary = z.infer<typeof VideoFormatsSummarySchema>;

export const MEDIA_KINDS = ["video", "audio", "captions", "info"] as const;
export const MediaKindSchema = z.enum(MEDIA_KINDS);
export type MediaKind = z.infer<typeof MediaKindSchema>;

export const MediaRowSchema = z.object({
  id: z.number().int(),
  kind: MediaKindSchema,
  version: z.number().int(),
  is_current: z.boolean(),
  location_id: z.number().int().nullable(),
  rel_path: z.string(),
  size_bytes: z.number().int().nonnegative(),
  vcodec: z.string().nullable(),
  acodec: z.string().nullable(),
  height: z.number().int().nullable(),
  fps: z.number().nullable(),
  bitrate: z.number().int().nullable(),
  lang: z.string().nullable(),
  downloaded_at: z.number().int().nullable(),
  transcoded_from: z.string().nullable(),
});
export type MediaRow = z.infer<typeof MediaRowSchema>;

export const VideoEffectiveSchema = z.object({
  values: z.record(z.string(), z.unknown()),
  provenance: z.record(z.string(), z.unknown()),
  matched_rule_ids: z.array(z.number().int()),
  evaluated_at: z.number().int(),
  next_eval_at: z.number().int().nullable(),
});
export type VideoEffective = z.infer<typeof VideoEffectiveSchema>;

export const VideoThumbnailSchema = z.object({
  variant: z.string(),
  sha256: z.string(),
  first_seen_at: z.number().int(),
  url: z.string(),
});
export type VideoThumbnail = z.infer<typeof VideoThumbnailSchema>;

export const VideoShareLinkSchema = z.object({
  token: z.string(),
  expires_at: z.number().int().nullable(),
  revoked_at: z.number().int().nullable(),
  access_count: z.number().int().nonnegative(),
  created_at: z.number().int(),
});
export type VideoShareLink = z.infer<typeof VideoShareLinkSchema>;

export const VideoDetailSchema = VideoRowSchema.extend({
  description: z.string().nullable(),
  tags: z.array(z.string()),
  category_id: z.string().nullable(),
  default_language: z.string().nullable(),
  formats: VideoFormatsSummarySchema,
  live_status: z.string().nullable(),
  last_recheck_at: z.number().int().nullable(),
  next_recheck_at: z.number().int().nullable(),
  recheck_tier: z.string().nullable(),
  consecutive_recheck_failures: z.number().int().nonnegative(),
  effective: VideoEffectiveSchema.nullable(),
  /** The per-video (`video` kind) rule's effects; null when there is none. */
  overrides: z.record(z.string(), z.unknown()).nullable(),
  /** Every media row, current and older versions (by kind, newest version first). */
  media: z.array(MediaRowSchema),
  /** Current caption files. */
  captions: z.array(z.object({ lang: z.string(), media_id: z.number().int() })),
  /** Every stored thumbnail, newest first. */
  thumbnails: z.array(VideoThumbnailSchema),
  share_links: z.array(VideoShareLinkSchema),
});
export type VideoDetail = z.infer<typeof VideoDetailSchema>;

export const VideoHistoryQuerySchema = z.object({
  page: pageParam,
  perPage: perPageParam,
  field: z.string().min(1).max(64).optional(),
});
export type VideoHistoryQuery = z.infer<typeof VideoHistoryQuerySchema>;

export const VideoChangeRowSchema = z.object({
  id: z.number().int(),
  field: z.string(),
  old: z.unknown(),
  new: z.unknown(),
  seen_at: z.number().int(),
  recheck_id: z.number().int().nullable(),
});
export type VideoChangeRow = z.infer<typeof VideoChangeRowSchema>;
export const VideoHistoryResponseSchema = pagedSchema(VideoChangeRowSchema);
export type VideoHistoryResponse = z.infer<typeof VideoHistoryResponseSchema>;

export const VideoStatsQuerySchema = z.object({
  from: queryInstant(false),
  to: queryInstant(true),
});
export type VideoStatsQuery = z.infer<typeof VideoStatsQuerySchema>;

export const VideoStatsPointSchema = z.object({
  at: z.number().int(),
  views: z.number().int().nullable(),
  likes: z.number().int().nullable(),
  comments: z.number().int().nullable(),
  ryd_dislikes: z.number().int().nullable(),
});
export type VideoStatsPoint = z.infer<typeof VideoStatsPointSchema>;
export const VideoStatsResponseSchema = z.object({ points: z.array(VideoStatsPointSchema) });
export type VideoStatsResponse = z.infer<typeof VideoStatsResponseSchema>;

export const VideoJobResponseSchema = z.object({
  job_id: z.number().int(),
  /** True when an equivalent queued or running job already existed. */
  deduped: z.boolean(),
});
export type VideoJobResponse = z.infer<typeof VideoJobResponseSchema>;

/** Video ids from JSON (an array) or a form post (repeated or comma separated); deduped. */
const VideoIdListSchema = z.preprocess(
  (value) => {
    const items: unknown = typeof value === "string" ? [value] : value;
    if (!Array.isArray(items)) {
      return value;
    }
    return items
      .flatMap((part: unknown) => (typeof part === "string" ? part.split(",") : [part]))
      .map((part) => (typeof part === "string" ? part.trim() : part))
      .filter((part) => part !== "");
  },
  z
    .array(VideoIdSchema)
    .min(1)
    .max(MAX_BULK_IDS)
    .transform((ids) => [...new Set(ids)]),
);

export const TrashRequestSchema = z.object({ ids: VideoIdListSchema });
export type TrashRequest = z.infer<typeof TrashRequestSchema>;
export const TrashResponseSchema = z.object({ count: z.number().int().nonnegative() });
export type TrashResponse = z.infer<typeof TrashResponseSchema>;

export const BulkDownloadEstimateRequestSchema = z.object({
  ids: VideoIdListSchema,
  kind: BulkKindSchema.default("video"),
});
export type BulkDownloadEstimateRequest = z.infer<typeof BulkDownloadEstimateRequestSchema>;

export const BulkDownloadRequestSchema = z.object({
  ids: VideoIdListSchema,
  /** A filename template for shared renderFilename; defaults to DEFAULT_FILENAME_TEMPLATE. */
  template: z.string().trim().min(1).max(500).optional(),
  kind: BulkKindSchema.default("video"),
});
export type BulkDownloadRequest = z.infer<typeof BulkDownloadRequestSchema>;

export const BulkDownloadEstimateSchema = z.object({
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  /** True above the bulk.warn_gb setting. There is no hard cap. */
  warn: z.boolean(),
});
export type BulkDownloadEstimate = z.infer<typeof BulkDownloadEstimateSchema>;
// --- end wave2C ---
// --- wave5A ---
// Share links (server/src/domain/shares.ts, routes/shares.ts, public/share.ts).
//   GET    /api/shares?SharesListQuery          -> SharesListResponse
//   POST   /api/shares        <- ShareCreateRequest -> 201 ShareLinkRow
//   GET    /api/shares/:token                   -> ShareLinkRow
//   POST   /api/shares/:token/revoke            -> ShareLinkRow (idempotent)
//   POST   /api/shares/revoke <- ShareRevokeBulkRequest -> ShareRevokeBulkResponse
//   DELETE /api/shares/:token                   -> 204 (revoked links only, else 409)
// Public, no auth; every invalid state answers the same 404 HTML page:
//   GET /s/:token                 share.html with SharePublicData injected as
//                                 <script id="share-data" type="application/json">
//   GET /s/:token/meta            -> SharePublicData
//   GET /s/:token/video, /audio   the current file (HTTP Range, HEAD, ?download=1)
//   GET /s/:token/captions/:lang  -> text/vtt
//   GET /s/:token/thumbnail       -> image/jpeg (best stored variant)
//   GET /s/:token/metadata.json   -> the stored info.json minus local paths, else a
//                                    picked subset of the video row; both carry share: true
// ---------------------------------------------------------------------------

/** 16 random bytes, base64url without padding: exactly 22 characters. */
export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
export const ShareTokenSchema = z.string().regex(SHARE_TOKEN_RE, "Not a share token.");

export const SHARE_STATUSES = ["active", "expired", "revoked"] as const;
export const ShareStatusSchema = z.enum(SHARE_STATUSES);
export type ShareStatus = z.infer<typeof ShareStatusSchema>;

export const SHARE_SORT_KEYS = [
  "created_at",
  "expires_at",
  "access_count",
  "last_access_at",
] as const;
export const ShareSortSchema = z.enum(SHARE_SORT_KEYS);
export type ShareSort = z.infer<typeof ShareSortSchema>;

export const SHARE_PER_PAGE = [25, 50, 100] as const;

export const ShareLinkRowSchema = z.object({
  token: z.string(),
  video_id: z.string(),
  /** The video's title (null until its metadata is known). */
  title: z.string().nullable(),
  channel_title: z.string().nullable(),
  /** Epoch ms; null = never expires. */
  expires_at: z.number().int().nullable(),
  revoked_at: z.number().int().nullable(),
  access_count: z.number().int().nonnegative(),
  last_access_at: z.number().int().nullable(),
  created_at: z.number().int(),
  /** Absolute public URL, from PUBLIC_ORIGIN. */
  url: z.string(),
  /** Computed: revoked wins over expired. */
  status: ShareStatusSchema,
});
export type ShareLinkRow = z.infer<typeof ShareLinkRowSchema>;

/** The filter half of the list query; also what "revoke all matching" carries. */
export const ShareFilterSchema = z.object({
  /** Case-insensitive substring of the video title or the token. */
  q: z.string().trim().max(200).optional(),
  status: ShareStatusSchema.optional(),
  video_id: VideoIdSchema.optional(),
});
export type ShareFilter = z.infer<typeof ShareFilterSchema>;

export const SharesListQuerySchema = ShareFilterSchema.extend({
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce
    .number()
    .int()
    .refine((value) => (SHARE_PER_PAGE as readonly number[]).includes(value), {
      message: "perPage must be 25, 50 or 100.",
    })
    .default(25),
  sort: ShareSortSchema.default("created_at"),
  dir: z.enum(["asc", "desc"]).default("desc"),
});
export type SharesListQuery = z.infer<typeof SharesListQuerySchema>;
export type SharesListQueryInput = z.input<typeof SharesListQuerySchema>;

export const SharesListResponseSchema = pagedSchema(ShareLinkRowSchema);
export type SharesListResponse = z.infer<typeof SharesListResponseSchema>;

export const ShareCreateRequestSchema = z.object({
  video_id: VideoIdSchema,
  /** Epoch ms in the future, or null (or omitted) for a link that never expires. */
  expires_at: z.number().int().positive().nullable().default(null),
});
export type ShareCreateRequest = z.infer<typeof ShareCreateRequestSchema>;
export type ShareCreateRequestInput = z.input<typeof ShareCreateRequestSchema>;

/** Most tokens one bulk revoke may name. */
export const MAX_SHARE_REVOKE_TOKENS = 10_000;

export const ShareRevokeBulkRequestSchema = z.union([
  z.object({ tokens: z.array(ShareTokenSchema).min(1).max(MAX_SHARE_REVOKE_TOKENS) }).strict(),
  // Paging and sort fields are accepted and ignored.
  z.object({ all_matching: SharesListQuerySchema }).strict(),
]);
export type ShareRevokeBulkRequest = z.infer<typeof ShareRevokeBulkRequestSchema>;
export type ShareRevokeBulkRequestInput = z.input<typeof ShareRevokeBulkRequestSchema>;

export const ShareRevokeBulkResponseSchema = z.object({
  /** Links newly revoked by this call (already revoked ones are not counted). */
  count: z.number().int().nonnegative(),
});
export type ShareRevokeBulkResponse = z.infer<typeof ShareRevokeBulkResponseSchema>;

/** The longest description the public payload carries. */
export const SHARE_DESCRIPTION_MAX = 2000;

/**
 * What the public share page gets (injected into the HTML, and from /meta). It
 * names nothing outside this one video: no settings, accounts, sources, rules,
 * locations or file paths.
 */
export const SharePublicDataSchema = z.object({
  token: z.string(),
  video: z.object({
    id: z.string(),
    title: z.string().nullable(),
    channel_title: z.string().nullable(),
    upload_date: z.number().int().nullable(),
    duration_s: z.number().nullable(),
    /** At most SHARE_DESCRIPTION_MAX characters. */
    description: z.string().nullable(),
    views: z.number().int().nullable(),
    likes: z.number().int().nullable(),
  }),
  /**
   * The file the player plays: the current video media, else the current audio
   * media. Null when nothing is downloaded. `has_audio_only` is true when a
   * separate audio-only file is available too (the audio download).
   */
  media: z
    .object({
      kind: z.enum(["video", "audio"]),
      mime: z.string(),
      size_bytes: z.number().int().nonnegative(),
      height: z.number().int().nullable(),
      has_audio_only: z.boolean(),
    })
    .nullable(),
  captions: z.array(z.object({ lang: z.string(), label: z.string() })),
  /** True when /s/:token/thumbnail has an image. */
  thumbnail: z.boolean(),
  downloads: z.object({
    video: z.string().optional(),
    audio: z.string().optional(),
    /** lang -> URL. */
    captions: z.record(z.string(), z.string()),
    metadata: z.string(),
  }),
});
export type SharePublicData = z.infer<typeof SharePublicDataSchema>;
// --- end wave5A ---
// --- wave5B ---
// Google Takeout import (server/src/domain/takeout.ts, routes/takeout.ts,
// jobs/handlers/takeout.ts).
//   POST /api/takeout?account_id=  multipart: one or more files (.tgz / .tar.gz / .zip, or loose
//        watch-history.json and *.csv); account_id may also be a form field
//        -> 202 TakeoutUploadResponse | 400 { code: TakeoutErrorCode } | 404 (account) | 413
//   GET  /api/takeout/:jobId -> TakeoutJobResponse
//   GET  /api/activity?kind=takeout.imported -> previous imports; `data` is TakeoutCounts
// The job is `takeout_import` (io class); progress arrives as SSE job.progress { id, pct }.
// ---------------------------------------------------------------------------
/** Hard cap on one upload request (all files together). */
export const TAKEOUT_MAX_UPLOAD_BYTES = 2 * 1024 ** 3;
/** The file picker's accept list. */
export const TAKEOUT_ACCEPT = ".tgz,.tar.gz,.zip,.json,.csv";
export const TAKEOUT_ACTIVITY_KIND = "takeout.imported";
export const TAKEOUT_JOB_TYPE = "takeout_import";

/** Machine readable 4xx codes of POST /api/takeout (besides the generic `invalid`). */
export const TAKEOUT_ERROR_CODES = [
  "history_is_html",
  "no_takeout_files",
  "archive_unreadable",
  "unsafe_archive",
  "upload_too_large",
  "no_files",
] as const;
export type TakeoutErrorCode = (typeof TAKEOUT_ERROR_CODES)[number];

export const TakeoutFileKindSchema = z.union([
  z.enum(["history", "watch_later", "liked", "subscription"]),
  z.templateLiteral(["playlist:", z.string()]),
]);

export const TakeoutUploadQuerySchema = z.object({
  account_id: z.coerce.number().int().positive(),
});
export type TakeoutUploadQuery = z.infer<typeof TakeoutUploadQuerySchema>;

/** Row skip counts by reason (shared/src/takeout.ts TakeoutSkipReason). */
const SkipCountsSchema = z.record(z.string(), z.number().int().nonnegative());

export const TakeoutPreviewFileSchema = z.object({
  /** The file's name in the upload or its path inside the archive. */
  name: z.string(),
  kind: TakeoutFileKindSchema,
  /** Rows the dry parse produced (history entries, playlist videos, channels). */
  rows: z.number().int().nonnegative(),
  skipped_rows: SkipCountsSchema,
});
export type TakeoutPreviewFile = z.infer<typeof TakeoutPreviewFileSchema>;

export const TakeoutSkippedFileSchema = z.object({ name: z.string(), reason: z.string() });
export type TakeoutSkippedFile = z.infer<typeof TakeoutSkippedFileSchema>;

export const TakeoutUploadResponseSchema = z.object({
  job_id: z.number().int(),
  files: z.array(TakeoutPreviewFileSchema),
  /** Files that will not be imported, capped; `skipped_total` is the full count. */
  skipped: z.array(TakeoutSkippedFileSchema),
  skipped_total: z.number().int().nonnegative(),
});
export type TakeoutUploadResponse = z.infer<typeof TakeoutUploadResponseSchema>;

/** What one import did. Stored as the `takeout.imported` activity row's data. */
export const TakeoutCountsSchema = z.object({
  account_id: z.number().int(),
  /** History entries read (a video watched three times counts three). */
  history: z.number().int().nonnegative(),
  /** Distinct videos those entries name. */
  history_videos: z.number().int().nonnegative(),
  watch_later: z.number().int().nonnegative(),
  liked: z.number().int().nonnegative(),
  subscriptions: z.number().int().nonnegative(),
  /** Playlists other than Watch later and Liked: counted, not imported (no playlist source). */
  playlists_ignored: z.number().int().nonnegative(),
  playlist_videos_ignored: z.number().int().nonnegative(),
  /** Videos the catalog did not know; created metadata-only and queued for a recheck. */
  new_videos: z.number().int().nonnegative(),
  /** video_sources and channel_sources rows created (0 on a repeat import). */
  new_sources: z.number().int().nonnegative(),
  /** Rows and files skipped, by reason. */
  skipped: SkipCountsSchema,
  /** recheck_batch jobs queued; null when no recheck handler is registered. */
  recheck_jobs: z.number().int().nonnegative().nullable(),
  duration_ms: z.number().int().nonnegative(),
});
export type TakeoutCounts = z.infer<typeof TakeoutCountsSchema>;

export const TakeoutJobResponseSchema = z.object({
  job_id: z.number().int(),
  status: JobStatusSchema,
  error: z.string().nullable(),
  created_at: z.number(),
  finished_at: z.number().nullable(),
  files: z.array(z.object({ name: z.string(), kind: TakeoutFileKindSchema })),
  /** Present once the import finished. */
  counts: TakeoutCountsSchema.nullable(),
});
export type TakeoutJobResponse = z.infer<typeof TakeoutJobResponseSchema>;
// --- end wave5B ---
// --- charts ---
// ---------------------------------------------------------------------------
// Charts API (/api/stats). Daily points are pre-aggregated by the stats_rollup
// job into stats_daily; the summary is read live.
//   GET  /api/stats/daily?from=YYYY-MM-DD&to=YYYY-MM-DD&location_id=<n|all>
//        -> StatsDailyResponse (defaults: the last 90 UTC days, location 0;
//           location_id=all answers the all-locations row plus every location)
//   GET  /api/stats/summary -> StatsSummary
//   POST /api/stats/rollup  -> StatsRollupResponse (today plus a 7-day backfill)
// ---------------------------------------------------------------------------
/** location_id 0 is the all-locations row of stats_daily. */
export const ALL_LOCATIONS_ID = 0;
export const STATS_DEFAULT_DAYS = 90;
/** The widest window one request may ask for. */
export const STATS_MAX_DAYS = 400;

const UTC_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A UTC calendar day, `YYYY-MM-DD`, that round-trips through Date. */
export const UtcDaySchema = z
  .string()
  .trim()
  .regex(UTC_DAY_PATTERN, "Use YYYY-MM-DD.")
  .refine((day) => {
    const parsed = Date.parse(`${day}T00:00:00Z`);
    return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === day;
  }, "Not a calendar day.");

export const StatsDailyQuerySchema = z.object({
  from: UtcDaySchema.optional(),
  to: UtcDaySchema.optional(),
  location_id: z
    .union([z.literal("all"), z.coerce.number().int().nonnegative()])
    .default(ALL_LOCATIONS_ID),
});
export type StatsDailyQuery = z.infer<typeof StatsDailyQuerySchema>;
export type StatsDailyQueryInput = z.input<typeof StatsDailyQuerySchema>;

export const StatsDailyPointSchema = z.object({
  day: z.string(),
  location_id: z.number().int().nonnegative(),
  bytes_used: z.number().int().nonnegative(),
  downloads: z.number().int().nonnegative(),
  catalog: z.number().int().nonnegative(),
  gone: z.number().int().nonnegative(),
  api_units: z.number().int().nonnegative(),
});
export type StatsDailyPoint = z.infer<typeof StatsDailyPointSchema>;

export const StatsLocationRefSchema = z.object({
  id: z.number().int(),
  label: z.string(),
});
export type StatsLocationRef = z.infer<typeof StatsLocationRefSchema>;

export const StatsDailyResponseSchema = z.object({
  /** The resolved window, inclusive, so a client can draw empty days. */
  from: z.string(),
  to: z.string(),
  /** Ordered by day, then location_id. */
  points: z.array(StatsDailyPointSchema),
  /** Every registered location, enabled or not, so old points stay labelled. */
  locations: z.array(StatsLocationRefSchema),
});
export type StatsDailyResponse = z.infer<typeof StatsDailyResponseSchema>;

export const StatsLocationBytesSchema = z.object({
  id: z.number().int(),
  label: z.string(),
  enabled: z.boolean(),
  bytes_used: z.number().int().nonnegative(),
  /** 0 = no quota set. */
  quota_bytes: z.number().int().nonnegative(),
});
export type StatsLocationBytes = z.infer<typeof StatsLocationBytesSchema>;

export const StatsSummarySchema = z.object({
  /** Catalog size: every known video. */
  videos: z.number().int().nonnegative(),
  /** Videos with a current video or audio file on disk. */
  downloaded: z.number().int().nonnegative(),
  gone: z.number().int().nonnegative(),
  bytes_by_location: z.array(StatsLocationBytesSchema),
  api_units_today: z.number().int().nonnegative(),
  api_units_budget: z.number().int().nonnegative(),
  downloads_7d: z.number().int().nonnegative(),
  downloads_30d: z.number().int().nonnegative(),
});
export type StatsSummary = z.infer<typeof StatsSummarySchema>;

export const StatsRollupResponseSchema = z.object({
  /** stats_daily rows written (every day times every location row). */
  points: z.number().int().nonnegative(),
  from: z.string(),
  to: z.string(),
});
export type StatsRollupResponse = z.infer<typeof StatsRollupResponseSchema>;
// --- end charts ---
