import { z } from "zod";
import {
  ApiErrorSchema,
  TAKEOUT_ACCEPT,
  TAKEOUT_ACTIVITY_KIND,
  TakeoutCountsSchema,
  TakeoutJobResponseSchema,
  TakeoutUploadResponseSchema,
  type TakeoutCounts,
  type TakeoutJobResponse,
  type TakeoutUploadResponse,
} from "@cellar/shared";
import {
  ABORTED_PROBLEM,
  ApiClientError,
  httpMessage,
  INVALID_RESPONSE_PROBLEM,
  NETWORK_PROBLEM,
  type ApiClient,
} from "./client.ts";
import { listActivity, type ActivityRow } from "./activity.ts";

/**
 * Google Takeout import API (shared/src/apiTypes.ts wave5B).
 *
 *   POST /api/takeout?account_id=  multipart files -> 202 TakeoutUploadResponse
 *   GET  /api/takeout/:jobId                       -> TakeoutJobResponse
 *   GET  /api/activity?kind=takeout.imported       -> previous imports
 *
 * The upload goes through XMLHttpRequest rather than fetch because fetch has
 * no upload progress events, and a Takeout archive can be large.
 */

/** File name endings the picker and the drop zone accept. */
export const ACCEPTED_SUFFIXES = TAKEOUT_ACCEPT.split(",");

export function isAcceptedFile(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPTED_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** The slice of XMLHttpRequest the upload uses; tests pass a stub. */
export interface XhrLike {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: FormData): void;
  abort(): void;
  readonly status: number;
  readonly statusText: string;
  readonly responseText: string;
  withCredentials: boolean;
  onload: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onabort: ((event: unknown) => void) | null;
  upload: { onprogress: ((event: { loaded: number; total: number }) => void) | null };
}

export type XhrFactory = () => XhrLike;

const defaultXhr: XhrFactory = () => new XMLHttpRequest() as unknown as XhrLike;

export interface UploadInput {
  files: readonly File[];
  accountId: number;
  /** Bytes sent so far and the request's total. */
  onProgress?: (loaded: number, total: number) => void;
}

export interface UploadHandle {
  promise: Promise<TakeoutUploadResponse>;
  abort(): void;
}

function errorFrom(xhr: XhrLike): ApiClientError {
  let payload: unknown;
  try {
    payload = JSON.parse(xhr.responseText) as unknown;
  } catch {
    payload = null;
  }
  const parsed = ApiErrorSchema.safeParse(payload);
  if (parsed.success) {
    return new ApiClientError(
      parsed.data.code ?? `http_${String(xhr.status)}`,
      parsed.data.error,
      xhr.status,
      parsed.data.details,
    );
  }
  return new ApiClientError(
    `http_${String(xhr.status)}`,
    httpMessage(xhr.status, xhr.statusText),
    xhr.status,
  );
}

export function uploadTakeout(
  api: ApiClient,
  input: UploadInput,
  createXhr: XhrFactory = defaultXhr,
): UploadHandle {
  const xhr = createXhr();
  const promise = new Promise<TakeoutUploadResponse>((resolve, reject) => {
    const form = new FormData();
    for (const file of input.files) {
      form.append("files", file, file.name);
    }
    xhr.open(
      "POST",
      `${api.baseUrl}/api/takeout?account_id=${encodeURIComponent(String(input.accountId))}`,
    );
    xhr.withCredentials = true;
    xhr.setRequestHeader("Accept", "application/json");
    xhr.upload.onprogress = (event) => {
      input.onProgress?.(event.loaded, event.total);
    };
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(errorFrom(xhr));
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(xhr.responseText) as unknown;
      } catch {
        payload = null;
      }
      const parsed = TakeoutUploadResponseSchema.safeParse(payload);
      if (!parsed.success) {
        reject(
          new ApiClientError(
            INVALID_RESPONSE_PROBLEM,
            "The server sent a response cellar could not read.",
          ),
        );
        return;
      }
      resolve(parsed.data);
    };
    xhr.onerror = () => {
      reject(new ApiClientError(NETWORK_PROBLEM, "Could not reach the server."));
    };
    xhr.onabort = () => {
      reject(new ApiClientError(ABORTED_PROBLEM, "The upload was canceled."));
    };
    xhr.send(form);
  });
  return {
    promise,
    abort: () => {
      xhr.abort();
    },
  };
}

export function getTakeoutJob(
  api: ApiClient,
  jobId: number,
  signal?: AbortSignal,
): Promise<TakeoutJobResponse> {
  return api.request(`/api/takeout/${String(jobId)}`, {
    schema: TakeoutJobResponseSchema,
    signal,
  });
}

/** One previous import, from its Activity row. */
export interface TakeoutImportEntry {
  id: number;
  at: number;
  message: string;
  jobId: number | null;
  counts: TakeoutCounts | null;
}

export function toImportEntry(row: ActivityRow): TakeoutImportEntry {
  const counts = TakeoutCountsSchema.safeParse(row.data);
  return {
    id: row.id,
    at: row.at,
    message: row.message,
    jobId: row.job_id,
    counts: counts.success ? counts.data : null,
  };
}

export async function listTakeoutImports(
  api: ApiClient,
  signal?: AbortSignal,
): Promise<TakeoutImportEntry[]> {
  const page = await listActivity(api, { kind: TAKEOUT_ACTIVITY_KIND, perPage: 20 }, signal);
  return page.rows.map(toImportEntry);
}

const JobEventSchema = z.object({
  id: z.number(),
  pct: z.number().optional(),
  message: z.string().optional(),
});

export interface TakeoutJobEvent {
  type: "progress" | "done" | "failed" | "cancelled" | "started" | "queued";
  pct: number | null;
  message: string | null;
}

/** A `job.*` SSE frame about `jobId`, or null when it is about something else. */
export function readTakeoutJobEvent(
  type: string,
  payload: unknown,
  jobId: number,
): TakeoutJobEvent | null {
  if (!type.startsWith("job.")) return null;
  const parsed = JobEventSchema.safeParse(payload);
  if (!parsed.success || parsed.data.id !== jobId) return null;
  const name = type.slice("job.".length);
  const known = ["progress", "done", "failed", "cancelled", "started", "queued"] as const;
  const kind = known.find((candidate) => candidate === name);
  if (kind === undefined) return null;
  return {
    type: kind,
    pct: parsed.data.pct === undefined ? null : Math.max(0, Math.min(100, parsed.data.pct)),
    message: parsed.data.message ?? null,
  };
}

/** How a file kind reads in the preview. */
export function kindLabel(kind: string): string {
  switch (kind) {
    case "history":
      return "Watch history";
    case "watch_later":
      return "Watch later";
    case "liked":
      return "Liked videos";
    case "subscription":
      return "Subscriptions";
    default:
      return kind.startsWith("playlist:")
        ? `Playlist "${kind.slice("playlist:".length)}" (counted, not imported)`
        : kind;
  }
}

/** Human copy for the skip reasons the server reports. */
export const SKIP_REASONS: Record<string, string> = {
  "not-used": "Not part of the import",
  "unsupported-file-type": "Not a Takeout file type",
  "history-is-html": "History exported as HTML",
  "not-a-regular-file": "Not a regular file",
  "unsafe-path": "Path outside the archive",
  "unreadable-file": "Unreadable file",
  ad: "Ads",
  "no-url": "Removed or private videos",
  "not-a-video": "Not a video (posts, channels, visits)",
  "malformed-entry": "Malformed entries",
  "invalid-video-id": "Invalid video ids",
  "invalid-channel-id": "Invalid channel ids",
};

export function skipReasonLabel(reason: string): string {
  if (reason.startsWith("unreadable: ")) return `Unreadable: ${reason.slice(12)}`;
  return SKIP_REASONS[reason] ?? reason;
}
