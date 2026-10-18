import {
  ToolsResponseSchema,
  UPDATABLE_TOOLS,
  type ToolsResponse,
  type ToolUpdateOutcome,
  type ToolUpdateStatus,
  type ToolVersionsInfo,
  type UpdatableTool,
} from "@cellar/shared";
import type { ApiClient } from "./client.ts";

/**
 * Tools API (/api/tools), parsed with the shared wave1C contracts.
 *
 *   GET  /api/tools                          -> ToolsResponse
 *   POST /api/tools/update   <- { tool?, force? } -> ToolsResponse (with outcomes)
 *   POST /api/tools/rollback <- { tool }          -> ToolsResponse
 */
export const TOOL_NAMES = UPDATABLE_TOOLS;
export type ToolName = UpdatableTool;
export type ToolVersions = ToolVersionsInfo;
export type { ToolsResponse, ToolUpdateOutcome, ToolUpdateStatus };

export const TOOL_LABELS: Record<ToolName, string> = { ytdlp: "yt-dlp", ffmpeg: "ffmpeg" };

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

/** Short label for an outcome status, as the About card shows it. */
export const OUTCOME_LABELS: Record<ToolUpdateStatus, string> = {
  updated: "updated",
  up_to_date: "up to date",
  available: "update available",
  skipped: "skipped",
  blocked: "blocked",
  failed: "failed",
};

export type ToastSeverity = "success" | "info" | "warn" | "error";

/** Tag colour per outcome. */
export const OUTCOME_SEVERITY: Record<ToolUpdateStatus, ToastSeverity> = {
  updated: "success",
  up_to_date: "success",
  skipped: "info",
  available: "info",
  blocked: "warn",
  failed: "error",
};

/** Worst first: a failure outranks a block, which outranks news, which outranks quiet. */
const RANK: Record<ToolUpdateStatus, number> = {
  failed: 5,
  blocked: 4,
  available: 3,
  updated: 2,
  skipped: 1,
  up_to_date: 0,
};

export interface OutcomeSummary {
  severity: ToastSeverity;
  summary: string;
  detail: string;
}

/**
 * One toast for a set of update outcomes. Its severity follows the worst
 * outcome, and the detail names each tool with what happened to it.
 */
export function summarizeOutcomes(outcomes: readonly ToolUpdateOutcome[]): OutcomeSummary {
  const worst = outcomes.reduce<ToolUpdateStatus>(
    (acc, outcome) => (RANK[outcome.status] > RANK[acc] ? outcome.status : acc),
    "up_to_date",
  );
  const named = (statuses: readonly ToolUpdateStatus[]): string =>
    outcomes
      .filter((outcome) => statuses.includes(outcome.status))
      .map((outcome) => TOOL_LABELS[outcome.tool])
      .join(", ");
  const detail = outcomes
    .map((outcome) => `${TOOL_LABELS[outcome.tool]}: ${OUTCOME_LABELS[outcome.status]}`)
    .join("; ");
  switch (worst) {
    case "failed":
      return { severity: "error", summary: `Update check failed for ${named(["failed"])}`, detail };
    case "blocked":
      return { severity: "warn", summary: `Update blocked for ${named(["blocked"])}`, detail };
    case "available":
      return { severity: "info", summary: "Updates available", detail: named(["available"]) };
    case "updated":
      return { severity: "success", summary: "Tools updated", detail: named(["updated"]) };
    case "skipped":
      // A rolled back release is not reinstalled until forced.
      return { severity: "info", summary: "Nothing installed", detail };
    default:
      return { severity: "success", summary: "Tools are up to date", detail };
  }
}
