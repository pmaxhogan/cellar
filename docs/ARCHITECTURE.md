# Cellar Architecture

Cellar is a self-hosted, single-tenant YouTube archiver. It downloads every YouTube video
the owner has watched, liked, added to Watch Later, or that was uploaded by a channel the
owner subscribes to (or added manually), across multiple YouTube accounts, governed by a
layered, drag-prioritised rule system with nested boolean conditions. It keeps all
metadata and its change history in SQLite, serves a secured admin SPA plus unauthenticated
public share links, transcodes, reaps storage lazily by reclaim priority across multiple
storage locations, notifies on failures and on videos going "gone", self-updates yt-dlp
and ffmpeg, and runs a comprehensive self-check. It ships as an MIT repo at
github.com/pmaxhogan/cellar and is deployed at https://cellar.maxhogan.dev.

This document is the source of truth for module boundaries, data model, API surface,
rule semantics and security rules. Builder agents implement against it. Deviations
require a note in the PR/commit message and a doc update.

## Reading guide

- This file is derived from `.claude/cellar-spec.md` (the ultraquest handoff spec). If
  this file and the spec ever disagree, THE SPEC WINS, and this file gets a fix.
- It is written as normative present tense: "The server does X" means the finished
  system does X and builders implement it. Waves (spec 5) only decide ORDER of delivery.
- Cellar copies the shape, tooling and conventions of the sibling project `amber`
  (Fastify 5 + node:sqlite + Vue 3/PrimeVue). Where this document says "amber pattern"
  it means the same structure as `amber/docs/ARCHITECTURE.md`.
- Items marked "provisional" are technical calls the spec leaves open; they hold until
  an implementer records the final call (see "Open technical calls").
- Where the code on main records a wire detail (a path, a verb, a column, an event name),
  this document states the code's shape; the code wins on wire details and the locked
  decisions in the spec win on intent. Sections that describe modules not yet on main
  (the `selfcheck` / `tools-update` manual actions) stay normative spec and say so where
  they appear; every other section was reconciled with the code (videos, rules, shares,
  Takeout import, ingestion, the stats rollup, and the download, transcode, move, reap
  and canary jobs). API shapes are pinned in `shared/src/apiTypes.ts`.
- Everything here is ASCII only. `-` is used instead of dashes and `->` for arrows.

Map from sections here to the spec:

| Section here | Spec |
| --- | --- |
| Locked stack, Directory layout | 1.2, 2, 3.12, 4.1 |
| Data model | 4.2 |
| Rules, effects and merge | 3.2, 4.3 |
| Rule AST | 4.4 |
| Default rule set | 1.2, 3.2, 4.5 |
| Ingestion and sources | 3.1, 4.6 |
| Media pipeline | 3.4, 4.7 |
| Metadata history and rechecks | 3.7, 4.6, 4.7 |
| Storage layout on disk | 3.3 |
| Quota and budgets | 3.1, 3.5 |
| Jobs and scheduler | 4.8 |
| Notifications and error policy | 3.8 |
| Logging and debug data | 3.9 |
| Accounts, cookies, proxies and tools | 3.5 |
| Share links and the public surface | 3.6, 4.9 |
| Self-check | 3.11 |
| REST API | 4.9 |
| Security model | 4.10, 1.2, 3.12 |
| Config | 4.11 |
| Frontend | 3.10, 4.12 |
| Testing | 3.13 |
| CI/CD | 2, 3.12 |
| Deployment | 1.2, 3.12, 7 |
| Open technical calls | 12 |

## Locked stack

- Node.js 26 ONLY: `engines.node` is `>=26`, `.node-version` is 26.x, the Docker runtime
  is Node 26. There is no older-Node compatibility job.
- TypeScript everywhere, ESM only (`"type": "module"`). TypeScript is pinned to 6.x, not
  7.x: typescript-eslint's peer range caps below 7. Relative imports carry a `.ts`
  extension (`rewriteRelativeImportExtensions` rewrites them on build).
- npm workspaces monorepo: `shared/ server/ web/ e2e/` with packages `@cellar/shared`,
  `@cellar/server`, `@cellar/web`, `@cellar/e2e`. The root package is `cellar`,
  version `0.1.0`, private, MIT.
- Server: Fastify 5, `node:sqlite` (stable on Node 26; SQLite with FTS5 and JSON1), no
  ORM. Frontend: Vue 3 + Vite + PrimeVue 4 SPA (+ `@primeuix/themes` 2), pinia,
  vue-router, PrimeVue Chart (Chart.js) for charts. Validation: zod 4 in `shared/`,
  inferred types on both sides.
- PrimeVue is pinned to the 4.x MIT line and `@primeuix/themes` to 2.x: PrimeVue 5
  adopted the commercial PrimeUI license model where every deployment needs a
  registered key and shows an "Invalid PrimeUI License" banner without one. Cellar is a
  public clone-and-deploy project, so there is no key to ship. Dependabot ignores both
  majors (and the TypeScript major).
- Dependencies otherwise track the latest stable compatible versions at build time
  (never pinned from memory), except the two pins above and TypeScript 6.x. Notable:
  fastify 5, `@fastify/static`, fastify-plugin, jose (CF Access JWT), pino 10 + pino-roll,
  zod 4, vue 3.5, vite, vue-tsc, pinia, vue-router, `@playwright/test`.
- Logging: pino only. Never `console.*` in `server/` or `shared/` (ESLint enforces).
  stdout NDJSON plus pino-roll size-rotated files. Child loggers per module
  (`log.child({ mod: "jobs" })`).
- Lint/format: ESLint 10 flat config (typescript-eslint recommended, eslint-plugin-vue
  flat/recommended, `no-console` error in server/shared, prettier last) + Prettier
  (semicolons, double quotes, 2-space, 100 columns). `docs/` is excluded from Prettier
  (`.prettierignore`) so hand-formatted tables survive. LF line endings everywhere
  (`.gitattributes` `* text=auto eol=lf`).
- ASCII only, enforced by `scripts/check-ascii.mjs` (fails on any non-ASCII byte in a
  tracked text file): no em/en dashes, smart quotes or arrows in code, docs, comments,
  commits, logs or UI copy. Use `-` and `->`.
- Private details guard: `scripts/check-private.mjs` fails when a tracked text file
  matches a private pattern (the owner's real hostname, dataset paths, usernames, ids).
  The patterns are never in the tree: they come from the `PRIVATE_PATTERNS` environment
  variable (a repository secret in CI) or from the local file
  `~/.config/cellar/private-patterns.txt`, and a failure prints only `file:line`, never
  the match. Docs and examples therefore use hypothetical values (host `nas`, pool path
  `/mnt/tank/apps/cellar`, `<team>.cloudflareaccess.com`, `owner@example.com`).
- Tests: Vitest 5 with v8 coverage; reporters `text`, `json`, `json-summary`,
  `cobertura`, `html`; a 0.5 percentage-point ratchet (`scripts/coverage-ratchet.mjs`,
  baseline `coverage-baseline.json`). Playwright for e2e.
- Conventional Commits: `type(scope): summary`, lower case, imperative, no trailing
  period. Migrations are append-only. Credentials never enter argv, URLs, logs, API
  responses or error messages. yt-dlp and ffmpeg are spawned with argv arrays, never a
  shell.
- External tools: yt-dlp (`yt-dlp_linux` release binary, sha256 verified), ffmpeg and
  ffprobe (BtbN static builds, with libsvtav1 and NVENC), the bgutil PO-token plugin.
- License MIT. Public repo. NEVER commit secrets; `.env` files are gitignored and
  `.env.example` documents the variables with empty values.

## Directory layout (repo)

```
package.json              # workspaces root: shared, server, web, e2e
tsconfig.base.json
eslint.config.js
.prettierrc.yaml, .prettierignore, .editorconfig, .gitattributes
.node-version             # 26.x
.env.example
vitest.config.ts          # projects: shared, server, web (coverage config lives here)
coverage-baseline.json
.github/workflows/        # ci.yml, build-image.yml, Dependabot auto-merge workflow
.github/dependabot.yml
.github/rulesets/         # ruleset JSON applied after acceptance
docs/ARCHITECTURE.md      # this file
docs/setup-cloudflare.md  # host Access app + /s bypass app, with curl checks
docs/brand/palette.md     # cellar palette with measured contrast ratios
shared/   @cellar/shared  # zod schemas, API types (apiTypes.ts), rules/ (AST, evaluate,
                          #   merge, nextFlip, effects registry, default rules), settings
                          #   registry, id parser, Takeout parsers, filename template
                          #   renderer (pure, no IO)
server/   @cellar/server  # Fastify 5, node:sqlite, jobs, yt-dlp/ffmpeg runners
web/      @cellar/web     # Vue 3 + Vite + PrimeVue 4 admin SPA (entry index.html)
                          #   + public share entry (share.html -> web/src/share.ts)
e2e/      @cellar/e2e     # Playwright
deploy/docker-compose.nas.yml   # the NAS Custom App
deploy/README.md                # NAS runbook (ZFS datasets, UID/GID, midclt, OAuth client,
                                #   cookies export, Takeout export)
scripts/check-ascii.mjs, scripts/check-private.mjs, scripts/coverage-ratchet.mjs
scripts/fake-bin/         # fake yt-dlp / ffmpeg / ffprobe shims for tests
Dockerfile
README.md, SECURITY.md, CLAUDE.md, LICENSE
```

Server module map (`server/src/`):

```
index.ts                 # entrypoint: config -> logger -> db -> app.listen
app.ts                   # buildApp(deps): registers plugins/routes; used by tests (inject)
config.ts                # env parsing/validation (zod), fail-fast
logging.ts               # pino setup (stdout + pino-roll multistream, redaction)
db/db.ts                 # node:sqlite wrapper: get/all/run/exec/tx with savepoints
db/migrate.ts            # migration runner (names recorded in a `migrations` table)
db/migrations.ts         # ordered append-only array of { name, sql }; 001_init is inline,
                         #   002 is db/migrations002.ts, 003 is db/migrations003.ts,
                         #   004 (title changes index) is db/migrations004.ts
db/kv.ts, db/paged.ts    # kv get/set (JSON values); paged-query helper + Where builder
security/cfAccess.ts     # CF Access JWT plugin (amber verbatim, adapted)
security/secrets.ts      # AES-256-GCM encrypt/decrypt (CELLAR_SECRET_KEY)
security/publicPaths.ts  # isPublicPath: ["/healthz", "/s"], shared with the SPA fallback
domain/                  # no Fastify inside: videos, videoFiles, bulk, channels, accounts,
                         #   accountStore, rules, ruleEval, effective, recheck, thumbnails,
                         #   locations, proxies, settings, reaper, mover, canary, shares,
                         #   takeout, notifications, activity, selfcheck, systemDeps, deps,
                         #   stats, errors
youtube/                 # api, oauth, quota, ingest, feeds, ryd (video identifier parsing
                         #   lives in shared/)
media/                   # exec (tool runner), spawn (streaming runner for jobs), tools
                         #   (baseline install + updater), ytdlp (argv + output parsing),
                         #   ffmpeg (probe + transcode plan), paths, rows, captions,
                         #   thumbnails, versions
jobs/                    # scheduler, queue, types, jobLog, boot (scheduler + log
                         #   retention), ingestBoot, pipelineBoot, pipelineDeps,
                         #   pipelineFallbacks, pipelineWiring, handlers/* (download,
                         #   downloadScan, transcode, move, reap, canary, evalPass,
                         #   pri0Sweep, ingest, recheck, takeout, statsRollup)
routes/*.ts              # thin REST routes per resource, mounted by plugins (wave1a:
                         #   accounts, channels, locations, proxies, settings; wave1b:
                         #   jobs, activity, actions, notifications; system: tools,
                         #   checks; wave2b: rules, inspect; plus videos, shares, takeout,
                         #   stats, status, events); routes/validate.ts (parseBody / parseQuery /
                         #   parseParams, toApiError)
public/share.ts          # the /s routes (public surface); public/legalPages.ts
events.ts                # SSE bus (/api/events)
web.ts                   # serves the built SPA(s) + client-route fallback
```

Rules of the road (amber pattern):

- `domain/*.ts` contains no Fastify; routes are thin and call domain functions.
- `domain/errors.ts` defines `DomainError` and its HTTP mapping; a single Fastify error
  handler maps it. 5xx responses carry a fixed message; the real error is logged. Codes:
  `not_found` 404, `conflict` 409, `invalid` 400, `immutable` 409, `unsupported` 400,
  `precondition_failed` 412, `quota_exhausted` 429, `no_account` 409. Error bodies are
  `{ error, code?, details? }`; validation failures carry `details.fields` (path ->
  message), and their `error` names the failing paths (`Invalid query string: kind.`),
  never the rejected values.
- `routes/validate.ts` parses bodies, queries and params with the shared zod schemas.
- `shared/` is pure: no IO, no Node-only imports. It must be built before `server` and
  `web` resolve its types (`npm run build` and `npm run typecheck` do that in order).

## Data model (SQLite)

DB file: `$DATA_DIR/state/cellar.db` (the `state/` directory is mode 0700). Pragmas on
open: `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5000`.
Single process, single writer. All
multi-statement writes run inside transactions via the `tx()` helper (savepoints when
nested). The wrapper is typed: `get` / `all` / `run` / `exec` / `tx`.

Migrations: `db/migrations.ts` exports an ordered list `{ name, sql }`. The runner
records applied names in a `migrations` table, one transaction per migration. Never edit
an applied migration; append new ones. `kv.installed_at` is written at first DB init
(`ensureInstalledAt`, never overwritten). The default rule set (below) is installed at
boot from `shared/src/rules/defaults.ts` by `ensureDefaultRules` (`domain/rules.ts`),
only when the `rules` table is empty and `kv.default_rules_seeded` is unset; the flag is
then set, so a later boot never re-seeds even if the owner deletes every custom rule. No
migration inserts rules. Present migrations:

- `001_init`: `settings`, `kv`, `locations` (seeded with one `media` -> `/media` row),
  `accounts`, `account_secrets`.
- `002_jobs_notifications`: `jobs`, `activity`, `notifications`, `notification_state`,
  `push_subscriptions`, `proxies`, `checks`.
- `003_catalog`: `channels`, `channel_sources`, `videos`, `video_sources`,
  `video_changes`, `video_stats`, `thumbnails`, `media`, `rules`, `video_effective`,
  `rule_notify_counts`, `quota_usage`, `stats_daily`, `share_links`, and the `videos_fts`
  table with its triggers.

All times are epoch milliseconds (INTEGER). Every table carries `created_at` and
`updated_at` unless a bullet shows its columns without them (those are append-only logs
or caches where the listed columns are the full set). JSON columns are TEXT holding
JSON, validated by a shared zod schema on write.

### Accounts and secrets

- `accounts`: `id`, `label`, `google_sub`, `email`, `channel_id`, `status`,
  `api_quota_reserved`, `scrape_budget_per_hour`, `last_api_ok_at`, `last_cookie_ok_at`,
  `created_at`, `updated_at`. A Google account, not a channel. Linking one requires BOTH
  a Google OAuth grant and a cookie jar. `status` is the link health shown on the
  Accounts page: `pending` | `ok` | `auth_lost` | `cookies_invalid` | `disabled`
  (`domain/accountStore.ts`; the migration default `new` reads as `pending`). The error
  policy sets `auth_lost` on the first confirmed 401 and `cookies_invalid` when the jar
  fails validation; both stay until the credential is replaced. The owner can only set
  `disabled` (pause) or `pending` (resume, which recomputes the status from the stored
  credentials). `scrape_budget_per_hour` NULL means the global
  `quota.scrape_requests_per_hour` applies. The API row (`AccountRow`) adds a derived
  `has_cookies` and leaves out `google_sub` and `api_quota_reserved`.
- `account_secrets`: `account_id`, `kind` (`oauth_refresh` | `cookies`), `ciphertext`,
  `iv`, `tag`, `updated_at`. AES-256-GCM via `security/secrets.ts`. One row per
  (account, kind). Secrets are write-only: API responses carry presence booleans and
  last-ok timestamps, never the secret.
- `proxies`: `id`, `label` (UNIQUE), `url_blob`, `url_redacted`, `enabled`, `fail_count`,
  `skipped_until`, `created_at`, `updated_at` (migration 002). The URL, which may carry
  credentials, is ONE AES-256-GCM blob (`url_blob` = IV || tag || ciphertext, via
  `security/secrets.ts`), not three columns like `account_secrets`. `url_redacted` is the
  `scheme://host:port` form shown in the UI; the full URL is never returned. Accepted
  schemes: http, https, socks4, socks4a, socks5, socks5h.

### Channels and videos

- `channels`: `id` (= `UC...`), `title`, `handle`, `uploads_playlist_id`,
  `thumbnail_url`, `first_seen_at`, `last_checked_at`.
- `channel_sources`: `id`, `channel_id`, `account_id` (nullable), `kind` (`subscription`
  | `manual`), `subscribed_at`, `created_at`. Manual rows have `account_id` NULL and use
  the `download_accounts` default `any`. Dedupe is a UNIQUE index on
  `(channel_id, COALESCE(account_id, 0), kind)`, so NULL account ids collapse.
- `videos`: `id` (11-char YouTube id), `channel_id`, `title`, `description`,
  `upload_date`, `published_at`, `duration_s`, `type` (`video` | `short` | `livestream`
  | `premiere`), `live_status`, `privacy` (`public` | `unlisted` | `private` |
  `removed` | `unavailable`), `gone_since`, `consecutive_recheck_failures`, `views`,
  `likes`, `comments`, `ryd_dislikes`, `ryd_ratio`, `tags_json`, `category_id`,
  `default_language`, `caption_available`, `max_height`, `has_av1`, `has_vp9`,
  `has_h264`, `max_fps`, `is_hdr`, `formats_json`, `content_signature` (a sha256 of the
  `contentDetails` fields `definition`, `dimension`, `projection` and `licensedContent`,
  which reveal a re-encode or re-edit; the duration is deliberately NOT part of it,
  because it has its own 2 s tolerance, see "Versions (YouTube-side edits)"),
  `last_recheck_at`, `next_recheck_at`,
  `recheck_tier`, `created_at`, `updated_at`. "Gone" means private, removed or
  unavailable, or marked gone by rechecks (`gone_since`).
- `video_sources`: `id`, `video_id`, `account_id` (nullable), `source` (`history` |
  `watch_later` | `liked` | `subscription` | `channel`), `first_seen_at`,
  `last_seen_at`, `source_ts` (nullable; the real watch/like/add time when known),
  `origin` (`live_feed` | `api` | `takeout`). Rows carry a surrogate `id`; dedupe is a
  UNIQUE index on `(video_id, COALESCE(account_id, 0), source)`. SQLite treats NULLs as
  distinct in a plain UNIQUE constraint, so the COALESCE makes a NULL `account_id`
  (manual channels) collapse to one row per video and source. `channel_sources` uses
  the same technique.
- `video_changes`: `id`, `video_id`, `recheck_id`, `field`, `old_json`, `new_json`,
  `seen_at`. THE one history store (see "Metadata history and rechecks"). `recheck_id`
  is the `jobs.id` of the `recheck_batch` run that observed the diff (NULL when ingestion
  wrote it); the spec names the column but no separate table. Indexed on
  `(video_id, seen_at)` for one video's timeline and `(field, seen_at)` (migration 004)
  for the cross-video Title changes list.
- `video_stats`: `video_id`, `at`, `views`, `likes`, `comments`, `ryd_dislikes`. A
  derived chart index; see "Metadata history and rechecks" for its status.
- `thumbnails`: `id`, `video_id`, `variant`, `url`, `sha256`, `path`, `first_seen_at`;
  UNIQUE `(video_id, variant, sha256)`. Every distinct hash is stored once. When a hash
  that was stored before comes back (the thumbnail is changed back), the existing row's
  `url` and `first_seen_at` are bumped to now, so the newest-first ordering that picks
  the thumbnail to serve puts it on top again.
- `videos_fts`: contentless FTS5 table (`content = ''`, tokenizer `unicode61
  remove_diacritics 2`) with columns `id` (UNINDEXED), `title`, `description`,
  `channel_title`, `tags`, keyed by the video's rowid and kept in sync by insert, delete
  and update triggers. The channel title is joined at trigger time, so a channel rename
  needs a domain-level reindex of that channel's videos: `ensureChannel`
  (`youtube/ingest.ts`) deletes the channel's videos from the index with the OLD title
  (a contentless table's delete trigger must see exactly what was indexed or the index
  is corrupted), updates the channel row, and re-inserts them with the new title, all in
  one transaction. Queried with `bm25` ranking and prefix queries (see "Videos API").

### Media and locations

- `media`: `id`, `video_id`, `kind` (`video` | `audio` | `captions` | `info`), `version`
  (int), `is_current`, `location_id` (nullable; NULL = lives under `/data/meta`, used
  by captions/info rows), `rel_path`, `size_bytes`, `sha256`, `vcodec`, `acodec`,
  `height`, `fps`, `bitrate`, `lang` (nullable), `downloaded_at`, `transcoded_from`
  (nullable), `created_at`.
- `locations`: `id`, `label` (UNIQUE), `container_path` (UNIQUE), `quota_bytes` (0 =
  unlimited until set), `enabled`, `used_bytes`, `fs_free_bytes`, `created_at`,
  `updated_at`. A location is a compose bind mount (container path) plus this row. The
  two cached columns exist, but the API row (`LocationRow`) computes both live:
  `used_bytes` is the sum of the current media sizes in the location, `fs_free_bytes`
  comes from statfs, and `mounted` (directory exists and is writable) is derived.
  Migration 001 seeds one location, `media` -> `/media`.

### Rules and evaluation results

- `rules`: `id`, `kind` (`global` | `custom` | `video`), `video_id` (nullable; set for
  `video` rules), `position` (int, custom ordering), `name`, `enabled`,
  `condition_json` (the AST; NULL for global/video rules; a custom rule always carries
  one, match-all being an empty `and` group), `effects_json` (sparse map of effect key ->
  value), `created_at`, `updated_at`. A partial UNIQUE index allows one `video` rule per
  `video_id`.
- `video_effective`: `video_id`, `effective_json`, `provenance_json`, `matched_rule_ids`
  (json), `evaluated_at`, `next_eval_at`, `reclaim_priority`, `location_id`, `include`.
  `effective_json` holds the merged effect values and `provenance_json` the per-key
  provenance (the id of the rule that set each key, or `"default"`); `reclaim_priority`,
  `location_id` and `include` are denormalized for the reaper, mover and download
  scheduling.
- `rule_notify_counts`: `rule_id`, `video_id`, `count`. Backs the `notify.max_times`
  limit.

### Jobs, activity, notifications

- `jobs`: `id`, `type`, `status` (`queued` | `running` | `done` | `failed` |
  `cancelled`), `priority`, `payload_json`, `account_id` (nullable), `video_id`
  (nullable), `attempts`, `max_attempts`, `run_after`, `started_at`, `finished_at`,
  `error`, `log_dir`, `created_at`.
- `activity`: `id`, `at`, `level`, `kind`, `message`, `video_id` (nullable), `job_id`
  (nullable), `data_json`. What the Activity page lists.
- `notifications`: `id`, `type`, `title`, `body`, `data_json`, `video_id` (nullable),
  `created_at`, `acked_at`, `pushed_at`.
- `notification_state`: `type`, `last_sent_at`. Rate-limit memory per notification type.
- `push_subscriptions`: `endpoint`, `keys_json`, `created_at`.

### Sharing, budgets, stats, misc

- `share_links`: `token` (PK), `video_id`, `expires_at` (nullable; NULL = never),
  `revoked_at` (nullable), `access_count`, `last_access_at`, `created_at`.
- `quota_usage`: `account_id`, `day`, `api_units`, `scrape_requests`; PK `(account_id,
  day)`. `account_id` 0 = project wide: Google's quota is per Cloud project, so every API
  call is charged to its account row AND to row 0, and the daily budget is enforced
  against row 0. `day` is `YYYY-MM-DD` in UTC; the per-account scrape counters use hour
  rows in the same table, keyed `YYYY-MM-DDTHH`.
- `stats_daily`: `day`, `location_id` (NOT NULL; 0 = all locations), `bytes_used`,
  `downloads`, `catalog`, `gone`, `api_units`; PK `(day, location_id)`. The
  pre-aggregated source of the charts, written by the `stats_rollup` job (see "Jobs and
  scheduler").
- `checks`: `id`, `run_at`, `trigger`, `results_json`, `ok`. Self-check history.
- `settings`: `key`, `value_json`, `updated_at`. The sparse global settings store (amber
  pattern): only keys the owner changed are stored.
- `kv`: `key`, `value_json`, `updated_at`; every value is JSON. Holds `installed_at`
  (written at first DB init; anchors the 7-day subscription backfill guard), the VAPID
  keypair (`vapid`), `tool_versions`, single-use OAuth `oauth_state:*` rows, proxy
  round-robin cursors (`proxy_rr:*`), scheduler last-run times (`schedule_last:*`), and
  similar.

## Rules, effects and merge

Rules replace amber's layered settings. There are three rule kinds, merged in a fixed
order, and a registry of effect keys that every rule layer draws from.

### Rule kinds and layering

- `global` (lowest priority): exactly one rule. No condition; it applies to every video.
  It cannot set `include`.
- `custom` (medium): any number of rules, ordered by drag and drop (`position`
  ascending = priority ascending, so a LATER rule wins). Each has a nested boolean
  condition (see "Rule AST") and a sparse set of effects.
- `video` (highest): at most one per video id, no condition (`video_id` set). Created
  from the Inspect page, the video detail page, and the trash action.

### Effects registry (`shared/src/rules/effects.ts`)

Each effect key declares a zod schema, a default, `allowedIn: ["global", "custom",
"video"]` and UI metadata (group, label, control). The spec restricts exactly one key:
`include` is NOT allowed in `global`; every other key is allowed in all three kinds.

| Key | Type | Default | allowedIn |
| --- | --- | --- | --- |
| `include` | bool | `true` | custom, video (NOT global) |
| `reclaim_priority` | int >= -1 | `-1` | global, custom, video |
| `location_id` | location id or null | null (= first enabled location) | global, custom, video |
| `media_mode` | `video` \| `audio_only` \| `captions_only` \| `metadata_only` | `video` | global, custom, video |
| `format_policy` | `prefer_av1` \| `prefer_vp9` \| `prefer_h264` \| `best` | `prefer_av1` | global, custom, video |
| `max_height` | int (pixels) | unset (no cap) | global, custom, video |
| `max_fps` | int | unset (no cap) | global, custom, video |
| `quality_priority` | null or `{ primary: resolution \| fps, resolutions: every tier of 4320/2160/1440/1080/720/480/360/240/144 ranked, fps: every tier of 60/50/48/30/25/24 ranked }` | null (codec first) | global, custom, video |
| `transcode` | object, see below | `{ mode: if_not_av1, codec: hevc_nvenc, quality: 28, preset: p5, audio_codec: copy }` | global, custom, video |
| `captions` | `{ enabled, languages: string[] \| "all", auto_generated: bool }` | `{ enabled: true, languages: "all", auto_generated: true }` | global, custom, video |
| `ytdlp` | `{ format_override?, rate_limit_bytes_per_s?, sleep_requests_min?, sleep_requests_max?, concurrent_fragments?, extra_args_allowlisted? }` | all fields unset (global settings apply) | global, custom, video |
| `download_accounts` | `sourcing` \| `any` \| account ids[] | `sourcing` | global, custom, video |
| `proxy` | `none` \| `pool` \| proxy ids[] | `none` | global, custom, video |
| `delay_after_upload` | duration | unset (no delay) | global, custom, video |
| `recheck_interval` | `tiered` \| duration | `tiered` | global, custom, video |
| `live` | `vod_only` \| `record_live` | `vod_only` | global, custom, video |
| `notify` | `{ enabled, max_times: int \| null, channel: push }` | `{ enabled: false, max_times: 1, channel: push }` | global, custom, video |

Details that are part of the contract:

- `reclaim_priority`: `-1` never delete; `0` delete media immediately (metadata kept)
  and never re-download; any positive integer is reaper-eligible, lowest value reaped
  first. "Higher number = reclaimed later" within a location.
- `include`: defaults to true through the registry. A video with `include: false` (from
  a custom or video rule) is never scheduled for download; its existing media is
  governed by `reclaim_priority` as usual.
- `location_id`: the storage location the video belongs on. A change in the resolved
  value moves the media; it never re-downloads (see "Media pipeline"). The default
  "first location" is resolved at evaluation time to the lowest-id enabled location.
- `transcode`: `{ mode: none | if_not_av1 | always, codec: hevc_nvenc | h264_nvenc |
  av1_svt | av1_nvenc, quality: 0-63 (CQ for NVENC, CRF for SVT-AV1), preset,
  max_video_bitrate_kbps?, max_height?, max_fps?, audio_codec: copy | aac | opus,
  audio_bitrate_kbps? }`. `max_height` downscales so the shorter side of the frame fits
  (aspect kept, even sizes); `max_fps` keeps every Nth frame with the smallest N that
  fits (60 -> 30, 50 -> 25, 48 -> 24), so motion stays even. Every
  subfield has a schema default, so a sparse object parses to a complete one. `av1_nvenc`
  is only offered when the hardware
  allows it (the NAS GPU does not). `hevc_nvenc` / `h264_nvenc` are offered in the rule
  UI only when NVENC is detected. Software `av1_svt` is a rule option, not the default.
- `captions`: WebVTT. Default is all manual subtitle languages plus auto-generated for
  the video's language. A default rule narrows this to English (see "Default rule set").
  `captions_only` and `audio_only` combine: audio-only media with captions enabled
  downloads both.
- `ytdlp.extra_args_allowlisted`: only flags from the allowlist
  (`YTDLP_EXTRA_ARGS_ALLOWLIST` in `shared/src/rules/effects.ts`, written `--flag` or
  `--flag=value`; nothing that runs commands, touches paths or carries credentials) are
  accepted; anything else is rejected at validation time.
- `download_accounts`: `sourcing` = the account(s) that sourced the video, round-robin
  across them; an explicit list or `any` is allowed. For manually added channels (no
  account) the default is `any`.
- `proxy`: `none`, `pool` (round-robin over enabled pool entries) or specific proxy ids.
- `delay_after_upload`: wait this long after `upload_date` before downloading.
- `recheck_interval`: `tiered` (daily under 30 days old, weekly under 1 year, monthly
  older) or a fixed duration. Pri-0 videos only recheck on leftover budget regardless.
- `live`: `vod_only` tracks live/upcoming videos, polls, and downloads when the VOD is
  published; `record_live` records with `--live-from-start`. Off by default.
- `notify`: notify up to `max_times` (1-1000, or unlimited when null; default 1) per
  video while the video meets the rule; counts live in `rule_notify_counts`. Delivery is
  Web Push.

Global-only settings (storage budgets, GPU/hardware access, scheduler cadences, error
thresholds, and so on) are NOT rule effects; they live in the `settings` table and the
global settings registry (see "Global settings").

### Merge

Evaluation merges layers in this order, per video:

1. Start from the registry defaults.
2. Apply the `global` rule's effects.
3. Apply each matching, enabled `custom` rule in ascending `position` (a later rule has
   higher priority). A rule overrides only the effect keys it sets. Values replace at
   effect-key granularity: a rule that sets `captions` supplies the whole `captions`
   value, and any field it omits takes the schema's field default. Object-valued effects
   (`transcode`, `captions`, `ytdlp`, `notify`) are never deep-merged.
4. Apply the `video` rule for this video id.

The result PLUS provenance (which rule set each key) is stored in `video_effective` and
shown on the Inspect page. `matched_rule_ids` lists the global rule, every matching
custom rule (in priority order) and the video rule; a disabled rule is skipped in every
layer. Provenance is the id of the rule that set the key; a key that no rule set
reports provenance "default". An effect a rule's kind may not set (`include` on the
global rule) is ignored by the merge. `location_id` stays null in the merge result; the
server substitutes the lowest-id enabled location.

Evaluation is triggered:

- on every change (video metadata or sources change, any rule edited; debounced);
- by a full pass every hour (the interval is a global setting);
- by the manual "Refresh and recheck all" action, which rechecks all metadata and so
  re-evaluates every rule.

Pri-0 deletions are swept immediately after a pass. `next_eval_at` per video is the
soonest time any age/time leaf in any enabled rule flips for that video (computed from
the thresholds); the hourly pass is the safety net.

### Global settings (`shared/src/settingsRegistry.ts`)

Amber pattern: each key declares a zod schema, a default and UI metadata (one scope,
`global`). Keys are dotted `group.name` strings. Storage is sparse: `GET /api/settings`
answers `{ overrides }` with only the keys the owner changed, and `PUT` takes the sparse
patch ITSELF as the body (a `{ patch: {...} }` wrapper is also accepted; no setting is
named `patch`) and answers the new `{ overrides }`. A null value clears an override.
Unknown keys reject the whole patch with a 400 (`details.fields` and `details.errors`
map key -> message), as do cross-key violations: `reaper.low_water_pct` must be below
`reaper.high_water_pct`, `download.sleep_requests_min_s` must not exceed the max, and
`recheck.daily_under_days` must not exceed `recheck.weekly_under_days`. A stored value
that no longer validates reads as the default. `tools.pot_provider_url` defaults to the
env `POT_PROVIDER_URL` while not overridden. The table records the final names, which
replace the provisional ones this document first assigned.

| Key | Default | Meaning |
| --- | --- | --- |
| `eval.interval_minutes` | 60 | Full rule-evaluation pass interval (1+; read once at boot, so a change applies after a restart) |
| `ingest.history_minutes` | 30 | History feed per account |
| `ingest.watch_later_minutes` | 30 | Watch Later feed per account |
| `ingest.liked_minutes` | 30 | Liked playlist per account |
| `ingest.subscriptions_hours` | 6 | Subscriptions list per account |
| `ingest.channel_uploads_minutes` | 30 | Newest uploads per channel |
| `ingest.channel_newest_n` | 50 | Newest uploads read per channel poll (1-500) |
| `ingest.manual_channel_full_scan_hours` | 24 | Full scan of manual channels until caught up (leftover budget) |
| `recheck.daily_under_days` | 30 | Daily recheck below this video age |
| `recheck.weekly_under_days` | 365 | Weekly below this, monthly above |
| `recheck.ryd_enabled` | true | Return YouTube Dislike lookups |
| `quota.api_units_per_day` | 10000 | Google API units per day |
| `quota.scrape_requests_per_hour` | 120 | Self-imposed yt-dlp requests/hour per account; `accounts.scrape_budget_per_hour` overrides it when not NULL |
| `download.concurrency` | 2 | `download` worker pool size (1-16) |
| `transcode.concurrency` | 1 | `transcode` worker pool size (1-8) |
| `download.rate_limit_bytes_per_s` | null (no cap) | yt-dlp `--limit-rate` default |
| `download.account_gap_seconds` | 30 | Minimum gap between downloads per account |
| `download.sleep_requests_min_s` / `download.sleep_requests_max_s` | 1 / 3 | yt-dlp `--sleep-requests` |
| `reaper.high_water_pct` | 95 | Start reaping at this % of quota |
| `reaper.low_water_pct` | 90 | Free down to this % of quota |
| `reaper.min_free_gb` | 10 | Also start reaping when the FS has less free than this |
| `notify.consecutive_download_failures` | 3 | Consecutive download failures across distinct videos |
| `notify.rate_limit_hours` | 6 | Per notification type, unless acknowledged |
| `notify.storage_pressure_hours` | 6 | Storage pressure repeat interval |
| `notify.outage_hours` | 6 | "Recheck pass failed" repeat interval |
| `canary.max_per_hour` | 1 | Canary download budget |
| `logs.job_retention_days` | 14 | Per-job log retention |
| `logs.job_retention_gb` | 2 | Per-job log total cap |
| `logs.failed_job_retention_days` | 60 | Retention for failed jobs' logs |
| `tools.auto_update` | true | Swap in verified yt-dlp / ffmpeg releases; when off, updates are only checked |
| `tools.pot_provider_url` | `http://bgutil:4416` | PO-token sidecar (env `POT_PROVIDER_URL` seeds it); empty disables |
| `tools.js_runtime` | `node` | yt-dlp `--js-runtimes` value (`node`, `deno`, `bun`, `quickjs`) |
| `tools.ffmpeg_release_tag` | `autobuild-2025-12-31-14-28` | BtbN release the ffmpeg updater installs (letters, digits, `.`, `_` and `-` only). The default is the pinned build the image ships, the newest one that still opens NVENC on 580-series drivers; `latest` is an explicit opt-in to follow the rolling build, whose newer builds need NVENC API 13.1 (driver 610+) |
| `selfcheck.interval_hours` | 24 | Self-check cadence |
| `bulk.warn_gb` | 20 | Bulk download size above which the estimate answers `warn: true` (decimal GB, 10^9 bytes); a warning only, no cap |
| `thumbnails.variants` | all six variants | Thumbnail variants to fetch, hash and keep on change |

Spec items that are constants in code, not settings: the proxy skip window (10 minutes
after 3 consecutive failures, `domain/proxies.ts`), the `/s` rate limit (120 per minute
per IP, `public/share.ts`), the tool update cadence (daily, the first run 5 minutes
after boot, `media/tools.ts`) and the scheduler tick (5 s). The 7-day backfill guard is
the duration in default rule 4, not a setting. The spec's "also route API calls through
the proxy" switch (`proxy_apply_to_api`) is not in the registry yet.

## Rule AST (`shared/src/rules/ast.ts`)

A condition is a JSON tree validated by a shared zod schema (the same schema validates
`POST /api/rules`, `PUT /api/rules/:id` and `POST /api/rules/preview`):

```
Group = { type: "group", op: "and" | "or", not?: boolean, children: Node[] }
Leaf  = { type: "cond", field, op, value, ci?, source? }
Node  = Group | Leaf
```

A group with `not: true` negates its combined result. An empty `and` group matches
everything ("match all"); an empty `or` group matches nothing. `ci` is accepted only on
text leaves and `source` only on `first_seen` leaves; every (field, op) pair has its own
value schema and unknown keys are rejected. `validateAst` bounds the tree before zod
recurses (depth 16, 500 nodes) and reports every problem with a JSON pointer; text
operands are at most 1000 characters and lists at most 500 entries.

### Fields and operators

| Field | Operators | Value |
| --- | --- | --- |
| `account` | `eq`, `in` | account id(s) |
| `source` | `has_any`, `has_all`, `has_only`, `has_none` | subset of `history`, `watch_later`, `liked`, `subscription`, `channel` |
| `type` | `eq`, `in` | `video`, `short`, `livestream`, `premiere` |
| `channel` | `eq`, `in` | channel id(s) (UI autocompletes the id from title/handle) |
| `status` | `eq`, `in` | `public`, `unlisted`, `gone`, `private`, `removed` |
| `duration_s` | `lt`, `lte`, `gt`, `gte`, `between` | number(s) |
| `views` | `lt`, `lte`, `gt`, `gte`, `between` | number(s) |
| `likes` | `lt`, `lte`, `gt`, `gte`, `between` | number(s) |
| `comments` | `lt`, `lte`, `gt`, `gte`, `between` | number(s) |
| `ryd_ratio` | `lt`, `lte`, `gt`, `gte`, `between` | number(s) (labelled "estimated") |
| `max_height` | `lt`, `lte`, `gt`, `gte`, `between` | number(s) |
| `max_fps` | `lt`, `lte`, `gt`, `gte`, `between` | number(s) |
| `has_codec` | `eq`, `in` | `av1`, `vp9`, `h264` |
| `is_hdr` | `eq` | bool |
| `caption_available` | `eq` | bool |
| `has_share_link` | `eq` | bool |
| `downloaded` | `eq` | bool |
| `current_location` | `eq` | location id |
| `title`, `description`, `tags`, `channel_title` | `contains`, `not_contains`, `starts_with`, `ends_with`, `eq` (each with a `ci` case-insensitive flag), `regex`, `not_regex` | string |
| `upload_date`, `first_seen`, `downloaded_at`, `last_seen`, `now` | `age_gt`, `age_lt`, `before`, `after`, `is_null` | duration (ISO-8601 or `{years?, months?, days?, hours?}`) for `age_*`; instant (epoch ms or ISO-8601 datetime with offset) for `before`/`after`; boolean for `is_null` |
| `upload_date` | additionally `before_install_minus` | duration X |

Notes:

- `regex` / `not_regex` carry a safe-regex guard (`shared/src/rules/safeRegex.ts`).
  `shared/` is synchronous, so there is no timeout or worker: a pattern is rejected at
  validation if it is over 200 characters, has a backreference, a nested quantifier, an
  ambiguous alternation under a quantifier, or more than 3 unbounded quantifiers, and
  matching runs against text truncated to 4096 characters. An unsafe pattern never
  matches (`regex` and `not_regex` are both false for it).
- `tags` matches when any tag matches; `not_contains` / `not_regex` hold when no tag
  matches.
- `source` set semantics, over the set `S` of sources a video currently has:
  `has_any` = `S` intersects the list; `has_all` = list is a subset of `S`;
  `has_only` = `S` is non-empty and a subset of the list; `has_none` = `S` does not
  intersect the list. For a video with no sources, `has_only` is false and `has_none`
  is true.
- Time anchors available to conditions (all four): upload/publish date
  (`upload_date`); first seen in a given source, per video, source and account
  (`first_seen`); download completed at (`downloaded_at`); last seen in any source /
  last watched when known (`last_seen`). `now` is the evaluation clock.
- `first_seen(source?)`: the `first_seen` leaf carries an optional single `source`
  (`{ type: "cond", field: "first_seen", source?, op, value }`). With a source it is the
  earliest first-seen among that source's rows; without one it is the earliest across
  all sources. A list is not accepted: the spec's `first_seen(subscription or channel)`
  is encoded as an OR group of two `first_seen` leaves, one per source (see rule 1
  below); for `age_gt` that equals "the earliest of the two is older".
- `age_gt` / `age_lt` compare `now - anchor` against the duration. `age_gt` is inclusive
  (`now >= anchor + d`) and `age_lt` strict (`now < anchor + d`), so the two are exact
  complements and `next_eval_at` can schedule the threshold instant itself. Months and
  years are UTC calendar units (Jan 31 plus one month clamps to the end of February).
  `before` and `after` are strict; `between` is inclusive and needs `[min, max]` with
  min <= max. `is_null` takes a boolean and tests whether the anchor has no value (for
  example a never-downloaded video's `downloaded_at`). Any other leaf over a missing
  anchor, or over a null number, boolean or enum column, is false. `upload_date` falls
  back to `published_at` when unknown.
- `status`: `gone` holds when the privacy is `private`, `removed` or `unavailable`, or a
  recheck set `gone_since`. A gone video's statuses are `gone` plus `private` or
  `removed` when that is its privacy, so an `unavailable` video matches only `gone`;
  otherwise the status is the privacy (`public` or `unlisted`).
- `install_age`: `upload_date before installed_at - X` is expressed as `upload_date`
  `before_install_minus` X (strict), a helper operator so the default guard rule is a
  plain leaf. `installed_at` comes from `kv`.
- The operator sets shown above are what `shared/src/rules/ast.ts` accepts, including
  for `has_codec`, `is_hdr`, `caption_available`, `has_share_link`, `downloaded` and
  `current_location` (bool -> `eq`, enum -> `eq`/`in`, `current_location` -> `eq`).
- Duration shorthand in tables here (`14d`, `2 months`, `2 years`, `7d`) denotes the
  ISO-8601 forms (`P14D`, `P2M`, `P2Y`, `P7D`); stored ASTs use ISO-8601 or the
  `{years?, months?, days?, hours?}` object (at least one key).

### Evaluation

Evaluation is a pure function in `shared/`:

```
evaluateCondition(node, video: VideoFacts, ctx: { now, installed_at }) -> boolean
```

`VideoFacts` is the `videos` row plus its `sources` rows, the current `media` fact
(`downloaded_at`, `location_id`, `vcodec`) and `share_link_count` (active links); the
context carries only the clock and the install time. It is unit-tested exhaustively
(every field, every operator, nested groups, NOT, empty groups, time-anchor edge cases,
regex guard). `domain/ruleEval.ts` loads inputs (building `VideoFacts`) and calls it.
The merge is also pure and lives in `shared/` (`resolveEffective`), as does
`next_eval_at` (`nextFlip.ts`: the soonest instant after `now` at which an `age_*`
threshold, or a `before`/`after` on `now`, flips for the video); `domain/effective.ts`
persists the result in `video_effective`.

The rule list preview (`POST /api/rules/preview`, body `{ condition }`) runs the same
function over the catalog and answers `{ count, total, sample: [{ id, title,
channel_title }] }`.

## Default rule set

Installed at first init from `shared/src/rules/defaults.ts` (`DEFAULT_RULES`, seeded by
`ensureDefaultRules` at boot, see "Data model"); all rules are editable and removable. Effects are stored
parsed, so object effects carry their
field defaults (rule 5's captions gain `enabled: true`, rule 7's notify gains
`channel: push`). Position ascending = priority ascending (the global rule is position
0). `G` is the global rule.

| # | Name | Condition | Effects |
| --- | --- | --- | --- |
| G | Global defaults | - | reclaim_priority -1; location_id null (= first enabled location); media_mode video; format_policy prefer_av1; transcode { mode if_not_av1, codec hevc_nvenc, quality 28, preset p5, audio copy }; captions { all, auto true }; live vod_only; download_accounts sourcing; proxy none; recheck tiered; notify { enabled false, max_times 1, channel push } |
| 1 | Expire: subscriptions after 2 weeks | source has_only [subscription, channel] AND (first_seen(source subscription) age_gt 14d OR first_seen(source channel) age_gt 14d) | reclaim_priority 0 |
| 2 | Expire: watched after 2 months | source has_none [liked, watch_later] AND source has_any [history] AND first_seen(history) age_gt 2 months | reclaim_priority 0 |
| 3 | Expire: liked after 2 years | source has_any [liked] AND source has_none [watch_later] AND first_seen(liked) age_gt 2 years | reclaim_priority 0 |
| 4 | Guard: no subscription backfill older than 7 days before install | source has_only [subscription, channel] AND upload_date before_install_minus 7d | reclaim_priority 0 |
| 5 | Captions: English only | (match all: an empty `and` group) | captions { languages [en], auto true } |
| 6 | Keep unlisted and gone forever | status in [unlisted, gone] | reclaim_priority -1 |
| 7 | Notify when a video goes gone | status eq gone | notify { enabled, max_times 1 } |

Resulting retention: subscription/channel-only -> 2 weeks; watched (not liked, not WL)
-> 2 months; liked (not WL) -> 2 years; Watch Later -> forever; unlisted/gone ->
forever. Watch Later has no expiry rule (the owner declined one). Rule 7's effect sets
nothing else, so the reclaim priority of a gone video comes from rule 6.

Why the conditions use `has_only` / `has_none`: the owner confirmed a 2/2/2 list
(subscribed videos 2 weeks, watched 2 months, liked 2 years). A video can have several
sources at once, and a naive per-source rule ("subscription source older than 2 weeks
-> pri 0") would delete a video that is also liked or in Watch Later. The
`has_only` / `has_none` source-set conditions are what make the 2/2/2 outcome hold for
multi-source videos (a subscribed video you also watched gets the 2-month window, a
watched video you also liked gets the 2-year window, and anything in Watch Later is
never expired). This is a faithful encoding of the owner's confirmed list, NOT a
deviation from it.

Notes on the set:

- The retention anchor for the preset rules is "first seen in that source". Other
  anchors are available for the owner's own rules.
- Retention is emergent, not a rule setting: the global rule sets every video to pri
  -1 and a higher-priority rule sets videos past an age to pri 0. There is no "delete
  after X" setting. The owner can change `0` to `1` in rules 1-4 to make the videos
  reap-eligible instead of immediately deleted.
- Rule 4 is the subscriptions backfill guard. It makes videos whose ONLY sources are
  the subscriptions/channel feed, uploaded more than 7 days before cellar was
  installed (first DB init, `kv.installed_at`), pri 0, which prevents an immediate
  uncapped backfill of the whole subscription history. Pri-0 videos get their
  metadata rechecked only when the request budget is not needed by anything else.
- Rule 5 narrows captions to English only (removable). The global rule keeps all
  languages.
- Rule 6 outranks rules 1-4 (later position wins), so unlisted and gone videos are
  never expired.
- `include` defaults to true through the registry; the global rule cannot set it.
- Pri 0 = delete media now (metadata kept) and never download again while pri 0.

## Ingestion and sources

### Hybrid credentials

Linking an account requires BOTH credentials:

- Google OAuth consent: YouTube Data API v3, scope
  `https://www.googleapis.com/auth/youtube.readonly`. The API drives subscriptions
  (`subscriptions.list mine=true`, with subscribe dates), liked videos
  (`playlistItems.list playlistId=LL`; `snippet.publishedAt` = like time), channel
  uploads (`UU<channelId>` playlists for subscribed and manual channels) and ALL
  metadata rechecks (`videos.list` with
  `part=snippet,contentDetails,statistics,status,liveStreamingDetails,topicDetails`,
  50 ids per call = 1 quota unit).
- A Netscape `cookies.txt` jar. Cookies drive watch history
  (`https://www.youtube.com/feed/history` via yt-dlp `youtube:history`), Watch Later
  (`:ytwatchlater`) and every yt-dlp download.

Rationale: history and Watch Later have no API path (the API returns empty for WL/HL
playlists since 2016); the API gives timestamps and 50x cheaper rechecks. Cellar never
calls `search.list` (100 units).

All accounts share one OAuth client (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in
`.env`, never in the DB); each account has its own refresh token and cookie jar. The
OAuth app must be set to Production in Google Cloud (the unverified-app warning is
fine for personal use): Testing mode expires refresh tokens every 7 days. The OAuth
redirect URI is `https://cellar.maxhogan.dev/api/oauth/google/callback`.

### Sources

`video_sources.source` is one of:

| Source | Origin | `source_ts` |
| --- | --- | --- |
| `history` | yt-dlp history feed (cookies), or Takeout `watch-history.json` | real watch time (Takeout) |
| `watch_later` | yt-dlp `:ytwatchlater` (cookies), or Takeout WL playlist | add time when known |
| `liked` | API `playlistItems.list LL`, or Takeout liked playlist | `snippet.publishedAt` |
| `subscription` | channel uploads of a subscribed channel (`channel_sources.kind = subscription`) | - |
| `channel` | channel uploads of a manually added channel (`channel_sources.kind = manual`) | - |

A manually added channel behaves exactly like the subscriptions source for a channel the
owner is not subscribed to: `channel_sources` rows with `kind = manual`, `account_id`
NULL, `download_accounts` default `any`.

`origin` records how the row arrived: `live_feed` (yt-dlp feeds), `api` (Data API) or
`takeout` (importer). A video can have many source rows; rules see the whole set.

### Ingestion jobs

Every feed is driven by its own scheduler entry (`jobs/ingestBoot.ts`) that ticks every
60 s, re-reads the account (or channel) list and the interval setting from the live
settings, and queues a deduped job for whatever is due (the feed and channel jobs at priority 10,
above the priority-5 rechecks of newly seen videos, so a stream of rechecks can never
starve the jobs that discover videos). A settings change or a newly
linked account therefore applies without a restart; the last queue time per feed and
account persists in `kv` (`ingest_last:*`). Defaults: history and Watch Later every 30
min per account, liked every 30 min, the subscriptions list every 6 h, channel uploads
every 30 min for the newest 50 uploads per channel, and a full catalog walk of manual
channels (leftover budget) every 24 h until caught up. `action:ingest-now` queues every
feed of every account and channel at once, plus the due rechecks.

Payload and class of each job (all `io` unless noted; "row" means the `jobs.account_id`
column, which is what the scheduler's per-account scrape gate looks at):

| Job | Account / payload | What it does |
| --- | --- | --- |
| `ingest_history` | row | yt-dlp `https://www.youtube.com/feed/history --flat-playlist -J --playlist-end <N> --sleep-requests 1 --cookies <tmp>`. N starts at 50 and doubles up to 500 while the newest page still holds an id with no `history` source for this account; it stops at a page of known ids or a feed shorter than asked. Upserts `video_sources(history)`. |
| `ingest_watch_later` | row | yt-dlp `:ytwatchlater` flat (one run, the whole list). An entry that left the list keeps its source row; only `last_seen_at` stops moving (rules may use `last_seen`), and the activity row reports how many are `notInList`. |
| `ingest_liked` | `{ account_id }` | API `playlistItems.list playlistId=LL`, 50 per page, newest first, until a page is all known (at most 200 pages). `source_ts` = `snippet.publishedAt` (the like time). |
| `ingest_subscriptions` | `{ account_id }` | API `subscriptions.list mine=true` (at most 100 pages) -> `channels` and `channel_sources(subscription)` with `subscribed_at`. A channel the API no longer returns keeps its row and is reported in an `ingest.subscriptions_missing` activity row. Newly found channels get an immediate `ingest_channel_uploads`. |
| `ingest_channel_uploads` | `{ channel_id }` | API `playlistItems.list UU...` for every tracked channel (any `channel_sources` row). A polled channel stops at the first upload it already has as a `subscription` or `channel` source and reads at most `ingest.channel_newest_n`. A brand-new channel source (never polled) pages until a whole page is older than `installed_at` minus 7 days (at most 40 pages), still CREATING the metadata-only records of that page so the guard rule marks them pri 0; only uploads newer than the cutoff are queued for an immediate recheck, the rest wait for the leftover-budget due rechecks. |
| `ingest_channel_backfill` (`leftover`) | `{ channel_id }` | The deep walk of a manual channel's whole uploads playlist, resuming from the page token kept in `kv` (`channel_backfill:<id>`), at most 400 pages a run, pausing as soon as the quota gate stops allowing the leftover class. Creates `channel` sources and metadata-only records; no immediate rechecks. |
| `recheck_batch` | `{ video_ids }` (at most 50) or `{ due: true, limit }` | See "Metadata history and rechecks". The API account is NOT in the payload: each 50-id chunk picks one at run time. |
| `recheck_batch_leftover` (`leftover`) | same payloads | The same handler for pri-0 videos. |
| `recheck_all` (`maintenance`) | `{}` | Queues every video in batches of 50 (pri-0 ones as `recheck_batch_leftover`). |
| `takeout_import` | `{ dir, files, account_id }` | See "Google Takeout importer". |

The two cookie feeds carry their account on the job row, so a spent hourly scrape budget
holds them; the API jobs keep it in the payload, so the scrape budget never stalls them.
A job whose account is no longer eligible (cookies invalid, auth lost, paused) is
skipped, not failed.

When an ingest job finishes, also when it stops midway on an error, `finishIngest`
queues a `recheck_batch` (priority 5, joining a queued batch that still has room, so many
small ingests cost one API unit per 50 videos) for the videos it just created, asks for a
debounced targeted evaluation of every video it touched, and writes one `ingest.<feed>`
activity row with the counts (pages, API units, scrape requests). Videos seen in a feed
are created as metadata-only skeletons; a feed only FILLS columns that are still empty
(title, duration, privacy, upload date, and `type = short` for a `/shorts/` URL), it never
overwrites a value, so a feed can never write a spurious history row. Placeholder entries
("[Private video]", "[Deleted video]") become a privacy marker with no title.

Cost accounting: every API call is charged to its account row and the project row before
it is made (see "Quota and budgets"). Every yt-dlp feed run is one scrape request
charged against the account's hourly budget, so a history run that doubles its depth
twice costs three requests; a run refused by an exhausted budget raises `quota_exhausted`.
yt-dlp gets the account's decrypted cookie jar as a 0600 temp file (refreshed jar written
back after each run); its stderr is reduced to one masked error line.

The yt-dlp `:ytsubs` subscriptions video feed MAY be used as an optimisation for noticing
new uploads cheaply; API `UU` polling stays the locked source of truth (provisional, see
"Open technical calls").

### Google Takeout importer

Two halves (`domain/takeout.ts`): the upload route stages and previews, the
`takeout_import` job (class `io`, 2 attempts, deduped on its staging directory) imports.

Export checklist (the same steps the Takeout page shows): Google Takeout -> Deselect all
-> tick "YouTube and YouTube Music" -> "All YouTube data included" -> keep only history,
playlists and subscriptions -> "Multiple formats" -> set history to JSON (the default
HTML cannot be imported; playlists and subscriptions are CSV only) -> export (a `.tgz`
or `.zip`).

**`POST /api/takeout?account_id=<id>`** takes `multipart/form-data` with one or more
files; `account_id` may also be a form field (the query wins, and a query value is
checked against `accounts` before the body is read, so a wrong id costs no upload).
Accepted: `.tgz` / `.tar.gz` and `.zip` archives, or loose `watch-history.json`,
playlist CSVs and `subscriptions.csv` (a `.html` upload is recognised only to explain
itself). Anything else is listed as skipped (`unsupported-file-type`). Limits: at most
500 files, and 2 GB for all files of one request together (`TAKEOUT_MAX_UPLOAD_BYTES`).
Multipart parsing is registered inside this plugin only, so no other route accepts a
multipart body. Files stream to disk under `$DATA_DIR/tmp/takeout-<uuid>/` (directory
0700, files 0600) and are never buffered in memory. Archives are unpacked inside that
directory: a `.zip` is read entry by entry (yauzl) and only wanted entries are written,
under generated names; a `.tgz` is listed and then extracted by the system `tar` into its
own subdirectory, and only regular files whose real path stays inside it are used
(symlinks are skipped). An archive with an absolute or `..` member is refused whole.
There is no decompression-bomb guard: the 2 GB cap is on the compressed upload, the
unpacked size is not limited.

Files are classified by name (`shared/src/takeout.ts`): `watch-history.json` -> `history`;
`subscriptions.csv` -> `subscription`; `Watch later.csv` / `Watch later-videos.csv` ->
`watch_later`; `Liked videos.csv` / `Liked videos-videos.csv` -> `liked`; any other CSV
inside a `playlists` directory (or a bare upload that is not a known non-playlist file)
-> `playlist:<name>`. Each importable file is dry-parsed for the preview.

Answers:

- `202` `{ job_id, files: [{ name, kind, rows, skipped_rows }], skipped: [{ name,
  reason }], skipped_total }` (`skipped` lists at most 200). The job is already queued.
- `400` with a machine-readable `code`: `history_is_html` (the history came as HTML and
  no JSON history is present), `no_takeout_files` (nothing importable), `archive_unreadable`,
  `unsafe_archive`, `no_files` (the upload carried no files); plus the generic `invalid`
  (not multipart, `account_id` missing or not a positive integer). `404` for an unknown
  account. `413` `upload_too_large`. A rejected upload leaves no staging directory behind.

**`GET /api/takeout/:jobId`** answers `{ job_id, status, error, created_at, finished_at,
files: [{ name, kind }], counts }` (404 when the job is not a takeout import). `counts`
is null until the import finished, then the `takeout.imported` activity row's data:
`history` (entries read, a video watched three times counts three), `history_videos`
(distinct), `watch_later`, `liked`, `subscriptions`, `playlists_ignored`,
`playlist_videos_ignored`, `new_videos`, `new_sources`, `skipped` (by reason),
`recheck_jobs` and `duration_ms`. Progress arrives as SSE `job.progress`, and previous
imports are listed by `GET /api/activity?kind=takeout.imported`.

What the import does:

- History entries -> `history` source rows for the chosen account with the real watch
  timestamp; Watch Later and Liked playlists -> their sources with the export's add time
  as `source_ts`; subscriptions -> `channels` and `channel_sources(subscription)` rows
  (`subscribed_at` is NULL: the export carries none). `origin` is `takeout`.
- Only Watch Later and Liked become sources. Every other playlist is counted
  (`playlists_ignored`, `playlist_videos_ignored`) but ignored, because cellar has no
  playlist source.
- Idempotent: `first_seen_at` only ever moves earlier (the earliest watch time wins,
  which also sets a history row's `source_ts`), `last_seen_at` only later, and `origin`
  is left alone on an existing row, so a repeat import creates nothing (`new_sources` is
  0). Rows are written in transactions of 500.
- Unknown videos are created as metadata-only records and queued for a recheck
  (`recheck_batch` jobs of 50 ids), then a targeted evaluation pass (a full pass above
  5000 touched videos) lets the rules decide what happens next.
- The result is logged as one `takeout.imported` Activity row. The staging directory is
  deleted when the import succeeds, when the last attempt fails and when the job is
  cancelled; a shutdown keeps it for the requeue.
- History JSON entries carry `titleUrl` (with the video id) and `time`. Entries that
  yield no row are skipped and counted per reason (`shared/src/takeout.ts`): `ad` (a
  "From Google Ads" entry, checked first because ads carry a real watch URL), `no-url`
  (no `titleUrl`: removed or private videos), `not-a-video` (a post, channel or visit)
  and `malformed-entry`; for CSVs, `invalid-video-id` and `invalid-channel-id`. The
  importer adds `unreadable-file` and `unsafe-path`. Rows are not deduplicated by the
  parsers; idempotency belongs to the importer.

Cloudflare caps one proxied request body at 100 MB on the Free and Pro plans, far below
cellar's own 2 GB cap. A big archive uploaded through the public hostname fails at the
edge, so upload the loose files from inside the archive (history JSON, playlist CSVs,
`subscriptions.csv`) instead, one request each if needed; they are usually far smaller
than the archive.

The parsers are pure (in `shared/`) and unit-tested on synthetic fixtures.

### Video identifier parsing (`shared/`)

A video identifier is any of `http://www.youtube.com/watch?v=ID`,
`http://youtube.com/watch?v=ID`, `https://youtube.com/watch?v=ID`,
`https://www.youtube.com/watch?v=ID`, `youtu.be/ID`, `youtube.com/watch?v=ID`,
`youtu.be/watch?v=ID&t=124&_sp=...`, a bare ID, or any similar form: also `/shorts/ID`,
`/live/ID`, `/embed/ID`, `/v/ID`, `music.youtube.com/watch?v=ID`, `m.youtube.com`. An ID
is 11 characters of `[A-Za-z0-9_-]`. The parser is pure, returns the normalised ID, and
is used by the Inspect page, `GET /api/inspect`, and manual channel/video entry.

## Media pipeline (download, transcode, move, reap, versions)

### Download

The `download` job (class `download`, 5 attempts, deduped per `video_id`; payload
`{ reason?: "version" | "redownload" }`, the job row carries the video and, when one was
chosen at queue time, the account). It is queued by:

- `download_scan` (class `maintenance`, one attempt), every 5 minutes and right after an
  eval pass that changed anything: it queues a download for up to 500 videos per run that
  are `include`d, not priority 0, not gone, not `private` / `removed` / `unavailable`,
  have no current video/audio media and no queued or running download (newest evaluation
  first; the next run takes the rest). This is also how media the reaper deleted comes
  back, as a plain download with the next media version number.
- a recheck that detected a YouTube-side edit (`reason: "version"`, see "Versions").
- `POST /api/videos/:id/download-now` (priority 20; it still goes through the checks
  below, so it does nothing for an excluded or pri-0 video).

Order of checks inside the job: the video exists and has been evaluated; `include`;
reclaim priority is not 0; media is not already present (skipped for a `version` re-download,
and for `captions_only` / `metadata_only` an existing info row counts as present);
`delay_after_upload`; live status; the 429 cooldown; the target location exists, is
enabled and is not paused by the reaper (not needed for `captions_only` / `metadata_only`).
Then an account is chosen (round-robin over the allowed accounts that have cookies, the
cursor in `kv` as `download_rr:*`; with none, the download runs without cookies) and a
proxy per the `proxy` effect. A skip other than "already present" writes a
`download.skipped` activity row.

Deferrals (`delay_after_upload` not yet due, an upcoming video, a live one under
`vod_only` re-polled every 15 minutes, an active 429 cooldown) do not fail the job: the
running row would satisfy `dedupe`, so a FRESH `download` row with a later `run_after` is
inserted (when no other active row exists) and the current one finishes. Each deferral
writes a `download.deferred` activity row.

The yt-dlp argv (`media/ytdlp.ts`, one flag per line of reasoning, URL last after `--`):

- `--no-playlist --no-overwrites --newline --progress --progress-template <marker>
  --print-json --no-simulate --print after_move:cellar-file:%(filepath)s -o
  <workdir>/%(id)s.%(ext)s --write-info-json --write-all-thumbnails`. The work directory
  is `<location>/.tmp/<videoId>/`, or `$DATA_DIR/tmp/meta-dl/<videoId>/` for
  `captions_only` / `metadata_only`.
- `-f <selector>`: `ytdlp.format_override` if the rule set one, else the selector built
  from `format_policy`, `max_height` and `max_fps` (for example `prefer_av1` ->
  `bv*[vcodec^=av01][height<=H]+ba/bv*[height<=H]+ba/b`). A `quality_priority` replaces
  the codec filters with one alternative per ranked (resolution, fps) pair, `primary` as
  the outer key, each split by `aspect_ratio` so a resolution tier is the shorter side of
  the frame in `(next tier down, tier]` and an fps tier is `(next tier down, tier]` (24
  covers anything slower); the caps still apply to every alternative, then
  `bv*<caps>+ba/b` catches the rest. The codec preference becomes `-S vcodec:av01|vp9|h264`
  (none for `best`), so it only breaks ties within a tier and a top tier without AV1 may
  be transcoded. `-S` covers the whole chain, so the catch-all sorts codec before
  resolution. `audio_only` selects
  `bestaudio[ext=webm]/bestaudio`: YouTube always offers an Opus/WebM or m4a audio-only
  stream, so the track is kept as is and `-x` is never used. `captions_only` and
  `metadata_only` use `--skip-download` instead.
- `--write-subs [--write-auto-subs] --sub-langs <list> --sub-format vtt --convert-subs
  vtt` when captions are enabled (never for `metadata_only`); a language list of `all`
  becomes `all,-live_chat`.
- `--cookies <tmp>` and `--proxy <url>` when present; `--sleep-requests <s>` (one value
  drawn per run, uniformly, from the min..max settings or the rule's `ytdlp` overrides),
  `--limit-rate`, `--concurrent-fragments`; `--live-from-start` for `record_live`;
  allowlisted extra args (a rejected one is dropped and logged as `download.args_rejected`).
- The tool flags: `--plugin-dirs <CELLAR_YTDLP_PLUGIN_DIRS>` (the bgutil plugin, default
  `/opt/cellar/yt-dlp-plugins`), `--js-runtimes <tools.js_runtime>` (default `node`) and,
  when a PO-token provider URL is configured, `--extractor-args
  youtubepot-bgutilhttp:base_url=<url>` (the form recorded in the Dockerfile). The
  provider URL is the `tools.pot_provider_url` setting; while it is still the registry
  default, `POT_PROVIDER_URL` from the environment seeds it.

Cookies are passed as a path to a 0600 temp file, never inline, and the refreshed jar is
written back. yt-dlp is spawned with an argv array, never a shell, by a streaming runner
(`media/spawn.ts`) that reports progress as it arrives and kills the process on cancel
(SIGTERM, then SIGKILL after 5 s). The run times out after 6 h (24 h for `record_live`).
The argv is only ever logged through `redactArgv` (the proxy URL loses its credentials,
anything URL-shaped is masked, the cookie PATH stays); `yt-dlp.log` in the job's log
directory gets the same masking, line by line.

On success, in this order: the media file is located (the printed `cellar-file:` path,
the info dict, else a scan) and probed with ffprobe (`kind` is `video` or `audio` from the
streams; a probe failure falls back to yt-dlp's format info) and hashed (sha256); the
info json moves to `/data/meta/<channelId>/<videoId>/info.json`, captions are installed
as `<lang>.vtt` and thumbnails are mapped to their variants and stored (see
"Thumbnails and captions"); the media file is atomically renamed into
`<location>/<channelId>/<videoId>/<videoId>.<ext>` (a `version` re-download first moves
the old current files to `versions/v<N>/`); then one transaction writes the `media` rows
(`version` = the next number, or the existing one for a `redownload`; captions and info
rows carry `location_id` NULL), updates the formats summary columns of `videos`, and the
job records success, publishes `video.media`, queues a `transcode` when the media is video
and `transcode.mode` is not `none`, and queues a `reap` for the location when its usage
reached the high-water mark. A video with no channel id lands in a `_unknown` bucket.

On failure the stderr is classified: `unavailable` (private, removed or unavailable) is
PERMANENT: it sets `videos.privacy`, writes a `download.unavailable` error row and ends the
job without a retry and without counting toward the failure alarm. A rate limit (HTTP 429)
sets the cooldown (`kv.download.cooldown`: 30 minutes, doubled up to 4 hours while the
previous cooldown ended less than 4 hours ago) that defers every download. A `network`
failure through a proxy marks the proxy failed. Everything else (`bot_wall`, `auth`,
`network`, `unknown`, a timeout) is rethrown, so the queue retries it with backoff up to 5
attempts; each non-permanent failure also feeds the consecutive-failure counter, and when
it reaches `notify.consecutive_download_failures` a `canary` job is queued.

`media_mode`: `audio_only` as above; `captions_only` and `metadata_only` skip media
(and need no location).

Livestreams and premieres follow the `live` effect: default `vod_only` (track as
upcoming/live, re-poll every 15 minutes, download when the VOD is published);
`record_live` uses `--live-from-start`.

### Format and codec policy

The NAS GPU is a GTX 1650 SUPER (Turing): NVENC H.264/HEVC and NVDEC, NO AV1 encode.
Decision: download AV1 if YouTube offers it, otherwise transcode to NVENC HEVC (the
owner's devices play HEVC). Software SVT-AV1 is a rule option, not the default. NVENC
and NVDEC are detected at runtime (a 10 frame test encode per encoder, not just the
encoder list) and fall back to CPU; the self-check reports availability; the rule UI
offers `hevc_nvenc` / `h264_nvenc` only when present.

### Transcode

The `transcode` job (class `transcode`, concurrency `transcode.concurrency` = 1 by
default, 2 attempts, 24 h timeout) works on the video's current media. It skips when
`transcode.mode` is `none`, the media is already a transcode (`transcoded_from` is set),
there is no video stream, or (mode `if_not_av1`) the download is already AV1 or already
the target codec family.

- Encoder: `hevc_nvenc` / `h264_nvenc` when the NVENC probe says the encoder opens;
  `av1_nvenc` only on a GPU with AV1 encode (never on the NAS). Otherwise the job falls
  back to software SVT-AV1 at the documented defaults (`-c:v libsvtav1 -preset 8 -crf 35`)
  under `nice -n 19` and writes a `transcode.fallback` warning: a CQ chosen for NVENC
  means something else as an SVT CRF, so the rule's quality and preset apply to SVT-AV1
  only when `av1_svt` was chosen explicitly.
- NVENC argv: `ffmpeg -y -hide_banner -nostats -progress pipe:1 [-hwaccel cuda
  -hwaccel_output_format cuda] -i in -map 0:v:0 -map 0:a? -map_metadata 0 -sn -dn
  [-vf framestep=N,scale_cuda=W:H (scale=W:H without CUDA decode)] -c:v
  hevc_nvenc -preset p5 -rc vbr -cq 28 -b:v 0 [-maxrate/-bufsize from
  max_video_bitrate_kbps] -c:a copy [-tag:v hvc1] [-movflags +faststart] out.<ext>`. The
  hwaccel pair is added only when NVDEC is available, and dropped for a downscaled AV1
  source (Turing NVDEC has no AV1, so frames would reach scale_cuda in system memory). `-rc vbr -cq <q> -b:v 0` is
  deliberate: without `-b:v 0` the encoder keeps its 2 Mb/s default as a ceiling and the
  CQ never applies.
- Container rule (decided, see "Open technical calls" 1): the original audio is kept
  (`audio_codec: copy`, the default); the output is `.mkv` when the OUTPUT audio is Opus
  or Vorbis and `.mp4` (with `-movflags +faststart`, HEVC tagged `hvc1`) otherwise. A rule
  that re-encodes audio to AAC therefore always gets an MP4.
- Verification: ffprobe on the output must show a video stream, an audio stream when the
  source had one, and a duration within 1 s of the source. On success the job swaps the
  current media in place (same `media` row id and version, new `rel_path`, size, hash and
  codecs; `transcoded_from` records the source codec, for example `vp9`) and DELETES the
  original, unless the media changed while ffmpeg ran, in which case the output is
  discarded. A failed verification keeps the original, deletes the output, writes a
  `transcode.verify_failed` warning and is NOT retried; an ffmpeg that exits non-zero fails
  the attempt and is retried once. "Store both copies" applies to YouTube-side edits only
  (see versions below), never to transcodes.

### Move

The `move` job (class `maintenance`, 3 attempts, deduped per video) runs when the
resolved `location_id` differs from where the current media lives. A `move_scan`
schedule (every 10 minutes) queues one for every such video; it only considers enabled
targets. All of the video's video/audio files (current and kept versions) move: each is
copied into the target location's in-flight directory, fsynced, verified (size, and
sha256 against the stored hash), renamed into place under the same relative path, its
`media` row switched, and the source unlinked. Media is MOVED, never re-downloaded, when
the location changes (demote old uploads to cold storage, promote a video that cleared a
view threshold to SSD). A missing or disabled target, or one paused by the reaper, skips
the move with a warning. A failed copy or verification removes the partial file, raises
the filesystem-error notification and fails the attempt.

### Reap

Two jobs free space, both in class `maintenance`.

`pri0_sweep` (payload `{ videoIds? }`, 2 attempts) deletes the media of pri-0 videos right
away: the video/audio files of every version and their `media` rows go; `video_changes`,
captions, thumbnails and info json under `/data/meta` stay, and nothing under `/data` is
ever unlinked. A trashed video is exactly this case. It is queued by an eval pass when a
video became pri 0 (and by every full pass that still finds pri-0 media).

`reap` (payload `{ location_id? }`, one attempt, deduped per location) runs per location
on the hourly `reap_hourly` schedule, after an eval pass (every enabled location after a
full pass, otherwise the locations the changed videos left or entered), after a download
that took a location to the high-water mark, and for `action:reap-now`:

- Pri-0 media still present is swept first (the safety net for the sweep job).
- A location is over when used >= `reaper.high_water_pct` of its quota (quota 0 means
  unlimited, so only the free-space rule applies) or the filesystem has less than
  `reaper.min_free_gb` free.
- While over, whole videos (every version) are deleted lowest `reclaim_priority` first,
  then oldest `downloaded_at`, until usage is at or under `reaper.low_water_pct` AND the
  free space is back above the minimum. Pri -1 (and videos never evaluated) are never
  touched. A file that cannot be removed (other than already missing) keeps its row and
  raises the filesystem-error notification.
- If nothing reclaimable remains and the location is still over, the reaper sets the
  pause flag `kv.location_paused:<id>`: downloads and moves targeting that location are
  skipped, a `location.paused` error row is written once, and a rate-limited
  storage-pressure notification fires. The flag clears (`location.resumed`) when a later
  pass finds the location under its thresholds.
- It refreshes the cached `locations.used_bytes` and `fs_free_bytes`.
- Media deleted by the reaper stays eligible for re-download later (except pri 0), via
  `download_scan`.
- Deleting a video never deletes its metadata, change history, thumbnails or captions;
  only the video/audio tracks.

### Versions (YouTube-side edits)

On recheck, if `duration_s` changes by more than 2 s, or the `content_signature` changes
from a stored value (the first observation never counts), and the video has current
media, cellar queues a `download` with `reason: "version"`. The old current media becomes
`versions/v<N>/` (`is_current = 0`) and stays until reaped as part of the video (same
priority); the new download becomes current under the next version number.

### Thumbnails and captions

Thumbnail variants are the `thumbnails.variants` setting (default all of `maxresdefault`,
`sddefault`, `hqdefault`, `mqdefault`, `default` and `hq720`; at least one). Each is
hashed (sha256) and stored on change only, under
`/data/meta/<channelId>/<videoId>/thumbnails/<variant>-<sha>.<ext>`, with a `thumbnails`
row. Two writers feed it: a recheck fetches the variants from `i.ytimg.com` (as `.jpg`; on
a video's first recheck and whenever the API reports a different URL for a variant), and a
download maps yt-dlp's `--write-all-thumbnails` files back to their variant, keeping the
real extension (YouTube also serves WebP). A hash that returns after another one replaced
it re-bumps that row's `first_seen_at`. Captions are WebVTT files `<lang>.vtt` in the same
meta directory, with `media(kind = captions, lang)` rows. Default languages: all manual
subtitle languages plus auto-generated for the video's language; the default rule narrows
to English.

### Like/dislike ratio

Return YouTube Dislike API lookups (`https://returnyoutubedislikeapi.com/votes?
videoId=`) are ON by default (`recheck.ryd_enabled`) and best effort: at most one request
per second per process, a 5 s timeout, one lookup per video per recheck run, and any
failure (timeout, HTTP error, odd body) simply means "no data", so a recheck never fails
because of it. The derived `ryd_dislikes` / `ryd_ratio` are labelled "estimated" in the
UI.

## Storage layout on disk

ZFS datasets on the NAS: `tank/apps/cellar` mounted at `/mnt/tank/apps/cellar`, with
child datasets `tank/apps/cellar/data` and `tank/apps/cellar/media`. Owned by
`3100:3100`, `chmod 750`.

| Host path | Container path | Contents |
| --- | --- | --- |
| `/mnt/tank/apps/cellar/data` | `/data` | state DB, logs, bin, thumbnails, captions, metadata blobs; NOT quota-counted |
| `/mnt/tank/apps/cellar/media` | `/media` | the first storage location; quota set in cellar's UI (not ZFS) |

Locations are compose bind mounts plus DB rows (container path, label, quota GB,
enabled). Adding a location later = add a mount in the Custom App + register it in the
UI.

Media locations hold ONLY video/audio files:

```
<location>/<channelId>/<videoId>/<videoId>.<ext>
<location>/<channelId>/<videoId>/versions/v<N>/...     # YouTube-side re-edits
<location>/.tmp/<videoId>/                              # in-flight downloads, transcode
                                                        #   output and move copies
```

A video whose channel id is unknown goes under `_unknown` instead of `<channelId>`.

Everything that must survive a media delete and stay out of the quota lives under
`/data`:

```
/data/state/cellar.db (+ -wal, -shm)                    # state DB (dir is 0700)
/data/meta/<channelId>/<videoId>/info.json
/data/meta/<channelId>/<videoId>/<lang>.vtt             # captions
/data/meta/<channelId>/<videoId>/thumbnails/<variant>-<sha>.<ext>   # .jpg, or the real
                                                        #   extension a download kept (.webp)
/data/bin/                                              # yt-dlp, ffmpeg, ffprobe, <tool>.prev,
                                                        #   .staging/ during an update
/data/logs/cellar.log                                   # pino-roll application log
/data/logs/jobs/<jobId>/                                # per-job debug data
/data/tmp/                                              # 0600 cookie temp files (dir is 0700),
                                                        #   takeout-<id>/ upload staging,
                                                        #   meta-dl/ and canary-* work dirs
/data/cache/                                            # XDG_CACHE_HOME (HOME is /data)
```

Stable ids only, no titles in paths. Human-readable names live in the DB/UI and in
download filenames. `captions_only` / `metadata_only` modes therefore need no location.

## Quota and budgets

Two budgets are tracked and enforced, both configurable:

- Google API unit budget: `quota.api_units_per_day`, 10,000 by default (the Cloud project
  default). Usage is tracked in `quota_usage.api_units` per account per UTC day and on
  the project-wide row (`account_id` 0), which the budget is enforced against. Units are
  charged per call, before the call, by Google's table (`videos.list` with 50 ids = 1
  unit; `playlistItems.list`, `subscriptions.list` and `channels.list` are 1 unit per
  call). A spent budget raises `quota_exhausted` (HTTP 429).
- A self-imposed per-account scrape budget (requests/hour: `accounts.
  scrape_budget_per_hour`, else `quota.scrape_requests_per_hour`, default 120), tracked
  in `quota_usage.scrape_requests` on hour rows (`day` = `YYYY-MM-DDTHH`). It is charged
  once per yt-dlp feed run (a history run that doubles its depth is several requests),
  refused with `quota_exhausted` once spent, and it also holds the account's queued `io`
  and `download` jobs in the scheduler until the next hour. Separately, downloads keep a
  minimum gap per account (`download.account_gap_seconds`, 30 s, between one download
  ending and the next starting) and `--sleep-requests` 1-3 s inside a run.

Budget classes: live work (live feeds, rechecks of non-zero-priority videos,
downloads) draws from the main budget. The `leftover` class (pri-0 rechecks, deep
backfill of a manual channel's catalog, other low-value work) consumes only what the
main class leaves unused: the quota gate lets a `leftover` job start only while the
project's API units used today are under 80% of the daily budget, and the deep backfill
re-checks the gate between pages. So backfill can never starve live feeds, rechecks or
downloads of API units.

The gate and the per-account holds are hooks the scheduler calls before starting a job
(see "Jobs and scheduler"). A jar that fails validation is skipped for downloads and
flagged on the Accounts page.

## Metadata history and rechecks

### One history store

Field-level diffs only. `video_changes` rows (`video_id`, `field`, `old_json`,
`new_json`, `seen_at`, `recheck_id`) are written when a tracked field differs from the
stored value. The tracked fields are `title`, `description`, `duration_s`, `privacy`,
`views`, `likes`, `comments`, `ryd_dislikes`, `tags_json`, `category_id`, `live_status`,
`type`, `upload_date` and `content_signature`. The first observation of a field (the
stored value is NULL) just fills it and writes no row, except for the four counters,
whose first value is always a row. This is the ONE history store: counters (views,
likes, comments, RYD dislikes) are tracked fields too, so their diff rows ARE the time
series. Formats and thumbnails are kept in their own places (`videos.formats_json`, the
`thumbnails` table, where every distinct hash is saved to disk).

`video_stats` is a derived chart index and is kept (migration 003 creates it). When a
counter changes, one point carrying all four counters is upserted at the observation
time; `GET /api/videos/:id/stats` serves those points, and rebuilds them from the diff
rows when a video has none stored. It is never a second source of truth (decided; see
"Open technical calls").

### Recheck cadence

Tiered by video age, configurable globally and per rule (`recheck_interval`): daily for
videos under 30 days old, weekly for under 1 year, monthly older. `videos.recheck_tier`
(`daily` | `weekly` | `monthly` | `custom` for a rule's fixed interval) and
`next_recheck_at` carry the schedule. A `recheck:due` schedule (every 5 minutes) queues a
`recheck_batch` of up to 200 due videos, and a `recheck_batch_leftover` for the pri-0
ones, which therefore recheck only on leftover budget. Only evaluated videos qualify
(a fresh backfill record waits until the rules say whether it is pri 0), never-rechecked
ones first. "Refresh and recheck all" (`action:refresh-all`) rechecks every video.

### `recheck_batch`

- Payload `{ video_ids }` (at most 50) or `{ due: true, limit }`; there is no account in
  it. Each 50-id chunk makes one `videos.list` call (1 unit,
  `part=snippet,contentDetails,statistics,status,liveStreamingDetails,topicDetails`) with
  an account picked at run time: round-robin over the accounts with API access, preferring
  those that source any id in the chunk (`no_account` when none has API access).
- An id missing from the response is a recheck failure for that id:
  `consecutive_recheck_failures++`, and its next recheck is 12 h later instead of its
  usual cadence. A SECOND consecutive miss, with other videos of the same call coming
  back, marks the video gone (`gone_since` set; `privacy` becomes `removed`, or stays
  `private`). A video the API returns resets the counter; one the API reports as
  `private` is gone too. The API's own privacy status (public, unlisted, private)
  distinguishes the cases it can; `removed` is what a vanished id is recorded as, and a
  download failure can later record `unavailable`.
- Any API error for the WHOLE call is an outage signal, not a per-video failure: so is a
  successful call that returns none of two or more requested ids. No per-video counters
  are touched, one rate-limited "recheck pass failed" notification is raised, and the job
  fails so the queue retries it with backoff. A spent quota budget (`quota_exhausted`) is a
  budget, not an outage; an authorization failure raises `account_auth_lost` for that
  account.
- Returned videos are diffed in (`video_changes`, `video_stats`); an RYD lookup is made
  (once per video per run); thumbnail variants are fetched and hashed on a video's first
  recheck and when the API names a different URL; a detected YouTube-side edit queues a
  version re-download (see "Versions (YouTube-side edits)"). Everything processed before
  an error is kept, and a targeted evaluation pass is scheduled for it.
- The video `type` is decided here: with `liveStreamingDetails` a stored `livestream` or
  `premiere` is kept, else `premiere` for an upcoming/live video with a known duration and
  `livestream` otherwise. Without live details it is `short` ONLY when the duration is at
  most 180 s AND yt-dlp says so (the downloaded `info.json` has `media_type: short` or a
  `/shorts/` URL; the history and Watch Later feeds fill `short` the same way from a
  `/shorts/` link while the type is still empty), or when yt-dlp has not said and the
  stored type is already `short`. Everything else is `video`.
- A pass that fails everything is an outage: no per-video notifications, one "recheck
  pass failed" error notification (rate-limited to once per 6 h).

### Gone notification

Cellar notifies when a video fails 2 consecutive rechecks AND at least one other video
succeeded in the same window (this guards against API-outage false positives). The
default rule 7 ("Notify when a video goes gone") produces the notification through the
`notify` effect.

## Jobs and scheduler

One `Scheduler` (amber shape), `server/src/jobs/scheduler.ts`:

- A persistent `jobs` table plus an in-memory min-heap. On boot the scheduler reloads
  queued/running jobs; jobs that were running are requeued. Natural dedupe: one video =
  one `download` job.
- Worker pools per class: `io` (API calls and feeds, 4), `download`
  (`download.concurrency`, default 2), `transcode` (`transcode.concurrency`, default 1),
  `maintenance` (1) and `leftover` (pri-0 rechecks and deep backfill, 1; it runs only
  while the quota gate says the main classes left budget unused). A job type is a string
  registered with a handler (`registerHandler(type, { class, handler, maxAttempts?,
  dedupeKey? })`, `maxAttempts` default 3); a queued row whose type has no handler is
  never claimed. Without a `dedupeKey`, `enqueue({ dedupe: true })` dedupes on type plus
  video id, or type plus account id when there is no video. Higher `priority` runs first.
- Per-account holds (a download gap per account, and the scrape budget for `io` and
  `download` jobs), the quota gate (budget classes), a circuit breaker per class (5
  consecutive failures open it for 5 minutes, then one half-open probe), and exponential
  backoff persisted in `run_after`: `attempts^2 * 30 s`, capped at 1 h, plus up to 10%
  jitter. A job past `max_attempts` becomes `failed`.
- SSE events on the `/api/events` bus: `job.queued`, `job.started`, `job.progress`,
  `job.done`, `job.failed` and `job.cancelled` (see "Conventions"). Graceful SIGTERM:
  stop claiming, give running jobs 20 s, then abort them; interrupted jobs are requeued.
- The scheduler ticks every 5 s (a fixed constant). Periodic work is registered with
  `scheduler.every(name, ms, fn)` in an in-memory min-heap whose last-run times persist in
  `kv` (`schedule_last:*`), so a restart resumes the cadence. The entries on main:

| Schedule | Interval | Does |
| --- | --- | --- |
| `ingest:history`, `ingest:watch_later`, `ingest:liked`, `ingest:subscriptions`, `ingest:channel_uploads`, `ingest:channel_backfill` | 60 s ticks | Read the interval setting and the account/channel list live and queue the jobs that are due ("Ingestion jobs") |
| `recheck:due` | 5 min | Queue due rechecks (`recheck_batch`, `recheck_batch_leftover`) |
| `eval_pass_hourly` | `eval.interval_minutes` (60 min, read once at boot) | Full `eval_pass` |
| `eval_pass_due` | 60 s | Queue a due-only `eval_pass` when a video's `next_eval_at` has passed or it was never evaluated |
| `reap_hourly` | 1 h | `reap` for every enabled location |
| `download_scan` | 5 min | Queue downloads for videos the rules keep that are not on disk |
| `move_scan` | 10 min | Queue `move` for videos whose resolved location changed |
| `logs_retention` | 24 h | `logs_retention` job |
| `stats_rollup` | 24 h | Queue `stats_rollup` with `run_after` = the next 00:10 UTC |

The self-check (at boot and every `selfcheck.interval_hours`) and the tool update check
(daily, the first run 5 minutes after boot) run on their own unref'ed timers rather than
as jobs.

`stats_rollup` fills `stats_daily` for the Charts page. `every()` is interval based, not
wall-clock based, so the daily entry enqueues the job with `run_after` set to the next
00:10 UTC and the rollup lands just after midnight whatever time the process booted; a
boot with no all-locations row for today also queues one run at once (`trigger:
"boot"`). Each run rolls up today and recomputes the two days before it. Every column
except `bytes_used` can be rebuilt for any past day from timestamps the catalog keeps; the
reaper deletes the media rows it frees, so a past day's `bytes_used` is a snapshot: the
daily run (when it lands within 6 hours after midnight) finalises yesterday's figure from
the live storage figure, today's row always takes the live one, and a backfill keeps an
existing snapshot and only reconstructs a missing one from the files still on disk.

Job types on main, with class, attempts and payload (the job row also carries `video_id`
and `account_id` where it has one):

| Job | Class | Attempts | Payload |
| --- | --- | --- | --- |
| `ingest_history`, `ingest_watch_later` | io | 2 | account on the row |
| `ingest_liked`, `ingest_subscriptions` | io | 2 | `{ account_id }` |
| `ingest_channel_uploads` | io | 2 | `{ channel_id }` |
| `ingest_channel_backfill` | leftover | 2 | `{ channel_id }` |
| `recheck_batch` | io | 3 | `{ video_ids }` or `{ due, limit }` |
| `recheck_batch_leftover` | leftover | 3 | same |
| `recheck_all` | maintenance | 1 | `{}` |
| `takeout_import` | io | 2 | `{ dir, files, account_id }` |
| `download` | download | 5 | `{ reason? }`, video on the row |
| `transcode` | transcode | 2 | video on the row |
| `move` | maintenance | 3 | video on the row |
| `reap` | maintenance | 1 | `{ location_id? }` |
| `canary` | maintenance | 1 | `{ reason? }` |
| `download_scan` | maintenance | 1 | `{}` |
| `eval_pass` | maintenance | 2 | `{ reason, videoIds?, dueOnly?, firstTriggerAt? }` |
| `pri0_sweep` | maintenance | 2 | `{ videoIds? }` |
| `logs_retention` | maintenance | 1 | `{}` |
| `stats_rollup` | maintenance | 2 | `{ trigger: "daily" \| "boot" }` (deduped per trigger) |
| `action:refresh-all`, `action:eval-now`, `action:reap-now`, `action:ingest-now` | maintenance | 1 | none |

`eval_pass` dedupes on `full`, `due` or the sorted id list. A targeted pass triggered by
an edit, an ingest or a recheck is debounced: it runs 5 s after the last trigger and no
later than 60 s after the first, further triggers merge into the queued pass, and one that
grows past 5000 ids becomes a full pass. A pass that changed anything queues
`download_scan`, a `pri0_sweep` when videos became pri 0 and `reap` jobs for the locations
involved.

Manual actions: `POST /api/actions/:name` for `refresh-all` (a `recheck_all`, then a full
pass), `eval-now`, `reap-now`, `ingest-now`, `selfcheck` or `tools-update` enqueues a
deduped `action:<name>` job (priority 10) and answers 202 `{ job_id }`. It answers 404 for
an unknown name and 501 `not_implemented` while no handler is registered for that action;
on main `selfcheck` and `tools-update` have no handler (use `POST /api/checks/run` and
`POST /api/tools/update`). Also per-video download-now and recheck, and job cancel/retry
from the Activity page (`POST /api/jobs/:id/cancel` and `/retry`; a cancel is a status
change plus a `job.cancelled` event, and the scheduler aborts the worker when it sees
either).

## Notifications and error policy

### Delivery

Web Push / VAPID from the cellar UI (the mkvid / tracked / cameld pattern): the browser
subscribes (`POST /api/notifications/subscribe` with its `PushSubscription.toJSON()`;
`DELETE /api/notifications/subscribe` with `{ endpoint }` unsubscribes;
`GET /api/notifications/vapid-public-key` serves `{ key }`). VAPID keys are generated at
first boot and stored in `kv`; the VAPID subject is `mailto:` plus the first allowed
Access email. Only https endpoints on a known browser push service (FCM, Mozilla,
Apple, Windows) are accepted, because the server POSTs to them. Every sent notification
is also written to `notifications` and shown in an in-app inbox with acknowledge
(`POST /api/notifications/:id/ack`; `POST /api/notifications/ack-all` answers
`{ acked }`; `acked_at`). `pushed_at` records push delivery. `POST
/api/notifications/test` sends a forced test notification and answers `{ sent: true,
id, pushed }`, or `{ sent: false, reason: "rate_limited" }`. Subscriptions live in
`push_subscriptions`.

### Thresholds (all configurable global settings)

| Trigger | Rule |
| --- | --- |
| Download failures | `notify.consecutive_download_failures` (3) consecutive download failures across distinct videos (a success resets the count; permanent "video unavailable" failures do not count); reaching it also queues a canary |
| YouTube broken | the canary download failed while `https://youtube.com/favicon.ico` fetches fine (`youtube_broken`) |
| Account auth loss | the first confirmed 401 / invalid cookie for an account |
| Storage pressure | storage nearly full and unable to clear: once per 6 h |
| FS errors | immediately |
| Recheck outage | one "recheck pass failed" error notification, at most once per 6 h |
| Video gone | 2 consecutive recheck failures AND at least one other video succeeded in the same window |
| Proxy failing | after 3 consecutive failures of a proxy (it is skipped for 10 min) |
| Rule `notify` | up to N times (or unlimited) per video while the video meets the rule |

Every notification type is rate-limited to 1 per `notify.rate_limit_hours` (6 h,
`notification_state.last_sent_at`) unless the previous one has been acknowledged; a
rate-limited call is suppressed entirely (no inbox row, no push). Types today:
`download_failures`, `youtube_broken` (a failed canary with the network up),
`proxy_failing` (rate key per proxy), `storage_pressure` (`notify.storage_pressure_hours`),
`fs_error` (forced, never limited), `account_auth_lost` (rate key per account),
`recheck_outage` (`notify.outage_hours`), `selfcheck_failed` (any failed self-check run),
`rule_notify` (a rule's `notify` effect; forced, limited by its own `max_times`) and
`test` (forced).

### Canary

The known-good canary is `https://www.youtube.com/watch?v=dQw4w9WgXcQ`. The `canary` job
(class `maintenance`, one attempt, deduped) downloads it with `-f worst` into a temp
directory under `/data/tmp`, WITHOUT cookies or a proxy and without sidecars, discards it
(10 minute timeout), and fetches `https://youtube.com/favicon.ico` alongside (15 s). It
runs at most `canary.max_per_hour` times (1) in a rolling hour (run times in
`kv.canary_last`); a request beyond the budget is dropped, not delayed. It is queued when
the consecutive-download-failure threshold is reached. It distinguishes "this video
failed" from "yt-dlp / YouTube is broken" from "the network is down":

- canary ok -> the failures are video specific; an activity row only.
- canary fails while the favicon fetch works -> the error notification `youtube_broken`
  (plus an error activity row).
- canary and favicon both fail -> the network looks down; an activity row only.

### Gone vs outage

A recheck pass that fails everything is an outage and never produces per-video "gone"
notifications. Private vs removed vs region-blocked is distinguished when the API says
so, and the notification text says which.

## Logging and debug data

- Application log: pino NDJSON to stdout plus pino-roll `/data/logs/cellar.log` (amber
  settings: 20m x 5). Redaction covers the `authorization`, `cookie` and
  `cf-access-jwt-assertion` request headers, `set-cookie` response headers, and the keys
  `authorization`, `cookie` / `cookies`, `refresh_token`, `access_token`,
  `client_secret`, `password`, `secret`, `proxy` and `proxy_url` (and their camelCase
  forms) at the top level and one object down.
- Per-job log files under `/data/logs/jobs/<jobId>/`: the job's own `job.log`, the
  download pipeline's `yt-dlp.log` (argv, output and exit code, credentials masked) and
  `ffmpeg.log`. Gzipped raw API response bodies are in the spec; nothing writes them on
  main yet, though the log route would serve them. Retained
  `logs.job_retention_days` (14) or a `logs.job_retention_gb` (2) cap; failed jobs are
  kept `logs.failed_job_retention_days` (60); queued and running jobs' logs are never
  pruned. Viewable in the Activity UI: `GET /api/jobs/:id/log` lists the files
  (`{ files: [{ name, size }] }`) and `GET /api/jobs/:id/log/:name` serves one as
  `text/plain` (a `.gz` file is served decompressed; the name is a single path segment
  of `[A-Za-z0-9._-]`).
- The `activity` table records the high-level events the Activity page lists; `jobs`
  rows carry `log_dir`.

## Accounts, cookies, proxies and tools

### Download defaults

Global settings, rule-overridable where the effects registry says so: 2 concurrent
downloads, 1 concurrent transcode, no speed cap, 30 s minimum gap per account,
`--sleep-requests` 1-3 s.

### Download account selection

The `download_accounts` effect: default `sourcing` = the account(s) that sourced the
video, round-robin across them; an explicit list or `any` is allowed. The per-account
gap and budget still apply. A jar that fails validation is skipped and flagged.

### Cookies

Cookies are pasted or uploaded as Netscape `cookies.txt` in the UI. They are encrypted
at rest (AES-256-GCM, `CELLAR_SECRET_KEY`), decrypted to a 0600 temp file under
`/data/tmp/` per yt-dlp invocation (deleted in `finally`), and the REFRESHED jar is
written back after each run, because yt-dlp rotates YouTube cookies. On upload the jar
is validated by running the history feed with `--flat-playlist --playlist-end 1`.
`POST /api/accounts/:id/cookies` takes `{ cookies }` (at most 1 MiB, Netscape format)
and answers `{ account, validation }`.

### Proxies

A global pool of named entries (URL stored encrypted as one blob, enable flag). Rules
pick `none`, `pool` round-robin, or specific entries; the round-robin cursor lives in
`kv` (`proxy_rr:*`), so the rotation survives restarts, and a proxy inside its skip
window is passed over. Proxies are applied to yt-dlp `--proxy` and are health-checked by
the self-check; routing API calls through them is a spec option that is not implemented
yet. `POST /api/proxies/:id/test` fetches `https://youtube.com/favicon.ico` through the
proxy (10 s budget; http, https, socks5 and socks5h) and answers `{ ok, latency_ms,
error? }`, where `error` is a short category (`timeout`, `http_<status>`, a connect
error code, `unsupported_scheme`) and never a raw message. The outcome feeds the failure
counter. A failing proxy is skipped for 10 min after 3 consecutive failures (constants
in `domain/proxies.ts`); a notification fires after those 3 failures.

### PO-token sidecar

`brainicism/bgutil-ytdlp-pot-provider` runs as a sidecar on the app's internal network
(no published ports). The yt-dlp side is the bgutil plugin, installed in the image at
`/opt/cellar/yt-dlp-plugins/bgutil-ytdlp-pot-provider` (a release zip whose root is the
`yt_dlp_plugins/` namespace folder; the release ships no checksum, so the download is
TLS-trusted only). yt-dlp only searches a plugin folder next to its own executable and
the server runs it from `/data/bin`, so the runner passes `--plugin-dirs` explicitly
(see "Tool updates"). The provider URL is the `tools.pot_provider_url` setting,
defaulting to the sidecar (`http://bgutil:4416`, seeded from `POT_PROVIDER_URL`; empty
disables it), and is handed to yt-dlp as the extractor arg
`youtubepot-bgutilhttp:base_url=<url>`. The plugin and the sidecar are a matched pair:
both track `latest`, so rebuilding one without the other can drift. The self-check
verifies the sidecar. The recommended combination against the YouTube bot wall is
cookies + PO token + a JS runtime.

### Tool updates

Official binaries live in `/data/bin`:

- The image installs yt-dlp (`yt-dlp_linux`, sha256-verified against `SHA2-256SUMS`) and
  BtbN static ffmpeg/ffprobe (with libsvtav1 and NVENC, sha256-verified against
  `checksums.sha256`) under `/opt/cellar/bin` (`BASELINE_BIN_DIR`), and the bgutil
  plugin under `/opt/cellar/yt-dlp-plugins`. At boot the server copies the three
  binaries into `/data/bin` when absent; a copy already there is never overwritten, so
  an update survives a restart.
- Command resolution (`toolCommand` in `server/src/config.ts`), in order: the
  `CELLAR_TOOL_YT_DLP` / `CELLAR_TOOL_FFMPEG` / `CELLAR_TOOL_FFPROBE` override (a JSON
  argv array, a test seam), then `$DATA_DIR/bin/<tool>` when it exists at call time,
  then the bare name from `PATH`. The image's `PATH` starts with `/data/bin`, then
  `/opt/cellar/bin`. The boot version probes resolve the same way, so `/api/status` and
  `/api/tools` report the build that actually answers (yt-dlp's probe gets 60 s: the
  onefile build unpacks itself first); `baseline` is always the image's copy, null when
  the image has none.
- A daily check (the first run 5 minutes after boot; `POST /api/tools/update` triggers
  it on demand with `{ tool?, force? }`) looks for newer releases: yt-dlp from GitHub
  releases (sha256 verified), ffmpeg/ffprobe from the BtbN builds (one archive carries
  both). The ffmpeg release is `releases/tags/<tools.ffmpeg_release_tag>`: for a dated
  `autobuild-*` tag the single `ffmpeg-N-*-linux64-gpl.tar.xz` asset, for `latest` the
  `ffmpeg-master-latest-linux64-gpl.tar.xz` asset, both verified against the release's
  `checksums.sha256`. The default pins the build the image ships, because later builds
  link NVENC API 13.1 and fail to open an encoder on drivers older than 610; `latest` is
  an explicit opt-in. A build is identified by its archive's `updated_at`, and the
  image's baseline carries no recorded one, so the FIRST update check downloads the
  pinned ffmpeg once (checksum-verified) even though it is the same release; afterwards
  checks report `up_to_date` until the tag or the asset changes. With
  `tools.auto_update` on, a newer build is downloaded to
  `/data/bin/.staging`, checksum-verified, version-probed from staging, and swapped in
  atomically: the live binary is hard linked to `<tool>.prev` and the staged file is
  renamed over the live path. With it off, the check only records what is available.
  NVENC guard: when the live ffmpeg passes the NVENC test encode (a 10 frame `lavfi`
  encode per `hevc_nvenc` / `h264_nvenc`), every encoder that works now must also work
  with the staged build; otherwise nothing is swapped, `last_error` reads "staged ffmpeg
  cannot use NVENC on this driver; kept the current build", the outcome is `blocked`, and
  that build is not downloaded again until an update is forced.
  `POST /api/tools/rollback` with `{ tool }` swaps `.prev` back (412 when there is no
  `.prev`); after a rollback, the release rolled away from is not reinstalled until
  forced. `GET /api/tools` reports per tool `current`, `previous`, `baseline`, `latest`,
  `checked_at`, `updated_at`, `update_available`, `last_error` and `rolled_back_from`
  (ffmpeg also `asset_updated_at`, the build identity), plus `js_runtime`, `pot_provider_url`, `auto_update` and `ffmpeg_release_tag`; the
  self-check and the About page show them. `POST /api/tools/update` adds `outcomes`, one
  per tool: `updated`, `up_to_date`, `available`, `skipped`, `blocked` or `failed`.
- Node (already in the image) is the JS runtime for yt-dlp's challenge solving. There
  are two runners. The buffered one (`media/exec.ts`: feeds, cookie validation, the
  self-check) adds `--plugin-dirs <CELLAR_YTDLP_PLUGIN_DIRS>` (default
  `/opt/cellar/yt-dlp-plugins`; empty disables) and `--js-runtimes <tools.js_runtime>`
  (default `node`), the latter only when the installed yt-dlp's `--help` mentions
  `--js-runtimes` (probed once per resolved command), and before each yt-dlp run it
  removes orphaned `_MEI*` directories (see "Deployment"). Feed runs do not pass the
  PO-token provider URL. The streaming runner (`media/spawn.ts`: downloads and the
  canary) takes its flags from the argv `media/ytdlp.ts` builds, which always includes the
  plugin dir and the JS runtime and adds the PO-token extractor arg; it does not prune.
  Both inherit the environment, hence `TMPDIR=/run/ytdlp`, and both run the tool as an
  argv array, never a shell.

### OAuth

OAuth client id/secret live in `.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`);
changing them needs `midclt call app.redeploy cellar`. `GET /api/oauth/google/start?
account=<id>` answers a 302 to Google's consent screen (authorization code + PKCE S256;
scopes `openid email youtube.readonly`; a single-use `state` kept in `kv` for 10
minutes) and `GET /api/oauth/google/callback` completes it, storing the refresh token
encrypted in `account_secrets`. The callback never answers with an error body: every
outcome is a 302 back to the SPA, to `/accounts?linked=<accountId>` on success or
`/accounts?error=<code>` on failure, where the code is one of a closed set (`state`,
`denied`, `google_error`, `missing_code`, `not_configured`, `secret_key`,
`account_missing`, `token_exchange`, `no_refresh_token`, `scope`, `id_token`,
`already_linked`).

## Share links and the public surface

### Tokens and links

- Token = 16 random bytes, base64url (22 characters), stored in PLAINTEXT in
  `share_links.token` (the owner chose no client-side security theatre). URL:
  `/s/<token>`.
- Per link: optional expiry datetime (`expires_at`, NULL = never), `revoked_at`,
  `access_count`, `last_access_at`. Many links per video are allowed, each with its own
  expiry; links are revocable at any time.
- Downloads are ALWAYS allowed on a share page (video, audio, captions, metadata JSON);
  there is no per-link download toggle.
- Revoked, expired and unknown tokens return the IDENTICAL 404 page and headers: a
  revoked link leaks nothing. Tokens are not enumerable and there is no directory
  listing.

### Public surface

The public API surface is exactly `/s/<token>` and `/s/<token>/...`, plus the bundle's
static assets under `/s/assets/` and two static legal pages. Everything else under `/s`
(including `/s` itself, `/s/`, any unknown path, any non-GET method, and any 4xx the
static handler would produce, such as a directory or traversal attempt) returns the same
404 HTML (the share bundle's `share.html`, `Cache-Control: no-store`) with
`X-Robots-Tag: noindex, nofollow`. The exceptions are `GET /s/privacy` and
`GET /s/tos`: static pages that the Google OAuth consent screen links to, and the only
`/s` paths that answer 200 without a token. They carry no data (the text says this is
single-tenant software run by its owner) and are cacheable for an hour.

| Route | Purpose |
| --- | --- |
| `GET /s/:token` | HTML share page: the public bundle's `share.html` with the link's payload injected as `<script id="share-data" type="application/json">` |
| `GET /s/:token/meta` | the same payload (`SharePublicData`) as JSON, `no-store` |
| `GET`/`HEAD /s/:token/video` | the current video file (Range supported; `?download=1` adds `Content-Disposition: attachment`) |
| `GET`/`HEAD /s/:token/audio` | the current audio file, same behaviour |
| `GET`/`HEAD /s/:token/captions/:lang` | WebVTT captions (`:lang` must be 1-32 of `A-Za-z0-9_-`) |
| `GET`/`HEAD /s/:token/thumbnail` | the best stored thumbnail, `image/jpeg` |
| `GET /s/:token/metadata.json` | downloadable metadata (`?download=1` names it `<title> [<id>].info.json`) |
| `GET /s/assets/*` | static assets of the share bundle (only files named `share-*`; admin chunks 404 here) |
| `GET /s/privacy` | static privacy policy (200, no token) |
| `GET /s/tos` | static terms of service (200, no token) |

Rules for the public surface:

- A token is valid iff it is 22 base64url characters, exists, is not revoked and has not
  expired. EVERY other case answers the same 404 page with the same headers: a malformed,
  unknown, expired or revoked token, a valid token's missing file, an unknown sub-path, a
  bad caption language, a missing asset, and the same under HEAD and under any other
  method (a POST to `/s/<token>` included). The `/s` error handler turns every 4xx except
  the rate limit's 429 into that page, so no response distinguishes a link's state.
- Rate limited per IP with `@fastify/rate-limit` (in memory, 120 requests per minute),
  keyed on `CF-Connecting-IP` (set by the Cloudflare edge; the container has no
  published port, so only cloudflared reaches it) with the request IP as the fallback.
  Over the limit answers 429 `rate_limited`. Responses carry
  `X-Robots-Tag: noindex, nofollow`, and the HTML carries `<meta name="robots"
  content="noindex">`.
- Token routes log at `warn` and above only, so a live link (a bearer secret in the URL)
  never enters the request log. Media is served `Cache-Control: private, no-cache`, so a
  revoked link stops serving at once; pages and JSON are `no-store`; files carry
  `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
- Every successful share view increments `access_count` and sets `last_access_at`, but
  ONLY a `GET` of `/s/:token` (the HTML page) counts: not `HEAD`, not `/meta`, not the
  media routes, not assets, and never a request that got the 404.
- The public bundle is a second Vite entry: `web/share.html` -> `web/src/share.ts`,
  built into the same `web/dist` with its assets served at `/s/assets/`. It contains
  the player with captions and speed control, metadata, and download buttons for
  video / audio / captions / metadata JSON. It has no access to anything beyond
  `/s/:token/*`; it cannot read or change any setting.
- The admin SPA and all of `/api/*` stay fully behind Access.
- Access control happens at the edge too: a second Cloudflare Access application scoped
  to `cellar.maxhogan.dev/s` carries a Bypass Everyone policy; the app's own public
  prefixes are `/healthz` and `/s` (see "Security model").
- The payload (`SharePublicData` in `shared/src/apiTypes.ts`, injected as `share-data`
  and served at `/meta`) is built from explicit field lists and names nothing outside
  this one video: `{ token, video: { id, title, channel_title, upload_date, duration_s,
  description (at most 2000 characters), views, likes }, media: { kind, mime,
  size_bytes, height, has_audio_only } | null, captions: [{ lang, label }], thumbnail:
  boolean, downloads: { video?, audio?, captions: { <lang>: url }, metadata } }`. The
  player plays the current video file, else the current audio file. No settings,
  accounts, sources, rules, locations or file paths are in it.
- `metadata.json` serves the stored info.json reduced to an allowlist of top-level keys
  (`PUBLIC_INFO_KEYS` in `domain/shares.ts`: id, title, description, channel and
  uploader fields, dates, counters, categories, tags, chapters, thumbnails, codecs and
  size fields; not container paths such as `_filename` and `filepath`, request headers,
  signed format URLs that embed the server's address, or playlist fields that name the
  owner's lists), else an explicit subset of the catalog row (an info.json over 32 MB
  also falls back). Both carry `share: true`.

### Admin side

All behind Access, under `/api/shares` (shapes pinned in `shared/src/apiTypes.ts`):

- `GET /api/shares`: paged (`page`, `perPage` of 25, 50 or 100), with `q` (substring of
  the video title or the token), `status` (`active` | `expired` | `revoked`), `video_id`,
  `sort` (`created_at` | `expires_at` | `access_count` | `last_access_at`) and `dir`. A
  row is `{ token, video_id, title, channel_title, expires_at, revoked_at,
  access_count, last_access_at, created_at, url, status }`; `url` is `PUBLIC_ORIGIN/s/<token>`
  and `status` is computed (revoked wins over expired).
- `POST /api/shares` `{ video_id, expires_at? }` answers 201 with the row. The video must
  be in the catalog (404) and an expiry must be in the future (400); no expiry means
  never. Many links per video are fine.
- `GET /api/shares/:token`: one link (404 unknown).
- `POST /api/shares/:token/revoke` (no body): idempotent, an already revoked link keeps
  its original `revoked_at`; answers the row.
- `POST /api/shares/revoke`: bulk revoke with `{ tokens: [...] }` (1 to 10,000) or
  `{ all_matching: <the list filters> }` (select-all revoke; paging and sort fields are
  ignored); answers `{ count }`, the links newly revoked.
- `DELETE /api/shares/:token`: hard delete, 204, only for a revoked link (409 otherwise).

Create and revoke write `share.created` / `share.revoked` activity rows that name a
six-character token hint, never the whole token. The video detail page lists and creates
links for that video. The condition field `has_share_link` and the context
`shareLinkCount` let rules see whether a video has a link.

## Self-check

Runs on demand (button, `POST /api/checks/run`), at boot, and every
`selfcheck.interval_hours` (24). Every check runs concurrently in its own try/catch
under a 15 s budget. Each result is `{ key, label, level, detail, value?, took_ms }`
with `level` one of `ok`, `warn`, `fail`, `skip`; a run is stored in `checks`
(`trigger` boot | schedule | manual; `ok` is true when no result failed) and shown as a
status grid, and a run with any `fail` raises a `selfcheck_failed` notification.
Details never carry credentials (proxies are named by label only). Checks:

- each location: writable, free space, quota headroom;
- DB: `PRAGMA integrity_check`, WAL, migrations applied;
- yt-dlp and ffmpeg/ffprobe: present, versions, and a dry run (`yt-dlp --version`,
  `ffmpeg -version`, ffprobe on a bundled tiny sample);
- NVENC / NVDEC probe;
- tool update state (`tools.updates`): skipped until the first update check has run,
  then a warning for a failed or `blocked` update check or an available newer build;
- PO-token sidecar reachable;
- YouTube favicon reachable;
- per-account API token valid (cheap `channels.list mine=true`) and cookie jar valid;
- VAPID keys present;
- clock skew versus the Google `Date` header;
- proxy pool health;
- disk space for `/data`.

## REST API (all JSON under /api, zod-validated bodies/queries)

- Unauthenticated: `GET /healthz` (also used by the Docker healthcheck) and the public
  share surface under `/s` (separate table below).
- Everything else requires a valid CF Access JWT (see "Security model").
- Paged lists (jobs, activity, notifications, channels, and the catalog lists) answer
  `{ rows, total, page, perPage }` (`page`, `perPage` <= 200, `q`, plus resource
  filters). Short lists (accounts, locations, proxies, rules, checks) answer `{ rows }`
  unpaged. Shapes are pinned in `shared/src/apiTypes.ts` and tested on both sides. The
  client zod-parses every response.
- Secrets are write-only: responses carry presence booleans (`has_cookies`) and
  timestamps (`last_api_ok_at`, `last_cookie_ok_at`), never the secret; proxy rows carry
  only `url_redacted`.
- Edits use PUT. For accounts, locations and proxies, PATCH is registered as an alias
  with the same partial-body semantics; rules use PUT only.
- Rows marked "provisional shape" have a method/path the spec does not pin down.
- The videos, rules, inspect, shares, takeout and stats routes are on main; their shapes
  are pinned in `shared/src/apiTypes.ts` and consumed by the web app.

### Admin API (auth: admin = valid CF Access JWT)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/healthz` | public | liveness for Docker and tunnel checks; answers `{ ok: true, version }` |
| GET | `/api/status` | admin | `{ version, insecureMode, startedAt, now, db: { ok, migrations }, tools: { ytdlp, ffmpeg } }` |
| GET | `/api/events` | admin | SSE stream: frames `{ type, at, payload }`, 25 s heartbeat, `job.*`, `activity` and `notification` events |
| GET | `/api/accounts` | admin | list accounts `{ rows }` (status, has_cookies, scrape budget, last ok times) |
| POST | `/api/accounts` | admin | create an unlinked account record (optional `label`); 201 |
| PUT | `/api/accounts/:id` | admin | edit `label`, `scrape_budget_per_hour` (null = global), `status` (`disabled` pauses, `pending` resumes); PATCH is an alias |
| DELETE | `/api/accounts/:id` | admin | unlink an account; 204 |
| POST | `/api/accounts/:id/cookies` | admin | `{ cookies }`: upload/paste a cookies.txt (validated, then encrypted); answers `{ account, validation }` |
| GET | `/api/oauth/google/start?account=` | admin | 302 to Google's consent screen for an account |
| GET | `/api/oauth/google/callback` | admin | OAuth redirect target (`PUBLIC_ORIGIN` + this path); always a 302 to `/accounts?linked=<id>` or `/accounts?error=<code>` |
| GET | `/api/channels` | admin | paged channels: `q` (title or handle substring, or id prefix), `kind` (`subscription` \| `manual`), `limit` (alias of `perPage`) |
| POST | `/api/channels` | admin | `{ ref }`: add a manual channel by URL / handle / id; 201 new, 200 already tracked |
| DELETE | `/api/channels/:id` | admin | stop following a manual channel; 204 (409 when only an account subscription holds it) |
| GET | `/api/videos` | admin | paged list: sort/filter/`q` (FTS)/source/account/status/location/date range (see "Videos API") |
| GET | `/api/videos/:id` | admin | one video with its effective settings, overrides, media rows, thumbnails, share links and previous titles |
| GET | `/api/videos/:id/history` | admin | `video_changes` timeline, newest first (`page`, `perPage`, `field`, `counters`) |
| GET | `/api/videos/:id/stats` | admin | counter time series for charts (`from`, `to`) |
| GET | `/api/title-changes` | admin | every `title` row of `video_changes` across the catalog, newest first (`page`, `perPage`, `channel_id`, `q` substring of the old or new title); see "Videos API" |
| GET, HEAD | `/api/videos/:id/media/:mediaId` | admin | stream a media file, HTTP Range supported; `?download=1` sends it as an attachment |
| GET, HEAD | `/api/videos/:id/captions/:lang` | admin | WebVTT captions |
| GET, HEAD | `/api/videos/:id/thumbnail/:variant` | admin | stored thumbnail variant, or `best`; `?sha=` pins one stored image |
| GET | `/api/videos/:id/metadata.json` | admin | the stored info.json, else the detail JSON |
| POST | `/api/videos/:id/download-now` | admin | queue a download immediately; 202 `{ job_id, deduped }` |
| POST | `/api/videos/:id/recheck` | admin | queue a metadata recheck; 202 `{ job_id, deduped }` |
| POST | `/api/videos/trash` | admin | `{ ids[] }`: per-video override pri 0 + immediate pri-0 sweep; 202 `{ count }` |
| POST | `/api/videos/bulk-download/estimate` | admin | `{ ids[], kind? }` -> `{ files, bytes, warn }` |
| POST | `/api/videos/bulk-download` | admin | `{ ids[], kind?, template? }` (JSON or an HTML form post) -> streamed ZIP (store, no compression) |
| PUT | `/api/videos/:id/overrides` | admin | `{ effects }`: set the per-video `video` rule effects; `effects: null` deletes the rule; answers the inspect response (contract) |
| GET | `/api/rules` | admin | `{ rows }`: the global rule first, then custom rules by position; no video rules (contract) |
| POST | `/api/rules` | admin | create a custom rule from a full draft `{ kind, video_id, position, name, enabled, condition, effects }` (contract) |
| PUT | `/api/rules/:id` | admin | replace a rule with the full draft (same kind); there is no PATCH (contract) |
| DELETE | `/api/rules/:id` | admin | delete a custom rule; 204 (contract) |
| PUT | `/api/rules/order` | admin | `{ ids }`: persist the drag-and-drop order as the custom rule ids in ascending position order (global and video rules are not part of it); answers `{ rows }` (contract) |
| POST | `/api/rules/preview` | admin | `{ condition }`: evaluate a condition, answers `{ count, total, sample }` (contract) |
| GET | `/api/inspect?id=<identifier>` | admin | normalised id, matched rules in priority order, effective settings with provenance (contract) |
| GET | `/api/locations` | admin | list locations `{ rows }` |
| POST | `/api/locations` | admin | register a location (`label`, `container_path`, `quota_bytes`, `enabled`); 201 |
| PUT | `/api/locations/:id` | admin | edit a location (partial body); PATCH is an alias |
| DELETE | `/api/locations/:id` | admin | remove a location; 204 |
| GET | `/api/locations/:id/usage` | admin | `{ used_bytes, fs_free_bytes, fs_total_bytes, quota_bytes, mounted }`, read live |
| GET | `/api/proxies` | admin | list proxy pool entries `{ rows }` (`url_redacted` only, never the URL) |
| POST | `/api/proxies` | admin | `{ label, url, enabled? }`: add a proxy; 201 |
| PUT | `/api/proxies/:id` | admin | edit label / URL / enabled (a new URL resets the failure state); PATCH is an alias |
| DELETE | `/api/proxies/:id` | admin | remove a proxy; 204 |
| POST | `/api/proxies/:id/test` | admin | fetch YouTube's favicon through the proxy; answers `{ ok, latency_ms, error? }` |
| GET | `/api/settings` | admin | `{ overrides }`: the sparse global overrides |
| PUT | `/api/settings` | admin | the body is the sparse patch itself (a `{ patch }` wrapper is also accepted); a null value clears one; answers `{ overrides }` |
| GET | `/api/shares` | admin | paged share links (search/filter/sort, expiry) |
| POST | `/api/shares` | admin | create a link for a video (optional expiry) |
| GET | `/api/shares/:token` | admin | one link |
| POST | `/api/shares/:token/revoke` | admin | revoke one link (idempotent; no body) |
| POST | `/api/shares/revoke` | admin | bulk revoke: `{ tokens }` or `{ all_matching: filters }` -> `{ count }` |
| DELETE | `/api/shares/:token` | admin | hard delete a revoked link (409 while it is not revoked) |
| GET | `/api/notifications` | admin | paged inbox (`unacked` filter) |
| POST | `/api/notifications/:id/ack` | admin | acknowledge; answers the notification row |
| POST | `/api/notifications/ack-all` | admin | acknowledge every unacknowledged notification; answers `{ acked }` |
| POST | `/api/notifications/test` | admin | send a forced test notification; answers `{ sent, id, pushed }` or `{ sent: false, reason: "rate_limited" }` |
| POST | `/api/notifications/subscribe` | admin | store a Web Push subscription (`PushSubscription.toJSON()`); 204 |
| DELETE | `/api/notifications/subscribe` | admin | `{ endpoint }`: drop a Web Push subscription; 204 |
| GET | `/api/notifications/vapid-public-key` | admin | `{ key }`: the VAPID public key |
| GET | `/api/activity` | admin | paged activity log (`level`, `kind`, `video_id` filters) |
| GET | `/api/jobs` | admin | paged jobs (`status`, `type` filters) |
| GET | `/api/jobs/:id` | admin | one job row |
| GET | `/api/jobs/:id/log` | admin | the job's log files: `{ files: [{ name, size }] }` |
| GET | `/api/jobs/:id/log/:name` | admin | one log file as `text/plain` (a `.gz` file is served decompressed) |
| POST | `/api/jobs/:id/cancel` | admin | cancel a queued or running job; answers the job row (409 in any other state) |
| POST | `/api/jobs/:id/retry` | admin | retry a failed or cancelled job with a fresh attempt budget; answers the job row (409 in any other state) |
| GET | `/api/checks?limit=` | admin | self-check history `{ rows }`, newest first (`limit` <= 200, default 20) |
| GET | `/api/checks/latest` | admin | the newest self-check run, `{ row }` (null before the first run) |
| POST | `/api/checks/run` | admin | run the self-check now; answers the new check row |
| GET | `/api/stats/daily` | admin | pre-aggregated daily chart points: `from`, `to` (`YYYY-MM-DD` UTC, default the last 90 days, at most 400), `location_id` (default 0 = all locations; `all` = every row); answers `{ from, to, points, locations }` |
| GET | `/api/stats/summary` | admin | live counts for the Charts tiles: videos, downloaded, gone, bytes per location against its quota, API units today against the budget, downloads in 7 and 30 days |
| POST | `/api/stats/rollup` | admin | roll up today plus a 7-day backfill now; answers `{ points, from, to }` |
| GET | `/api/tools` | admin | yt-dlp / ffmpeg versions and update state, `js_runtime`, `pot_provider_url`, `auto_update`, `ffmpeg_release_tag` |
| POST | `/api/tools/update` | admin | `{ tool?, force? }`: check for updates now (and apply them when `tools.auto_update` is on); answers the tools response plus `outcomes` |
| POST | `/api/tools/rollback` | admin | `{ tool }`: swap a tool back to its `.prev` build; 412 when there is none |
| POST | `/api/takeout?account_id=` | admin | multipart upload of a Takeout `.tgz` / `.tar.gz` / `.zip`, or loose json / csv files (2 GB); 202 preview + job (see "Google Takeout importer") |
| GET | `/api/takeout/:jobId` | admin | status and counts of a `takeout_import` job |
| POST | `/api/actions/:name` | admin | `refresh-all` (recheck all metadata, re-evaluate every rule), `eval-now`, `reap-now`, `ingest-now`, `selfcheck`, `tools-update`: enqueue a job, 202 `{ job_id }` (501 until its handler exists, which on main is the case for `selfcheck` and `tools-update`; 404 for an unknown name) |

### Videos API

Routes in `routes/videos.ts`, logic in `domain/videos.ts`, `videoFiles.ts` and `bulk.ts`;
shapes in the `wave2C` block of `shared/src/apiTypes.ts`.

**List** (`GET /api/videos`). Query: `page`; `perPage` 25, 50 (default), 100 or 200;
`sort` (`upload_date` | `first_seen` | `title` | `views` | `likes` | `duration_s` |
`size` | `reclaim_priority` | `last_recheck`) and `dir` (default `desc`; nulls last, ties
by id); `q` (at most 500 characters); `source`, `status` and `type` (each a list: repeat
the parameter or comma-separate, at most 50 items); `account_id`, `channel_id`,
`location_id`; `downloaded` (boolean); `date_from` / `date_to` (inclusive bounds on
`upload_date`, epoch ms or `YYYY-MM-DD` in UTC, a bare `date_to` covers that whole day);
`min_duration` / `max_duration` (seconds); `pri` (`-1`, `0` or `positive`, the effective
reclaim priority). `status` values are `public`, `unlisted`, `gone`, `private` and
`removed` (`gone` also covers `unavailable` and anything with `gone_since`). A row has
the catalog columns, the `sources` it came from, `downloaded`, `media_size_bytes`,
`location_id` (where the current file lives, else where the rules want it),
`reclaim_priority` and `include` (null until evaluated) and `thumbnail_url`, a
content-addressed `/api/videos/:id/thumbnail/<variant>?sha=<hash>` route.

`q` first has every whole channel id (`UC` plus 22 characters, double quotes ignored)
pulled out of it: those become a `v.channel_id IN (...)` filter (several ids are
alternatives), since channel ids are not FTS columns and `unicode61` would split one on
`-` and `_`. A `q` that is only channel ids lists those channels in the default sort.
The rest of `q` is turned into a safe FTS5 query: split on whitespace, drop bare `AND` / `OR` /
`NOT` / `NEAR`, strip double quotes, drop terms without a letter or digit, quote every
term, prefix-match the last one, AND the terms together. If nothing searchable is left
the search is ignored. With `q` and no explicit `sort`, rows are ranked by
`bm25(videos_fts, 0, 10, 1, 4, 2)`, i.e. column weights title 10, description 1, channel
title 4, tags 2; without `q` the default sort is `upload_date`.

**Detail** (`GET /api/videos/:id`) is the list row plus description, tags, category,
language, a formats summary, live status, the recheck state (`last_recheck_at`,
`next_recheck_at`, `recheck_tier`, `consecutive_recheck_failures`), `effective` (merged
values, provenance, matched rule ids, `evaluated_at`, `next_eval_at`), the per-video
`overrides`, EVERY `media` row (current and older versions), the current `captions`,
every stored `thumbnails` entry, the video's `share_links` and `previous_titles`:
`[{ title, changed_at }]`, most recent first, built from the `title` rows of
`video_changes` (each row's old value is the title that held until its `seen_at`; rows
whose old value is empty or not text are skipped). **History**
(`/history?page&perPage&field&counters`) pages the `video_changes` rows newest first as
`{ id, field, old, new, seen_at, recheck_id }`. `counters=false` drops the counter rows
(`COUNTER_FIELDS` in `shared/src/apiTypes.ts`: `views`, `likes`, `comments`,
`ryd_dislikes`) in SQL, so paging and `total` cover only what is shown; an explicit
`field` wins over it. Absent or `true` keeps every row. The detail page asks for
`counters=false` and refetches with counters only when the owner toggles them on,
since counter rows outnumber real changes by hundreds to one. **Stats** (`/stats?from&to`) answers
`{ points: [{ at, views, likes, comments, ryd_dislikes }] }` oldest first.

**Title changes** (`GET /api/title-changes?page&perPage&channel_id&q`) pages every
`title` row of `video_changes` across the catalog, newest first (`seen_at`, then `id`),
as `{ id, video_id, channel_id, channel_title, title, old_title, new_title, changed_at,
thumbnail_url }`: `title` is the current title, `old_title` / `new_title` are the row's
decoded values (null when empty, not text or malformed, the same decoding as
`previous_titles`), `changed_at` is the row's `seen_at` and `thumbnail_url` is the list's
best stored thumbnail. `channel_id` filters on the video's channel; `q` (trimmed, at most
200 characters) is a case-insensitive `LIKE` substring of the decoded old OR new title,
with `%` and `_` escaped so they match literally. The `(field, seen_at)` index from
migration 004 serves the ordering without a sort.

**Files.** `GET` / `HEAD /videos/:id/media/:mediaId` streams the file with HTTP Range
(`206`, `416` for an unsatisfiable range, `Accept-Ranges`); `?download=1` adds an
attachment `Content-Disposition` named by the default filename template
(`{title} [{id}].{ext}`). Media is `Cache-Control: private, no-cache`; every file response
carries `X-Content-Type-Options: nosniff`. Thumbnails: `:variant` is one of the six
variants or `best`. Without `?sha=` the newest stored image of that variant is served,
else the newest of the next best variant in the order `maxresdefault`, `hq720`,
`sddefault`, `hqdefault`, `mqdefault`, `default` (`best` walks that list from the top);
with `?sha=` exactly that stored image is served, with no fallback. A `?sha=` URL is
`private, max-age=31536000, immutable`, any other thumbnail URL is cached for a day.
Stored paths are resolved under their location or the meta directory and refused if they
escape it. `GET /videos/:id/metadata.json` serves the stored info.json, else the detail
JSON.

**Triggers.** `POST /videos/:id/download-now` and `/recheck` enqueue a job for the video
at priority 20 with payload `{ video_ids: [id], manual: true }`, deduped, and answer 202
`{ job_id, deduped }` (`deduped` is true when an equivalent queued or running job already
existed); 404 for an unknown video, 501 `not_implemented` when no handler is registered
for the job type (the recheck route queues a `recheck_batch`). `POST /videos/trash`
takes `{ ids }` (1 to 10,000 valid ids, deduped; JSON or a form), applies the rules
domain's `trashVideos` (a `video` rule named "Trashed" with `reclaim_priority` 0 per id,
keeping any other overrides, then an immediate evaluation and an immediate pri-0 sweep of
those ids) and answers 202 `{ count }`, the number of videos trashed.

**Bulk download.** `POST /videos/bulk-download/estimate` takes `{ ids, kind }` and answers
`{ files, bytes, warn }`, where `kind` is `video` (default), `audio`, `captions` or `all`
(video, audio, captions and metadata) and `warn` is true above `bulk.warn_gb` (decimal GB;
no cap). `POST /videos/bulk-download` takes `{ ids, kind, template? }` and streams a store
(no compression) ZIP named `cellar-YYYY-MM-DD.zip`. The ZIP writer is hand rolled
(`domain/bulk.ts`): the archive is produced chunk by chunk as the client reads and its
exact length is known before the first byte, so the response has a `Content-Length` and
the browser shows real progress. Entries use data descriptors (the CRC is computed while
streaming) and switch to ZIP64 records only when a size, an offset or the entry count
needs them. Files come in request order, named by the template (`shared/` renderer);
captions are `<stem>.<lang>.vtt` and, for `all`, `<stem>.metadata.json` (the stored
info.json, else the detail JSON) sit next to them; names are made unique
case-insensitively; a file the database knows but the disk does not is skipped, and a
selection with nothing to send is a 404. The body is accepted as JSON or as an
`application/x-www-form-urlencoded` form (`ids` repeated or comma-separated, at most 1 MiB),
because a plain HTML form post is the one way a browser can stream a large ZIP straight to
disk.

### Public API (auth: public; rate-limited per IP; noindex)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/s/:token` | public | share page HTML with the `share-data` payload injected; counts one access |
| GET | `/s/:token/meta` | public | the same payload as JSON |
| GET, HEAD | `/s/:token/video` | public | video stream (Range) |
| GET, HEAD | `/s/:token/audio` | public | audio (Range) |
| GET, HEAD | `/s/:token/captions/:lang` | public | captions |
| GET, HEAD | `/s/:token/thumbnail` | public | thumbnail |
| GET | `/s/:token/metadata.json` | public | downloadable metadata |
| GET | `/s/assets/*` | public | static share bundle assets (`share-*` files only) |
| GET | `/s/privacy` | public | static privacy policy, 200 without a token |
| GET | `/s/tos` | public | static terms of service, 200 without a token |
| ANY | `/s/<anything else>` | public | the identical 404 HTML, `X-Robots-Tag: noindex, nofollow` |

### Conventions

- `GET /api/status` is the contract the shell uses: `insecureMode` drives the red
  banner, `tools` feeds About, `db.migrations` shows the applied count.
- SSE frames carry a named `event:` line (`event: <type>`, then `data: <json frame>`),
  are `{ type, at, payload }`, and the payload contract is pinned in
  `shared/src/apiTypes.ts` and tested on both sides. A comment line (`: heartbeat`) every
  25 s keeps the stream open. Event types today: `job.queued`, `job.started`,
  `job.progress`, `job.done`, `job.failed` and `job.cancelled` (payload `{ id, type,
  videoId, accountId?, pct?, message?, error?, willRetry?, runAfter? }`; a retry
  re-emits `job.queued`), `activity` (an activity row) and `notification` (`{ id, type,
  title }`). There is no `job.finished`: a finished job is `job.done` or `job.failed`.
  The web client lists every named type it wants (`CELLAR_EVENT_TYPES`), because
  `EventSource` only fires `onmessage` for unnamed frames. The rules and pipeline code
  also publish `rules.changed` (`{ reason, ruleId, videoIds? }`), `video.effective`
  (`{ videoId, before, after }`, or `{ bulk: true, changed }` when one pass changed more
  than 200 videos) and `video.media` (`{ videoId, kind, version, locationId }` after a
  download or transcode, `{ videoId, deleted, bytes }` after a pri-0 sweep). A
  publisher may attach extra diagnostic fields without breaking a client.
- Errors: `DomainError` -> HTTP map (see "Rules of the road"); JSON error bodies
  `{ error, code?, details? }`; 5xx answer `{ error: "internal error", code: "internal" }`;
  an unmatched `/api/*` path answers a 404 `not_found` JSON body, never the SPA. Other
  4xx errors raised by the framework or a route keep their status and `code` (for
  example a Takeout `413 upload_too_large`, or `400 history_is_html`), and a route whose
  job handler does not exist yet answers `501 not_implemented`.
- Bulk download: `POST /api/videos/bulk-download` streams a ZIP with store (no
  compression); filenames come from the template renderer in `shared/`. The UI warns
  above `bulk.warn_gb` (20 GB); there is no cap. Downloads of video/audio/captions are
  served as-is, no server-side transcode or caption baking. See "Videos API".
- Media streaming (`/api/videos/:id/media/:mediaId`, `/s/:token/video`) supports HTTP
  Range for in-browser playback.

## Security model

- CF Access JWT middleware (`security/cfAccess.ts`, an amber plugin adapted) is a
  global `onRequest` hook on every route EXCEPT the public prefixes `/healthz` and `/s`.
  The exemption covers the BARE `/s` as well as `/s/*`: the Cloudflare bypass
  application is scoped by destination path, and a bypass on `/s` applies beneath it
  and to `/s` itself, so the middleware must agree with that scoping exactly. The
  boundary is a PATH SEPARATOR, never a character count: `/s` does not cover `/ssh` or
  `/status`, which stay authenticated. `isPublicPath` (`security/publicPaths.ts`)
  matches at `/` boundaries, case-sensitively, with the query stripped, and is shared
  with the SPA fallback so the two cannot disagree.
- Verification with `jose`: JWKS from `https://<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/
  certs` via `createRemoteJWKSet`; `jwtVerify` enforcing issuer
  `https://<CF_ACCESS_TEAM_DOMAIN>`, audience `CF_ACCESS_AUD`, RS256, 30 s clock
  tolerance; then the required `email` claim must be in `CF_ACCESS_ALLOWED_EMAILS`
  (comma-separated, case-insensitive). The token comes from the `Cf-Access-Jwt-Assertion`
  header, then the `CF_Authorization` cookie. Any failure -> 401 JSON, fail closed,
  logged at warn; the token is never logged. Test: `server/test/cfAccess.test.ts`.
- Everything the admin SPA is served from sits BEHIND this middleware: static assets
  and the client-route fallback are as authenticated as the API. The share bundle under
  `/s/assets/` is the only public static content.
- Startup refuses to boot when the CF variables are missing, UNLESS
  `INSECURE_ALLOW_PUBLIC_ACCESS=1`: then auth is skipped, the server binds 127.0.0.1
  ONLY (hard-coded, overriding `HOST`/`PORT` binds), logs a loud banner at startup and
  every 10 minutes, and `GET /api/status` reports `insecureMode: true`, which the UI
  renders as a permanent undismissable red banner. Localhost traffic is NEVER
  otherwise treated as authenticated.
- Case sensitivity: Cloudflare Access matches paths case-insensitively while the app
  router is case-sensitive. `/S/nope` therefore passes the Access bypass, is not a public
  path to the app and answers 401 JSON from the app (a 302 to the Access login is also
  acceptable and equally closed), while `/s/nope` is a 404 from the app. This is
  documented in `docs/setup-cloudflare.md`, with the curl checks.
- Secrets at rest: OAuth refresh tokens, cookie jars and proxy URLs are encrypted with
  AES-256-GCM under `CELLAR_SECRET_KEY` (64 hex characters in `.env`) via
  `security/secrets.ts`. A malformed key fails config validation at boot; a missing key
  logs a warning, and any credential read or write is refused with 412
  `precondition_failed` until it is set. Decrypted cookies only ever touch a 0600 file
  under `/data/tmp/`, deleted in `finally`.
- Never log argv containing cookies or proxy credentials. The pino redaction list covers
  `cookie`, `authorization`, `cf-access-jwt-assertion`, `refresh_token`,
  `client_secret` and proxy URLs. No secrets in argv, URLs, logs, API responses or
  error messages. The download pipeline logs its yt-dlp argv only through `redactArgv`
  (`media/ytdlp.ts`: the `--proxy` value keeps its host but loses its credentials,
  anything URL-shaped is masked; the cookies PATH stays, its contents never enter argv)
  and masks the proxy URL in the per-job `yt-dlp.log`.
- yt-dlp is invoked with an argv array (no shell); extra args come only from an
  allowlist. Regex conditions are guarded by a static safety check and input truncation
  (see "Rule AST").
- Share tokens: 16 random bytes base64url, plaintext in the DB (locked decision),
  one uniform 404 for every invalid state (revoked, expired, unknown or malformed token,
  a live link's missing file, any sub-route, HEAD and POST included), per-IP rate limit,
  noindex headers, no directory listing, and token URLs kept out of the request log.
  The public bundle has no API access beyond `/s/:token/*`.
- Takeout upload surface: `POST /api/takeout` is admin-only (behind Access like all of
  `/api`) and is the only multipart endpoint; it streams to `$DATA_DIR/tmp`, caps one
  request at 2 GB, and refuses an archive with an absolute or `..` member before
  extracting. There is no decompression-bomb guard on the unpacked size. See "Google
  Takeout importer".
- Private details guard: `scripts/check-private.mjs` (CI and `npm run lint:private`)
  keeps the owner's real hostnames, paths, usernames and ids out of the public tree; the
  patterns live in a CI secret and a local file, never in the repository.
- SSRF note: cellar fetches user-supplied channel/video identifiers, but identifiers
  are parsed to a normalised id first and yt-dlp / the Data API are only ever given
  YouTube ids, never arbitrary URLs. Proxy URLs are owner-configured.
- Container: non-root `3100:3100`, `cap_drop: [ALL]`, `no-new-privileges`, a read-only
  root filesystem with tmpfs scratch, datasets `chmod 750` (see "Deployment").
- OAuth: scope is read-only (`youtube.readonly`); refresh tokens are encrypted; the
  client id/secret live in `.env`, not the DB.

## Config (.env / env vars)

`PORT` (8080), `HOST` (0.0.0.0; forced to 127.0.0.1 in insecure mode), `DATA_DIR`
(/data), `LOG_LEVEL` (info), `PUBLIC_ORIGIN` (`https://cellar.maxhogan.dev`; used for
OAuth redirects and share URLs), `CELLAR_SECRET_KEY` (64 hex), `CF_ACCESS_TEAM_DOMAIN`
(`<team>.cloudflareaccess.com`), `CF_ACCESS_AUD`, `CF_ACCESS_ALLOWED_EMAILS`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `POT_PROVIDER_URL`
(`http://bgutil:4416`), `NVIDIA_VISIBLE_DEVICES` (all), `NVIDIA_DRIVER_CAPABILITIES`
(`video,compute,utility`), and `INSECURE_ALLOW_PUBLIC_ACCESS` (dev only, empty in any
deployment).

Also read, all optional: `NODE_ENV` (`development` | `test` | `production`), `WEB_DIST_DIR`
(the built SPA directory; defaults to `web/dist` beside the server build) and
`BASELINE_BIN_DIR` (the image's baseline tools, default `/opt/cellar/bin`). A blank value
in `.env` counts as unset.

`CF_ACCESS_TEAM_DOMAIN` is the same Access team as amber's. `config.ts` reads ONLY
through zod validation and fails fast. `.env.example` documents every
deployment-fundamental variable with empty values. Everything that is not
deployment-fundamental is a DB setting managed in the UI. Changing `.env` on the NAS
needs `sudo midclt call app.redeploy cellar`.

Tool seams (never set in a deployment): `CELLAR_TOOL_YT_DLP`, `CELLAR_TOOL_FFMPEG` and
`CELLAR_TOOL_FFPROBE` take a JSON array `["<command>", ...prefixArgs]` that replaces the
tool command (tests run `scripts/fake-bin/yt-dlp.mjs` through node this way); otherwise
`media/exec.ts` runs `$DATA_DIR/bin/<tool>` when present, else the name from `PATH`.
`CELLAR_YTDLP_PLUGIN_DIRS` (default `/opt/cellar/yt-dlp-plugins`, empty disables) is
passed to yt-dlp as `--plugin-dirs`, and the runner adds `--js-runtimes <tools.js_runtime>`
(default `node`) when the installed yt-dlp supports it. Resolution order for a tool
command: override, then `$DATA_DIR/bin/<tool>`, then `PATH` (`toolCommand`).

Container environment (set in the image, not `.env`): `NODE_ENV=production`,
`DATA_DIR=/data`, `PORT=8080`, `HOME=/data` (uid 3100 has no passwd entry, so tools that
resolve `$HOME` would otherwise fail), `XDG_CACHE_HOME=/data/cache` and
`PATH=/data/bin:/opt/cellar/bin:$PATH` (an updated tool shadows the baseline). The
compose file adds `TMPDIR=/run/ytdlp` (see "Deployment").

## Frontend

- Shell copied from amber: sidebar nav (`NAV_LINKS` drives it), status pill, theme
  toggle, insecure banner, toast. `main.ts` wires pinia + router + PrimeVue
  (`definePreset(Aura, ...)`, `darkModeSelector`, `cssLayer: false`) + ToastService;
  `router/index.ts` uses `createWebHistory` with lazy pages. `api/client.ts`
  (`createApiClient({ fetchImpl })`) zod-parses every response and throws
  `ApiClientError`; `api/provide.ts` exposes `useApi()`. No Tailwind, PrimeVue styled
  mode.
- Theme: PrimeVue Aura preset with a NEW primary scale (deep wine/burgundy, "cellar"),
  dark by default, light via toggle (persisted). The palette is documented in
  `docs/brand/palette.md` with measured contrast ratios. No em dashes in any UI copy.
- Server-side datatables: lazy PrimeVue DataTable with `paginator`, `rows`,
  `total-records`, `@page` / `@sort`; rows per page 25/50/100/200; an AbortController
  cancels the previous load. Filters and `q` (FTS) are sent to the server.
- The SPA is built by Vite with TWO entries: `index.html` (admin) and `share.html`
  (public share bundle, entry `web/src/share.ts`). `server/src/web.ts` serves both
  from the same process: fingerprinted assets get a one-year immutable cache; any
  other unmatched GET falls back to `index.html` with `no-store`, except `/healthz`,
  `/api` and `/s` (on the path-separator boundary), so an API typo stays a JSON 404 and
  `/s/*` is never answered with the admin shell. In development Vite serves the app
  and proxies `/api` across, so a missing `web/dist` is normal and logged, not fatal.
- SSE store keeps lists live (`job.*` events); empty/error/loading states for every
  async view; toasts for mutations; confirmation dialogs for destructive actions.

### Admin pages

| Page | Contents |
| --- | --- |
| Videos | server-side datatable, FTS search (also matches a pasted channel id), filters (source, account, channel by title or id, status, location, date range), bulk select, trash icon, bulk download |
| Video detail | player (`<video>` with `<track>` captions and a speed menu), metadata, history timeline, stats chart, media files, share links, per-video overrides |
| Inspect | paste any identifier -> normalised id -> matched rules in priority order -> effective settings with per-key provenance -> edit per-video overrides |
| Rules | reorderable list (drag and drop) + builder + live preview; the editor is a full-screen Drawer, opened from the list or directly at `/rules?edit=<id>` (the Inspect page links matched rules that way) |
| Accounts | link OAuth, upload cookies, status, quota |
| Channels | subscribed channels + manual add |
| Locations | register mounts, quota, usage |
| Proxies | pool management |
| Share links | paged, search/filter/sort, expiry, revoke, select-all revoke |
| Activity | jobs + logs |
| Notifications | inbox + push subscribe |
| Self-check | status grid + history, run now |
| Charts | PrimeVue Chart; storage used per location, downloads/day, catalog growth, gone count, API units used (server returns pre-aggregated daily points) |
| Settings | global settings editor |
| About | versions (cellar, yt-dlp, ffmpeg), tool update |

Public: the share page (`/s/<token>`).

### Rule builder

A nested group tree: AND/OR groups with a NOT flag, draggable condition rows,
field -> operator -> value with field-aware inputs (duration picker, channel
autocomplete, enum chips, date/age pickers), a live "matches N videos" preview
(`POST /api/rules/preview`), and a rule list reorderable by drag and drop (relative
priority; later = higher). Stored as a JSON AST validated by the shared zod schema. The
editor saves with `PUT /api/rules/:id` (the full draft) or `POST /api/rules`; the list
order is persisted with `PUT /api/rules/order { ids }` (custom rule ids only).
Codec options include `hevc_nvenc` / `h264_nvenc` only when the self-check reports
NVENC. `include` is not offered on the global rule.

### Trash and bulk download

- Trash: bulk-select + trash icon = a per-video override rule with pri 0 plus an
  immediate pri-0 sweep. Metadata, history, thumbnails and captions are never deleted.
- Bulk download is admin only. It is either a streamed ZIP (store) or a
  download-to-folder through the File System Access API (`showDirectoryPicker()`,
  feature-detected, falling back to ZIP). The filename template supports fields like
  `{title} {channel} {upload_date} {id} {ext} {source} {resolution}` and sanitises the
  result. The UI warns above 20 GB; there is no cap.

### Inspect page

Paste any identifier -> the id is normalised -> matched rules in priority order ->
the effective settings with per-key provenance (default / global / rule name / video
override) -> edit per-video overrides (`PUT /api/videos/:id/overrides`).

## Testing

- Vitest 5 projects: `shared` (pure), `server` (node, 30 s timeout; unit + integration
  against real node:sqlite files in temp dirs), `web` (`web/vitest.config.ts`,
  happy-dom, `@vue/test-utils`).
- Unit tests cover ALL domain logic: rule AST + evaluation + merge, reaper, mover, id
  parser, Takeout parsers, template renderer, token/404 behaviour. Fixtures are
  synthetic, generated without real account data (recorded public API shapes trimmed to
  well-known public videos).
- Fake yt-dlp and ffmpeg/ffprobe shims live in `scripts/fake-bin/` (node scripts, wired
  in through the `CELLAR_TOOL_*` seams or put on PATH, that emit canned JSON/progress
  and write dummy files) for integration tests of the job
  runner, cookie write-back, transcode verification and moves - no network.
- Coverage: v8, reporters `text`, `json`, `json-summary`, `cobertura`, `html`, collected
  across shared + server + web. `scripts/coverage-ratchet.mjs` compares against
  `coverage-baseline.json` and fails if any metric drops more than 0.5 percentage
  points; `npm run coverage:ratchet:write` rewrites the baseline, which is committed as
  its own chore commit.
- Playwright e2e (`e2e/`): chromium, 1 worker, `webServer` = the BUILT server
  (`node server/dist/index.js`) with `INSECURE_ALLOW_PUBLIC_ACCESS=1`, a temp `DATA_DIR`
  and a throwaway `CELLAR_SECRET_KEY`, on port 8099. UI flows run against it.
  `tests/dockerImage.spec.ts` smoke-tests the built image from inside the container
  (`docker exec`: binaries present, `/healthz` ok, root serves the SPA) and is skipped
  unless `CELLAR_E2E_IMAGE` names an image. Why the split: the insecure flag binds
  127.0.0.1, which a published container port can never reach.
- Optional `LIVE=1` suite downloads the public canary for real; skipped in CI, run on
  the NAS during acceptance.
- Browser QA for this repo uses claude-in-chrome (overrides the global `/browse` rule).

## CI/CD

- `ci.yml`: push to main, pull requests and `workflow_dispatch`. Jobs: `lint`
  (typecheck, ESLint, Prettier check, `scripts/check-ascii.mjs`, and
  `scripts/check-private.mjs` with the `PRIVATE_PATTERNS` secret; on a push to the
  default branch it fails closed when the secret is missing), `test` (Node 26,
  coverage + ratchet, coverage artifact), `build` (all workspaces; asserts
  `server/dist/index.js`, `web/dist/index.html` and `web/dist/share.html` exist) and
  `e2e` (needs build; installs chromium; uploads the Playwright report on failure).
  Least-privilege `contents: read`; concurrency group cancels superseded PR runs; all
  jobs honor `[skip ci]`.
- `build-image.yml`: on push to main (path-filtered to the source, Dockerfile, lockfile
  and workflow) plus `workflow_dispatch`. Builds the multi-stage image with buildx,
  `load`s it, runs a docker-exec smoke test (healthz loop + yt-dlp / ffmpeg / ffprobe
  presence), then pushes `ghcr.io/pmaxhogan/cellar` with tags `latest` and
  `sha-<short>` using `GITHUB_TOKEN` (permissions: contents read, packages write).
- `dependabot.yml`: npm and github-actions (and docker), weekly Monday 06:00
  America/Chicago, one `minor-and-patch` group per ecosystem plus a `security` group,
  cooldown 14/3/0 (major/minor/patch); ignores majors for `primevue`,
  `@primeuix/themes` and `typescript`.
- Dependabot auto-merge is native: on Dependabot PRs, minor/patch updates are approved
  and `gh pr merge --auto --squash` is armed; majors stay for manual review. Waiting
  for green requires the required-checks ruleset, which is added AFTER acceptance.
- Branch policy: main is unprotected during the build (push per green wave, fix
  forward, never revert). After acceptance one protection flip applies a ruleset with
  the required CI checks (lint, test, build, e2e) and the code-coverage rule
  (`.github/rulesets/code-coverage.json`, max drop 0.5), squash-only merges,
  delete-branch-on-merge, and arms Dependabot auto-merge.
- Watchtower on the NAS pulls `:latest` within about 2 minutes of publish
  (label-scoped).

## Deployment

### Image

Multi-stage `node:26-bookworm-slim` (builder, tools, runtime). The builder runs `npm ci`,
builds shared -> server -> web, then `npm prune --omit=dev`. The tools stage downloads
the baseline set into `/opt/cellar`, checksum-verified where the publisher ships a
checksum file: yt-dlp (`yt-dlp_linux`, a PyInstaller onefile build, so no Python in the
image) and BtbN ffmpeg + ffprobe (the pinned release `autobuild-2025-12-31-14-28`, the
default of `tools.ffmpeg_release_tag`) in `/opt/cellar/bin`, and the bgutil PO-token plugin in
`/opt/cellar/yt-dlp-plugins`. The runtime stage installs apt `ca-certificates curl
xz-utils` (xz unpacks ffmpeg updates) and copies `/opt/cellar` in. At boot the server
copies the three binaries to `/data/bin` when absent, and the updater swaps newer
versions in atomically. Environment: `NODE_ENV=production DATA_DIR=/data PORT=8080
HOME=/data XDG_CACHE_HOME=/data/cache PATH=/data/bin:/opt/cellar/bin:$PATH`.
`VOLUME ["/data", "/media"]`. `HEALTHCHECK curl -fsS http://127.0.0.1:8080/healthz`.
`CMD node server/dist/index.js`. The image runs as a non-root user chosen by compose
(`user: "3100:3100"`).

### Compose (NAS Custom App, `deploy/docker-compose.nas.yml`)

Service `cellar`:

```yaml
services:
  cellar:
    image: ghcr.io/pmaxhogan/cellar:latest
    pull_policy: always
    restart: unless-stopped
    user: "3100:3100"
    cap_drop: [ALL]
    security_opt:
      - no-new-privileges:true
    read_only: true          # verified to coexist with the nvidia runtime
    tmpfs:
      - /tmp:size=512m,uid=3100,gid=3100,mode=1770            # noexec scratch
      - /run/ytdlp:size=1g,uid=3100,gid=3100,mode=0700,exec  # yt-dlp onefile unpack dir
    environment:
      TMPDIR: /run/ytdlp
    env_file:
      - /mnt/tank/apps/cellar/.env
    volumes:
      - /mnt/tank/apps/cellar/data:/data
      - /mnt/tank/apps/cellar/media:/media
    deploy:
      resources:
        reservations:
          devices:
            - capabilities: [gpu, video]
              count: all
              driver: nvidia
    labels:
      com.centurylinklabs.watchtower.enable: "true"
    logging:
      driver: json-file
      options: { max-size: 20m, max-file: "3" }
    depends_on:
      - bgutil
  # sidecars (below): bgutil, cellar-watchtower
```

- Sidecars: `cellar-watchtower` (`containrrr/watchtower:latest`, `WATCHTOWER_CLEANUP=true
  LABEL_ENABLE=true POLL_INTERVAL=120 ROLLING_RESTART=true`, mounts
  `/var/run/docker.sock` and `/root/.docker/config.json:/config.json:ro`; the GHCR
  login already exists on the NAS) and `bgutil` (`brainicism/bgutil-ytdlp-pot-provider`,
  container `cellar-bgutil`, `init: true`, the PO-token provider on the internal network
  at `http://bgutil:4416`, no published ports; it runs as `3100:3100` with a read-only
  rootfs, a 64 MB tmpfs `/tmp`, `cap_drop: [ALL]` and `no-new-privileges`, verified on
  the NAS).
- Scratch space: with a read-only rootfs there are two tmpfs mounts. `/tmp` (512 MB) is
  `noexec`. `yt-dlp_linux` is a PyInstaller onefile build that unpacks itself into
  `$TMPDIR` on every run, which needs an executable directory, so a dedicated tmpfs
  `/run/ytdlp` (1 GB, mode 0700, `exec`) is mounted and `TMPDIR=/run/ytdlp` is set in
  the service environment (every child process inherits it). Nothing else gets an exec
  mount. Each run unpacks about 45 MB, and a killed run leaves its `_MEI*` directory
  behind; enough orphans fill the exec tmpfs, after which every run fails, hence the
  size and the pruning. Before each yt-dlp run made through `media/exec.ts` (feeds,
  cookie validation, self-check) it removes `_MEI*` directories in the child's `$TMPDIR`
  that are older than 10 minutes and that no live process has a file mapped from (read
  from `/proc/*/maps`, so a long download keeps its files; without `/proc` nothing is
  removed). Downloads and the canary are spawned by `media/spawn.ts`, which does not prune
  itself; the 30-minute feed runs keep the directory clean.
- No published ports: the Cloudflare tunnel reaches the container by DNS alias.
- GPU: reserved with the mkvid pattern (`deploy.resources.reservations.devices`);
  `NVIDIA_VISIBLE_DEVICES=all`, `NVIDIA_DRIVER_CAPABILITIES=video,compute,utility`.
  Docker's default runtime on the NAS is `nvidia`. The NAS GPU is a GTX 1650 SUPER.
- Created through `sudo midclt call app.create` with `custom_app: true` and the compose
  file as the string `custom_compose_config_string` (the payload is recorded in
  `deploy/README.md`; the fallback is pasting the compose in the Apps UI).

### Container hardening

- Unique UID/GID `3100:3100` (not present on the NAS OS). Datasets are owned by it with
  `chmod 750`, so the `apps` user (568) and other non-root users cannot read cellar's
  files, and vice versa.
- `cap_drop: [ALL]` with nothing added back; `security_opt: [no-new-privileges:true]`;
  `read_only: true` with the two tmpfs mounts above, verified to coexist with the nvidia
  runtime on this NAS (`docker run --read-only --gpus all ... nvidia-smi`), so no
  exception is needed. Storage locations must therefore be real mounts.
- json-file logging 20m x3, `pull_policy: always`, restart unless-stopped.

### NAS setup

`sudo zfs create tank/apps/cellar`, `.../data` and `.../media`; `chown 3100:3100`,
`chmod 750`; `/mnt/tank/apps/cellar/.env` holds the variables in "Config"
(`CELLAR_SECRET_KEY` generated, `CF_ACCESS_TEAM_DOMAIN` copied from amber's `.env`,
`CF_ACCESS_AUD` and the Google credentials filled by the owner). `.env` changes need
`sudo midclt call app.redeploy cellar`. The runbook is `deploy/README.md`.

### Cloudflare

- Hostname `cellar.maxhogan.dev`; tunnel public hostname ->
  `http://cellar.ix-cellar.svc.cluster.local:8080` (a bare service name does not
  resolve).
- Access application 1: self-hosted `cellar.maxhogan.dev`, policy Allow, the owner's
  email. Its AUD goes into `CF_ACCESS_AUD`.
- Access application 2: domain `cellar.maxhogan.dev`, path `s` (covers `/s` and
  `/s/*`), policy Bypass, include Everyone.
- Curl checks: `curl -sI https://cellar.maxhogan.dev/healthz` -> 200; `/` -> 302 to
  Access; `/s/nope` -> 404 (not 302); `/S/nope` -> 401 from the app (observed; a 302 is also
  acceptable. Access is case-insensitive, the router is not).
- Google Cloud: enable "YouTube Data API v3", OAuth consent External and published to
  Production, an OAuth client "Web application" with redirect URI
  `https://cellar.maxhogan.dev/api/oauth/google/callback`.

### Walking skeleton

The first deployable build contains: config, logging, db + migration 001 (settings, kv,
locations, accounts skeleton), cfAccess with `/healthz` and `/s` public, `/api/status`,
the SPA shell (nav, theme, insecure banner), the `/s/*` 404 page, and the Dockerfile
with baseline yt-dlp/ffmpeg + bgutil plugin. `/healthz` is 200 without auth, `/`
redirects to Access, and `/s/<anything unknown>` is the 404 HTML with
`X-Robots-Tag: noindex, nofollow`.

## Open technical calls and their resolutions

These are the technical calls spec section 12 leaves to the implementers. Each started as
the spec's recommendation, held as PROVISIONAL until an implementer recorded the final
call. DECIDED rows record that call. The one PROVISIONAL row left (10) still holds the
spec's recommendation, because no code settles it.

| # | Call | Decision |
| --- | --- | --- |
| 1 | Container for NVENC HEVC output (mp4 with aac re-encode vs mkv keeping opus) | DECIDED (wave 3, `media/ffmpeg.ts`): keep the original audio (`audio_codec: copy`); the container follows the output audio: `.mkv` for Opus/Vorbis, `.mp4` with `-movflags +faststart` otherwise; HEVC in MP4 is tagged `hvc1`. NVENC runs `-rc vbr -cq <q> -b:v 0`. |
| 2 | Exact yt-dlp flags for the JS runtime and the PO-token provider on the installed version | DECIDED (wave 3, `media/ytdlp.ts`): `--plugin-dirs <dir>`, `--js-runtimes <tools.js_runtime>`, `--extractor-args youtubepot-bgutilhttp:base_url=<url>` (omitted when the provider URL is empty). Progress uses `--newline --progress` with a `cellar-progress` marker in `--progress-template`; the final file comes from `--print after_move:...` plus `--print-json`. `--sleep-requests` takes one value, drawn per run from the min..max settings. |
| 3 | Whether `read_only: true` rootfs coexists with the nvidia runtime | DECIDED. Kept: it coexists (verified on the NAS). Because the yt-dlp onefile build must unpack into an executable directory, the layout is `/tmp` (noexec) plus a dedicated exec tmpfs `/run/ytdlp` with `TMPDIR=/run/ytdlp`. |
| 4 | `midclt call app.create` payload shape for a custom compose app on TrueNAS 25.10 | DECIDED. `custom_app: true` with `custom_compose_config_string` (the compose file as a string), recorded in `deploy/README.md`; the UI paste remains the documented fallback. |
| 5 | Rate limiter for `/s` | DECIDED. `@fastify/rate-limit`, 120 requests per minute per IP in memory, keyed on `CF-Connecting-IP` (request IP as the fallback); over the limit is 429 `rate_limited`. |
| 6 | FTS query parsing | DECIDED (`domain/videos.ts`, `splitSearchTerms` then `buildFtsQuery`): whole channel ids become a `channel_id IN` filter; for the rest split on whitespace, drop bare `AND` / `OR` / `NOT` / `NEAR`, strip double quotes, drop terms without a letter or digit, quote every term, prefix match on the last term, AND them. Ranked by `bm25(videos_fts, 0, 10, 1, 4, 2)` (title 10, description 1, channel title 4, tags 2). `videos_fts` is contentless FTS5 with the `unicode61` tokenizer. |
| 7 | Takeout history entries without `titleUrl` (ads, removed videos) and archive formats | DECIDED. Entries are read from `titleUrl`; ads and entries without a usable URL are skipped and counted per reason (`shared/src/takeout.ts`), and the Activity row reports the counts. The importer accepts `.zip`, `.tgz` / `.tar.gz` and loose files (`domain/takeout.ts`). |
| 8 | Thumbnail variants to fetch | DECIDED: `--write-all-thumbnails`, each file mapped back to its variant through the info dict and filtered by the `thumbnails.variants` setting (default: those six); hashed, stored on change only as `<variant>-<sha>.<ext>` keeping the real extension (YouTube also serves WebP). |
| 9 | Default `cq`/`preset` for hevc_nvenc and `crf`/`preset` for SVT-AV1 | DECIDED: hevc_nvenc `cq 28` / `p5` (the effect defaults); SVT-AV1 `crf 35` / preset 8 when it runs as the fallback for a missing NVENC encoder, the rule's quality and numeric preset when `av1_svt` is chosen explicitly. |
| 10 | Whether to also ingest `:ytsubs` as a cheaper way to notice new uploads than per-channel UU polling | PROVISIONAL. API `UU` polling is the locked source of truth; the `:ytsubs` feed may be added later as an optimisation only. |
| 11 | (from spec 3.7) Whether `video_stats` exists | DECIDED. Kept as a derived chart index (migration 003) rebuilt from `video_changes`; never a second source of truth. |
