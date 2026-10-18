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
