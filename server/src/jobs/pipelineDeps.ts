import type { EffectiveSettings, NotifyResult, ResolvedSettings } from "@cellar/shared";
import type { Logger } from "pino";
import type { Db } from "../db/db.ts";
import type { ActivityInput } from "../domain/activity.ts";
import type { NotifyInput } from "../domain/notifications.ts";
import type { EventBus } from "../events.ts";
import type { NvencInfo } from "../media/ffmpeg.ts";
import type { SpawnTool } from "../media/spawn.ts";
import type { EnqueueInput, EnqueueResult } from "./queue.ts";
import type { JobRegistry } from "./types.ts";

/**
 * Everything the media pipeline (download, transcode, move, reap, canary)
 * needs from the rest of the server. Defined here, locally, so the pipeline
 * imports none of the modules other workstreams own; index.ts builds one and
 * the orchestrator wires the real accounts, proxies, settings, effective
 * settings and locations modules into it.
 */

export interface PipelineLocation {
  id: number;
  container_path: string;
  /** 0 = unlimited (only the minimum-free-space rule applies). */
  quota_bytes: number;
  enabled: boolean;
}

export interface PipelineEffective {
  effective: EffectiveSettings;
  reclaim_priority: number;
  location_id: number | null;
  include: boolean;
}

export interface PipelineConfig {
  dataDir: string;
  metaDir: string;
  tmpDir: string;
  /** POT_PROVIDER_URL; used when the `tools.pot_provider_url` setting is still the default. */
  potProviderUrl: string;
  /** yt-dlp `--plugin-dirs` value; empty means none. */
  ytdlpPluginDirs: string;
}

export interface PipelineDeps {
  db: Db;
  log: Logger;
  events: EventBus;
  config: PipelineConfig;
  now(): number;
  /** Streaming tool runner (media/spawn.ts createSpawnTool). Must NOT add yt-dlp flags itself. */
  runTool: SpawnTool;
  /** Decrypt the account's jar to a 0600 temp file, run fn, write the rotated jar back, delete. */
  withCookiesFile<T>(accountId: number, fn: (path: string) => Promise<T>): Promise<T>;
  pickProxy(policy: EffectiveSettings["proxy"]): { id: number; url: string } | null;
  /** Returns the consecutive failure count when known. */
  markProxyFailure(id: number): number | void;
  markProxyOk(id: number): void;
  getSettings(): ResolvedSettings;
  getEffective(videoId: string): PipelineEffective | null;
  locations(): PipelineLocation[];
  /** Accounts that sourced the video (video_sources plus channel_sources). */
  sourcingAccountIds(videoId: string): number[];
  /** Accounts that have a usable (not flagged) cookie jar. */
  accountsWithCookies(): number[];
  nvenc(): Promise<NvencInfo>;
  notify(input: NotifyInput): Promise<NotifyResult>;
  /** Non-null when the consecutive-failure threshold tripped. */
  recordDownloadFailure(videoId: string): Promise<NotifyResult | null>;
  recordDownloadSuccess(): void;
  recordStoragePressure(locationId: number, detail: string): Promise<unknown>;
  recordFsError(detail: string): Promise<unknown>;
  logActivity(input: ActivityInput): void;
  enqueue(input: EnqueueInput): EnqueueResult;
  /** Scheduler.every. */
  every(name: string, intervalMs: number, fn: () => unknown): void;
  /** Where bootPipeline registers handlers. Default: the process-wide jobRegistry. */
  registry?: JobRegistry;
  /** Canary favicon fetch. Default: global fetch. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Free/total bytes of the filesystem under a path. Default: fs.statfs. */
  statfs?: (path: string) => Promise<{ free: number; total: number }>;
  /** Test seam for atomicRename's primitive (cross-device moves). */
  rename?: (from: string, to: string) => Promise<void>;
}
