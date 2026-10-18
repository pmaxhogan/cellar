import { vi } from "vitest";
import { DEFAULT_RULES, type InspectResponse, type RuleRow } from "@cellar/shared";
import { createApiClient, type ApiClient } from "../../src/api/client.ts";

/**
 * A real ApiClient over a scripted fetch. Handlers are keyed `METHOD /path`
 * (no query string); a handler returns a JSON body, or a `Reply` for another
 * status. Every request is recorded with its parsed body and query.
 */

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

export class Reply {
  constructor(
    readonly status: number,
    readonly body: unknown = null,
  ) {}
}

export type Handler = (call: Call) => unknown;

export interface FakeApi {
  api: ApiClient;
  calls: Call[];
  fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
  on: (key: string, handler: Handler | unknown) => void;
  callsTo: (key: string) => Call[];
}

export function fakeApi(handlers: Record<string, Handler | unknown> = {}): FakeApi {
  const table = new Map<string, Handler>();
  const on = (key: string, handler: Handler | unknown): void => {
    table.set(key, typeof handler === "function" ? (handler as Handler) : () => handler);
  };
  for (const [key, handler] of Object.entries(handlers)) on(key, handler);
  const calls: Call[] = [];

  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://cellar.test");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const call: Call = { method, path: url.pathname, query: url.searchParams, body };
    calls.push(call);
    const signal = init?.signal;
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const handler = table.get(`${method} ${url.pathname}`);
    if (handler === undefined) {
      return new Response(JSON.stringify({ error: `no fake for ${method} ${url.pathname}` }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Like real fetch, an abort rejects a request that is still in flight.
    const aborted = new Promise<never>((_, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
        once: true,
      });
    });
    const out = await Promise.race([Promise.resolve(handler(call)), aborted]);
    if (out instanceof Reply) {
      return new Response(out.status === 204 ? null : JSON.stringify(out.body), {
        status: out.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(out ?? null), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  return {
    api: createApiClient({ fetchImpl }),
    calls,
    fetchImpl,
    on,
    callsTo: (key) => calls.filter((call) => `${call.method} ${call.path}` === key),
  };
}

const NOW = 1_760_000_000_000;

/** The shipped default rule set as stored rows (global id 1, then ids 2..8). */
export function defaultRows(): RuleRow[] {
  return DEFAULT_RULES.map((rule, index) => ({
    id: index + 1,
    kind: rule.kind,
    video_id: rule.video_id,
    position: rule.position,
    name: rule.name,
    enabled: rule.enabled,
    condition: JSON.parse(JSON.stringify(rule.condition)) as unknown,
    effects: JSON.parse(JSON.stringify(rule.effects)) as Record<string, unknown>,
    created_at: NOW,
    updated_at: NOW,
  }));
}

export function makeRow(overrides: Partial<RuleRow> = {}): RuleRow {
  return {
    id: 50,
    kind: "custom",
    video_id: null,
    position: 1,
    name: "Shorts are temporary",
    enabled: true,
    condition: {
      type: "group",
      op: "and",
      children: [{ type: "cond", field: "type", op: "eq", value: "short" }],
    },
    effects: { reclaim_priority: 1 },
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

export function makeInspect(overrides: Partial<InspectResponse> = {}): InspectResponse {
  return {
    video_id: "dQw4w9WgXcQ",
    known: true,
    title: "A synthetic video",
    channel_title: "Synthetic channel",
    matched: [
      { id: 1, kind: "global", name: "Global defaults", position: 0 },
      { id: 7, kind: "custom", name: "Keep unlisted and gone forever", position: 6 },
    ],
    effective: {
      include: true,
      reclaim_priority: -1,
      location_id: null,
      media_mode: "video",
      format_policy: "prefer_av1",
      max_height: null,
      max_fps: null,
      transcode: {
        mode: "if_not_av1",
        codec: "hevc_nvenc",
        quality: 28,
        preset: "p5",
        audio_codec: "copy",
      },
      captions: { enabled: true, languages: ["en"], auto_generated: true },
      live: "vod_only",
      ytdlp: {},
      download_accounts: "sourcing",
      proxy: "none",
      delay_after_upload: null,
      recheck_interval: "tiered",
      notify: { enabled: false, max_times: 1, channel: "push" },
    },
    provenance: {
      include: "default",
      reclaim_priority: 7,
      location_id: 1,
      media_mode: 1,
      format_policy: 1,
      max_height: "default",
      max_fps: "default",
      transcode: 1,
      captions: 1,
      live: 1,
      ytdlp: "default",
      download_accounts: 1,
      proxy: 1,
      delay_after_upload: "default",
      recheck_interval: 1,
      notify: 1,
    },
    overrides: null,
    evaluated_at: NOW,
    ...overrides,
  };
}
