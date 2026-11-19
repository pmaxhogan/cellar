import type { QuickAddResponse } from "@cellar/shared";
import { enqueueRecheck, RECHECK_BATCH_JOB } from "../youtube/ingest.ts";
import { requireVideoId, runEvalPass, type RulesDeps } from "./ruleEval.ts";
import {
  getVideoRuleRow,
  parseVideoEffects,
  publishVideoRuleChange,
  toRuleRow,
  upsertVideoRule,
} from "./rules.ts";
import { ensureVideo } from "./videos.ts";

/**
 * Quick add (POST /api/videos/quick-add): put one video in the catalog, pin
 * it with a `video` rule so it is downloaded and never reclaimed, and queue
 * the work right away. Every other rule keeps applying: the video rule only
 * sets the keys below, so format, captions, transcode and the rest still come
 * from the global and custom rules.
 */

export const QUICK_ADD_RULE_NAME = "Quick add";
export const QUICK_ADD_DOWNLOAD_JOB = "download";
/** The same priority as the manual download-now and recheck triggers. */
export const QUICK_ADD_PRIORITY = 20;

/** The keys the quick add rule forces: downloaded, and kept forever. */
export const QUICK_ADD_EFFECTS = { include: true, reclaim_priority: -1 } as const;

function hasSourcingAccount(deps: Pick<RulesDeps, "db">, videoId: string): boolean {
  return (
    deps.db.get(
      "SELECT 1 AS one FROM video_sources WHERE video_id = ? AND account_id IS NOT NULL LIMIT 1",
      videoId,
    ) !== undefined
  );
}

/**
 * Accepts any identifier the shared parser reads (400 otherwise). Idempotent:
 * adding a video twice rewrites the same rule and joins the queued jobs.
 *
 * - The video is created as a metadata-only skeleton when it is new, and a
 *   recheck is queued to fill it in.
 * - The `video` rule keeps the overrides it already has (a trashed video is
 *   un-trashed: its reclaim priority goes back to -1) and is named "Quick add".
 * - A video no account sourced has nobody under the default `download_accounts:
 *   sourcing`, so the rule sets `any` unless an override already chose.
 * - The video is evaluated at once, so the download job finds its effective
 *   settings, then a `download` job is queued unless media is already stored.
 */
export async function quickAddVideo(deps: RulesDeps, input: string): Promise<QuickAddResponse> {
  const videoId = requireVideoId(input);
  const now = (deps.now ?? Date.now)();
  const created = deps.db.tx(() => {
    const isNew = ensureVideo(deps.db, videoId, { now });
    const existing = getVideoRuleRow(deps.db, videoId);
    const current = existing === undefined ? {} : toRuleRow(existing).effects;
    const accounts =
      "download_accounts" in current || hasSourcingAccount(deps, videoId)
        ? {}
        : { download_accounts: "any" };
    upsertVideoRule(
      deps.db,
      videoId,
      parseVideoEffects({ ...current, ...accounts, ...QUICK_ADD_EFFECTS }),
      QUICK_ADD_RULE_NAME,
      now,
    );
    return isNew;
  });
  publishVideoRuleChange(
    {
      db: deps.db,
      log: deps.log,
      events: deps.events,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    },
    "quick_added",
    `Quick added ${videoId}`,
    [videoId],
  );
  await runEvalPass(deps, { reason: "quick_add", videoIds: [videoId] });

  const row = deps.db.get<{
    title: string | null;
    channel_title: string | null;
    downloaded: number;
  }>(
    `SELECT v.title, c.title AS channel_title,
            EXISTS (SELECT 1 FROM media m WHERE m.video_id = v.id AND m.is_current = 1
                       AND m.kind IN ('video', 'audio')) AS downloaded
       FROM videos v LEFT JOIN channels c ON c.id = v.channel_id WHERE v.id = ?`,
    videoId,
  );
  const downloaded = Number(row?.downloaded ?? 0) !== 0;
  if (created && deps.registry.has(RECHECK_BATCH_JOB)) {
    enqueueRecheck(deps, [videoId], { priority: QUICK_ADD_PRIORITY });
  }
  let jobId: number | null = null;
  if (!downloaded && deps.registry.has(QUICK_ADD_DOWNLOAD_JOB)) {
    jobId = deps.enqueue({
      type: QUICK_ADD_DOWNLOAD_JOB,
      videoId,
      payload: { video_ids: [videoId], manual: true },
      priority: QUICK_ADD_PRIORITY,
      dedupe: true,
    }).id;
  }
  return {
    video_id: videoId,
    created,
    downloaded,
    title: row?.title ?? null,
    channel_title: row?.channel_title ?? null,
    job_id: jobId,
  };
}
