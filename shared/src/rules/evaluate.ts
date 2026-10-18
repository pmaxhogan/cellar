import { z } from "zod";
import type { ConditionNode, LeafNode, SourceKind, VideoStatus } from "./ast.ts";
import { SourceKindSchema, VideoTypeSchema } from "./ast.ts";
import { RowIdSchema } from "./effects.ts";
import { boundedTest, compileSafeRegex } from "./safeRegex.ts";
import { addDuration, instantMs, type RuleDuration } from "./time.ts";

/**
 * Pure condition evaluation (spec 4.4). The server loads a `VideoFacts`
 * object per video (the `videos` row plus its sources, current media and
 * share-link count) and calls `evaluateCondition`; nothing here does IO.
 *
 * Null handling: a leaf over a null number, boolean, enum or time anchor is
 * false, except `is_null`, which is true exactly when the anchor is null.
 */

export const PRIVACY_VALUES = ["public", "unlisted", "private", "removed", "unavailable"] as const;
export const PrivacySchema = z.enum(PRIVACY_VALUES);
export type Privacy = z.infer<typeof PrivacySchema>;

/** Epoch milliseconds. */
const Ms = z.number();

/** One `video_sources` row. */
export const VideoSourceFactSchema = z.object({
  /** Null for manually added channels. */
  account_id: RowIdSchema.nullable(),
  source: SourceKindSchema,
  first_seen_at: Ms,
  last_seen_at: Ms,
  /** The real watch / like / add time when known. Not used as a rule anchor. */
  source_ts: Ms.nullable(),
});
export type VideoSourceFact = z.infer<typeof VideoSourceFactSchema>;

/** The current video (or audio) `media` row, or null when nothing is downloaded. */
export const VideoMediaFactSchema = z.object({
  downloaded_at: Ms.nullable(),
  location_id: RowIdSchema.nullable(),
  vcodec: z.string().nullable(),
});
export type VideoMediaFact = z.infer<typeof VideoMediaFactSchema>;

/** Everything a condition can read about one video. */
export const VideoFactsSchema = z.object({
  id: z.string(),
  channel_id: z.string().nullable(),
  channel_title: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  tags: z.array(z.string()),
  type: VideoTypeSchema.nullable(),
  privacy: PrivacySchema.nullable(),
  gone_since: Ms.nullable(),
  upload_date: Ms.nullable(),
  published_at: Ms.nullable(),
  duration_s: z.number().nullable(),
  views: z.number().nullable(),
  likes: z.number().nullable(),
  comments: z.number().nullable(),
  ryd_ratio: z.number().nullable(),
  max_height: z.number().nullable(),
  max_fps: z.number().nullable(),
  has_av1: z.boolean().nullable(),
  has_vp9: z.boolean().nullable(),
  has_h264: z.boolean().nullable(),
  is_hdr: z.boolean().nullable(),
  caption_available: z.boolean().nullable(),
  sources: z.array(VideoSourceFactSchema),
  media: VideoMediaFactSchema.nullable(),
  /** Active (not revoked, not expired) share links. */
  share_link_count: z.int().min(0),
});
export type VideoFacts = z.infer<typeof VideoFactsSchema>;

/** Evaluation clock and install time, both epoch ms. */
export const EvalContextSchema = z.object({ now: Ms, installed_at: Ms });
export type EvalContext = z.infer<typeof EvalContextSchema>;

const GONE_PRIVACY: ReadonlySet<Privacy> = new Set(["private", "removed", "unavailable"]);

/** True when the video is private, removed or unavailable, or rechecks marked it gone. */
export function isGone(video: Pick<VideoFacts, "privacy" | "gone_since">): boolean {
  return (video.privacy !== null && GONE_PRIVACY.has(video.privacy)) || video.gone_since !== null;
}

/**
 * The derived statuses a video has. A gone video has `gone` plus `private` or
 * `removed` when that is its privacy; otherwise its privacy (`public` or
 * `unlisted`).
 */
export function videoStatuses(video: Pick<VideoFacts, "privacy" | "gone_since">): VideoStatus[] {
  if (isGone(video)) {
    const out: VideoStatus[] = ["gone"];
    if (video.privacy === "private" || video.privacy === "removed") out.push(video.privacy);
    return out;
  }
  if (video.privacy === "public" || video.privacy === "unlisted") return [video.privacy];
  return [];
}

/** Distinct sources the video currently has, across accounts. */
export function sourceSet(video: Pick<VideoFacts, "sources">): Set<SourceKind> {
  return new Set(video.sources.map((s) => s.source));
}

export type TimeField = "upload_date" | "first_seen" | "downloaded_at" | "last_seen" | "now";
type TimeLeaf = Extract<LeafNode, { field: TimeField }>;

/**
 * The instant a time leaf reads, or null when the video has none.
 * `first_seen` without `source` is the earliest `first_seen_at` across all
 * sources; with `source` it is the earliest among rows of that source.
 * `upload_date` falls back to `published_at` when unknown.
 */
export function anchorValue(
  leaf: Pick<TimeLeaf, "field"> & { source?: SourceKind | undefined },
  video: VideoFacts,
  ctx: EvalContext,
): number | null {
  switch (leaf.field) {
    case "upload_date":
      return video.upload_date ?? video.published_at;
    case "first_seen": {
      let earliest: number | null = null;
      for (const s of video.sources) {
        if (leaf.source !== undefined && s.source !== leaf.source) continue;
        if (earliest === null || s.first_seen_at < earliest) earliest = s.first_seen_at;
      }
      return earliest;
    }
    case "downloaded_at":
      return video.media?.downloaded_at ?? null;
    case "last_seen": {
      let latest: number | null = null;
      for (const s of video.sources) {
        if (latest === null || s.last_seen_at > latest) latest = s.last_seen_at;
      }
      return latest;
    }
    case "now":
      return ctx.now;
  }
}

/**
 * The instant at which an anchor becomes older than `d`: `anchor + d`, with
 * months and years added as calendar units. `age_gt d` holds from this
 * instant on (inclusive) and `age_lt d` holds strictly before it, so the two
 * are exact complements and `nextEvalAt` can schedule the threshold itself.
 */
export function ageThreshold(anchor: number, d: RuleDuration): number {
  return addDuration(anchor, d);
}

function compareNumber(
  op: "lt" | "lte" | "gt" | "gte" | "between",
  actual: number | null,
  value: number | readonly [number, number],
): boolean {
  if (actual === null) return false;
  if (op === "between") {
    const [lo, hi] = value as readonly [number, number];
    return actual >= lo && actual <= hi;
  }
  const v = value as number;
  switch (op) {
    case "lt":
      return actual < v;
    case "lte":
      return actual <= v;
    case "gt":
      return actual > v;
    case "gte":
      return actual >= v;
  }
}

type TextLeaf = Extract<LeafNode, { field: "title" | "description" | "tags" | "channel_title" }>;

function textMatches(leaf: TextLeaf, text: string): boolean {
  const ci = leaf.ci === true;
  switch (leaf.op) {
    case "regex":
    case "not_regex": {
      const re = compileSafeRegex(leaf.value, ci);
      return re !== null && boundedTest(re, text);
    }
  }
  const hay = ci ? text.toLowerCase() : text;
  const needle = ci ? leaf.value.toLowerCase() : leaf.value;
  switch (leaf.op) {
    case "contains":
    case "not_contains":
      return hay.includes(needle);
    case "starts_with":
      return hay.startsWith(needle);
    case "ends_with":
      return hay.endsWith(needle);
    case "eq":
      return hay === needle;
  }
}

/**
 * Text leaf over one or more strings. Positive operators hold when any value
 * matches; `not_contains` / `not_regex` hold when no value matches. An unsafe
 * regex never matches, so both `regex` and `not_regex` are false for it.
 */
function evaluateText(leaf: TextLeaf, values: readonly string[]): boolean {
  if (leaf.op === "regex" || leaf.op === "not_regex") {
    if (compileSafeRegex(leaf.value, leaf.ci === true) === null) return false;
  }
  const any = values.some((v) => textMatches(leaf, v));
  return leaf.op === "not_contains" || leaf.op === "not_regex" ? !any : any;
}

function evaluateTime(leaf: TimeLeaf, video: VideoFacts, ctx: EvalContext): boolean {
  const anchor = anchorValue(leaf, video, ctx);
  if (leaf.op === "is_null") return (anchor === null) === leaf.value;
  if (anchor === null) return false;
  switch (leaf.op) {
    case "age_gt":
      return ctx.now >= ageThreshold(anchor, leaf.value);
    case "age_lt":
      return ctx.now < ageThreshold(anchor, leaf.value);
    case "before":
      return anchor < instantMs(leaf.value);
    case "after":
      return anchor > instantMs(leaf.value);
    case "before_install_minus":
      return anchor < addDuration(ctx.installed_at, leaf.value, -1);
  }
}

function inList<T>(op: "eq" | "in", actual: T, value: T | readonly T[]): boolean {
  return op === "eq" ? actual === value : (value as readonly T[]).includes(actual);
}

function codecFlag(video: VideoFacts, codec: "av1" | "vp9" | "h264"): boolean {
  if (codec === "av1") return video.has_av1 === true;
  if (codec === "vp9") return video.has_vp9 === true;
  return video.has_h264 === true;
}

function evaluateBool(actual: boolean | null, value: boolean): boolean {
  return actual !== null && actual === value;
}

/** Evaluates one leaf. */
export function evaluateLeaf(leaf: LeafNode, video: VideoFacts, ctx: EvalContext): boolean {
  switch (leaf.field) {
    case "account": {
      const wanted: readonly number[] = leaf.op === "eq" ? [leaf.value] : leaf.value;
      return video.sources.some((s) => s.account_id !== null && wanted.includes(s.account_id));
    }
    case "source": {
      const have = sourceSet(video);
      const list = leaf.value;
      switch (leaf.op) {
        case "has_any":
          return list.some((s) => have.has(s));
        case "has_all":
          return list.every((s) => have.has(s));
        case "has_only":
          return have.size > 0 && [...have].every((s) => list.includes(s));
        case "has_none":
          return !list.some((s) => have.has(s));
      }
      break;
    }
    case "type":
      return video.type !== null && inList(leaf.op, video.type, leaf.value);
    case "channel":
      return video.channel_id !== null && inList(leaf.op, video.channel_id, leaf.value);
    case "status": {
      const statuses = videoStatuses(video);
      const wanted: readonly VideoStatus[] = leaf.op === "eq" ? [leaf.value] : leaf.value;
      return statuses.some((s) => wanted.includes(s));
    }
    case "duration_s":
    case "views":
    case "likes":
    case "comments":
    case "ryd_ratio":
    case "max_height":
    case "max_fps":
      return compareNumber(leaf.op, video[leaf.field], leaf.value);
    case "has_codec": {
      const wanted = leaf.op === "eq" ? [leaf.value] : leaf.value;
      return wanted.some((c) => codecFlag(video, c));
    }
    case "is_hdr":
    case "caption_available":
      return evaluateBool(video[leaf.field], leaf.value);
    case "has_share_link":
      return video.share_link_count > 0 === leaf.value;
    case "downloaded":
      return (video.media !== null && video.media.downloaded_at !== null) === leaf.value;
    case "current_location":
      return video.media !== null && video.media.location_id === leaf.value;
    case "title":
      return evaluateText(leaf, [video.title ?? ""]);
    case "description":
      return evaluateText(leaf, [video.description ?? ""]);
    case "channel_title":
      return evaluateText(leaf, [video.channel_title ?? ""]);
    case "tags":
      return evaluateText(leaf, video.tags);
    case "upload_date":
    case "first_seen":
    case "downloaded_at":
    case "last_seen":
    case "now":
      return evaluateTime(leaf, video, ctx);
  }
}

/**
 * Evaluates a condition tree against one video. `and` short-circuits on the
 * first false child, `or` on the first true one; `not` negates the group.
 * An empty `and` is true, an empty `or` is false.
 */
export function evaluateCondition(
  node: ConditionNode,
  video: VideoFacts,
  ctx: EvalContext,
): boolean {
  if (node.type === "cond") return evaluateLeaf(node, video, ctx);
  const result =
    node.op === "and"
      ? node.children.every((child) => evaluateCondition(child, video, ctx))
      : node.children.some((child) => evaluateCondition(child, video, ctx));
  return node.not === true ? !result : result;
}
