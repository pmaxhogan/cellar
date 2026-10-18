import { createApiClient, type ApiClient } from "../../src/api/client.ts";

/**
 * A fetch stand-in for page tests: routes keyed by method and path, every call
 * recorded. Pages talk to it through the real ApiClient, so the response
 * schemas are exercised exactly as in the app.
 */

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

export type FakeReply = Response | Promise<Response>;
export type FakeHandler = (request: FakeRequest) => FakeReply;

interface Route {
  method: string;
  pattern: string | RegExp;
  handler: FakeHandler;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

export function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

export function apiError(status: number, error: string, code?: string): Response {
  return json(code === undefined ? { error } : { error, code }, status);
}

export interface FakeServer {
  api: ApiClient;
  fetchImpl: typeof fetch;
  calls: FakeRequest[];
  on: (method: string, pattern: string | RegExp, handler: FakeHandler) => FakeServer;
  /** Calls matching a method and a path (exact string or regex). */
  callsTo: (method: string, pattern: string | RegExp) => FakeRequest[];
}

function matches(pattern: string | RegExp, path: string): boolean {
  return typeof pattern === "string" ? pattern === path : pattern.test(path);
}

export function fakeServer(): FakeServer {
  const routes: Route[] = [];
  const calls: FakeRequest[] = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "http://cellar.test");
    const method = (init?.method ?? "GET").toUpperCase();
    if (init?.signal?.aborted === true) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const request: FakeRequest = { method, path: url.pathname, query: url.searchParams, body };
    calls.push(request);
    // Last registered wins, so a test can override a default route.
    for (let i = routes.length - 1; i >= 0; i -= 1) {
      const route = routes[i]!;
      if (route.method === method && matches(route.pattern, url.pathname)) {
        return route.handler(request);
      }
    }
    return apiError(404, `No fake route for ${method} ${url.pathname}`, "not_found");
  }) as typeof fetch;

  const server: FakeServer = {
    api: createApiClient({ fetchImpl }),
    fetchImpl,
    calls,
    on(method, pattern, handler) {
      routes.push({ method: method.toUpperCase(), pattern, handler });
      return server;
    },
    callsTo(method, pattern) {
      return calls.filter((call) => call.method === method && matches(pattern, call.path));
    },
  };
  return server;
}
