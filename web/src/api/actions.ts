import { z } from "zod";
import type { ApiClient, ApiClientError } from "./client.ts";

/**
 * Manual actions: POST /api/actions/:name -> { job_id }. A name whose handler
 * is not wired yet answers 501 with code not_implemented.
 */
export const ACTION_NAMES = [
  "refresh-all",
  "eval-now",
  "reap-now",
  "ingest-now",
  "selfcheck",
  "tools-update",
] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

export interface ActionInfo {
  name: ActionName;
  label: string;
  description: string;
}

export const ACTIONS: readonly ActionInfo[] = [
  {
    name: "ingest-now",
    label: "Ingest now",
    description: "Read every linked account's sources and queue what is new.",
  },
  {
    name: "eval-now",
    label: "Evaluate rules",
    description: "Run an evaluation pass over the catalog now.",
  },
  {
    name: "reap-now",
    label: "Reap now",
    description: "Delete media the rules no longer keep.",
  },
  {
    name: "refresh-all",
    label: "Refresh all",
    description: "Recheck all metadata, then re-evaluate every rule.",
  },
  {
    name: "selfcheck",
    label: "Self-check",
    description: "Run the self-check suite in the background.",
  },
  {
    name: "tools-update",
    label: "Update tools",
    description: "Check for and install newer yt-dlp and ffmpeg builds.",
  },
];

export const ActionResponseSchema = z.object({ job_id: z.number().int() });
export type ActionResponse = z.infer<typeof ActionResponseSchema>;

export function runAction(api: ApiClient, name: ActionName): Promise<ActionResponse> {
  return api.request(`/api/actions/${name}`, { method: "POST", schema: ActionResponseSchema });
}

/** The server has the route but not the handler yet. */
export function isNotImplemented(error: ApiClientError): boolean {
  return error.status === 501 || error.problem === "not_implemented";
}
