import {
  ShareLinkRowSchema,
  ShareRevokeBulkResponseSchema,
  SharesListResponseSchema,
  type ShareFilter,
  type ShareLinkRow,
  type ShareSort,
  type SharesListResponse,
  type ShareStatus,
} from "@cellar/shared";
import { buildQuery, type ApiClient } from "./client.ts";

/** The admin side of share links (/api/shares). */

export interface ShareQuery {
  page: number;
  perPage: number;
  q?: string;
  status?: ShareStatus;
  videoId?: string;
  sort: ShareSort;
  dir: "asc" | "desc";
}

export function listShares(
  api: ApiClient,
  query: ShareQuery,
  signal?: AbortSignal,
): Promise<SharesListResponse> {
  const search = buildQuery({
    page: query.page,
    perPage: query.perPage,
    q: query.q?.trim(),
    status: query.status,
    video_id: query.videoId,
    sort: query.sort,
    dir: query.dir,
  });
  return api.request(`/api/shares${search}`, { schema: SharesListResponseSchema, signal });
}

/** `expiresAt` is epoch ms, or null for a link that never expires. */
export function createShare(
  api: ApiClient,
  videoId: string,
  expiresAt: number | null,
): Promise<ShareLinkRow> {
  return api.request("/api/shares", {
    method: "POST",
    body: { video_id: videoId, expires_at: expiresAt },
    schema: ShareLinkRowSchema,
  });
}

function tokenPath(token: string): string {
  return `/api/shares/${encodeURIComponent(token)}`;
}

export function revokeShare(api: ApiClient, token: string): Promise<ShareLinkRow> {
  return api.request(`${tokenPath(token)}/revoke`, { method: "POST", schema: ShareLinkRowSchema });
}

export async function revokeShares(
  api: ApiClient,
  target: { tokens: string[] } | { filter: ShareFilter },
): Promise<number> {
  const body =
    "tokens" in target
      ? { tokens: target.tokens }
      : {
          all_matching: Object.fromEntries(
            Object.entries(target.filter).filter(
              ([, value]) => value !== undefined && value !== "",
            ),
          ),
        };
  const result = await api.request("/api/shares/revoke", {
    method: "POST",
    body,
    schema: ShareRevokeBulkResponseSchema,
  });
  return result.count;
}

/** Hard delete; the server accepts it for revoked links only. */
export function deleteShare(api: ApiClient, token: string): Promise<void> {
  return api.request(tokenPath(token), { method: "DELETE" });
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type ExpiryPreset = "1d" | "7d" | "30d" | "never" | "custom";

export const EXPIRY_PRESETS: { label: string; value: ExpiryPreset }[] = [
  { label: "1 day", value: "1d" },
  { label: "7 days", value: "7d" },
  { label: "30 days", value: "30d" },
  { label: "Never", value: "never" },
  { label: "Custom", value: "custom" },
];

/**
 * The expiry a preset means right now. `custom` uses the picked date, which
 * must lie in the future; anything else returns undefined (not submittable).
 */
export function expiryFor(
  preset: ExpiryPreset,
  custom: Date | null,
  now = Date.now(),
): number | null | undefined {
  switch (preset) {
    case "1d":
      return now + DAY;
    case "7d":
      return now + 7 * DAY;
    case "30d":
      return now + 30 * DAY;
    case "never":
      return null;
    case "custom": {
      const at = custom?.getTime();
      return at !== undefined && Number.isFinite(at) && at > now ? at : undefined;
    }
  }
}

/** Severity of the PrimeVue Tag for each status. */
export const STATUS_SEVERITY: Record<ShareStatus, "success" | "warn" | "secondary"> = {
  active: "success",
  expired: "warn",
  revoked: "secondary",
};

export const STATUS_LABEL: Record<ShareStatus, string> = {
  active: "Active",
  expired: "Expired",
  revoked: "Revoked",
};
