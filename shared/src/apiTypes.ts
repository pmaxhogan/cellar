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
