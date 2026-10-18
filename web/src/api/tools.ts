import { z } from "zod";
import type { ApiClient } from "./client.ts";

/**
 * Tools API (/api/tools). Local schemas until the wave1C block of
 * shared/src/apiTypes.ts lands with the same shape.
 *
 *   GET  /api/tools                          -> ToolsResponse
 *   POST /api/tools/update   <- { tool?, force? } -> ToolsResponse
 *   POST /api/tools/rollback <- { tool }          -> ToolsResponse
 */
export const TOOL_NAMES = ["ytdlp", "ffmpeg"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const TOOL_LABELS: Record<ToolName, string> = { ytdlp: "yt-dlp", ffmpeg: "ffmpeg" };

export const ToolVersionsSchema = z.object({
  current: z.string().nullable(),
  previous: z.string().nullable(),
  baseline: z.string().nullable(),
  latest: z.string().nullable(),
  checked_at: z.number().nullable(),
  updated_at: z.number().nullable(),
});
export type ToolVersions = z.infer<typeof ToolVersionsSchema>;

export const ToolsResponseSchema = z.object({
  ytdlp: ToolVersionsSchema,
  ffmpeg: ToolVersionsSchema,
  js_runtime: z.string().nullable(),
  pot_provider_url: z.string().nullable(),
});
export type ToolsResponse = z.infer<typeof ToolsResponseSchema>;

export function getTools(api: ApiClient, signal?: AbortSignal): Promise<ToolsResponse> {
  return api.request("/api/tools", { schema: ToolsResponseSchema, signal });
}

export interface ToolUpdateBody {
  tool?: ToolName;
  /** Install even when the current version is already the latest. */
  force?: boolean;
}

export function updateTools(api: ApiClient, body: ToolUpdateBody = {}): Promise<ToolsResponse> {
  return api.request("/api/tools/update", {
    method: "POST",
    body,
    schema: ToolsResponseSchema,
  });
}

export function rollbackTool(api: ApiClient, tool: ToolName): Promise<ToolsResponse> {
  return api.request("/api/tools/rollback", {
    method: "POST",
    body: { tool },
    schema: ToolsResponseSchema,
  });
}

/** An update is available when the check found a version other than the current one. */
export function updateAvailable(versions: ToolVersions): boolean {
  return (
    versions.latest !== null && versions.current !== null && versions.latest !== versions.current
  );
}
