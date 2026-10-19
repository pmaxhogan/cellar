import { TitleChangesResponseSchema, type TitleChangesResponse } from "@cellar/shared";
import { buildQuery, type ApiClient } from "./client.ts";

/**
 * Title changes across every video (/api/title-changes).
 *
 *   GET /api/title-changes?page&perPage&channel_id&q -> paged TitleChangeRow
 */
export interface TitleChangesQuery {
  page: number;
  perPage: number;
  channelId?: string | null;
  q?: string | null;
}

export function listTitleChanges(
  api: ApiClient,
  query: TitleChangesQuery,
  signal?: AbortSignal,
): Promise<TitleChangesResponse> {
  const search = buildQuery({
    page: query.page,
    perPage: query.perPage,
    channel_id: query.channelId,
    q: query.q?.trim(),
  });
  return api.request(`/api/title-changes${search}`, {
    schema: TitleChangesResponseSchema,
    signal,
  });
}
