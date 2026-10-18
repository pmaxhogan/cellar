import { z } from "zod";
import { ApiErrorSchema, StatusResponseSchema, type StatusResponse } from "@cellar/shared";
import { cellarEventSchema, type CellarEvent } from "./types.ts";

/**
 * Typed client for the cellar REST API.
 *
 * Every failure - transport, HTTP status, or a response that does not match its
 * schema - surfaces as an ApiClientError carrying a stable machine-readable
 * `problem` code plus a human-facing `message`, so call sites never have to
 * care which layer broke.
 *
 * The server's error body is `{error, code?, details?}`: `error` is the
 * human-readable message and `code` the machine-readable one.
 */

export const NETWORK_PROBLEM = "network_error";
export const INVALID_RESPONSE_PROBLEM = "invalid_response";
export const ABORTED_PROBLEM = "aborted";

export class ApiClientError extends Error {
  readonly problem: string;
  readonly status: number | null;
  readonly details: Record<string, unknown> | null;

  constructor(problem: string, message: string, status: number | null = null, details?: unknown) {
    super(message);
    this.name = "ApiClientError";
    this.problem = problem;
    this.status = status;
    this.details =
      details !== null && typeof details === "object" && !Array.isArray(details)
        ? (details as Record<string, unknown>)
        : null;
  }

  /** True when retrying the same request could plausibly succeed. */
  get retryable(): boolean {
    if (this.problem === NETWORK_PROBLEM) return true;
    if (this.status === null) return false;
    return this.status >= 500 || this.status === 429;
  }
}

const HTTP_MESSAGES: Record<number, string> = {
  400: "The request was rejected as invalid.",
  401: "Not signed in. Reload the page to authenticate again.",
  403: "That action is not permitted.",
  404: "Not found. It may have been deleted already.",
  409: "That conflicts with something that already exists.",
  413: "That upload is too large.",
  429: "Rate limited. Wait a moment and try again.",
  500: "The server hit an unexpected error.",
  502: "The server is unreachable.",
  503: "The server is not ready yet.",
};

export function httpMessage(status: number, statusText: string): string {
  const known = HTTP_MESSAGES[status];
  if (known !== undefined) return known;
  return statusText === "" ? `Request failed with status ${status}` : statusText;
}

function isAbort(cause: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" &&
      cause instanceof DOMException &&
      cause.name === "AbortError") ||
    (cause instanceof Error && cause.name === "AbortError")
  );
}

/** Turn anything thrown by fetch or a schema into an ApiClientError. */
export function normalizeError(cause: unknown): ApiClientError {
  if (cause instanceof ApiClientError) return cause;
  if (cause instanceof z.ZodError) {
    const first = cause.issues[0];
    const where = first === undefined ? "" : ` at ${first.path.join(".") || "root"}`;
    return new ApiClientError(
      INVALID_RESPONSE_PROBLEM,
      `The server sent a response cellar could not read${where}.`,
    );
  }
  if (cause instanceof SyntaxError) {
    return new ApiClientError(
      INVALID_RESPONSE_PROBLEM,
      "The server sent a response cellar could not read.",
    );
  }
  if (isAbort(cause)) {
    return new ApiClientError(ABORTED_PROBLEM, "The request was canceled.");
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return new ApiClientError(
    NETWORK_PROBLEM,
    message === "" ? "Could not reach the server." : `Could not reach the server. ${message}`,
  );
}

export type QueryValue = string | number | boolean | null | undefined;

export function buildQuery(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text === "" ? "" : `?${text}`;
}

export interface RequestOptions<T> {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  schema?: z.ZodType<T>;
  signal?: AbortSignal;
}

export interface ApiClientOptions {
  /** Prefix for every path. Empty in the app; tests may point it elsewhere. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export type ApiClient = ReturnType<typeof createApiClient>;

export function createApiClient(options: ApiClientOptions = {}) {
  const baseUrl = options.baseUrl ?? "";
  const doFetch: typeof fetch = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));

  function url(path: string): string {
    return `${baseUrl}${path}`;
  }

  async function errorFromResponse(response: Response): Promise<ApiClientError> {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const parsed = ApiErrorSchema.safeParse(payload);
    if (parsed.success) {
      return new ApiClientError(
        parsed.data.code ?? `http_${response.status}`,
        parsed.data.error,
        response.status,
        parsed.data.details,
      );
    }
    return new ApiClientError(
      `http_${response.status}`,
      httpMessage(response.status, response.statusText),
      response.status,
    );
  }

  /** Fetch with credentials; any non-2xx becomes an ApiClientError. */
  async function raw(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await doFetch(url(path), { credentials: "same-origin", ...init });
    } catch (cause) {
      throw normalizeError(cause);
    }
    if (!response.ok) {
      throw await errorFromResponse(response);
    }
    return response;
  }

  async function request<T>(path: string, opts: RequestOptions<T> = {}): Promise<T> {
    const method = opts.method ?? "GET";
    const headers: Record<string, string> = { Accept: "application/json" };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    const response = await raw(path, { method, headers, body, signal: opts.signal });

    if (opts.schema === undefined) {
      // Callers that pass no schema do not read the body (204 or ignored).
      await response.text().catch(() => "");
      return undefined as T;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw normalizeError(cause);
    }
    const parsed = opts.schema.safeParse(payload);
    if (!parsed.success) {
      throw normalizeError(parsed.error);
    }
    return parsed.data;
  }

  const status = (signal?: AbortSignal): Promise<StatusResponse> =>
    request("/api/status", { schema: StatusResponseSchema, signal });

  const eventsUrl = (): string => url("/api/events");

  return {
    baseUrl,
    raw,
    request,
    status,
    eventsUrl,
  };
}

/** Parse one SSE data frame into a CellarEvent, or null when unreadable. */
export function parseEventData(data: string): CellarEvent | null {
  try {
    const parsed = cellarEventSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const api = createApiClient();
