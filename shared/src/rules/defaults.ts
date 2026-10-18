import type { ConditionNode, LeafNode, SourceKind } from "./ast.ts";
import { cloneJson } from "./clone.ts";
import type { RuleDuration } from "./time.ts";
import { RuleDraftSchema, type RuleDraft } from "./rule.ts";

/**
 * The default rule set (spec 4.5), installed by migration at first init. All
 * rules are editable and removable. Position ascending = priority ascending;
 * the global rule has position 0.
 *
 *   G  Global defaults
 *   1  Expire: subscriptions after 2 weeks
 *   2  Expire: watched after 2 months
 *   3  Expire: liked after 2 years
 *   4  Guard: no subscription backfill older than 7 days before install
 *   5  Captions: English only
 *   6  Keep unlisted and gone forever
 *   7  Notify when a video goes gone
 *
 * `first_seen(subscription or channel)` is an `or` of two `first_seen` leaves,
 * one per source; for `age_gt` that equals "the earliest of the two is older".
 */

function and(...children: ConditionNode[]): ConditionNode {
  return { type: "group", op: "and", children };
}

function or(...children: ConditionNode[]): ConditionNode {
  return { type: "group", op: "or", children };
}

function sources(
  op: "has_any" | "has_all" | "has_only" | "has_none",
  value: SourceKind[],
): LeafNode {
  return { type: "cond", field: "source", op, value };
}

function firstSeenOlderThan(source: SourceKind, value: RuleDuration): LeafNode {
  return { type: "cond", field: "first_seen", source, op: "age_gt", value };
}

const RAW_DEFAULT_RULES: unknown[] = [
  {
    kind: "global",
    video_id: null,
    position: 0,
    name: "Global defaults",
    enabled: true,
    condition: null,
    effects: {
      reclaim_priority: -1,
      location_id: null,
      media_mode: "video",
      format_policy: "prefer_av1",
      transcode: {
        mode: "if_not_av1",
        codec: "hevc_nvenc",
        quality: 28,
        preset: "p5",
        audio_codec: "copy",
      },
      captions: { enabled: true, languages: "all", auto_generated: true },
      live: "vod_only",
      download_accounts: "sourcing",
      proxy: "none",
      recheck_interval: "tiered",
      notify: { enabled: false, max_times: 1, channel: "push" },
    },
  },
  {
    kind: "custom",
    video_id: null,
    position: 1,
    name: "Expire: subscriptions after 2 weeks",
    enabled: true,
    condition: and(
      sources("has_only", ["subscription", "channel"]),
      or(
        firstSeenOlderThan("subscription", { days: 14 }),
        firstSeenOlderThan("channel", { days: 14 }),
      ),
    ),
    effects: { reclaim_priority: 0 },
  },
  {
    kind: "custom",
    video_id: null,
    position: 2,
    name: "Expire: watched after 2 months",
    enabled: true,
    condition: and(
      sources("has_none", ["liked", "watch_later"]),
      sources("has_any", ["history"]),
      firstSeenOlderThan("history", { months: 2 }),
    ),
    effects: { reclaim_priority: 0 },
  },
  {
    kind: "custom",
    video_id: null,
    position: 3,
    name: "Expire: liked after 2 years",
    enabled: true,
    condition: and(
      sources("has_any", ["liked"]),
      sources("has_none", ["watch_later"]),
      firstSeenOlderThan("liked", { years: 2 }),
    ),
    effects: { reclaim_priority: 0 },
  },
  {
    kind: "custom",
    video_id: null,
    position: 4,
    name: "Guard: no subscription backfill older than 7 days before install",
    enabled: true,
    condition: and(sources("has_only", ["subscription", "channel"]), {
      type: "cond",
      field: "upload_date",
      op: "before_install_minus",
      value: { days: 7 },
    }),
    effects: { reclaim_priority: 0 },
  },
  {
    kind: "custom",
    video_id: null,
    position: 5,
    name: "Captions: English only",
    enabled: true,
    condition: and(),
    effects: { captions: { languages: ["en"], auto_generated: true } },
  },
  {
    kind: "custom",
    video_id: null,
    position: 6,
    name: "Keep unlisted and gone forever",
    enabled: true,
    condition: { type: "cond", field: "status", op: "in", value: ["unlisted", "gone"] },
    effects: { reclaim_priority: -1 },
  },
  {
    kind: "custom",
    video_id: null,
    position: 7,
    name: "Notify when a video goes gone",
    enabled: true,
    condition: { type: "cond", field: "status", op: "eq", value: "gone" },
    effects: { notify: { enabled: true, max_times: 1 } },
  },
];

/**
 * A fresh, validated copy of the default rules (global first, then custom
 * rules 1..7). Effects are parsed, so object effects carry their field
 * defaults (rule 5's captions gain `enabled: true`, rule 7's notify gains
 * `channel: "push"`).
 */
export function defaultRules(): RuleDraft[] {
  return RAW_DEFAULT_RULES.map((rule) => RuleDraftSchema.parse(cloneJson(rule)));
}

/** The default rule set. Treat as read-only; call `defaultRules()` for a mutable copy. */
export const DEFAULT_RULES: readonly RuleDraft[] = Object.freeze(defaultRules());
