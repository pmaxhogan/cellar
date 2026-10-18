import type { TakeoutCounts, TakeoutJobResponse, TakeoutUploadResponse } from "@cellar/shared";
import type { XhrLike } from "../../src/api/takeout.ts";

/** Synthetic Takeout API payloads and a controllable XMLHttpRequest stand-in. */

export const EMOJI = `Road trip ${String.fromCodePoint(0x1f697)}`;

export function account(id: number, label: string, email: string | null = null) {
  return {
    id,
    label,
    email,
    channel_id: null,
    status: "ok" as const,
    has_cookies: true,
    scrape_budget_per_hour: null,
    last_api_ok_at: null,
    last_cookie_ok_at: null,
    created_at: 1_700_000_000_000,
  };
}

export function preview(overrides: Partial<TakeoutUploadResponse> = {}): TakeoutUploadResponse {
  return {
    job_id: 7,
    files: [
      {
        name: "Takeout/YouTube and YouTube Music/history/watch-history.json",
        kind: "history",
        rows: 1234,
        skipped_rows: { ad: 3, "no-url": 2 },
      },
      {
        name: "Takeout/YouTube and YouTube Music/playlists/Watch later-videos.csv",
        kind: "watch_later",
        rows: 12,
        skipped_rows: {},
      },
      {
        name: "Takeout/YouTube and YouTube Music/playlists/Mix-videos.csv",
        kind: "playlist:Mix",
        rows: 4,
        skipped_rows: {},
      },
    ],
    skipped: [
      { name: "Takeout/YouTube and YouTube Music/history/search-history.json", reason: "not-used" },
    ],
    skipped_total: 3,
    ...overrides,
  };
}

export function counts(overrides: Partial<TakeoutCounts> = {}): TakeoutCounts {
  return {
    account_id: 1,
    history: 1234,
    history_videos: 900,
    watch_later: 12,
    liked: 30,
    subscriptions: 55,
    playlists_ignored: 1,
    playlist_videos_ignored: 4,
    new_videos: 800,
    new_sources: 997,
    skipped: { ad: 3, "no-url": 2 },
    recheck_jobs: 16,
    duration_ms: 4200,
    ...overrides,
  };
}

export function jobResponse(overrides: Partial<TakeoutJobResponse> = {}): TakeoutJobResponse {
  return {
    job_id: 7,
    status: "queued",
    error: null,
    created_at: 1_700_000_000_000,
    finished_at: null,
    files: [],
    counts: null,
    ...overrides,
  };
}

export function importActivity(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    at: Date.now() - 3_600_000,
    level: "info",
    kind: "takeout.imported",
    message: `Takeout imported: import ${String(id)}`,
    video_id: null,
    job_id: id,
    data: counts(),
    ...overrides,
  };
}

/** Records what the page did with it; the test drives the response. */
export class FakeXhr implements XhrLike {
  static instances: FakeXhr[] = [];

  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: FormData | null = null;
  aborted = false;
  status = 0;
  statusText = "";
  responseText = "";
  withCredentials = false;
  onload: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onabort: ((event: unknown) => void) | null = null;
  upload: { onprogress: ((event: { loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };

  constructor() {
    FakeXhr.instances.push(this);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  send(body: FormData): void {
    this.body = body;
  }

  abort(): void {
    this.aborted = true;
    this.onabort?.({});
  }

  progress(loaded: number, total: number): void {
    this.upload.onprogress?.({ loaded, total });
  }

  respond(status: number, body: unknown, statusText = ""): void {
    this.status = status;
    this.statusText = statusText;
    this.responseText = typeof body === "string" ? body : JSON.stringify(body);
    this.onload?.({});
  }

  fail(): void {
    this.onerror?.({});
  }

  static last(): FakeXhr {
    const xhr = FakeXhr.instances.at(-1);
    if (xhr === undefined) throw new Error("no XMLHttpRequest was opened");
    return xhr;
  }
}
