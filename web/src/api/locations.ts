import { z } from "zod";
import {
  LocationRowSchema,
  LocationsListResponseSchema,
  settingsRegistry,
  type LocationRow,
} from "@cellar/shared";
import type { ApiClient } from "./client.ts";

export const LocationUsageSchema = z.object({
  used_bytes: z.number().int().nonnegative(),
  fs_free_bytes: z.number().int().nonnegative().nullable(),
  fs_total_bytes: z.number().int().nonnegative().nullable(),
  quota_bytes: z.number().int().nonnegative(),
  mounted: z.boolean(),
});
export type LocationUsage = z.infer<typeof LocationUsageSchema>;

/** A row plus whatever a usage refresh added (the filesystem size). */
export type LocationView = LocationRow & { fs_total_bytes?: number | null };

export interface LocationDraft {
  label: string;
  container_path: string;
  quota_bytes: number;
  enabled: boolean;
}

export async function listLocations(api: ApiClient, signal?: AbortSignal): Promise<LocationRow[]> {
  const result = await api.request("/api/locations", {
    schema: LocationsListResponseSchema,
    signal,
  });
  return result.rows;
}

export function createLocation(api: ApiClient, draft: LocationDraft): Promise<LocationRow> {
  return api.request("/api/locations", {
    method: "POST",
    body: draft,
    schema: LocationRowSchema,
  });
}

export function updateLocation(
  api: ApiClient,
  id: number,
  patch: Partial<LocationDraft>,
): Promise<LocationRow> {
  return api.request(`/api/locations/${id}`, {
    method: "PUT",
    body: patch,
    schema: LocationRowSchema,
  });
}

export function deleteLocation(api: ApiClient, id: number): Promise<void> {
  return api.request(`/api/locations/${id}`, { method: "DELETE" });
}

export function getLocationUsage(api: ApiClient, id: number): Promise<LocationUsage> {
  return api.request(`/api/locations/${id}/usage`, { schema: LocationUsageSchema });
}

/**
 * Quotas are entered in GB. 1024-based, so the number typed is the number
 * formatBytes shows back.
 */
export const BYTES_PER_GB = 1024 ** 3;

export function gbToBytes(gb: number): number {
  return Math.round(gb * BYTES_PER_GB);
}

/** For prefilling the quota field: two decimals at most. */
export function bytesToGb(bytes: number): number {
  return Math.round((bytes / BYTES_PER_GB) * 100) / 100;
}

export type UsageTone = "ok" | "warn" | "danger";

export interface UsageSummary {
  /** used / quota as a percentage; null when there is no quota to divide by. */
  percent: number | null;
  /** The same, clamped to 0..100 for drawing the bar. */
  barPercent: number;
  tone: UsageTone;
}

/**
 * The reaper starts at the high-water mark and frees down to the low-water
 * mark (global settings, defaults 95% / 90%). The bar turns warn between the
 * two and danger at or above the high mark.
 */
export function usageSummary(
  used: number,
  quota: number,
  highPct: number = settingsRegistry["reaper.high_water_pct"].default,
  lowPct: number = settingsRegistry["reaper.low_water_pct"].default,
): UsageSummary {
  if (quota <= 0) return { percent: null, barPercent: 0, tone: "ok" };
  const percent = (used / quota) * 100;
  const tone: UsageTone = percent >= highPct ? "danger" : percent >= lowPct ? "warn" : "ok";
  return { percent, barPercent: Math.min(100, Math.max(0, percent)), tone };
}

/** Problems with a container path, or null when it is usable. */
export function containerPathProblem(path: string): string | null {
  const trimmed = path.trim();
  if (trimmed === "") return "Enter the path inside the container, such as /media2.";
  if (!trimmed.startsWith("/")) {
    return "Use an absolute path inside the container, such as /media2.";
  }
  if (trimmed === "/") return "The container root cannot be a location.";
  if (trimmed === "/data" || trimmed.startsWith("/data/")) {
    return "/data holds cellar's own state and is not quota-counted; mount media elsewhere.";
  }
  return null;
}

export const ADD_LOCATION_DOCS_URL =
  "https://github.com/pmaxhogan/cellar/blob/main/deploy/README.md#adding-a-second-storage-location";
