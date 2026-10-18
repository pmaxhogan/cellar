import { z } from "zod";
import { pagedSchema } from "@cellar/shared";
import { buildQuery, type ApiClient } from "./client.ts";

/**
 * Activity API (/api/activity). Local schema until the wave1B block of
 * shared/src/apiTypes.ts lands with the same shape.
 *
 *   GET /api/activity?page&perPage&level&kind&video_id -> paged ActivityRow
 */
export const ACTIVITY_LEVELS = ["debug", "info", "warn", "error"] as const;
export type ActivityLevel = (typeof ACTIVITY_LEVELS)[number];

export const ActivityRowSchema = z.object({
  id: z.number().int(),
  at: z.number(),
  level: z.enum(ACTIVITY_LEVELS),
  kind: z.string(),
  message: z.string(),
  video_id: z.string().nullable(),
  job_id: z.number().int().nullable(),
  data: z.unknown().nullable(),
});
export type ActivityRow = z.infer<typeof ActivityRowSchema>;

export const ActivityListResponseSchema = pagedSchema(ActivityRowSchema);
export type ActivityListResponse = z.infer<typeof ActivityListResponseSchema>;

export interface ActivityQuery {
  page?: number;
  perPage?: number;
  level?: ActivityLevel | null;
  kind?: string | null;
  videoId?: string | null;
}

export function listActivity(
  api: ApiClient,
  query: ActivityQuery = {},
  signal?: AbortSignal,
): Promise<ActivityListResponse> {
  const path = `/api/activity${buildQuery({
    page: query.page,
    perPage: query.perPage,
    level: query.level,
    kind: query.kind,
    video_id: query.videoId,
  })}`;
  return api.request(path, { schema: ActivityListResponseSchema, signal });
}

/** True when a live row belongs in a list filtered by `query`. */
export function matchesActivityQuery(row: ActivityRow, query: ActivityQuery): boolean {
  const { level, kind, videoId } = query;
  if (level !== null && level !== undefined && row.level !== level) return false;
  if (kind !== null && kind !== undefined && kind !== "" && row.kind !== kind) return false;
  if (videoId !== null && videoId !== undefined && row.video_id !== videoId) return false;
  return true;
}
