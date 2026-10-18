import {
  ChannelRowSchema,
  ChannelsListResponseSchema,
  type ChannelRef,
  type ChannelRow,
  type ChannelSourceKind,
  type ChannelsListResponse,
} from "@cellar/shared";
import { buildQuery, type ApiClient } from "./client.ts";

/** "all" is UI only; the rest are the server's `kind` values, sent as is. */
export type ChannelKindFilter = "all" | ChannelSourceKind;

export interface ChannelQuery {
  q?: string;
  page: number;
  perPage: number;
  kind: ChannelKindFilter;
}

export function listChannels(
  api: ApiClient,
  query: ChannelQuery,
  signal?: AbortSignal,
): Promise<ChannelsListResponse> {
  const search = buildQuery({
    q: query.q?.trim(),
    page: query.page,
    perPage: query.perPage,
    // "all" is the server default; leaving it out keeps the URL minimal.
    kind: query.kind === "all" ? undefined : query.kind,
  });
  return api.request(`/api/channels${search}`, { schema: ChannelsListResponseSchema, signal });
}

/** `ref` is what the owner typed; the server parses and resolves it again. */
export function addChannel(api: ApiClient, ref: string): Promise<ChannelRow> {
  return api.request("/api/channels", {
    method: "POST",
    body: { ref },
    schema: ChannelRowSchema,
  });
}

export function deleteChannel(api: ApiClient, id: string): Promise<void> {
  return api.request(`/api/channels/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** The 409 code the server answers when no linked account can resolve a handle. */
export const NO_ACCOUNT_PROBLEM = "no_account";

/** How a parsed reference reads back to the owner before it is submitted. */
export function describeChannelRef(ref: ChannelRef): { kind: string; detail: string } {
  switch (ref.kind) {
    case "id":
      return { kind: "Channel id", detail: ref.value };
    case "handle":
      return { kind: "Handle", detail: `@${ref.value}` };
    case "url-custom":
      return { kind: "Custom URL", detail: `/c/${ref.value}` };
    case "user":
      return { kind: "Legacy username", detail: `/user/${ref.value}` };
  }
}

/** Anything but a UC id needs a linked account's API access to resolve. */
export function needsResolve(ref: ChannelRef): boolean {
  return ref.kind !== "id";
}

export function channelUrl(id: string): string {
  return `https://www.youtube.com/channel/${encodeURIComponent(id)}`;
}
