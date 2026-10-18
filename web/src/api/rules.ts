import { z } from "zod";
import {
  AccountsListResponseSchema,
  ChannelsListResponseSchema,
  InspectResponseSchema,
  LocationsListResponseSchema,
  ProxiesListResponseSchema,
  RulePreviewSchema,
  RulesListResponseSchema,
  RuleRowSchema,
  type AccountRow,
  type ChannelRow,
  type ConditionNode,
  type InspectResponse,
  type LocationRow,
  type ProxyRow,
  type RulePreview,
  type RuleRow,
} from "@cellar/shared";
import { buildQuery, type ApiClient } from "./client.ts";

/**
 * Rules, preview, inspect and the lookups the rule builder needs. Every call
 * goes through the injected client so a test can mount a page with a stubbed
 * fetch. Shapes are the shared contracts in `@cellar/shared` apiTypes.
 *
 * A stubbed client resolves `undefined` for every request; the list helpers
 * treat that as an empty list so a page mounted with no fixtures renders its
 * empty state instead of throwing.
 */

/** The body of POST /api/rules and PUT /api/rules/:id (a shared RuleDraft). */
export interface RuleDraftBody {
  kind: RuleRow["kind"];
  video_id: string | null;
  position: number;
  name: string;
  enabled: boolean;
  condition: ConditionNode | null;
  effects: Record<string, unknown>;
}

/** The editable part of a stored row, ready to PUT back. */
export function draftFromRow(row: RuleRow): RuleDraftBody {
  return {
    kind: row.kind,
    video_id: row.video_id,
    position: row.position,
    name: row.name,
    enabled: row.enabled,
    condition: row.condition as ConditionNode | null,
    effects: row.effects,
  };
}

export async function listRules(api: ApiClient, signal?: AbortSignal): Promise<RuleRow[]> {
  const res = await api.request("/api/rules", { schema: RulesListResponseSchema, signal });
  return res?.rows ?? [];
}

export function createRule(api: ApiClient, draft: RuleDraftBody): Promise<RuleRow> {
  return api.request("/api/rules", { method: "POST", body: draft, schema: RuleRowSchema });
}

export function updateRule(api: ApiClient, id: number, draft: RuleDraftBody): Promise<RuleRow> {
  return api.request(`/api/rules/${id}`, { method: "PUT", body: draft, schema: RuleRowSchema });
}

export async function deleteRule(api: ApiClient, id: number): Promise<void> {
  await api.request(`/api/rules/${id}`, { method: "DELETE" });
}

/** Persists the custom rule order: `ids` in new ascending position (priority) order. */
export async function reorderRules(api: ApiClient, ids: number[]): Promise<RuleRow[]> {
  const res = await api.request("/api/rules/order", {
    method: "PUT",
    body: { ids },
    schema: RulesListResponseSchema,
  });
  return res?.rows ?? [];
}

/** How long the rule editor waits after the last edit before asking for a preview. */
export const PREVIEW_DEBOUNCE_MS = 400;

export function previewCondition(
  api: ApiClient,
  condition: ConditionNode,
  signal?: AbortSignal,
): Promise<RulePreview> {
  return api.request("/api/rules/preview", {
    method: "POST",
    body: { condition },
    schema: RulePreviewSchema,
    signal,
  });
}

export function inspectVideo(
  api: ApiClient,
  id: string,
  signal?: AbortSignal,
): Promise<InspectResponse> {
  return api.request(`/api/inspect${buildQuery({ id })}`, {
    schema: InspectResponseSchema,
    signal,
  });
}

/** Sets (or with null, deletes) the per-video override rule. */
export function setVideoOverrides(
  api: ApiClient,
  videoId: string,
  effects: Record<string, unknown> | null,
): Promise<InspectResponse> {
  return api.request(`/api/videos/${encodeURIComponent(videoId)}/overrides`, {
    method: "PUT",
    body: { effects },
    schema: InspectResponseSchema,
  });
}

/** Channel autocomplete: matches title, handle or id. */
export async function searchChannels(
  api: ApiClient,
  q: string,
  signal?: AbortSignal,
): Promise<ChannelRow[]> {
  const res = await api.request(`/api/channels${buildQuery({ q, limit: 10 })}`, {
    schema: ChannelsListResponseSchema,
    signal,
  });
  return res?.rows ?? [];
}

export async function listLocations(api: ApiClient): Promise<LocationRow[]> {
  const res = await api.request("/api/locations", { schema: LocationsListResponseSchema });
  return res?.rows ?? [];
}

export async function listAccounts(api: ApiClient): Promise<AccountRow[]> {
  const res = await api.request("/api/accounts", { schema: AccountsListResponseSchema });
  return res?.rows ?? [];
}

export async function listProxies(api: ApiClient): Promise<ProxyRow[]> {
  const res = await api.request("/api/proxies", { schema: ProxiesListResponseSchema });
  return res?.rows ?? [];
}

/**
 * NVENC availability as `GET /api/status` may report it. Neither field is in
 * the shared StatusResponse yet, so this reads them leniently: `gpu.nvenc` may
 * be a boolean or a per-codec `{ hevc, h264, av1 }` object.
 */
const NvencFlagsSchema = z.object({
  hevc: z.boolean().optional(),
  h264: z.boolean().optional(),
  av1: z.boolean().optional(),
});
const StatusGpuSchema = z.object({
  gpu: z
    .object({ nvenc: z.union([z.boolean(), NvencFlagsSchema]).nullable().optional() })
    .nullable()
    .optional(),
});

/** Per-codec flags; `undefined` means the server did not say. */
export interface CodecSupport {
  hevc_nvenc?: boolean;
  h264_nvenc?: boolean;
  av1_nvenc?: boolean;
}

export async function fetchCodecSupport(api: ApiClient): Promise<CodecSupport> {
  let res: z.infer<typeof StatusGpuSchema> | undefined;
  try {
    res = await api.request("/api/status", { schema: StatusGpuSchema });
  } catch {
    return {};
  }
  const nvenc = res?.gpu?.nvenc;
  if (nvenc === undefined || nvenc === null) return {};
  if (typeof nvenc === "boolean") {
    return { hevc_nvenc: nvenc, h264_nvenc: nvenc, av1_nvenc: nvenc };
  }
  return { hevc_nvenc: nvenc.hevc, h264_nvenc: nvenc.h264, av1_nvenc: nvenc.av1 };
}
