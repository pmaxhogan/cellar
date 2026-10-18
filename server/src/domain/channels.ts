import { parseChannelRef, type ChannelRef, type ChannelRow } from "@cellar/shared";
import type { Db } from "../db/db.ts";
import { youtubeApi } from "../youtube/api.ts";
import { ensureChannel } from "../youtube/ingest.ts";
import { nowOf, type ServiceDeps } from "./deps.ts";
import { conflict, DomainError, invalid, notFound } from "./errors.ts";

/**
 * Channels and why they are tracked. A channel can be followed through any
 * number of `channel_sources`: one `subscription` row per account that
 * subscribes, plus at most one `manual` row (account_id NULL) the owner added.
 */

export const MAX_PER_PAGE = 200;

interface ChannelDbRow {
  id: string;
  title: string | null;
  handle: string | null;
  thumbnail_url: string | null;
  subscribed: number;
  manual: number;
  video_count: number;
}

const SELECT_CHANNEL = `
  SELECT c.id, c.title, c.handle, c.thumbnail_url,
         EXISTS (SELECT 1 FROM channel_sources s
                 WHERE s.channel_id = c.id AND s.kind = 'subscription') AS subscribed,
         EXISTS (SELECT 1 FROM channel_sources s
                 WHERE s.channel_id = c.id AND s.kind = 'manual') AS manual,
         (SELECT COUNT(*) FROM videos v WHERE v.channel_id = c.id) AS video_count
  FROM channels c`;

function toRow(row: ChannelDbRow): ChannelRow {
  return {
    id: row.id,
    title: row.title,
    handle: row.handle,
    thumbnail_url: row.thumbnail_url,
    subscribed: Number(row.subscribed) === 1,
    manual: Number(row.manual) === 1,
    video_count: Number(row.video_count),
  };
}

/** Escape LIKE wildcards so user text matches literally (used with ESCAPE '\'). */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export interface ChannelListQuery {
  q?: string | undefined;
  kind?: "subscription" | "manual" | undefined;
  page: number;
  perPage: number;
}

export interface ChannelPage {
  rows: ChannelRow[];
  total: number;
  page: number;
  perPage: number;
}

export function listChannels(db: Db, query: ChannelListQuery): ChannelPage {
  const where: string[] = [];
  const params: string[] = [];
  const q = query.q?.trim() ?? "";
  if (q !== "") {
    const pattern = `%${escapeLike(q)}%`;
    where.push("(c.title LIKE ? ESCAPE '\\' OR c.handle LIKE ? ESCAPE '\\' OR c.id = ?)");
    params.push(pattern, pattern, q);
  }
  if (query.kind !== undefined) {
    where.push("EXISTS (SELECT 1 FROM channel_sources s WHERE s.channel_id = c.id AND s.kind = ?)");
    params.push(query.kind);
  }
  const clause = where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`;
  const { n: total } = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM channels c${clause}`,
    ...params,
  ) as { n: number };
  const perPage = Math.min(Math.max(1, query.perPage), MAX_PER_PAGE);
  const page = Math.max(1, query.page);
  const rows = db
    .all<ChannelDbRow>(
      `${SELECT_CHANNEL}${clause}
       ORDER BY COALESCE(c.title, c.handle, c.id) COLLATE NOCASE, c.id
       LIMIT ? OFFSET ?`,
      ...params,
      perPage,
      (page - 1) * perPage,
    )
    .map(toRow);
  return { rows, total, page, perPage };
}

export function getChannel(db: Db, id: string): ChannelRow {
  const row = db.get<ChannelDbRow>(`${SELECT_CHANNEL} WHERE c.id = ?`, id);
  if (row === undefined) {
    throw notFound("Channel", id);
  }
  return toRow(row);
}

interface ApiChannel {
  id?: string;
  snippet?: {
    title?: string;
    customUrl?: string;
    thumbnails?: Record<string, { url?: string } | undefined>;
  };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
}

interface ChannelsListResponse {
  items?: ApiChannel[];
}

/**
 * Any account that holds a Google grant and is not known to be broken or
 * disabled, freshest first. A freshly linked account without a cookie jar is
 * still `pending`, and its API access is what a handle lookup needs.
 */
function apiAccount(db: Db): number | null {
  const row = db.get<{ id: number }>(
    `SELECT a.id FROM accounts a
     WHERE a.status NOT IN ('auth_lost', 'disabled') AND EXISTS (SELECT 1 FROM account_secrets s
                                       WHERE s.account_id = a.id AND s.kind = 'oauth_refresh')
     ORDER BY a.last_api_ok_at DESC, a.id LIMIT 1`,
  );
  return row === undefined ? null : Number(row.id);
}

function noAccount(): DomainError {
  return new DomainError(
    "no_account",
    "Resolving a handle or name needs a linked account with a working Google grant.",
  );
}

/**
 * Look a reference up with `channels.list`. A handle uses `forHandle`, a
 * legacy `/user/` name `forUsername`; a `/c/` custom URL has no API lookup,
 * so it is tried as a handle and then as a username (each 1 unit).
 */
async function resolveRef(
  deps: ServiceDeps,
  accountId: number,
  ref: ChannelRef,
): Promise<ApiChannel | null> {
  const api = youtubeApi(deps, accountId);
  const part = "snippet,contentDetails";
  const lookups: Record<string, string>[] =
    ref.kind === "id"
      ? [{ id: ref.value }]
      : ref.kind === "handle"
        ? [{ forHandle: `@${ref.value}` }]
        : ref.kind === "user"
          ? [{ forUsername: ref.value }]
          : [{ forHandle: `@${ref.value}` }, { forUsername: ref.value }];
  for (const lookup of lookups) {
    const body = await api.get<ChannelsListResponse>("channels", {
      part,
      maxResults: 1,
      ...lookup,
    });
    const item = body.items?.find((candidate) => typeof candidate.id === "string");
    if (item !== undefined) {
      return item;
    }
  }
  return null;
}

function thumbnailOf(channel: ApiChannel): string | null {
  const thumbs = channel.snippet?.thumbnails ?? {};
  for (const size of ["default", "medium", "high"]) {
    const url = thumbs[size]?.url;
    if (typeof url === "string") {
      return url;
    }
  }
  return null;
}

/**
 * Add a channel the owner wants followed without subscribing. A bare `UC...`
 * id is inserted without any API call when no account is available (the
 * ingestion jobs fill the metadata later); every other reference needs one.
 * Idempotent: adding a channel that is already manual returns it unchanged.
 */
export async function addManualChannel(
  deps: ServiceDeps,
  input: string,
): Promise<{ channel: ChannelRow; created: boolean }> {
  const ref = parseChannelRef(input);
  if (ref === null) {
    throw invalid("That is not a channel URL, handle or id.", {
      fields: { ref: "Not a channel reference" },
    });
  }
  const accountId = apiAccount(deps.db);
  let found: ApiChannel | null = null;
  if (ref.kind !== "id" || accountId !== null) {
    if (accountId === null) {
      throw noAccount();
    }
    try {
      found = await resolveRef(deps, accountId, ref);
    } catch (error) {
      if (ref.kind !== "id") {
        throw error;
      }
      // An id stands on its own; the metadata lookup is only a nicety.
      deps.log.warn({ err: error, channelId: ref.value }, "channel metadata lookup failed");
    }
    if (found === null && ref.kind !== "id") {
      throw notFound("Channel", input.trim());
    }
  }

  const id = found?.id ?? ref.value;
  const now = nowOf(deps);
  const created = deps.db.tx(() => {
    // ensureChannel reindexes the channel's videos in videos_fts when the title
    // changes (a contentless FTS table must be deleted with the indexed text).
    ensureChannel(
      deps.db,
      {
        id,
        title: found?.snippet?.title ?? null,
        thumbnailUrl: found === null ? null : thumbnailOf(found),
        uploadsPlaylistId: found?.contentDetails?.relatedPlaylists?.uploads ?? null,
      },
      now,
    );
    deps.db.run(
      `INSERT INTO channels (id, title, handle, uploads_playlist_id, thumbnail_url, first_seen_at,
                             created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         title = COALESCE(excluded.title, channels.title),
         handle = COALESCE(excluded.handle, channels.handle),
         uploads_playlist_id = COALESCE(excluded.uploads_playlist_id, channels.uploads_playlist_id),
         thumbnail_url = COALESCE(excluded.thumbnail_url, channels.thumbnail_url),
         updated_at = excluded.updated_at`,
      id,
      found?.snippet?.title ?? null,
      found?.snippet?.customUrl ?? (ref.kind === "handle" ? `@${ref.value}` : null),
      found?.contentDetails?.relatedPlaylists?.uploads ?? null,
      found === null ? null : thumbnailOf(found),
      now,
      now,
      now,
    );
    return (
      deps.db.run(
        `INSERT OR IGNORE INTO channel_sources (channel_id, account_id, kind, created_at)
         VALUES (?, NULL, 'manual', ?)`,
        id,
        now,
      ).changes > 0
    );
  });
  return { channel: getChannel(deps.db, id), created };
}

/**
 * Stop following a channel manually. Subscription sources are owned by the
 * subscriptions ingest and cannot be removed here.
 */
export function removeManualChannel(db: Db, id: string): void {
  const removed = db.run(
    "DELETE FROM channel_sources WHERE channel_id = ? AND kind = 'manual'",
    id,
  ).changes;
  if (removed > 0) {
    return;
  }
  const subscriptions = db.get(
    "SELECT 1 AS one FROM channel_sources WHERE channel_id = ? AND kind = 'subscription'",
    id,
  );
  if (subscriptions !== undefined) {
    throw conflict(
      "This channel is followed through an account subscription, not manually. " +
        "Unsubscribe on YouTube to stop following it.",
    );
  }
  throw notFound("Manual channel", id);
}
