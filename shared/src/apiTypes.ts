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

export const ToolUpdateOutcomeSchema = z.object({
  tool: UpdatableToolSchema,
  status: z.enum(["updated", "up_to_date", "available", "skipped", "failed"]),
  detail: z.string(),
});
export type ToolUpdateOutcome = z.infer<typeof ToolUpdateOutcomeSchema>;

export const ToolsResponseSchema = z.object({
  ytdlp: ToolVersionsSchema,
  ffmpeg: ToolVersionsSchema,
  js_runtime: z.string().nullable(),
  pot_provider_url: z.string(),
  auto_update: z.boolean(),
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
