import { vi } from "vitest";
// @ts-expect-error primevue ships no type declarations for this subpath.
import ToastEventBusUntyped from "primevue/toasteventbus";
import { createApiClient, type ApiClient } from "../../src/api/client.ts";

export interface CapturedToast {
  severity: string;
  summary: string;
  detail?: string;
}

const ToastEventBus = ToastEventBusUntyped as {
  emit: (event: string, payload?: unknown) => void;
};

/**
 * Record every toast the page adds. ToastService.add emits ("add", message) on
 * this bus; nothing renders it in a component test, so the spy swallows it.
 * Restored by vi.restoreAllMocks().
 */
export function captureToasts(): CapturedToast[] {
  const toasts: CapturedToast[] = [];
  vi.spyOn(ToastEventBus, "emit").mockImplementation((event: string, payload?: unknown) => {
    if (event === "add") toasts.push(payload as CapturedToast);
  });
  return toasts;
}

/**
 * A route table standing in for the server. Pages under test get a real
 * ApiClient (so schemas, error bodies and status handling run for real) whose
 * fetch is answered from this table instead of the network.
 *
 * Keys are "METHOD /path" with the query string stripped; `:id` style segments
 * are not supported, a test lists the concrete path it expects. A handler
 * returns a Response, or any other value which is sent as a 200 JSON body.
 */

export interface RecordedCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

export type Handler = (call: RecordedCall) => unknown;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

export function apiError(status: number, error: string, code?: string): Response {
  return json(code === undefined ? { error } : { error, code }, status);
}

export interface FakeServer {
  api: ApiClient;
  calls: RecordedCall[];
  /** Add or replace one route. */
  on: (key: string, handler: Handler) => void;
  /** Calls whose "METHOD /path" equals `key`. */
  callsTo: (key: string) => RecordedCall[];
}

export function fakeServer(routes: Record<string, Handler> = {}): FakeServer {
  const table = new Map<string, Handler>(Object.entries(routes));
  const calls: RecordedCall[] = [];

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://cellar.test");
    const method = (init?.method ?? "GET").toUpperCase();
    const text = typeof init?.body === "string" ? init.body : undefined;
    const call: RecordedCall = {
      method,
      path: url.pathname,
      query: url.searchParams,
      body: text === undefined ? undefined : JSON.parse(text),
    };
    calls.push(call);
    const handler = table.get(`${method} ${url.pathname}`);
    if (handler === undefined) return apiError(404, `no route for ${method} ${url.pathname}`);
    const result = await handler(call);
    return result instanceof Response ? result : json(result);
  });

  return {
    api: createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    calls,
    on: (key, handler) => table.set(key, handler),
    callsTo: (key) => calls.filter((call) => `${call.method} ${call.path}` === key),
  };
}
