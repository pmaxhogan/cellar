import type { RecheckDeps } from "../../domain/recheck.ts";
import {
  apiAccountIds,
  cookieAccountIds,
  emptyResult,
  finishIngest,
  INGEST_CHANNEL_BACKFILL_JOB,
  INGEST_CHANNEL_UPLOADS_JOB,
  INGEST_HISTORY_JOB,
  INGEST_LIKED_JOB,
  INGEST_SUBSCRIPTIONS_JOB,
  INGEST_WATCH_LATER_JOB,
  ingestChannelBackfill,
  ingestChannelUploads,
  ingestHistory,
  ingestLiked,
  ingestSubscriptions,
  ingestWatchLater,
  type IngestDeps,
  type IngestFeed,
  type IngestResult,
  type IngestRunOptions,
} from "../../youtube/ingest.ts";
import type { JobClass, JobContext, JobRegistry } from "../types.ts";

/**
 * Handlers of the ingestion jobs. Payloads:
 *
 *   ingest_history          jobs.account_id (or { account_id })   io
 *   ingest_watch_later      jobs.account_id (or { account_id })   io
 *   ingest_liked            { account_id }                          io
 *   ingest_subscriptions    { account_id }                          io
 *   ingest_channel_uploads  { channel_id }                          io
 *   ingest_channel_backfill { channel_id }                          leftover
 *
 * The two cookie feeds carry their account on the job row, so the
 * scheduler's per-account scrape gate holds them; the API jobs keep it in the
 * payload, so a spent scrape budget never stalls them.
 */

export interface IngestHandlerDeps extends RecheckDeps {
  /** The scheduler's quota gate; the deep backfill re-checks it between pages. */
  budgetOk?: (cls: JobClass) => boolean;
}

function payloadOf(ctx: JobContext): Record<string, unknown> {
  const raw = ctx.job.payload;
  return raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function accountOf(ctx: JobContext): number | null {
  if (ctx.job.accountId !== null) {
    return ctx.job.accountId;
  }
  const value = payloadOf(ctx)["account_id"];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function channelOf(ctx: JobContext): string | null {
  const value = payloadOf(ctx)["channel_id"];
  return typeof value === "string" && value !== "" ? value : null;
}

/** Dedupe key for payload-addressed jobs. */
export function accountKey(payload: unknown): string {
  const value = (payload as { account_id?: unknown } | null)?.account_id;
  return `account:${String(value)}`;
}

export function channelKey(payload: unknown): string {
  const value = (payload as { channel_id?: unknown } | null)?.channel_id;
  return `channel:${String(value)}`;
}

function jobDeps(deps: IngestHandlerDeps, ctx: JobContext): IngestHandlerDeps {
  return { ...deps, db: ctx.db, log: ctx.log };
}

/** Run one ingest, then the follow-up (recheck, eval, activity), also after a failure. */
async function runIngest(
  deps: IngestDeps,
  ctx: JobContext,
  result: IngestResult,
  run: (result: IngestResult, options: IngestRunOptions) => Promise<unknown>,
): Promise<IngestResult> {
  const options: IngestRunOptions = {
    checkpoint: () => {
      ctx.checkpoint();
    },
  };
  try {
    await run(result, options);
  } catch (error) {
    finishIngest(deps, result, { jobId: ctx.job.id, error });
    throw error;
  }
  finishIngest(deps, result, { jobId: ctx.job.id });
  return result;
}

function skip(ctx: JobContext, feed: IngestFeed, reason: string): Promise<void> {
  ctx.log.info({ feed, reason }, "ingest skipped");
  return Promise.resolve();
}

type AccountIngest = (
  deps: IngestDeps,
  accountId: number,
  result: IngestResult,
  options: IngestRunOptions,
) => Promise<IngestResult>;

function accountHandler(
  deps: IngestHandlerDeps,
  feed: IngestFeed,
  eligible: (deps: IngestDeps) => number[],
  ingest: AccountIngest,
  after?: (deps: IngestHandlerDeps, result: IngestResult) => void,
) {
  return async (ctx: JobContext): Promise<void> => {
    const d = jobDeps(deps, ctx);
    const accountId = accountOf(ctx);
    if (accountId === null) {
      return skip(ctx, feed, "no account in the job");
    }
    if (!eligible(d).includes(accountId)) {
      return skip(ctx, feed, "account is not linked for this feed, paused or broken");
    }
    const result = await runIngest(d, ctx, emptyResult(feed, accountId), (r, options) =>
      ingest(d, accountId, r, options),
    );
    after?.(d, result);
  };
}

const cookieAccounts = (deps: IngestDeps): number[] => cookieAccountIds(deps.db);
const apiAccounts = (deps: IngestDeps): number[] => apiAccountIds(deps.db);

/** Queue the uploads poll of channels a subscriptions run just found. */
function pollNewChannels(deps: IngestHandlerDeps, result: IngestResult): void {
  for (const channelId of result.newChannels) {
    deps.enqueue({
      type: INGEST_CHANNEL_UPLOADS_JOB,
      payload: { channel_id: channelId },
      dedupe: true,
    });
  }
}

export function registerIngestHandlers(registry: JobRegistry, deps: IngestHandlerDeps): void {
  const register = (type: string, registration: Parameters<JobRegistry["register"]>[1]): void => {
    if (!registry.has(type)) {
      registry.register(type, registration);
    }
  };
  register(INGEST_HISTORY_JOB, {
    class: "io",
    maxAttempts: 2,
    handler: accountHandler(deps, "history", cookieAccounts, (d, id, r, o) =>
      ingestHistory(d, id, r, o),
    ),
  });
  register(INGEST_WATCH_LATER_JOB, {
    class: "io",
    maxAttempts: 2,
    handler: accountHandler(deps, "watch_later", cookieAccounts, ingestWatchLater),
  });
  register(INGEST_LIKED_JOB, {
    class: "io",
    maxAttempts: 2,
    dedupeKey: accountKey,
    handler: accountHandler(deps, "liked", apiAccounts, ingestLiked),
  });
  register(INGEST_SUBSCRIPTIONS_JOB, {
    class: "io",
    maxAttempts: 2,
    dedupeKey: accountKey,
    handler: accountHandler(
      deps,
      "subscriptions",
      apiAccounts,
      ingestSubscriptions,
      pollNewChannels,
    ),
  });
  register(INGEST_CHANNEL_UPLOADS_JOB, {
    class: "io",
    maxAttempts: 2,
    dedupeKey: channelKey,
    handler: async (ctx) => {
      const d = jobDeps(deps, ctx);
      const channelId = channelOf(ctx);
      if (channelId === null) {
        return skip(ctx, "channel_uploads", "no channel in the job");
      }
      await runIngest(d, ctx, emptyResult("channel_uploads", null, channelId), (r, options) =>
        ingestChannelUploads(d, channelId, r, options),
      );
    },
  });
  register(INGEST_CHANNEL_BACKFILL_JOB, {
    class: "leftover",
    maxAttempts: 2,
    dedupeKey: channelKey,
    handler: async (ctx) => {
      const d = jobDeps(deps, ctx);
      const channelId = channelOf(ctx);
      if (channelId === null) {
        return skip(ctx, "channel_backfill", "no channel in the job");
      }
      const budgetOk = deps.budgetOk;
      await runIngest(d, ctx, emptyResult("channel_backfill", null, channelId), (r, options) =>
        ingestChannelBackfill(d, channelId, r, {
          ...options,
          ...(budgetOk === undefined ? {} : { budgetOk: () => budgetOk("leftover") }),
        }),
      );
    },
  });
}
