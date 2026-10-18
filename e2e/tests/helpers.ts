import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  test as base,
  expect,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
} from "@playwright/test";

/**
 * Shared fixtures and small API helpers.
 *
 * There is no database reset: every spec runs against the one server the
 * Playwright config starts, so a spec names the rows it creates with
 * uniqueName() and deletes them again. That also keeps a CI retry (which
 * re-runs a file against the same database) from tripping over the rows the
 * first attempt left behind.
 */

/** Distinguishes this run's rows from anything an earlier attempt created. */
export const RUN_ID = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

let nameCounter = 0;

/** A label no other spec (and no earlier attempt of this one) uses. */
export function uniqueName(prefix: string): string {
  nameCounter += 1;
  return `${prefix} e2e-${RUN_ID}-${String(nameCounter)}`;
}

/** A syntactically valid, unique UC channel id: "UC" plus 22 id characters. */
export function uniqueChannelId(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  let id = "UC";
  for (let index = 0; index < 22; index += 1) {
    id += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return id;
}

/** A temp directory that the caller is expected to clean up. */
export function scratchDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `cellar-e2e-${prefix}-`));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * The form a location path has to take in the UI, which (like the container it
 * is written for) only accepts POSIX absolute paths. On Linux that is the path
 * itself. On Windows the drive letter is dropped and the separators flipped:
 * node's resolve() on the server puts the server's own drive back, which is
 * the drive the temp directory is on when both live on C:.
 */
export function toContainerPath(dir: string): string {
  if (process.platform !== "win32") return dir;
  return dir.replace(/^[A-Za-z]:/, "").replaceAll("\\", "/");
}

/** Fails with the response body in the message, which beats a bare status. */
async function expectStatus(response: APIResponse, expected: number[], what: string) {
  if (!expected.includes(response.status())) {
    const body = await response.text().catch(() => "");
    throw new Error(`${what} answered ${String(response.status())}: ${body.slice(0, 500)}`);
  }
}

/** Thin JSON helpers over Playwright's request context, for setup and teardown. */
export class Api {
  readonly request: APIRequestContext;

  constructor(request: APIRequestContext) {
    this.request = request;
  }

  async get<T>(path: string): Promise<T> {
    const response = await this.request.get(path);
    await expectStatus(response, [200], `GET ${path}`);
    return (await response.json()) as T;
  }

  async send<T>(
    method: "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    data?: unknown,
    expected: number[] = [200, 201, 202, 204],
  ): Promise<T> {
    const response = await this.request.fetch(path, {
      method,
      ...(data === undefined ? {} : { data }),
    });
    await expectStatus(response, expected, `${method} ${path}`);
    const text = await response.text();
    return (text === "" ? undefined : JSON.parse(text)) as T;
  }

  /** The raw response, for asserting on a status the helpers would reject. */
  raw(method: string, path: string, data?: unknown): Promise<APIResponse> {
    return this.request.fetch(path, {
      method,
      maxRedirects: 0,
      ...(data === undefined ? {} : { data }),
    });
  }

  /** True when the server answers this GET with anything but the API 404. */
  async has(path: string): Promise<boolean> {
    const response = await this.request.get(path);
    if (response.status() !== 404) return true;
    const body = (await response.json().catch(() => ({}))) as { code?: string };
    return body.code !== "not_found";
  }

  // ---- typed shortcuts for the resources the specs create and clean up

  async status(): Promise<StatusBody> {
    return this.get<StatusBody>("/api/status");
  }

  async settings(): Promise<Record<string, unknown>> {
    return (await this.get<{ overrides: Record<string, unknown> }>("/api/settings")).overrides;
  }

  async putSettings(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    const body = await this.send<{ overrides: Record<string, unknown> }>(
      "PUT",
      "/api/settings",
      patch,
    );
    return body.overrides;
  }

  async locations(): Promise<LocationBody[]> {
    return (await this.get<{ rows: LocationBody[] }>("/api/locations")).rows;
  }

  async accounts(): Promise<AccountBody[]> {
    return (await this.get<{ rows: AccountBody[] }>("/api/accounts")).rows;
  }

  async proxies(): Promise<ProxyBody[]> {
    return (await this.get<{ rows: ProxyBody[] }>("/api/proxies")).rows;
  }

  async unreadCount(): Promise<number> {
    const body = await this.get<{ total: number }>("/api/notifications?unacked=true&perPage=1");
    return body.total;
  }

  /** Deletes every row of a collection whose label carries this run's id. */
  async deleteOwned(collection: "accounts" | "locations" | "proxies"): Promise<void> {
    const rows = await this.get<{ rows: { id: number; label: string }[] }>(`/api/${collection}`);
    for (const row of rows.rows) {
      if (row.label.includes(`e2e-${RUN_ID}`)) {
        await this.send("DELETE", `/api/${collection}/${String(row.id)}`, undefined, [204, 404]);
      }
    }
  }
}

export interface StatusBody {
  version: string;
  insecureMode: boolean;
  db: { ok: boolean; migrations: number };
  tools: { ytdlp: string | null; ffmpeg: string | null };
}

export interface LocationBody {
  id: number;
  label: string;
  container_path: string;
  quota_bytes: number;
  enabled: boolean;
  mounted: boolean;
}

export interface AccountBody {
  id: number;
  label: string;
  status: string;
  has_cookies: boolean;
}

export interface ProxyBody {
  id: number;
  label: string;
  url_redacted: string;
  enabled: boolean;
}

interface Fixtures {
  /** The server's origin, as the config resolved it. */
  apiBase: string;
  api: Api;
}

/**
 * `test` with the API helpers, plus a guard that fails any test whose page
 * threw an uncaught error, so "the page did not break" is checked everywhere
 * rather than only where a spec remembers to.
 */
export const test = base.extend<Fixtures>({
  apiBase: async ({ baseURL }, use) => {
    if (baseURL === undefined) throw new Error("baseURL is not configured");
    await use(baseURL);
  },
  api: async ({ request }, use) => {
    await use(new Api(request));
  },
  page: async ({ page }, use) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await use(page);
    expect(errors, "uncaught errors in the page").toEqual([]);
  },
});

export { expect };

/** The toast PrimeVue renders for a mutation, by its summary line. */
export function toastWith(page: Page, summary: string | RegExp): Locator {
  return page.locator(".p-toast-message").filter({ hasText: summary });
}

/** Quotas are entered in GB, 1024-based, the same unit formatBytes shows back. */
export const BYTES_PER_GB = 1024 ** 3;
