import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config } from "../../src/config.ts";
import { storeSecret } from "../../src/domain/accountStore.ts";
import type { FetchLike } from "../../src/domain/deps.ts";
import type { RecheckDeps } from "../../src/domain/recheck.ts";
import { EventBus } from "../../src/events.ts";
import { JobQueue } from "../../src/jobs/queue.ts";
import { JobRegistry, type JobContext, type JobRecord } from "../../src/jobs/types.ts";
import { createConsoleLogger } from "../../src/logging.ts";
import type { RydClient } from "../../src/youtube/ryd.ts";
import { createTempDb, TEST_SECRET_KEY, type TempDb } from "../helpers.ts";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  FAKE_YTDLP_ENV,
  FakeGoogle,
  jsonResponse,
  REPO_ROOT,
  seedLinkedAccount,
} from "../wave1aHelpers.ts";

export const log = createConsoleLogger("silent");
export const NOW = Date.UTC(2026, 9, 18, 12);
export const DAY = 24 * 60 * 60_000;
export const JAR = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tabc\n";

export const YTDLP_FIXTURES = join(REPO_ROOT, "server", "test", "fixtures", "ytdlp");
export const HISTORY_FIXTURE = join(YTDLP_FIXTURES, "history.flat.json");
export const WATCH_LATER_FIXTURE = join(YTDLP_FIXTURES, "watchlater.flat.json");

/** Channel ids used across the suite (from the fixtures). */
export const RICK = "UCuAXFkgsw1L7xaCfnd5JJOw";
export const JAWED = "UC4QobU6STFB0P71PMvOGN5A";
export const THREE_B1B = "UCYO_jab_esuFRV4b17AJtAw";
export const VERITASIUM = "UCHnyfMqiRRG1u-2MsSQLbXA";

export type RouteHandler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/** One isolated database, config, fake Google and job queue per test. */
export class IngestEnv {
  readonly temp: TempDb;
  readonly config: Config;
  readonly google: FakeGoogle;
  readonly registry = new JobRegistry();
  readonly events = new EventBus();
  readonly queue: JobQueue;
  now = NOW;
  /** Extra hosts (RYD, i.ytimg.com) answered before FakeGoogle. */
  readonly routes = new Map<string, RouteHandler>();
  ryd: RydClient | undefined;

  private constructor(temp: TempDb, google: FakeGoogle) {
    this.temp = temp;
    this.google = google;
    this.config = loadConfig({
      INSECURE_ALLOW_PUBLIC_ACCESS: "1",
      DATA_DIR: temp.dir,
      CELLAR_SECRET_KEY: TEST_SECRET_KEY,
      GOOGLE_CLIENT_ID: CLIENT_ID,
      GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
      CELLAR_TOOL_YT_DLP: FAKE_YTDLP_ENV,
    });
    this.queue = new JobQueue(temp.db, { registry: this.registry, now: () => this.now });
    // installed_at is "now" unless a test moves it.
    this.temp.db.run("UPDATE kv SET value_json = ? WHERE key = 'installed_at'", String(NOW));
  }

  static async create(): Promise<IngestEnv> {
    const temp = createTempDb();
    const google = await new FakeGoogle().init();
    return new IngestEnv(temp, google);
  }

  get db(): TempDb["db"] {
    return this.temp.db;
  }

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const route = this.routes.get(url.host);
    if (route !== undefined) {
      return route(url, init);
    }
    return this.google.fetch(input, init);
  };

  deps(overrides: Partial<RecheckDeps> = {}): RecheckDeps {
    return {
      config: this.config,
      db: this.db,
      log,
      events: this.events,
      fetch: this.fetch,
      now: () => this.now,
      enqueue: (input) => this.queue.enqueue(input),
      registry: this.registry,
      ...(this.ryd === undefined ? {} : { ryd: this.ryd }),
      ...overrides,
    };
  }

  /** An account with a Google grant (and a cookie jar unless `cookies: false`). */
  account(options: { cookies?: boolean; label?: string; status?: string } = {}): number {
    const id = seedLinkedAccount(this.db, {
      label: options.label ?? "main",
      ...(options.status === undefined ? {} : { status: options.status }),
    });
    if (options.cookies !== false) {
      storeSecret(this.config, this.db, id, "cookies", JAR, this.now);
    }
    return id;
  }

  /** An account with a cookie jar but no Google grant. */
  cookieOnlyAccount(): number {
    const { lastInsertRowid } = this.db.run(
      `INSERT INTO accounts (label, status, created_at, updated_at) VALUES ('jar', 'ok', ?, ?)`,
      this.now,
      this.now,
    );
    storeSecret(this.config, this.db, lastInsertRowid, "cookies", JAR, this.now);
    return lastInsertRowid;
  }

  /** Serve YouTube API `path` with `handler`. */
  api(path: string, handler: (url: URL) => Response | undefined): void {
    this.google.api[path] = (url) => handler(url);
  }

  apiCalls(path: string): URL[] {
    return this.google
      .apiCalls()
      .filter((call) => call.url.pathname === `/youtube/v3/${path}`)
      .map((call) => call.url);
  }

  jobs(type?: string): { id: number; type: string; payload: unknown; priority: number }[] {
    return this.db
      .all<{ id: number; type: string; payload_json: string; priority: number }>(
        type === undefined
          ? "SELECT id, type, payload_json, priority FROM jobs ORDER BY id"
          : "SELECT id, type, payload_json, priority FROM jobs WHERE type = ? ORDER BY id",
        ...(type === undefined ? [] : [type]),
      )
      .map((row) => ({
        id: row.id,
        type: row.type,
        payload: parseOr(row.payload_json),
        priority: row.priority,
      }));
  }

  activity(kind?: string): { level: string; kind: string; message: string; data: unknown }[] {
    return this.db
      .all<{ level: string; kind: string; message: string; data_json: string | null }>(
        "SELECT level, kind, message, data_json FROM activity ORDER BY id",
      )
      .filter((row) => kind === undefined || row.kind === kind)
      .map((row) => ({
        level: row.level,
        kind: row.kind,
        message: row.message,
        data: row.data_json === null ? null : (JSON.parse(row.data_json) as unknown),
      }));
  }

  video(id: string): Record<string, unknown> | undefined {
    return this.db.get("SELECT * FROM videos WHERE id = ?", id);
  }

  sources(videoId: string): Record<string, unknown>[] {
    return this.db.all(
      `SELECT account_id, source, first_seen_at, last_seen_at, source_ts, origin
         FROM video_sources WHERE video_id = ? ORDER BY id`,
      videoId,
    );
  }

  /** A JobContext over a synthetic running job, for calling handlers directly. */
  ctx(type: string, job: Partial<JobRecord> = {}): JobContext {
    const controller = new AbortController();
    return {
      job: {
        id: 9000,
        type,
        status: "running",
        priority: 0,
        payload: {},
        accountId: null,
        videoId: null,
        attempts: 1,
        maxAttempts: 3,
        runAfter: 0,
        startedAt: this.now,
        finishedAt: null,
        error: null,
        logDir: null,
        createdAt: this.now,
        ...job,
      },
      db: this.db,
      log,
      logDir: join(this.temp.dir, "logs"),
      signal: controller.signal,
      progress: () => undefined,
      checkpoint: () => undefined,
    };
  }

  close(): void {
    this.temp.close();
  }
}

function parseOr(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function youtubeFixture<T = unknown>(name: string): T {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, "server", "test", "fixtures", "youtube", name), "utf8"),
  ) as T;
}

export { jsonResponse };

/** A synthetic but valid 11-character video id. */
export function vid(n: number, prefix = "v"): string {
  return `${prefix}${String(n).padStart(10, "0")}`.slice(0, 11);
}

/** A playlistItems.list item for `videoId`, published (and added) at `at`. */
export function playlistItem(
  videoId: string,
  at: number,
  channelId: string = THREE_B1B,
  title = `Video ${videoId}`,
): Record<string, unknown> {
  const iso = new Date(at).toISOString();
  return {
    kind: "youtube#playlistItem",
    snippet: {
      publishedAt: iso,
      title,
      videoOwnerChannelId: channelId,
      videoOwnerChannelTitle: "Owner",
      resourceId: { kind: "youtube#video", videoId },
    },
    contentDetails: { videoId, videoPublishedAt: iso },
  };
}

/** Serve `pages` (bodies) by pageToken: page i has nextPageToken `p<i+1>`. */
export function pagedHandler(
  pages: readonly { items: unknown[] }[],
): (url: URL) => Response | undefined {
  return (url) => {
    const token = url.searchParams.get("pageToken");
    const index = token === null ? 0 : Number(token.slice(1));
    const page = pages[index];
    if (page === undefined) {
      return jsonResponse(400, { error: { code: 400, errors: [{ reason: "invalidPageToken" }] } });
    }
    return jsonResponse(200, {
      kind: "youtube#playlistItemListResponse",
      items: page.items,
      ...(index + 1 < pages.length ? { nextPageToken: `p${String(index + 1)}` } : {}),
    });
  };
}
