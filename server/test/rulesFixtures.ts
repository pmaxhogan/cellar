import { resolveSettings, type ResolvedSettings } from "@cellar/shared";
import { vi, type Mock } from "vitest";
import type { Db } from "../src/db/db.ts";
import { INSTALLED_AT_KEY, setKv } from "../src/db/kv.ts";
import type { RuleNotifyInput } from "../src/domain/effective.ts";
import { createRulesDeps, type RulesDeps } from "../src/domain/ruleEval.ts";
import { EventBus, type CellarEvent } from "../src/events.ts";
import { JobQueue } from "../src/jobs/queue.ts";
import { JobRegistry } from "../src/jobs/types.ts";
import { createConsoleLogger } from "../src/logging.ts";

/** Synthetic catalog builders for the rules suite. Rows go straight into SQLite. */

export const DAY = 24 * 60 * 60_000;
/** The suite clock: 2026-10-18T00:00:00Z. */
export const NOW = Date.UTC(2026, 9, 18);
/** Installed 30 days before NOW. */
export const INSTALLED_AT = NOW - 30 * DAY;

export interface Harness {
  deps: RulesDeps;
  queue: JobQueue;
  registry: JobRegistry;
  events: EventBus;
  seen: CellarEvent[];
  notify: Mock<(input: RuleNotifyInput) => Promise<unknown>>;
  recordFsError: Mock<(detail: string) => Promise<unknown>>;
  clock: { now: number };
  settings: { value: ResolvedSettings };
}

export function harness(db: Db, dataDir: string, extra: Partial<RulesDeps> = {}): Harness {
  setKv(db, INSTALLED_AT_KEY, INSTALLED_AT);
  const clock = { now: NOW };
  const registry = new JobRegistry();
  const events = new EventBus();
  const seen: CellarEvent[] = [];
  events.subscribe((event) => seen.push(event));
  const queue = new JobQueue(db, { registry, events, now: () => clock.now });
  const notify = vi.fn(async (_input: RuleNotifyInput): Promise<unknown> => ({ sent: true }));
  const recordFsError = vi.fn(async (_detail: string): Promise<unknown> => ({ sent: true }));
  const settings = { value: resolveSettings({}) };
  const deps: RulesDeps = {
    ...createRulesDeps({
      db,
      log: createConsoleLogger("silent"),
      events,
      dataDir,
      registry,
      enqueue: (input) => queue.enqueue(input),
      now: () => clock.now,
      getSettings: () => settings.value,
      notify,
      recordFsError,
    }),
    ...extra,
  };
  return { deps, queue, registry, events, seen, notify, recordFsError, clock, settings };
}

export function addAccount(db: Db, label = "main"): number {
  return db.run("INSERT INTO accounts (label, created_at, updated_at) VALUES (?, 1, 1)", label)
    .lastInsertRowid;
}

export function addChannel(db: Db, id: string, title: string): void {
  db.run(
    `INSERT INTO channels (id, title, first_seen_at, created_at, updated_at)
     VALUES (?, ?, 1, 1, 1)`,
    id,
    title,
  );
}

export interface VideoInput {
  channel_id?: string | null;
  title?: string | null;
  privacy?: string | null;
  type?: string | null;
  upload_date?: number | null;
  gone_since?: number | null;
  views?: number | null;
  tags_json?: string | null;
  has_av1?: number | null;
  caption_available?: number | null;
}

export function addVideo(db: Db, id: string, input: VideoInput = {}): string {
  db.run(
    `INSERT INTO videos (id, channel_id, title, privacy, type, upload_date, gone_since, views,
                         tags_json, has_av1, caption_available, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
    id,
    input.channel_id ?? null,
    input.title === undefined ? `Video ${id}` : input.title,
    input.privacy === undefined ? "public" : input.privacy,
    input.type === undefined ? "video" : input.type,
    input.upload_date === undefined ? NOW - 2 * DAY : input.upload_date,
    input.gone_since ?? null,
    input.views ?? null,
    input.tags_json ?? null,
    input.has_av1 ?? null,
    input.caption_available ?? null,
  );
  return id;
}

export function addSource(
  db: Db,
  videoId: string,
  source: string,
  firstSeenAt: number,
  accountId: number | null = null,
  lastSeenAt: number = firstSeenAt,
): void {
  db.run(
    `INSERT INTO video_sources (video_id, account_id, source, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)`,
    videoId,
    accountId,
    source,
    firstSeenAt,
    lastSeenAt,
  );
}

export interface MediaInput {
  kind?: string;
  version?: number;
  is_current?: number;
  location_id?: number | null;
  rel_path?: string;
  size_bytes?: number;
  downloaded_at?: number | null;
  vcodec?: string | null;
}

export function addMedia(db: Db, videoId: string, input: MediaInput = {}): number {
  return db.run(
    `INSERT INTO media (video_id, kind, version, is_current, location_id, rel_path, size_bytes,
                        downloaded_at, vcodec, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    videoId,
    input.kind ?? "video",
    input.version ?? 1,
    input.is_current ?? 1,
    input.location_id === undefined ? 1 : input.location_id,
    input.rel_path ?? `UCchan/${videoId}/${videoId}.mkv`,
    input.size_bytes ?? 100,
    input.downloaded_at === undefined ? NOW - DAY : input.downloaded_at,
    input.vcodec ?? "av01",
  ).lastInsertRowid;
}

export function effectiveRow(
  db: Db,
  videoId: string,
):
  | {
      reclaim_priority: number;
      location_id: number | null;
      include: number;
      next_eval_at: number | null;
      matched_rule_ids: string;
      effective_json: string;
      provenance_json: string;
      evaluated_at: number;
    }
  | undefined {
  return db.get("SELECT * FROM video_effective WHERE video_id = ?", videoId);
}

/** An 11-character video id from a short tag: vid("a") -> "a__________". */
export function vid(tag: string): string {
  return tag.padEnd(11, "_").slice(0, 11);
}
