import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ABORTED_PROBLEM,
  ApiClientError,
  INVALID_RESPONSE_PROBLEM,
  NETWORK_PROBLEM,
  buildQuery,
  createApiClient,
  httpMessage,
  normalizeError,
  parseEventData,
} from "../src/api/client.ts";
import { makeStatus } from "./helpers/stubApi.ts";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function clientReturning(response: Response | Promise<Response>) {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response);
  return { client: createApiClient({ fetchImpl }), fetchImpl };
}

async function caught(promise: Promise<unknown>): Promise<ApiClientError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiClientError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("createApiClient: status", () => {
  it("GETs /api/status with credentials and parses it", async () => {
    const status = makeStatus({ insecureMode: true });
    const { client, fetchImpl } = clientReturning(jsonResponse(status));
    await expect(client.status()).resolves.toEqual(status);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/api/status");
    expect(init?.method).toBe("GET");
    expect(init?.credentials).toBe("same-origin");
    expect((init?.headers as Record<string, string>).Accept).toBe("application/json");
  });

  it("prefixes every path with baseUrl", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(makeStatus()));
    const client = createApiClient({ fetchImpl, baseUrl: "http://cellar.test" });
    await client.status();
    expect(fetchImpl.mock.calls[0]![0]).toBe("http://cellar.test/api/status");
    expect(client.eventsUrl()).toBe("http://cellar.test/api/events");
  });

  it("rejects a response that does not match the schema, naming the field", async () => {
    const { client } = clientReturning(jsonResponse({ ...makeStatus(), db: { ok: "yes" } }));
    const error = await caught(client.status());
    expect(error.problem).toBe(INVALID_RESPONSE_PROBLEM);
    expect(error.message).toContain("db.ok");
    expect(error.retryable).toBe(false);
  });

  it("rejects a body that is not JSON", async () => {
    const { client } = clientReturning(new Response("<html>", { status: 200 }));
    const error = await caught(client.status());
    expect(error.problem).toBe(INVALID_RESPONSE_PROBLEM);
  });
});

describe("createApiClient: errors", () => {
  it("surfaces the server's {error, code, details} body", async () => {
    const { client } = clientReturning(
      jsonResponse({ error: "Nope", code: "not_ready", details: { step: "db" } }, { status: 503 }),
    );
    const error = await caught(client.status());
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error.problem).toBe("not_ready");
    expect(error.message).toBe("Nope");
    expect(error.status).toBe(503);
    expect(error.details).toEqual({ step: "db" });
    expect(error.retryable).toBe(true);
  });

  it("falls back to http_<status> when the body has no code", async () => {
    const { client } = clientReturning(jsonResponse({ error: "Gone" }, { status: 404 }));
    const error = await caught(client.status());
    expect(error.problem).toBe("http_404");
    expect(error.message).toBe("Gone");
    expect(error.details).toBeNull();
  });

  it("uses a canned message when the error body is not the error shape", async () => {
    const { client } = clientReturning(new Response("oops", { status: 401 }));
    const error = await caught(client.status());
    expect(error.problem).toBe("http_401");
    expect(error.message).toContain("Not signed in");
    expect(error.retryable).toBe(false);
  });

  it("turns a transport failure into a retryable network error", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"));
    const error = await caught(createApiClient({ fetchImpl }).status());
    expect(error.problem).toBe(NETWORK_PROBLEM);
    expect(error.message).toBe("Could not reach the server. Failed to fetch");
    expect(error.retryable).toBe(true);
  });

  it("reports an abort as aborted, not as a network failure", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new DOMException("The operation was aborted.", "AbortError"));
    const error = await caught(createApiClient({ fetchImpl }).status());
    expect(error.problem).toBe(ABORTED_PROBLEM);
  });
});

describe("createApiClient: request", () => {
  it("sends a JSON body with a content type", async () => {
    const { client, fetchImpl } = clientReturning(jsonResponse({ id: 7 }));
    const result = await client.request("/api/things", {
      method: "POST",
      body: { name: "x" },
      schema: z.object({ id: z.number() }),
    });
    expect(result).toEqual({ id: 7 });
    const init = fetchImpl.mock.calls[0]![1]!;
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"name":"x"}');
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("returns undefined and drains the body when no schema is given", async () => {
    const { client } = clientReturning(new Response(null, { status: 204 }));
    await expect(client.request("/api/things/1", { method: "DELETE" })).resolves.toBeUndefined();
  });

  it("exposes raw for callers that stream", async () => {
    const { client } = clientReturning(new Response("bytes", { status: 200 }));
    const response = await client.raw("/api/blob", {});
    await expect(response.text()).resolves.toBe("bytes");
  });
});

describe("helpers", () => {
  it("normalizeError passes ApiClientError through and wraps everything else", () => {
    const original = new ApiClientError("x", "y");
    expect(normalizeError(original)).toBe(original);
    expect(normalizeError(new SyntaxError("bad")).problem).toBe(INVALID_RESPONSE_PROBLEM);
    expect(normalizeError(new z.ZodError([])).message).toBe(
      "The server sent a response cellar could not read.",
    );
    const abort = new Error("stop");
    abort.name = "AbortError";
    expect(normalizeError(abort).problem).toBe(ABORTED_PROBLEM);
    expect(normalizeError("").message).toBe("Could not reach the server.");
    expect(normalizeError(42).message).toBe("Could not reach the server. 42");
  });

  it("ApiClientError keeps only object details and judges retryability", () => {
    expect(new ApiClientError("a", "b", 400, ["x"]).details).toBeNull();
    expect(new ApiClientError("a", "b", 429).retryable).toBe(true);
    expect(new ApiClientError("a", "b", 400).retryable).toBe(false);
    expect(new ApiClientError("a", "b").retryable).toBe(false);
    expect(new ApiClientError("a", "b").name).toBe("ApiClientError");
  });

  it("httpMessage prefers the canned text, then statusText, then the code", () => {
    expect(httpMessage(429, "")).toContain("Rate limited");
    expect(httpMessage(418, "I'm a teapot")).toBe("I'm a teapot");
    expect(httpMessage(418, "")).toBe("Request failed with status 418");
  });

  it("buildQuery drops empty values and encodes the rest", () => {
    expect(buildQuery({})).toBe("");
    expect(buildQuery({ a: null, b: undefined, c: "" })).toBe("");
    expect(buildQuery({ q: "a b", page: 2, all: true })).toBe("?q=a+b&page=2&all=true");
  });

  it("parseEventData reads {type, at, payload} frames and rejects the rest", () => {
    expect(parseEventData('{"type":"job.done","at":5,"payload":{"id":1}}')).toEqual({
      type: "job.done",
      at: 5,
      payload: { id: 1 },
    });
    expect(parseEventData('{"type":"","at":5}')).toBeNull();
    expect(parseEventData('{"at":5}')).toBeNull();
    expect(parseEventData("not json")).toBeNull();
  });
});
