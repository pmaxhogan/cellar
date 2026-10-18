import { z } from "zod";
import { ProxiesListResponseSchema, ProxyRowSchema, type ProxyRow } from "@cellar/shared";
import type { ApiClient } from "./client.ts";

/**
 * Proxy URLs carry credentials, so they are write-only: the server only ever
 * returns `url_redacted`, and the UI never holds a stored URL to prefill.
 */

export const ProxyTestResultSchema = z.object({
  ok: z.boolean(),
  latency_ms: z.number().nonnegative().nullish(),
  error: z.string().nullish(),
});
export type ProxyTestResult = z.infer<typeof ProxyTestResultSchema>;

export interface ProxyCreate {
  label: string;
  url: string;
  enabled: boolean;
}

export type ProxyUpdate = Partial<ProxyCreate>;

export async function listProxies(api: ApiClient, signal?: AbortSignal): Promise<ProxyRow[]> {
  const result = await api.request("/api/proxies", { schema: ProxiesListResponseSchema, signal });
  return result.rows;
}

export function createProxy(api: ApiClient, body: ProxyCreate): Promise<ProxyRow> {
  return api.request("/api/proxies", { method: "POST", body, schema: ProxyRowSchema });
}

export function updateProxy(api: ApiClient, id: number, patch: ProxyUpdate): Promise<ProxyRow> {
  return api.request(`/api/proxies/${id}`, { method: "PUT", body: patch, schema: ProxyRowSchema });
}

export function deleteProxy(api: ApiClient, id: number): Promise<void> {
  return api.request(`/api/proxies/${id}`, { method: "DELETE" });
}

export function testProxy(api: ApiClient, id: number): Promise<ProxyTestResult> {
  return api.request(`/api/proxies/${id}/test`, {
    method: "POST",
    schema: ProxyTestResultSchema,
  });
}

/** A light shape check; the server validates the scheme it supports. */
export function proxyUrlProblem(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed === "") return "Enter the proxy URL.";
  if (!/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(trimmed)) {
    return "Use scheme://[user:password@]host:port, such as socks5://host:1080.";
  }
  return null;
}

export function describeTest(result: ProxyTestResult): string {
  if (result.ok) {
    return result.latency_ms === null || result.latency_ms === undefined
      ? "Reachable"
      : `Reachable in ${Math.round(result.latency_ms)} ms`;
  }
  return result.error ? `Failed: ${result.error}` : "Failed";
}
