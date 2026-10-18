import {
  addDuration,
  parseIsoDuration,
  RuleDurationSchema,
  type ResolvedSettings,
  type RuleDuration,
} from "@cellar/shared";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db/db.ts";
import { parseJsonColumn } from "../db/paged.ts";
import type { JobRegistry } from "../jobs/types.ts";
import { youtubeApi } from "../youtube/api.ts";
import {
  enqueueRecheck,
  ensureChannel,
  isChannelId,
  pickApiAccount,
  RECHECK_BATCH_SIZE,
  type IngestDeps,
} from "../youtube/ingest.ts";
import { QuotaExhausted } from "../youtube/quota.ts";
import { cachedRyd, createRydClient, rydRatio, type RydClient } from "../youtube/ryd.ts";
import { logActivity } from "./activity.ts";
import { fetchOf, nowOf } from "./deps.ts";
import { DomainError } from "./errors.ts";
import { recordAccountAuthLoss, recordOutage, type NotifyDeps } from "./notifications.ts";
import { scheduleEvalPass } from "./ruleEval.ts";
import { getSettings } from "./settings.ts";
import {
  refreshThumbnails,
  thumbnailsNeedRefresh,
  thumbnailUrls,
  type ApiThumbnails,
  type ThumbnailVariant,
} from "./thumbnails.ts";
import { applyVideoDiff, type DiffResult, type VideoPatch } from "./videos.ts";

/**
 * Metadata rechecks (`recheck_batch`): one `videos.list` call per 50 ids
 * (1 unit), the response mapped onto `applyVideoDiff` so every changed
 * tracked field becomes a `video_changes` row, plus the gone logic, the
 * tiered cadence, RYD estimates, thumbnail refresh and version detection.
 */

export const VIDEO_PARTS =
  "snippet,contentDetails,statistics,status,liveStreamingDetails,topicDetails";
export const DAY_MS = 24 * 60 * 60_000;
export const SHORT_MAX_SECONDS = 180;
/** A version re-download needs the duration to move by more than this. */
export const VERSION_DURATION_TOLERANCE_S = 2;
/** A missing video is asked about again this soon (the second miss decides). */
export const MISSING_RETRY_MS = 12 * 60 * 60_000;
export const DOWNLOAD_JOB = "download";

export type RecheckTier = "daily" | "weekly" | "monthly" | "custom";

// ---------------------------------------------------------------------------
// API shapes
// ---------------------------------------------------------------------------

export interface ApiVideo {
  id?: string;
  snippet?: {
    publishedAt?: string;
    channelId?: string;
    channelTitle?: string;
    title?: string;
    description?: string;
    thumbnails?: ApiThumbnails;
    tags?: string[];
    categoryId?: string;
    liveBroadcastContent?: string;
    defaultLanguage?: string;
    defaultAudioLanguage?: string;
  };
  contentDetails?: {
    duration?: string;
    dimension?: string;
    definition?: string;
    caption?: string;
    licensedContent?: boolean;
    projection?: string;
  };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
  status?: { privacyStatus?: string };
  liveStreamingDetails?: Record<string, unknown>;
}

interface VideosListResponse {
  items?: ApiVideo[];
}

// ---------------------------------------------------------------------------
// Pure mapping
// ---------------------------------------------------------------------------

/**
 * Seconds of an ISO 8601 duration as YouTube sends it (`PT3M33S`, `P1DT2H`,
 * `P0D`). Null for anything unparsable or calendar-month based.
 */
export function parseDurationSeconds(iso: unknown): number | null {
  if (typeof iso !== "string") {
    return null;
  }
  const parts = parseIsoDuration(iso);
  if (parts === null || parts.months !== 0) {
    return null;
  }
  return Math.round(parts.ms / 1000);
}

/**
 * Hash of the contentDetails fields that reveal a re-encode or re-edit:
 * definition, dimension, projection and licensedContent. The duration is left
 * out on purpose: it has its own 2 s tolerance (spec 4.7), which a hash that
 * included it would defeat.
 */
export function contentSignature(details: ApiVideo["contentDetails"]): string | null {
  if (details === undefined) {
    return null;
  }
  const parts = [
    details.definition ?? null,
    details.dimension ?? null,
    details.projection ?? null,
    details.licensedContent ?? null,
  ];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** `none` | `upcoming` | `live` from snippet.liveBroadcastContent. */
export function liveStatusOf(video: ApiVideo): string | null {
  const value = video.snippet?.liveBroadcastContent;
  return value === "none" || value === "upcoming" || value === "live" ? value : null;
}

function countOf(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

function epochOf(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export interface TypeInput {
  durationS: number | null;
  hasLiveDetails: boolean;
  liveStatus: string | null;
  storedType: string | null;
  /** yt-dlp's opinion when known: true = a short, false = not a short. */
  shortHint: boolean | null;
}

/**
 * The video type. With liveStreamingDetails: a stored livestream/premiere is
 * kept (an ended broadcast stays what it was); otherwise `premiere` when it is
 * upcoming/live with a known duration (pre-uploaded content), else
 * `livestream`. Without: `short` when the duration is at most 180 s and
 * yt-dlp says it is a short, or when yt-dlp has not said and the stored type
 * is already `short` (a recheck never downgrades it); else `video`.
 */
export function classifyType(input: TypeInput): string {
  if (input.hasLiveDetails) {
    if (input.storedType === "livestream" || input.storedType === "premiere") {
      return input.storedType;
    }
    const broadcasting = input.liveStatus === "upcoming" || input.liveStatus === "live";
    return broadcasting && input.durationS !== null && input.durationS > 0
      ? "premiere"
      : "livestream";
  }
  if (input.durationS !== null && input.durationS <= SHORT_MAX_SECONDS) {
    if (input.shortHint === true || (input.shortHint === null && input.storedType === "short")) {
      return "short";
    }
  }
  return "video";
}

export interface MapContext {
  storedType: string | null;
  shortHint: boolean | null;
}

/**
 * Map one videos.list item onto the observed-metadata patch (no recheck
 * bookkeeping). Keys are only present for parts the response carried; within
 * a present part a missing value is observed-empty (null): hidden likes,
 * disabled comments, no tags.
 */
export function mapVideoItem(video: ApiVideo, context: MapContext): VideoPatch {
  const patch: VideoPatch = {};
  const snippet = video.snippet;
  if (snippet !== undefined) {
    if (typeof snippet.title === "string") {
      patch.title = snippet.title;
    }
    patch.description = typeof snippet.description === "string" ? snippet.description : null;
    patch.tags_json = JSON.stringify(
      Array.isArray(snippet.tags) ? snippet.tags.filter((t) => typeof t === "string") : [],
    );
    patch.category_id = typeof snippet.categoryId === "string" ? snippet.categoryId : null;
    patch.default_language = snippet.defaultLanguage ?? snippet.defaultAudioLanguage ?? null;
    const published = epochOf(snippet.publishedAt);
    if (published !== null) {
      patch.upload_date = published;
      patch.published_at = published;
    }
    const live = liveStatusOf(video);
    if (live !== null) {
      patch.live_status = live;
    }
  }
  const details = video.contentDetails;
  const durationS = parseDurationSeconds(details?.duration);
  if (details !== undefined) {
    if (durationS !== null) {
      patch.duration_s = durationS;
    }
    patch.caption_available = details.caption === "true";
    patch.content_signature = contentSignature(details);
  }
  const stats = video.statistics;
  if (stats !== undefined) {
    patch.views = countOf(stats.viewCount);
    patch.likes = countOf(stats.likeCount);
    patch.comments = countOf(stats.commentCount);
  }
  const privacy = video.status?.privacyStatus;
  if (privacy === "public" || privacy === "unlisted" || privacy === "private") {
    patch.privacy = privacy;
  }
  if (details !== undefined || video.liveStreamingDetails !== undefined) {
    patch.type = classifyType({
      durationS,
      hasLiveDetails: video.liveStreamingDetails !== undefined,
      liveStatus: liveStatusOf(video),
      storedType: context.storedType,
      shortHint: context.shortHint,
    });
  }
  return patch;
}

export interface RecheckSchedule {
  tier: RecheckTier;
  nextAt: number;
}

/**
 * When to look again. A rule's fixed `recheck_interval` wins; otherwise the
 * tier comes from the upload age: daily under `recheck.daily_under_days`,
 * weekly under `recheck.weekly_under_days`, monthly beyond. A video without
 * an upload date counts as new (daily).
 */
export function recheckSchedule(
  uploadDate: number | null,
  now: number,
  settings: Pick<ResolvedSettings, "recheck.daily_under_days" | "recheck.weekly_under_days">,
  interval: RuleDuration | "tiered" = "tiered",
): RecheckSchedule {
  if (interval !== "tiered") {
    return { tier: "custom", nextAt: Math.max(now + 60_000, addDuration(now, interval)) };
  }
  const age = uploadDate === null ? 0 : now - uploadDate;
  if (age < settings["recheck.daily_under_days"] * DAY_MS) {
    return { tier: "daily", nextAt: now + DAY_MS };
  }
  if (age < settings["recheck.weekly_under_days"] * DAY_MS) {
    return { tier: "weekly", nextAt: now + 7 * DAY_MS };
  }
  return { tier: "monthly", nextAt: now + 30 * DAY_MS };
}

/** The `recheck_interval` effect resolved for the video, "tiered" when absent or invalid. */
export function effectiveRecheckInterval(db: Db, videoId: string): RuleDuration | "tiered" {
  const row = db.get<{ effective_json: string }>(
    "SELECT effective_json FROM video_effective WHERE video_id = ?",
    videoId,
  );
  const effective = parseJsonColumn(row?.effective_json ?? null);
  if (typeof effective !== "object" || effective === null) {
    return "tiered";
  }
  const value = (effective as Record<string, unknown>)["recheck_interval"];
  if (value === undefined || value === "tiered") {
    return "tiered";
  }
  const parsed = RuleDurationSchema.safeParse(value);
  return parsed.success ? parsed.data : "tiered";
}

/**
 * yt-dlp's view of whether a video is a short, from the info.json the
 * download pipeline keeps under the meta dir: `media_type`, else a /shorts/
 * URL. Null when there is no info.json or it does not say.
 */
export function shortHintFromInfo(
  metaDir: string,
  channelId: string | null,
  videoId: string,
): boolean | null {
  if (channelId === null) {
    return null;
  }
  const path = join(metaDir, channelId, videoId, "info.json");
  if (!existsSync(path)) {
    return null;
  }
  try {
    const info = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const mediaType = info["media_type"];
    if (typeof mediaType === "string") {
      return mediaType === "short";
    }
    for (const key of ["webpage_url", "original_url"]) {
      const url = info[key];
      if (typeof url === "string" && url.includes("/shorts/")) {
        return true;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Videos whose recheck is due, never-rechecked first. Only evaluated videos
 * (a video_effective row) qualify, so a fresh backfill record waits for the
 * rules to decide whether it is pri 0 before it costs main-budget units.
 */
export function dueRecheckIds(
  db: Db,
  now: number,
  limit: number,
  options: { pri0: boolean },
): string[] {
  return db
    .all<{ id: string }>(
      `SELECT v.id FROM videos v JOIN video_effective ve ON ve.video_id = v.id
        WHERE (v.next_recheck_at IS NULL OR v.next_recheck_at <= ?)
          AND ${options.pri0 ? "ve.reclaim_priority = 0" : "ve.reclaim_priority <> 0"}
        ORDER BY v.next_recheck_at IS NOT NULL, v.next_recheck_at, v.id
        LIMIT ?`,
      now,
      Math.max(0, limit),
    )
    .map((row) => row.id);
}

/** Accounts that source any of the ids (preferred for the recheck call). */
function sourcingAccounts(db: Db, ids: readonly string[]): number[] {
  if (ids.length === 0) {
    return [];
  }
  return db
    .all<{ account_id: number }>(
      `SELECT DISTINCT account_id FROM video_sources
        WHERE account_id IS NOT NULL AND video_id IN (${ids.map(() => "?").join(", ")})
        ORDER BY account_id`,
      ...ids,
    )
    .map((row) => Number(row.account_id));
}

/** `recheck_all`: queue every video, chunks of 50; pri-0 videos on the leftover class. */
export function enqueueRecheckAll(deps: Pick<IngestDeps, "db" | "enqueue">): {
  normal: number;
  leftover: number;
} {
  const rows = deps.db.all<{ id: string; pri: number | null }>(
    `SELECT v.id, ve.reclaim_priority AS pri FROM videos v
       LEFT JOIN video_effective ve ON ve.video_id = v.id ORDER BY v.id`,
  );
  const normal = rows.filter((row) => row.pri !== 0).map((row) => row.id);
  const leftover = rows.filter((row) => row.pri === 0).map((row) => row.id);
  enqueueRecheck(deps, normal);
  enqueueRecheck(deps, leftover, { leftover: true });
  return { normal: normal.length, leftover: leftover.length };
}

// ---------------------------------------------------------------------------
// The batch
// ---------------------------------------------------------------------------

export interface RecheckDeps extends IngestDeps {
  /** To ask whether the `download` job exists (version re-downloads). */
  registry?: Pick<JobRegistry, "has">;
  /** Shared rate-limited RYD client; default one per fetch function. */
  ryd?: RydClient;
  /** Override the yt-dlp shorts hint (tests). */
  shortHint?: (channelId: string | null, videoId: string) => boolean | null;
}

export interface RecheckOptions {
  /** jobs.id of the run, stored on every video_changes row. */
  recheckId?: number | null;
  checkpoint?: () => void;
  /** Filled as the run goes, so a caller still has the counts after a throw. */
  result?: RecheckResult;
}

export interface RecheckResult {
  requested: number;
  returned: number;
  missing: number;
  /** Ids marked gone by this run. */
  gone: string[];
  /** History rows written. */
  changes: number;
  units: number;
  /** Ids whose re-download was queued as a new version. */
  versions: string[];
  thumbnailsStored: number;
  /** Ids processed (returned or missing), the eval pass targets. */
  touched: string[];
}

export function emptyRecheckResult(): RecheckResult {
  return {
    requested: 0,
    returned: 0,
    missing: 0,
    gone: [],
    changes: 0,
    units: 0,
    versions: [],
    thumbnailsStored: 0,
    touched: [],
  };
}

const rydClients = new WeakMap<object, RydClient>();

function rydFor(deps: RecheckDeps): RydClient {
  if (deps.ryd !== undefined) {
    return deps.ryd;
  }
  const fetchFn = fetchOf(deps);
  const key = deps.fetch ?? globalThis;
  let client = rydClients.get(key);
  if (client === undefined) {
    client = createRydClient({ fetch: fetchFn, log: deps.log });
    rydClients.set(key, client);
  }
  return client;
}

function notifyDeps(deps: RecheckDeps): NotifyDeps {
  return {
    db: deps.db,
    log: deps.log,
    events: deps.events,
    getSettings: () => getSettings(deps.db),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  };
}

interface StoredForRecheck {
  type: string | null;
  privacy: string | null;
  gone_since: number | null;
  upload_date: number | null;
  channel_id: string | null;
  consecutive_recheck_failures: number;
}

function loadStored(db: Db, id: string): StoredForRecheck | undefined {
  return db.get<StoredForRecheck>(
    `SELECT type, privacy, gone_since, upload_date, channel_id, consecutive_recheck_failures
       FROM videos WHERE id = ?`,
    id,
  );
}

function hasCurrentMedia(db: Db, id: string): boolean {
  return (
    db.get(
      `SELECT 1 AS one FROM media WHERE video_id = ? AND is_current = 1
         AND kind IN ('video', 'audio')`,
      id,
    ) !== undefined
  );
}

/** A YouTube-side edit worth a new version: duration moved > 2 s, or the signature changed. */
export function isNewVersion(diff: DiffResult): boolean {
  for (const change of diff.changes) {
    if (
      change.field === "duration_s" &&
      typeof change.old === "number" &&
      typeof change.new === "number" &&
      Math.abs(change.new - change.old) > VERSION_DURATION_TOLERANCE_S
    ) {
      return true;
    }
    if (change.field === "content_signature" && change.old !== null) {
      return true;
    }
  }
  return false;
}

/** An API failure for the whole call: an outage signal, never per-video failures. */
export class RecheckOutageError extends Error {
  override readonly name = "RecheckOutageError";
}

async function applyItem(
  deps: RecheckDeps,
  video: ApiVideo & { id: string },
  context: {
    now: number;
    settings: ResolvedSettings;
    recheckId: number | null;
    ryd: RydClient | null;
    variants: readonly ThumbnailVariant[];
  },
  result: RecheckResult,
): Promise<void> {
  const { db } = deps;
  const stored = loadStored(db, video.id);
  if (stored === undefined) {
    return;
  }
  const apiChannel = isChannelId(video.snippet?.channelId) ? video.snippet.channelId : null;
  const channelId = apiChannel ?? stored.channel_id;
  const durationS = parseDurationSeconds(video.contentDetails?.duration);
  const needsHint =
    video.liveStreamingDetails === undefined &&
    durationS !== null &&
    durationS <= SHORT_MAX_SECONDS;
  const hint = needsHint
    ? (deps.shortHint ?? ((ch, id) => shortHintFromInfo(deps.config.metaDir, ch, id)))(
        channelId,
        video.id,
      )
    : null;
  const patch = mapVideoItem(video, { storedType: stored.type, shortHint: hint });

  if (apiChannel !== null) {
    ensureChannel(db, { id: apiChannel, title: video.snippet?.channelTitle ?? null }, context.now);
    patch.channel_id = apiChannel;
  }
  if (context.ryd !== null) {
    const votes = await context.ryd.votes(video.id);
    if (votes !== null) {
      const likes = typeof patch.likes === "number" ? patch.likes : votes.likes;
      patch.ryd_dislikes = votes.dislikes;
      patch.ryd_ratio = rydRatio(likes, votes.dislikes);
    }
  }
  const uploadDate = typeof patch.upload_date === "number" ? patch.upload_date : stored.upload_date;
  const schedule = recheckSchedule(
    uploadDate,
    context.now,
    context.settings,
    effectiveRecheckInterval(db, video.id),
  );
  const privacy = typeof patch.privacy === "string" ? patch.privacy : stored.privacy;
  patch.consecutive_recheck_failures = 0;
  patch.gone_since = privacy === "private" ? (stored.gone_since ?? context.now) : null;
  patch.last_recheck_at = context.now;
  patch.recheck_tier = schedule.tier;
  patch.next_recheck_at = schedule.nextAt;

  const diff = applyVideoDiff(db, video.id, patch, {
    recheckId: context.recheckId,
    seenAt: context.now,
  });
  result.changes += diff.changes.filter((change) => change.history).length;

  if (
    isNewVersion(diff) &&
    deps.registry?.has(DOWNLOAD_JOB) === true &&
    hasCurrentMedia(db, video.id)
  ) {
    deps.enqueue({
      type: DOWNLOAD_JOB,
      videoId: video.id,
      payload: { reason: "version" },
      dedupe: true,
    });
    result.versions.push(video.id);
  }

  if (channelId !== null && thumbnailsNeedRefresh(db, video.id, video.snippet?.thumbnails)) {
    const thumbs = await refreshThumbnails(deps, {
      videoId: video.id,
      channelId,
      urls: thumbnailUrls(video.id, video.snippet?.thumbnails, context.variants),
    });
    result.thumbnailsStored += thumbs.stored;
  }
}

function applyMissing(
  deps: RecheckDeps,
  id: string,
  context: { now: number; settings: ResolvedSettings; recheckId: number | null },
  othersSucceeded: boolean,
  result: RecheckResult,
): void {
  const stored = loadStored(deps.db, id);
  if (stored === undefined) {
    return;
  }
  const failures = stored.consecutive_recheck_failures + 1;
  const patch: VideoPatch = { consecutive_recheck_failures: failures };
  const markGone = failures >= 2 && othersSucceeded && stored.gone_since === null;
  if (markGone) {
    patch.privacy = stored.privacy === "private" ? "private" : "removed";
    patch.gone_since = context.now;
    result.gone.push(id);
  }
  const alreadyGone = stored.gone_since !== null || markGone;
  patch.next_recheck_at = alreadyGone
    ? recheckSchedule(stored.upload_date, context.now, context.settings).nextAt
    : context.now + MISSING_RETRY_MS;
  const diff = applyVideoDiff(deps.db, id, patch, {
    recheckId: context.recheckId,
    seenAt: context.now,
  });
  result.changes += diff.changes.filter((change) => change.history).length;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Recheck the given ids (unknown ids are ignored), 50 per API call. Per call:
 *
 * - QuotaExhausted propagates untouched (a budget, not an outage).
 * - Auth loss notifies (rate limited per account) and propagates.
 * - Any other error, or a 200 that returns none of two or more ids, is an
 *   outage: one rate-limited notification, no per-video counters touched,
 *   and a RecheckOutageError so the job retries with backoff.
 * - Otherwise returned ids are diffed in, missing ids count a failure, and a
 *   second consecutive miss marks the video gone only when another video of
 *   the same call came back.
 *
 * Everything processed before an error is kept, and evaluated.
 */
export async function runRecheck(
  deps: RecheckDeps,
  ids: readonly string[],
  options: RecheckOptions = {},
): Promise<RecheckResult> {
  const result = options.result ?? emptyRecheckResult();
  const unique = [...new Set(ids)];
  const known =
    unique.length === 0
      ? new Set<string>()
      : new Set(
          deps.db
            .all<{ id: string }>(
              `SELECT id FROM videos WHERE id IN (${unique.map(() => "?").join(", ")})`,
              ...unique,
            )
            .map((row) => row.id),
        );
  const wanted = unique.filter((id) => known.has(id));
  result.requested = wanted.length;
  const settings = getSettings(deps.db);
  const ryd = settings["recheck.ryd_enabled"] ? cachedRyd(rydFor(deps)) : null;
  const recheckId = options.recheckId ?? null;
  try {
    for (let at = 0; at < wanted.length; at += RECHECK_BATCH_SIZE) {
      options.checkpoint?.();
      const chunk = wanted.slice(at, at + RECHECK_BATCH_SIZE);
      const now = nowOf(deps);
      const accountId = pickApiAccount(deps.db, sourcingAccounts(deps.db, chunk), "recheck", now);
      if (accountId === null) {
        throw new DomainError("no_account", "No linked account has working YouTube API access.");
      }
      let body: VideosListResponse;
      try {
        body = await youtubeApi(deps, accountId).get<VideosListResponse>("videos", {
          part: VIDEO_PARTS,
          id: chunk,
          maxResults: RECHECK_BATCH_SIZE,
        });
        result.units += 1;
      } catch (error) {
        if (error instanceof QuotaExhausted) {
          throw error;
        }
        result.units += 1;
        if (error instanceof DomainError && error.details?.["reason"] === "auth_lost") {
          await recordAccountAuthLoss(notifyDeps(deps), accountId);
          throw error;
        }
        await recordOutage(
          notifyDeps(deps),
          `videos.list failed for a batch of ${String(chunk.length)} videos: ${errorText(error)}`,
        );
        throw new RecheckOutageError(`Recheck outage: ${errorText(error)}`);
      }
      const inChunk = new Set(chunk);
      const items = (body.items ?? []).filter(
        (item): item is ApiVideo & { id: string } =>
          typeof item.id === "string" && inChunk.has(item.id),
      );
      if (items.length === 0 && chunk.length >= 2) {
        await recordOutage(
          notifyDeps(deps),
          `videos.list returned none of ${String(chunk.length)} requested videos.`,
        );
        throw new RecheckOutageError("Recheck outage: the API returned none of the videos.");
      }
      const context = {
        now,
        settings,
        recheckId,
        ryd,
        variants: settings["thumbnails.variants"],
      };
      const returned = new Set<string>();
      for (const item of items) {
        if (returned.has(item.id)) {
          continue;
        }
        returned.add(item.id);
        await applyItem(deps, item, context, result);
        result.touched.push(item.id);
      }
      result.returned += returned.size;
      for (const id of chunk) {
        if (!returned.has(id)) {
          applyMissing(deps, id, context, returned.size > 0, result);
          result.missing += 1;
          result.touched.push(id);
        }
      }
    }
  } finally {
    if (result.touched.length > 0) {
      scheduleEvalPass(deps, "recheck", { videoIds: result.touched });
    }
  }
  return result;
}

/** One activity row for a recheck run. */
export function logRecheck(
  deps: RecheckDeps,
  result: RecheckResult,
  options: { jobId?: number | null; leftover?: boolean; error?: unknown } = {},
): void {
  const failed = options.error !== undefined;
  const counts =
    `${String(result.returned)} of ${String(result.requested)} returned, ` +
    `${String(result.missing)} missing, ${String(result.gone.length)} gone, ` +
    `${String(result.changes)} changes, ${String(result.units)} API units`;
  logActivity(deps, {
    level: failed ? "warn" : "info",
    kind: "recheck.batch",
    message: failed
      ? `Recheck stopped early (${counts}): ${errorText(options.error)}`
      : `Recheck: ${counts}.`,
    jobId: options.jobId ?? null,
    data: {
      requested: result.requested,
      returned: result.returned,
      missing: result.missing,
      gone: result.gone,
      changes: result.changes,
      units: result.units,
      versions: result.versions,
      thumbnailsStored: result.thumbnailsStored,
      leftover: options.leftover === true,
      ...(failed ? { error: errorText(options.error) } : {}),
    },
  });
}
