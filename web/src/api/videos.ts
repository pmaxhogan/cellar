import {
  BulkDownloadEstimateSchema,
  MAX_BULK_IDS,
  SOURCE_KINDS,
  STATUS_VALUES,
  TrashResponseSchema,
  VIDEO_PER_PAGE,
  VIDEO_PRI_FILTERS,
  VIDEO_SORT_KEYS,
  VIDEO_TYPES,
  VideoDetailSchema,
  VideoHistoryResponseSchema,
  VideoJobResponseSchema,
  VideosListResponseSchema,
  VideoStatsResponseSchema,
  type BulkDownloadEstimate,
  type BulkKind,
  type SourceKind,
  type VideoDetail,
  type VideoHistoryResponse,
  type VideoJobResponse,
  type VideoRow,
  type VideoShareLink,
  type VideosListResponse,
  type VideoSort,
  type VideoStatsResponse,
  type VideoStatus,
  type VideoType,
} from "@cellar/shared";
import { buildQuery, type ApiClient, type QueryValue } from "./client.ts";

/**
 * The videos catalog API (GET /api/videos and friends) plus the mapping
 * between the list page's state and two string forms of it: the URL query the
 * page mirrors (so a filtered view can be shared and reloaded) and the API
 * query the server parses with VideosListQuerySchema.
 */

export type DownloadedFilter = "yes" | "no";
export type PriFilter = (typeof VIDEO_PRI_FILTERS)[number];
export type SortDir = "asc" | "desc";

export interface VideoFilters {
  q: string;
  source: SourceKind[];
  account_id: number | null;
  channel_id: string | null;
  status: VideoStatus[];
  downloaded: DownloadedFilter | null;
  type: VideoType[];
  /** YYYY-MM-DD, inclusive (the server reads a bare date as UTC). */
  date_from: string | null;
  date_to: string | null;
  /** Seconds, inclusive. */
  min_duration: number | null;
  max_duration: number | null;
  pri: PriFilter | null;
  location_id: number | null;
}

export interface VideoListState {
  filters: VideoFilters;
  page: number;
  perPage: number;
  /** Null: the server default (relevance with `q`, else upload date). */
  sort: VideoSort | null;
  dir: SortDir;
}

export const DEFAULT_PER_PAGE = 50;

export function emptyFilters(): VideoFilters {
  return {
    q: "",
    source: [],
    account_id: null,
    channel_id: null,
    status: [],
    downloaded: null,
    type: [],
    date_from: null,
    date_to: null,
    min_duration: null,
    max_duration: null,
    pri: null,
    location_id: null,
  };
}

export function defaultListState(): VideoListState {
  return { filters: emptyFilters(), page: 1, perPage: DEFAULT_PER_PAGE, sort: null, dir: "desc" };
}

/** True when any filter narrows the list (paging and sort do not count). */
export function hasFilters(filters: VideoFilters): boolean {
  const empty = emptyFilters();
  return (Object.keys(empty) as (keyof VideoFilters)[]).some(
    (key) => JSON.stringify(filters[key]) !== JSON.stringify(empty[key]),
  );
}

type RawQuery = Record<string, unknown>;

function first(raw: unknown): string | null {
  const value: unknown = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function list<T extends string>(raw: unknown, allowed: readonly T[]): T[] {
  const parts = (Array.isArray(raw) ? (raw as unknown[]) : [raw])
    .filter((part): part is string => typeof part === "string")
    .flatMap((part) => part.split(","))
    .map((part) => part.trim());
  const out: T[] = [];
  for (const part of parts) {
    if ((allowed as readonly string[]).includes(part) && !out.includes(part as T)) {
      out.push(part as T);
    }
  }
  return out;
}

function nonNegativeInt(raw: unknown): number | null {
  const text = first(raw);
  if (text === null || !/^\d{1,12}$/.test(text)) return null;
  return Number(text);
}

function positiveInt(raw: unknown): number | null {
  const value = nonNegativeInt(raw);
  return value !== null && value > 0 ? value : null;
}

function isoDate(raw: unknown): string | null {
  const text = first(raw);
  return text !== null && /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function oneOf<T extends string>(raw: unknown, allowed: readonly T[]): T | null {
  const text = first(raw);
  return text !== null && (allowed as readonly string[]).includes(text) ? (text as T) : null;
}

function downloadedFrom(raw: unknown): DownloadedFilter | null {
  const text = first(raw);
  if (text === "yes" || text === "true") return "yes";
  if (text === "no" || text === "false") return "no";
  return null;
}

/** Read the page state from a route query. Anything unreadable falls back to the default. */
export function stateFromQuery(query: RawQuery): VideoListState {
  const perPage = positiveInt(query["perPage"]);
  return {
    filters: {
      q: first(query["q"]) ?? "",
      source: list(query["source"], SOURCE_KINDS),
      account_id: positiveInt(query["account_id"]),
      channel_id: first(query["channel_id"]),
      status: list(query["status"], STATUS_VALUES),
      downloaded: downloadedFrom(query["downloaded"]),
      type: list(query["type"], VIDEO_TYPES),
      date_from: isoDate(query["date_from"]),
      date_to: isoDate(query["date_to"]),
      min_duration: nonNegativeInt(query["min_duration"]),
      max_duration: nonNegativeInt(query["max_duration"]),
      pri: oneOf(query["pri"], VIDEO_PRI_FILTERS),
      location_id: positiveInt(query["location_id"]),
    },
    page: positiveInt(query["page"]) ?? 1,
    perPage:
      perPage !== null && (VIDEO_PER_PAGE as readonly number[]).includes(perPage)
        ? perPage
        : DEFAULT_PER_PAGE,
    sort: oneOf(query["sort"], VIDEO_SORT_KEYS),
    dir: first(query["dir"]) === "asc" ? "asc" : "desc",
  };
}

/** The filter part of both the URL and the API query. Lists are comma joined. */
function filterParams(filters: VideoFilters): Record<string, QueryValue> {
  const joined = (values: readonly string[]) => (values.length === 0 ? null : values.join(","));
  return {
    q: filters.q.trim(),
    source: joined(filters.source),
    account_id: filters.account_id,
    channel_id: filters.channel_id,
    status: joined(filters.status),
    downloaded: filters.downloaded === null ? null : filters.downloaded === "yes",
    type: joined(filters.type),
    date_from: filters.date_from,
    date_to: filters.date_to,
    min_duration: filters.min_duration,
    max_duration: filters.max_duration,
    pri: filters.pri,
    location_id: filters.location_id,
  };
}

function compact(params: Record<string, QueryValue>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    out[key] = String(value);
  }
  return out;
}

/** The URL query for a state: defaults are left out so a plain list has a plain URL. */
export function stateToQuery(state: VideoListState): Record<string, string> {
  return compact({
    ...filterParams(state.filters),
    downloaded: state.filters.downloaded,
    page: state.page === 1 ? null : state.page,
    perPage: state.perPage === DEFAULT_PER_PAGE ? null : state.perPage,
    sort: state.sort,
    dir: state.sort === null || state.dir === "desc" ? null : state.dir,
  });
}

/** The API query for a state, in the shape VideosListQuerySchema parses. */
export function stateToApiQuery(state: VideoListState): Record<string, string> {
  return compact({
    ...filterParams(state.filters),
    page: state.page,
    perPage: state.perPage,
    // No sort: the server ranks by relevance when `q` is set, else by upload date.
    sort: state.sort,
    dir: state.sort === null ? null : state.dir,
  });
}

function videoPath(id: string, rest = ""): string {
  return `/api/videos/${encodeURIComponent(id)}${rest}`;
}

export function listVideos(
  api: ApiClient,
  state: VideoListState,
  signal?: AbortSignal,
): Promise<VideosListResponse> {
  return api.request(`/api/videos${buildQuery(stateToApiQuery(state))}`, {
    schema: VideosListResponseSchema,
    signal,
  });
}

export interface CollectProgress {
  collected: number;
  total: number;
}

export interface CollectResult {
  rows: VideoRow[];
  total: number;
  /** True when more videos matched than one request may carry. */
  capped: boolean;
}

/** The page size used to collect every matching id. */
export const COLLECT_PER_PAGE = 200;

/**
 * Every row matching the filters, paged at 200 until the total is covered or
 * MAX_BULK_IDS is reached. Rows come back too so a bulk dialog can name files.
 */
export async function collectMatching(
  api: ApiClient,
  filters: VideoFilters,
  options: {
    sort?: VideoSort | null;
    dir?: SortDir;
    signal?: AbortSignal;
    max?: number;
    onProgress?: (progress: CollectProgress) => void;
  } = {},
): Promise<CollectResult> {
  const max = options.max ?? MAX_BULK_IDS;
  const rows: VideoRow[] = [];
  const seen = new Set<string>();
  let total: number;
  for (let page = 1; ; page += 1) {
    const result = await listVideos(
      api,
      {
        filters,
        page,
        perPage: COLLECT_PER_PAGE,
        sort: options.sort ?? null,
        dir: options.dir ?? "desc",
      },
      options.signal,
    );
    total = result.total;
    for (const row of result.rows) {
      if (rows.length >= max) break;
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
    options.onProgress?.({ collected: rows.length, total: Math.min(total, max) });
    const exhausted = result.rows.length < COLLECT_PER_PAGE || page * COLLECT_PER_PAGE >= total;
    if (rows.length >= max || exhausted) break;
  }
  return { rows, total, capped: total > max };
}

export function getVideo(api: ApiClient, id: string, signal?: AbortSignal): Promise<VideoDetail> {
  return api.request(videoPath(id), { schema: VideoDetailSchema, signal });
}

/** History rows per page on the detail page. */
export const HISTORY_PER_PAGE = 50;

export function getVideoHistory(
  api: ApiClient,
  id: string,
  query: { page: number; perPage?: number; field?: string },
  signal?: AbortSignal,
): Promise<VideoHistoryResponse> {
  const search = buildQuery({
    page: query.page,
    perPage: query.perPage ?? HISTORY_PER_PAGE,
    field: query.field,
  });
  return api.request(videoPath(id, `/history${search}`), {
    schema: VideoHistoryResponseSchema,
    signal,
  });
}

export function getVideoStats(
  api: ApiClient,
  id: string,
  signal?: AbortSignal,
): Promise<VideoStatsResponse> {
  return api.request(videoPath(id, "/stats"), { schema: VideoStatsResponseSchema, signal });
}

export function recheckVideo(api: ApiClient, id: string): Promise<VideoJobResponse> {
  return api.request(videoPath(id, "/recheck"), {
    method: "POST",
    schema: VideoJobResponseSchema,
  });
}

export function downloadVideoNow(api: ApiClient, id: string): Promise<VideoJobResponse> {
  return api.request(videoPath(id, "/download-now"), {
    method: "POST",
    schema: VideoJobResponseSchema,
  });
}

export async function trashVideos(api: ApiClient, ids: readonly string[]): Promise<number> {
  const result = await api.request("/api/videos/trash", {
    method: "POST",
    body: { ids },
    schema: TrashResponseSchema,
  });
  return result.count;
}

export function estimateBulkDownload(
  api: ApiClient,
  ids: readonly string[],
  kind: BulkKind,
  signal?: AbortSignal,
): Promise<BulkDownloadEstimate> {
  return api.request("/api/videos/bulk-download/estimate", {
    method: "POST",
    body: { ids, kind },
    schema: BulkDownloadEstimateSchema,
    signal,
  });
}

// --- URLs the browser fetches directly (player, links, downloads) ----------

export function mediaUrl(videoId: string, mediaId: number, download = false): string {
  return videoPath(videoId, `/media/${mediaId}${download ? "?download=1" : ""}`);
}

export function captionsUrl(videoId: string, lang: string): string {
  return videoPath(videoId, `/captions/${encodeURIComponent(lang)}`);
}

export function metadataUrl(videoId: string): string {
  return videoPath(videoId, "/metadata.json");
}

/** Public share page for a token (the short `/s/<token>` URL). */
export function sharePageUrl(token: string, origin = globalThis.location?.origin ?? ""): string {
  return `${origin}/s/${encodeURIComponent(token)}`;
}

// --- Share links ------------------------------------------------------------

/** The shares API row and list envelope come from the shared contract. */
export {
  ShareLinkRowSchema,
  SharesListResponseSchema as ShareLinksListResponseSchema,
  type ShareLinkRow,
  type ShareStatus,
} from "@cellar/shared";
import {
  ShareLinkRowSchema as SharedShareLinkRowSchema,
  SharesListResponseSchema as SharedSharesListResponseSchema,
  type ShareLinkRow,
  type ShareStatus,
} from "@cellar/shared";
export const SHARE_STATUSES = ["active", "expired", "revoked"] as const;
const ShareLinkRowSchema = SharedShareLinkRowSchema;
const ShareLinksListResponseSchema = SharedSharesListResponseSchema;

/** What the page shows for a link, from a shares API row or a video detail row. */
export interface ShareLinkView {
  token: string;
  expires_at: number | null;
  revoked_at: number | null;
  access_count: number;
  last_access_at: number | null;
  created_at: number;
  url: string;
  status: ShareStatus;
}

/** Derive the status the shares API would report for a detail row. */
export function shareStatus(
  row: Pick<ShareLinkView, "expires_at" | "revoked_at">,
  now = Date.now(),
): ShareStatus {
  if (row.revoked_at !== null) return "revoked";
  if (row.expires_at !== null && row.expires_at <= now) return "expired";
  return "active";
}

export function shareView(row: VideoShareLink | ShareLinkRow, now = Date.now()): ShareLinkView {
  const full = "url" in row ? row : null;
  return {
    token: row.token,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    access_count: row.access_count,
    last_access_at: full?.last_access_at ?? null,
    created_at: row.created_at,
    url: full?.url ?? sharePageUrl(row.token),
    status: full?.status ?? shareStatus(row, now),
  };
}

/** Share links of one video (newest first), at most 100: one video rarely has more. */
export async function listShareLinks(
  api: ApiClient,
  videoId: string,
  signal?: AbortSignal,
): Promise<ShareLinkView[]> {
  const result = await api.request(
    `/api/shares${buildQuery({ video_id: videoId, page: 1, perPage: 100 })}`,
    { schema: ShareLinksListResponseSchema, signal },
  );
  return result.rows.map((row) => shareView(row));
}

export async function createShareLink(
  api: ApiClient,
  videoId: string,
  expiresAt: number | null,
): Promise<ShareLinkView> {
  const row = await api.request("/api/shares", {
    method: "POST",
    body: { video_id: videoId, expires_at: expiresAt },
    schema: ShareLinkRowSchema,
  });
  return shareView(row);
}

/** Revoke one link (idempotent); answers the revoked row. */
export async function revokeShareLink(api: ApiClient, token: string): Promise<ShareLinkView> {
  const row = await api.request(`/api/shares/${encodeURIComponent(token)}/revoke`, {
    method: "POST",
    schema: ShareLinkRowSchema,
  });
  return shareView(row);
}
