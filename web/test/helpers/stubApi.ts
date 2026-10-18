import { vi } from "vitest";
import type { StatusResponse } from "@cellar/shared";
import type { ApiClient } from "../../src/api/client.ts";

/** A fully stubbed ApiClient. Every method resolves to an empty-ish value. */
export function stubApi(overrides: Partial<ApiClient> = {}): ApiClient {
  const base = {
    baseUrl: "",
    raw: vi.fn(),
    request: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockResolvedValue(makeStatus()),
    eventsUrl: vi.fn().mockReturnValue("/api/events"),
  };
  return { ...base, ...overrides } as unknown as ApiClient;
}

export function makeStatus(overrides: Partial<StatusResponse> = {}): StatusResponse {
  return {
    version: "0.1.0-test",
    insecureMode: false,
    startedAt: 1_700_000_000_000,
    now: 1_700_000_600_000,
    db: { ok: true, migrations: 3 },
    tools: { ytdlp: "2026.10.10", ffmpeg: "7.1" },
    ...overrides,
  };
}
