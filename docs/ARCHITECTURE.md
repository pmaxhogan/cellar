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
shared/   @cellar/shared  # zod schemas, API types, rule AST + effects registry, settings
                          #   registry, id parser, filename template renderer (pure, no IO)
server/   @cellar/server  # Fastify 5, node:sqlite, jobs, yt-dlp/ffmpeg runners
web/      @cellar/web     # Vue 3 + Vite + PrimeVue 4 admin SPA (entry index.html)
                          #   + public share entry (share.html -> web/src/share.ts)
e2e/      @cellar/e2e     # Playwright
deploy/docker-compose.nas.yml   # the NAS Custom App
deploy/README.md                # NAS runbook (ZFS datasets, UID/GID, midclt, OAuth client,
                                #   cookies export, Takeout export)
scripts/check-ascii.mjs, scripts/coverage-ratchet.mjs
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
db/migrations.ts         # ordered append-only array of { name, sql }
security/cfAccess.ts     # CF Access JWT plugin (amber verbatim, adapted)
security/secrets.ts      # AES-256-GCM encrypt/decrypt (CELLAR_SECRET_KEY)
security/publicPaths.ts  # isPublicPath: ["/healthz", "/s"], shared with the SPA fallback
domain/                  # no Fastify inside: videos, sources, channels, accounts, rules,
                         #   ruleEval, effective, locations, reaper, mover, shares,
                         #   notifications, selfcheck, takeout, bulk, stats, errors
youtube/                 # api, oauth, quota, feeds, ryd, idParser (re-export of shared)
media/                   # ytdlp, ffmpeg, formats, captions, thumbnails, versions, tools
jobs/                    # scheduler, queue, types, handlers/*
routes/*.ts              # thin REST routes per resource; routes/validate.ts
                         #   (parseBody / parseQuery / parseParams)
public/share.ts          # the /s routes (public surface)
events.ts                # SSE bus (/api/events)
web.ts                   # serves the built SPA(s) + client-route fallback
```

Rules of the road (amber pattern):

- `domain/*.ts` contains no Fastify; routes are thin and call domain functions.
- `domain/errors.ts` defines `DomainError` and its HTTP mapping; a single Fastify error
  handler maps it. 5xx responses carry a fixed message; the real error is logged.
- `routes/validate.ts` parses bodies, queries and params with the shared zod schemas.
- `shared/` is pure: no IO, no Node-only imports. It must be built before `server` and
  `web` resolve its types (`npm run build` and `npm run typecheck` do that in order).

## Data model (SQLite)

DB file: `$DATA_DIR/cellar.db`. Pragmas on open: `journal_mode=WAL`, `synchronous=FULL`,
`foreign_keys=ON`, `busy_timeout=5000`. Single process, single writer. All
multi-statement writes run inside transactions via the `tx()` helper (savepoints when
nested). The wrapper is typed: `get` / `all` / `run` / `exec` / `tx`.

Migrations: `db/migrations.ts` exports an ordered list `{ name, sql }`. The runner
records applied names in a `migrations` table, one transaction per migration. Never edit
an applied migration; append new ones. The default rule set (below) is installed by a
migration at first init, and `kv.installed_at` is written at first DB init.

All times are epoch milliseconds (INTEGER). Every table carries `created_at` and
`updated_at` unless a bullet shows its columns without them (those are append-only logs
or caches where the listed columns are the full set). JSON columns are TEXT holding
JSON, validated by a shared zod schema on write.

### Accounts and secrets

- `accounts`: `id`, `label`, `google_sub`, `email`, `channel_id`, `status`,
  `api_quota_reserved`, `scrape_budget_per_hour`, `last_api_ok_at`, `last_cookie_ok_at`,
  `created_at`, `updated_at`. A Google account, not a channel. Linking one requires BOTH
  a Google OAuth grant and a cookie jar. `status` is the link health shown on the
  Accounts page (the value set is provisional; it includes an auth-lost state that the
  error policy sets on the first confirmed 401 / invalid cookie).
- `account_secrets`: `account_id`, `kind` (`oauth_refresh` | `cookies`), `ciphertext`,
  `iv`, `tag`, `updated_at`. AES-256-GCM via `security/secrets.ts`. One row per
  (account, kind). Secrets are write-only: API responses carry presence booleans and
  last-ok timestamps, never the secret.
- `proxies`: `id`, `label`, URL stored encrypted (`url_ciphertext`, `url_iv`, `url_tag`,
  same scheme as `account_secrets`), `enabled`, `fail_count`, `skipped_until`.
  (The spec abbreviates this table's encrypted columns; the three-column scheme is
  provisional.)

### Channels and videos

- `channels`: `id` (= `UC...`), `title`, `handle`, `uploads_playlist_id`,
  `thumbnail_url`, `first_seen_at`, `last_checked_at`.
- `channel_sources`: `channel_id`, `account_id` (nullable), `kind` (`subscription` |
  `manual`), `subscribed_at`, `created_at`. Manual rows have `account_id` NULL and use
  the `download_accounts` default `any`.
- `videos`: `id` (11-char YouTube id), `channel_id`, `title`, `description`,
  `upload_date`, `published_at`, `duration_s`, `type` (`video` | `short` | `livestream`
  | `premiere`), `live_status`, `privacy` (`public` | `unlisted` | `private` |
  `removed` | `unavailable`), `gone_since`, `consecutive_recheck_failures`, `views`,
  `likes`, `comments`, `ryd_dislikes`, `ryd_ratio`, `tags` (json), `category_id`,
  `default_language`, `caption_available`, `max_height`, `has_av1`, `has_vp9`,
  `has_h264`, `max_fps`, `is_hdr`, `formats_json`, `last_recheck_at`, `next_recheck_at`,
  `recheck_tier`, `created_at`, `updated_at`. "Gone" means private or removed.
- `video_sources`: `video_id`, `account_id` (nullable), `source` (`history` |
  `watch_later` | `liked` | `subscription` | `channel`), `first_seen_at`,
  `last_seen_at`, `source_ts` (nullable; the real watch/like/add time when known),
  `origin` (`live_feed` | `api` | `takeout`). PK `(video_id, account_id, source)`.
  Implementer note: SQLite treats NULLs as distinct inside a PRIMARY KEY of a rowid
  table, so a NULL `account_id` (manual channels) does not collide by itself. The
  implementer must make the uniqueness hold for NULL `account_id` (for example a unique
  index over `coalesce(account_id, 0)`) and record the choice. The same applies to
  `channel_sources`.
- `video_changes`: `id`, `video_id`, `recheck_id`, `field`, `old_json`, `new_json`,
  `seen_at`. THE one history store (see "Metadata history and rechecks"). `recheck_id`
  is the `jobs.id` of the `recheck_batch` run that observed the diff (provisional; the
  spec names the column but no separate table).
- `video_stats`: `video_id`, `at`, `views`, `likes`, `comments`, `ryd_dislikes`. A
  derived chart index; see "Metadata history and rechecks" for its status.
- `thumbnails`: `video_id`, `variant`, `url`, `sha256`, `path`, `first_seen_at`. Every
  distinct URL/hash is stored.
- `videos_fts`: FTS5 external-content table over `title`, `description`, channel title,
  `tags`, kept in sync with triggers. Queried with `bm25` ranking and prefix queries.

### Media and locations

- `media`: `id`, `video_id`, `kind` (`video` | `audio` | `captions` | `info`), `version`
  (int), `is_current`, `location_id` (nullable; NULL = lives under `/data/meta`, used
  by captions/info rows), `rel_path`, `size_bytes`, `sha256`, `vcodec`, `acodec`,
  `height`, `fps`, `bitrate`, `lang` (nullable), `downloaded_at`, `transcoded_from`
  (nullable), `created_at`.
- `locations`: `id`, `label`, `container_path`, `quota_bytes`, `enabled`, `used_bytes`
  (cached), `fs_free_bytes` (cached), `created_at`, `updated_at`. A location is a
  compose bind mount (container path) plus this row.

### Rules and evaluation results

- `rules`: `id`, `kind` (`global` | `custom` | `video`), `video_id` (nullable; set for
  `video` rules), `position` (int, custom ordering), `name`, `enabled`,
  `condition_json` (the AST; NULL for global/video rules), `effects_json` (sparse map of
  effect key -> value), `created_at`, `updated_at`.
- `video_effective`: `video_id`, `effective_json`, `matched_rule_ids` (json),
  `evaluated_at`, `next_eval_at`, `reclaim_priority`, `location_id`, `include`.
  `effective_json` holds the merged effect values and the per-key provenance (which
  rule set each key); `reclaim_priority`, `location_id` and `include` are denormalized
  for the reaper, mover and download scheduling.
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
- `quota_usage`: `account_id`, `day`, `api_units`, `scrape_requests`.
- `stats_daily`: `day`, `location_id` (nullable), `bytes_used`, `downloads`, `catalog`,
  `gone`, `api_units`. The pre-aggregated source of the charts.
- `checks`: `id`, `run_at`, `trigger`, `results_json`, `ok`. Self-check history.
- `settings`: `key`, `value_json`. The global settings registry store (amber pattern).
- `kv`: `key`/`value` pairs. Holds `installed_at` (written at first DB init; anchors the
  7-day subscription backfill guard), the VAPID keypair, tool versions, and similar.

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

### Effects registry (`shared/src/effects.ts`)

Each effect key declares a zod schema, a default, `allowedIn: ["global", "custom",
"video"]` and UI metadata (group, label, control). The spec restricts exactly one key:
`include` is NOT allowed in `global`; every other key is allowed in all three kinds.

| Key | Type | Default | allowedIn |
| --- | --- | --- | --- |
| `include` | bool | `true` | custom, video (NOT global) |
| `reclaim_priority` | int >= -1 | `-1` | global, custom, video |
| `location_id` | location id | first location | global, custom, video |
| `media_mode` | `video` \| `audio_only` \| `captions_only` \| `metadata_only` | `video` | global, custom, video |
| `format_policy` | `prefer_av1` \| `prefer_vp9` \| `prefer_h264` \| `best` | `prefer_av1` | global, custom, video |
| `max_height` | int (pixels) | unset (no cap) | global, custom, video |
| `max_fps` | int | unset (no cap) | global, custom, video |
| `transcode` | object, see below | `{ mode: if_not_av1, codec: hevc_nvenc, cq: 28, preset: p5, audio_codec: copy }` | global, custom, video |
| `captions` | `{ enabled, languages: string[] \| "all", auto_generated: bool }` | `{ enabled: true, languages: "all", auto_generated: true }` | global, custom, video |
| `ytdlp` | `{ format_override?, rate_limit_bytes_per_s?, sleep_requests_min?, sleep_requests_max?, concurrent_fragments?, extra_args_allowlisted? }` | all fields unset (global settings apply) | global, custom, video |
| `download_accounts` | `sourcing` \| `any` \| account ids[] | `sourcing` | global, custom, video |
| `proxy` | `none` \| `pool` \| proxy ids[] | `none` | global, custom, video |
| `delay_after_upload` | duration | unset (no delay) | global, custom, video |
| `recheck_interval` | `tiered` \| duration | `tiered` | global, custom, video |
| `live` | `vod_only` \| `record_live` | `vod_only` | global, custom, video |
| `notify` | `{ enabled, max_times: int \| null, channel: push }` | `{ enabled: false }` | global, custom, video |

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
  av1_svt | av1_nvenc, quality: crf/cq int, preset, max_video_bitrate_kbps?,
  audio_codec, audio_bitrate_kbps }`. `av1_nvenc` is only offered when the hardware
  allows it (the NAS GPU does not). `hevc_nvenc` / `h264_nvenc` are offered in the rule
  UI only when NVENC is detected. Software `av1_svt` is a rule option, not the default.
- `captions`: WebVTT. Default is all manual subtitle languages plus auto-generated for
  the video's language. A default rule narrows this to English (see "Default rule set").
  `captions_only` and `audio_only` combine: audio-only media with captions enabled
  downloads both.
- `ytdlp.extra_args_allowlisted`: only flags from the server-side allowlist are
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
- `notify`: notify up to `max_times` (or unlimited when null) per video while the video
  meets the rule; counts live in `rule_notify_counts`. Delivery is Web Push.

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
   value, and any field it omits takes the schema's field default.
4. Apply the `video` rule for this video id.

The result PLUS provenance (which rule set each key) is stored in `video_effective` and
shown on the Inspect page. `matched_rule_ids` lists the global rule, every matching
custom rule and the video rule. A key that no rule set reports provenance "default".

Evaluation is triggered:

- on every change (video metadata or sources change, any rule edited; debounced);
- by a full pass every hour (the interval is a global setting);
- by the manual "Refresh and recheck all" action, which rechecks all metadata and so
  re-evaluates every rule.

Pri-0 deletions are swept immediately after a pass. `next_eval_at` per video is the
soonest time any age/time leaf in any enabled rule flips for that video (computed from
the thresholds); the hourly pass is the safety net.

### Global settings (`shared/src/settingsRegistry.ts`)

Amber pattern: each key declares a zod schema, a default, allowed scopes (here only
`global`) and UI metadata. `GET /api/settings` returns the sparse overrides stored; `PUT`
takes the same shape and a null value clears an override. Unknown keys are rejected as
a whole. The spec fixes the defaults below but names none of the identifiers: the key
names are PROVISIONAL (assigned by this document) until an implementer records the
final names in the registry and updates this table.

| Key | Default | Meaning |
| --- | --- | --- |
| `eval_interval_minutes` | 60 | Full rule-evaluation pass interval |
| `ingest_history_interval_minutes` | 30 | History feed per account |
| `ingest_watch_later_interval_minutes` | 30 | Watch Later feed per account |
| `ingest_liked_interval_minutes` | 30 | Liked playlist per account |
| `ingest_subscriptions_interval_minutes` | 360 | Subscriptions list per account |
| `ingest_channel_uploads_interval_minutes` | 30 | Newest 50 uploads per channel |
| `ingest_channel_uploads_page_size` | 50 | Newest uploads read per channel poll |
| `manual_channel_full_scan_interval_hours` | 24 | Full scan of manual channels until caught up |
| `recheck_tier_daily_max_age_days` | 30 | Daily recheck below this video age |
| `recheck_tier_weekly_max_age_days` | 365 | Weekly below this, monthly above |
| `api_daily_unit_budget` | 10000 | Google API units per day |
| `scrape_budget_per_hour` | unset (per-account column `accounts.scrape_budget_per_hour`) | Self-imposed requests/hour per account |
| `max_concurrent_downloads` | 2 | `download` worker pool size |
| `max_concurrent_transcodes` | 1 | `transcode` worker pool size |
| `download_speed_limit_bytes_per_s` | unset (no cap) | yt-dlp `--limit-rate` default |
| `account_min_gap_seconds` | 30 | Minimum gap between yt-dlp runs per account |
| `sleep_requests_min_seconds` / `sleep_requests_max_seconds` | 1 / 3 | yt-dlp `--sleep-requests` |
| `reaper_high_water_pct` | 95 | Start reaping at this % of quota |
| `reaper_low_water_pct` | 90 | Free down to this % of quota |
| `reaper_min_free_bytes` | 10 GB | Also start reaping when the FS has less free than this |
| `ryd_enabled` | true | Return YouTube Dislike lookups |
| `pot_provider_url` | `http://bgutil:4416` | PO-token sidecar (env `POT_PROVIDER_URL` seeds it) |
| `proxy_apply_to_api` | false | Also route YouTube API calls through the proxy |
| `proxy_skip_minutes` | 10 | A failing proxy is skipped this long |
| `proxy_fail_notify_after` | 3 | Consecutive failures before a notification |
| `job_log_retention_days` | 14 | Per-job log retention |
| `job_log_cap_bytes` | 2 GB | Per-job log total cap |
| `job_log_failed_retention_days` | 60 | Retention for failed jobs' logs |
| `notify_download_failure_threshold` | 3 | Consecutive download failures across distinct videos |
| `notify_rate_limit_hours` | 6 | Per notification type, unless acknowledged |
| `canary_max_per_hour` | 1 | Canary download budget |
| `recheck_outage_notify_hours` | 6 | "Recheck pass failed" rate limit |
| `bulk_download_warn_bytes` | 20 GB | UI warning threshold, no cap |
| `share_rate_limit_per_minute` | implementer's call | Per-IP limit on `/s` |
| `backfill_guard_days` | 7 | Used by the default guard rule (rule 4) |
| `selfcheck_interval_hours` | 24 | Self-check cadence |
| `tool_update_check_interval_hours` | 24 | yt-dlp / ffmpeg update check |

## Rule AST (`shared/src/ruleAst.ts`)

A condition is a JSON tree validated by a shared zod schema (the same schema validates
`POST /api/rules`, `PUT /api/rules/:id` and `POST /api/rules/preview`):

```
Group = { type: "group", op: "and" | "or", not?: boolean, children: Node[] }
Leaf  = { type: "cond", field, op, value }
Node  = Group | Leaf
```

A group with `not: true` negates its combined result. An empty `and` group matches
everything ("match all"); an empty `or` group matches nothing.

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
| `upload_date`, `first_seen`, `downloaded_at`, `last_seen`, `now` | `age_gt`, `age_lt`, `before`, `after`, `is_null` | duration (ISO-8601 or `{days, months, years}`) for `age_*`; absolute datetime for `before`/`after` |
| `upload_date` | additionally `before_install_minus` | duration X |

Notes:

- `regex` / `not_regex` carry a safe-regex guard (length limit and a `re2`-style check
  or a timeout via worker) so a pathological pattern cannot stall evaluation.
- `source` set semantics, over the set `S` of sources a video currently has:
  `has_any` = `S` intersects the list; `has_all` = list is a subset of `S`;
  `has_only` = `S` is non-empty and a subset of the list; `has_none` = `S` does not
  intersect the list.
- Time anchors available to conditions (all four): upload/publish date
  (`upload_date`); first seen in a given source, per video, source and account
  (`first_seen`); download completed at (`downloaded_at`); last seen in any source /
  last watched when known (`last_seen`). `now` is the evaluation clock.
- `first_seen(source?)`: with a source (or a list of sources, as in the default rules'
  `first_seen(subscription or channel)`) it is the earliest first-seen across those
  sources; without one it is the earliest across all sources. The spec writes this as a
  parametrised field; the leaf carries the parameter as an optional `arg` (provisional:
  `Leaf = { type: "cond", field, arg?, op, value }` for `first_seen` only).
- `age_gt` / `age_lt` compare `now - anchor` against the duration. `is_null` tests that
  the anchor has no value (for example a never-downloaded video's `downloaded_at`).
- `install_age`: `upload_date before installed_at - X` is expressed as `upload_date`
  `before_install_minus` X, a helper operator so the default guard rule is a plain
  leaf. `installed_at` comes from `kv`.
- The spec lists operators for `has_codec`, `is_hdr`, `caption_available`,
  `has_share_link`, `downloaded` and `current_location` only by field name, with
  `current_location (eq)` explicit; the operator sets shown above for those fields are
  the nearest family (bool -> `eq`, enum -> `eq`/`in`) and are provisional.
- Duration shorthand in tables here (`14d`, `2 months`, `2 years`, `7d`) denotes the
  ISO-8601 forms (`P14D`, `P2M`, `P2Y`, `P7D`); stored ASTs use ISO-8601 or the
  `{days, months, years}` object.

### Evaluation

Evaluation is a pure function in `shared/`:

```
evaluate(video, sourcesFor(video), context{ now, installed_at, shareLinkCount, media })
  -> boolean
```

It is unit-tested exhaustively (every field, every operator, nested groups, NOT, empty
groups, time-anchor edge cases, regex guard). `domain/ruleEval.ts` loads inputs and
calls it; `domain/effective.ts` performs the merge and writes `video_effective`.

The rule list preview (`POST /api/rules/preview`) runs the same function over the
catalog and answers a match count plus a sample.

## Default rule set

Installed by migration at first init; all rules are editable and removable. Position
ascending = priority ascending. `G` is the global rule.

| # | Name | Condition | Effects |
| --- | --- | --- | --- |
| G | Global defaults | - | reclaim_priority -1; location = first location; media_mode video; format_policy prefer_av1; transcode { mode if_not_av1, codec hevc_nvenc, cq 28, preset p5, audio copy }; captions { all, auto true }; live vod_only; download_accounts sourcing; proxy none; recheck tiered; notify off |
| 1 | Expire: subscriptions after 2 weeks | source has_only [subscription, channel] AND first_seen(subscription or channel) age_gt 14d | reclaim_priority 0 |
| 2 | Expire: watched after 2 months | source has_none [liked, watch_later] AND source has_any [history] AND first_seen(history) age_gt 2 months | reclaim_priority 0 |
| 3 | Expire: liked after 2 years | source has_any [liked] AND source has_none [watch_later] AND first_seen(liked) age_gt 2 years | reclaim_priority 0 |
| 4 | Guard: no subscription backfill older than 7 days before install | source has_only [subscription, channel] AND upload_date before_install_minus 7d | reclaim_priority 0 |
| 5 | Captions: English only | (match all) | captions { languages [en], auto true } |
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

Per account, on a schedule driven by global settings (defaults: history + WL every 30
min, liked every 30 min, subscriptions list every 6 h, channel uploads every 30 min for
the newest 50 per channel, full channel scan daily for manual channels until caught
up):

- `ingest_history`: yt-dlp `https://www.youtube.com/feed/history --flat-playlist -J
  --playlist-end <N>`. N is adaptive: stop when a page is all known. Upserts
  `video_sources(history)`; `first_seen_at` = now for new entries.
- `ingest_watch_later`: yt-dlp `:ytwatchlater` flat, with removal detection. An entry
  no longer in Watch Later does NOT remove the source row; it only lets `last_seen_at`
  go stale (rules may use `last_seen`).
- `ingest_liked`: API `playlistItems.list LL`, 50 per page, walking until a known
  entry. `source_ts` = `snippet.publishedAt`.
- `ingest_subscriptions`: API `subscriptions.list mine` -> `channel_sources` rows of
  kind `subscription`, `subscribed_at` = `snippet.publishedAt`.
- `ingest_channel_uploads`: API `playlistItems.list UU...`, newest first;
  `video_sources(subscription | channel)` with `first_seen_at` = now. For a brand-new
  channel source, backfill pages until the guard rule would reject everything older,
  but still CREATE metadata-only records for those videos so they appear in the catalog
  as pri 0 and are rechecked on leftover budget. The deep backfill of a manual
  channel's full catalog runs in the `leftover` budget class, same as pri-0 rechecks:
  it must never starve live feeds, rechecks or downloads of API units.
- `recheck_batch`: see "Metadata history and rechecks".
- `takeout_import`: see below.

Each ingestion/recheck call consumes quota via `youtube/quota.ts` (see "Quota and
budgets"). The scheduler refuses to start a job whose budget class is exhausted;
pri-0 rechecks are class `leftover`.

Feed ingestion invokes yt-dlp with the account's decrypted cookie jar (0600 temp file,
refreshed jar written back after each run) and honors the account's request gap and
scrape budget. The yt-dlp `:ytsubs` subscriptions video feed MAY be used as an
optimisation for noticing new uploads cheaply; API `UU` polling stays the locked
source of truth (provisional, see "Open technical calls").

### Google Takeout importer

`POST /api/takeout` (multipart) accepts the Takeout `.zip` or individual
`watch-history.json`, playlist CSVs and `subscriptions.csv`:

- History entries -> `history` source with the real watch timestamp as `first_seen_at`
  (and `source_ts`); Watch Later / Liked playlists -> their sources; subscriptions ->
  channel sources.
- Idempotent. Logged as an Activity row with counts.
- Unknown videos are created as metadata-only records and queued for recheck; rules
  decide what happens next.
- History JSON entries carry `titleUrl` (with the video id) and `time`. Entries without
  `titleUrl` (ads, removed videos) are skipped and counted (provisional, see "Open
  technical calls").

The parsers are pure (in `shared/` or `domain/takeout.ts`) and unit-tested on synthetic
fixtures.

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

The `download` job runs per video, deduped by `video_id`. It respects the per-account
gap, the global concurrency (2), proxy selection, `delay_after_upload` and live status.

- It builds the yt-dlp argv from the effective settings: `-f` from `format_policy` plus
  `max_height` / `max_fps` (for example `prefer_av1` ->
  `bv*[vcodec^=av01][height<=H]+ba/bv*[height<=H]+ba/b`), `--cookies <tmp>`, `--proxy`,
  `--sleep-requests`, `--limit-rate`, `--write-info-json`, `--write-subs
  --write-auto-subs --sub-langs <list> --sub-format vtt --convert-subs vtt`,
  `--write-all-thumbnails`, `--no-overwrites`, `-o` into
  `<location>/.tmp/<videoId>/`, `--print-json`, the PO-token provider extractor-arg
  when configured, and the JS runtime flag (Node is in the image; the exact flag is
  verified against the installed yt-dlp's `--help`).
- On success: the non-media sidecars (info json, vtt, thumbnails) move from the
  location's `.tmp/` to `/data/meta/<channelId>/<videoId>/`; fsync; the video/audio file
  is atomically renamed into `<location>/<channelId>/<videoId>/`; `media` rows are
  inserted (`version` = 1 or the next; captions/info rows carry `location_id` NULL);
  the file is hashed; the refreshed cookie jar is written back; logs go to
  `/data/logs/jobs/<id>/`.
- On failure: attempts with backoff; a consecutive-failure counter feeds the error
  policy; a canary job runs if the threshold trips.
- `media_mode`: `audio_only` -> `-f ba` plus `-x` only when needed (best Opus/WebM,
  fallback m4a); `captions_only` and `metadata_only` skip media entirely (and need no
  location).
- Livestreams/premieres follow the `live` effect: default `vod_only` (track as
  upcoming/live, poll, download when the VOD is published); `record_live` uses
  `--live-from-start`.
- Cookies are passed as a path to a 0600 temp file, never inline. The argv of a run that
  carries a proxy URL is never logged unredacted. yt-dlp is spawned with an argv array,
  never a shell.

### Format and codec policy

The NAS GPU is a GTX 1650 SUPER (Turing): NVENC H.264/HEVC and NVDEC, NO AV1 encode.
Decision: download AV1 if YouTube offers it, otherwise transcode to NVENC HEVC (the
owner's devices play HEVC). Software SVT-AV1 is a rule option, not the default. NVENC
and NVDEC are detected at runtime and fall back to CPU; the self-check reports
availability; the rule UI offers `hevc_nvenc` / `h264_nvenc` only when present.

### Transcode

The `transcode` job (global concurrency 1) decides by `transcode.mode` plus the
downloaded vcodec (via ffprobe):

- NVENC HEVC: `ffmpeg -hwaccel cuda -hwaccel_output_format cuda -i in -c:v hevc_nvenc
  -preset p5 -cq 28 -c:a copy -movflags +faststart out.<ext>`.
- Software SVT-AV1: `-c:v libsvtav1 -preset 8 -crf 35`, run under `nice 19`.
- Container rule (provisional): keep the original audio; the output is `.mkv` when the
  audio is Opus and `.mp4` otherwise (see "Open technical calls").
- Verification: ffprobe on the output must show the expected streams and a duration
  within 1 s of the source. On success the job swaps the current media, DELETES the
  original and updates `media` (`transcoded_from` points at the source row). "Store
  both copies" applies to YouTube-side edits only (see versions below), never to
  transcodes.

### Move

The `move` job runs when the resolved `location_id` differs from the current media's:
copy with fsync, verify size and sha256, swap `media.location_id` / `rel_path`, unlink
the source. Media is MOVED, never re-downloaded, when the location changes (demote old
uploads to cold storage, promote a video that cleared a view threshold to SSD). The one
exception is media that the quota reaper already deleted: that is re-downloaded (unless
pri 0).

### Reap

The `reap` job runs per location, after each eval pass and on the hourly tick:

- Pri-0 current media is deleted immediately: the video/audio files and their `media`
  rows go; `video_changes`, captions, thumbnails and info json under `/data/meta`
  stay. A trashed video is exactly this case.
- Over-threshold locations (>= 95% of quota, or < 10 GB free on the underlying FS):
  delete the lowest `reclaim_priority` first, then the oldest `downloaded_at`, until
  under the low-water mark (90%). Pri -1 is never touched. Nothing under `/data` is
  ever reaped.
- If nothing reclaimable remains and the location is still over, downloads targeting
  that location pause and a rate-limited error notification fires.
- Media deleted by the reaper stays eligible for re-download later (except pri 0).
- Deleting a video never deletes its metadata, change history, thumbnails or captions;
  only the video/audio tracks.

### Versions (YouTube-side edits)

On recheck, if `duration_s` changes by more than 2 s, or the API reports a new
`contentDetails` signature, cellar schedules a re-download. The old current media
becomes `versions/v<N>/` (`is_current = 0`) and stays until reaped as part of the video
(same priority); the new download becomes current.

### Thumbnails and captions

Thumbnail variants fetched (provisional): `maxresdefault`, `sddefault`, `hqdefault`,
`mqdefault`, `default` (+ `hq720`). Each is hashed (sha256) and stored on change only,
under `/data/meta/<channelId>/<videoId>/thumbnails/<variant>-<sha>.jpg`, with a
`thumbnails` row. Captions are WebVTT files `<lang>.vtt` in the same meta directory,
with `media(kind = captions, lang)` rows. Default languages: all manual subtitle
languages plus auto-generated for the video's language; the default rule narrows to
English.

### Like/dislike ratio

Return YouTube Dislike API lookups (`https://returnyoutubedislikeapi.com/votes?
videoId=`) are ON by default, rate-limited and cached per recheck. The derived
`ryd_dislikes` / `ryd_ratio` are labelled "estimated" in the UI.

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
<location>/.tmp/<videoId>/                              # in-flight downloads
```

Everything that must survive a media delete and stay out of the quota lives under
`/data`:

```
/data/cellar.db (+ -wal, -shm)                          # state DB
/data/meta/<channelId>/<videoId>/info.json
/data/meta/<channelId>/<videoId>/<lang>.vtt             # captions
/data/meta/<channelId>/<videoId>/thumbnails/<variant>-<sha>.jpg
/data/bin/                                              # yt-dlp, ffmpeg, ffprobe (+ previous)
/data/logs/cellar.log                                   # pino-roll application log
/data/logs/jobs/<jobId>/                                # per-job debug data
/data/tmp/                                              # 0600 cookie temp files
```

Stable ids only, no titles in paths. Human-readable names live in the DB/UI and in
download filenames. `captions_only` / `metadata_only` modes therefore need no location.

## Quota and budgets

Two budgets are tracked and enforced, both configurable:

- Google API unit budget: 10,000 units/day by default (the Cloud project default),
  tracked in `quota_usage.api_units` per account per day. Units are charged per call by
  Google's table (`videos.list` with 50 ids = 1 unit; `playlistItems.list`,
  `subscriptions.list`, `channels.list` per Google's table).
- A self-imposed per-account scrape budget (requests/hour, `accounts.
  scrape_budget_per_hour`), tracked in `quota_usage.scrape_requests`, plus a 30 s
  minimum gap between yt-dlp runs per account and `--sleep-requests` 1-3 s.

Budget classes: live work (live feeds, rechecks of non-zero-priority videos,
downloads) draws from the main budget. The `leftover` class (pri-0 rechecks, deep
backfill of a manual channel's catalog, other low-value work) consumes only what the
main class leaves unused. The scheduler refuses to start a job whose class is exhausted
(a "quota gate"), so backfill can never starve live feeds, rechecks or downloads of API
units.

Per-account token buckets implement the gap and scrape budget (see "Jobs and
scheduler"). A jar that fails validation is skipped for downloads and flagged on the
Accounts page.

## Metadata history and rechecks

### One history store

Field-level diffs only. `video_changes` rows (`video_id`, `field`, `old_json`,
`new_json`, `seen_at`, `recheck_id`) are written when a tracked field differs from the
stored value. This is the ONE history store: counters (views, likes, comments, RYD
dislikes) are tracked fields too, so their diff rows ARE the time series. Anything else
the API exposes that differs on a recheck (description, length, privacy, tags,
category, formats, thumbnails URL, ...) is a tracked field. Every distinct thumbnail
URL/hash is saved to disk; every distinct title is retained via the diffs.

`video_stats` is a derived chart index. It exists only as an index rebuilt from
`video_changes`; if the charts can query `video_changes` fast enough, the table is
dropped (provisional, planner's call; recorded in "Open technical calls").

### Recheck cadence

Tiered by video age, configurable globally and per rule (`recheck_interval`): daily for
videos under 30 days old, weekly for under 1 year, monthly older. `videos.recheck_tier`
and `next_recheck_at` carry the schedule. Pri-0 videos recheck only on leftover budget.
A manual "Refresh and recheck all" rechecks every video.

### `recheck_batch`

- `videos.list` with 50 ids per call (1 unit).
- An id missing from the response is a recheck failure for that id:
  `consecutive_recheck_failures++`. A second consecutive miss, with other successes in
  the same window, marks the video gone (`gone_since` set; `privacy` records
  unlisted/private/removed/unavailable as the API says). Private vs removed vs
  region-blocked are distinguished when the API says so.
- Any API error for the WHOLE batch is an outage signal, not a per-video failure.
- Diffs go into `video_changes`; counters into `video_stats` (if kept); an RYD lookup is
  made; thumbnail variants are hashed and stored on change.
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
- Worker pools per class: `io` (API calls and feeds), `download` (2), `transcode` (1),
  `maintenance` (1).
- Per-account token buckets (the 30 s gap and the scrape budget), the quota gate
  (budget classes), a circuit breaker per class, and exponential backoff with jitter
  persisted in `run_after`.
- SSE `job.*` events on the `/api/events` bus; graceful SIGTERM: finish or requeue
  running jobs.
- Tick every 5 s. Hourly: eval pass -> reap. Daily: tool update check, self-check,
  stats rollup, log retention.

Job types: `ingest_history`, `ingest_watch_later`, `ingest_liked`,
`ingest_subscriptions`, `ingest_channel_uploads`, `recheck_batch`, `takeout_import`,
`download`, `transcode`, `move`, `reap`, plus maintenance jobs (eval pass, canary,
self-check, tool update, stats rollup, log retention).

Manual actions: `POST /api/actions/{refresh-all, eval-now, reap-now, ingest-now}`,
per-video download-now and recheck, and job cancel/retry from the Activity page.

## Notifications and error policy

### Delivery

Web Push / VAPID from the cellar UI (the mkvid / tracked / cameld pattern): the browser
subscribes (`POST /api/notifications/subscribe`, `GET /api/notifications/vapid-public-key`
serves the key); VAPID keys are generated at first boot and stored in `kv`; every
notification is also written to `notifications` and shown in an in-app inbox with
acknowledge (`acked_at`). `pushed_at` records push delivery. Subscriptions live in
`push_subscriptions`.

### Thresholds (all configurable global settings)

| Trigger | Rule |
| --- | --- |
| Download failures | 3 consecutive download failures across distinct videos, OR a pipeline failure plus canary failure while `https://youtube.com/favicon.ico` fetches fine |
| Account auth loss | the first confirmed 401 / invalid cookie for an account |
| Storage pressure | storage nearly full and unable to clear: once per 6 h |
| FS errors | immediately |
| Recheck outage | one "recheck pass failed" error notification, at most once per 6 h |
| Video gone | 2 consecutive recheck failures AND at least one other video succeeded in the same window |
| Proxy failing | after 3 consecutive failures of a proxy (it is skipped for 10 min) |
| Rule `notify` | up to N times (or unlimited) per video while the video meets the rule |

Every notification type is rate-limited to 1 per 6 h (`notification_state.last_sent_at`)
unless the previous one has been acknowledged.

### Canary

The known-good canary is `https://www.youtube.com/watch?v=dQw4w9WgXcQ`. A canary
download goes to a temp dir, uses the lowest-quality format, is discarded, and runs at
most once per hour. It distinguishes "this video failed" from "yt-dlp / YouTube is
broken": a pipeline failure together with a canary failure, while the favicon fetch
succeeds (so the network is fine), raises the error notification.

### Gone vs outage

A recheck pass that fails everything is an outage and never produces per-video "gone"
notifications. Private vs removed vs region-blocked is distinguished when the API says
so, and the notification text says which.

## Logging and debug data

- Application log: pino NDJSON to stdout plus pino-roll `/data/logs/cellar.log` (amber
  settings: 20m x 5). Redaction covers `cookie`, `authorization`,
  `cf-access-jwt-assertion`, `refresh_token`, `client_secret`, and proxy URLs.
- Per-job log files under `/data/logs/jobs/<jobId>/`: yt-dlp stdout/stderr, ffmpeg
  logs, and raw API response bodies (gzipped). Retained 14 days or a 2 GB cap (both
  settings); failed jobs are kept 60 days. Viewable in the Activity UI
  (`GET /api/jobs/:id/log`).
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

### Proxies

A global pool of named entries (URL stored encrypted, enable flag). Rules pick `none`,
`pool` round-robin, or specific entries. Proxies are applied to yt-dlp `--proxy` and
optionally to API calls, and are health-checked by the self-check. A failing proxy is
skipped for 10 min; a notification fires after 3 consecutive failures.

### PO-token sidecar

`brainicism/bgutil-ytdlp-pot-provider` runs as a sidecar on the app's internal network
(no published ports). The yt-dlp plugin is installed in the image. The provider URL is a
global setting defaulting to the sidecar (`http://bgutil:4416`, seeded from
`POT_PROVIDER_URL`). The self-check verifies it. The recommended combination against
the YouTube bot wall is cookies + PO token + a JS runtime.

### Tool updates

Official binaries live in `/data/bin`:

- The image installs yt-dlp (`yt-dlp_linux`, sha256-verified against `SHA2-256SUMS`),
  BtbN static ffmpeg/ffprobe (with libsvtav1 and NVENC) and the bgutil PO-token plugin
  under `/opt/cellar`. The server copies them to `/data/bin` at boot.
- A daily check downloads newer releases: yt-dlp from GitHub releases (sha256 verified),
  ffmpeg/ffprobe from the BtbN builds. The updater swaps atomically and keeps the
  previous version for rollback; the self-check and About page report versions.
  `POST /api/tools/update` triggers it on demand.
- Node (already in the image) is the JS runtime for yt-dlp's challenge solving; the
  exact flag (`--js-runtimes node` or the current equivalent) is verified against the
  installed version's `--help`.

### OAuth

OAuth client id/secret live in `.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`);
changing them needs `midclt call app.redeploy cellar`. `GET /api/oauth/google/start?
account=` begins the consent flow and `GET /api/oauth/google/callback` completes it,
storing the refresh token encrypted in `account_secrets`.

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
static assets under `/s/assets/`. Everything else under `/s` (including `/s` itself,
`/s/`, and any unknown path) returns the same 404 HTML with
`X-Robots-Tag: noindex, nofollow`.

| Route | Purpose |
| --- | --- |
| `GET /s/:token` | HTML share page (the public bundle's `share.html`) |
| `GET /s/:token/meta` | metadata JSON for the page |
| `GET /s/:token/video` | video stream (Range supported) |
| `GET /s/:token/audio` | audio |
| `GET /s/:token/captions/:lang` | WebVTT captions |
| `GET /s/:token/thumbnail` | thumbnail |
| `GET /s/:token/metadata.json` | downloadable metadata |
| `GET /s/assets/*` | static assets of the share bundle |

Rules for the public surface:

- Rate limited per IP (in-memory token bucket is fine). Responses carry
  `X-Robots-Tag: noindex, nofollow`, and the HTML carries `<meta name="robots"
  content="noindex">`.
- The public bundle is a second Vite entry: `web/share.html` -> `web/src/share.ts`,
  built into the same `web/dist` with its assets served at `/s/assets/`. It contains
  the player with captions and speed control, metadata, and download buttons for
  video / audio / captions / metadata JSON. It has no access to anything beyond
  `/s/:token/*`; it cannot read or change any setting.
- The admin SPA and all of `/api/*` stay fully behind Access.
- Access control happens at the edge too: a second Cloudflare Access application scoped
  to `cellar.maxhogan.dev/s` carries a Bypass Everyone policy; the app's own public
  prefixes are `/healthz` and `/s` (see "Security model").
- Every successful share view increments `access_count` and sets `last_access_at`.

### Admin side

`GET/POST /api/shares` list (paged, searchable/filterable/sortable, with expiry) and
create; revoke individually or in bulk (select-all revoke). The video detail page lists
and creates links for that video. The condition field `has_share_link` and the context
`shareLinkCount` let rules see whether a video has a link.

## Self-check

Runs on demand (button), at boot, and every 24 h. Results are stored with history
(`checks`) and shown as a status grid; failures emit notifications per the error
policy. Checks:

- each location: writable, free space, quota headroom;
- DB: `PRAGMA integrity_check`, WAL, migrations applied;
- yt-dlp and ffmpeg/ffprobe: present, versions, and a dry run (`yt-dlp --version`,
  `ffmpeg -version`, ffprobe on a bundled tiny sample);
- NVENC / NVDEC probe;
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
- Paged lists answer `{ rows, total, page, perPage }` (`page`, `perPage` <= 200, `sort`,
  `dir`, `q`, plus resource filters). Shapes are pinned in `shared/src/apiTypes.ts` and
  tested on both sides. The client zod-parses every response.
- Secrets are write-only: responses carry presence booleans (`hasCookies`,
  `hasRefreshToken`) and timestamps, never the secret.
- Rows marked "provisional shape" have a method/path the spec does not pin down.

### Admin API (auth: admin = valid CF Access JWT)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/healthz` | public | liveness for Docker and tunnel checks |
| GET | `/api/status` | admin | `{ version, insecureMode, startedAt, now, db: { ok, migrations }, tools: { ytdlp, ffmpeg } }` |
| GET | `/api/events` | admin | SSE stream: frames `{ type, at, payload }`, 25 s heartbeat, `job.*` events |
| GET | `/api/accounts` | admin | list accounts (status, quota, last ok times) |
| POST | `/api/accounts` | admin | create an account record |
| PATCH | `/api/accounts/:id` | admin | edit label, scrape budget, etc. |
| DELETE | `/api/accounts/:id` | admin | unlink an account |
| POST | `/api/accounts/:id/cookies` | admin | upload/paste a cookies.txt (validated, then encrypted) |
| GET | `/api/oauth/google/start?account=` | admin | begin Google OAuth consent for an account |
| GET | `/api/oauth/google/callback` | admin | OAuth redirect target (`PUBLIC_ORIGIN` + this path) |
| GET | `/api/channels` | admin | list subscribed and manual channels |
| POST | `/api/channels` | admin | add a manual channel by URL / handle / id |
| DELETE | `/api/channels/:id` | admin | remove a manual channel (provisional shape) |
| GET | `/api/videos` | admin | paged list: sort/filter/`q` (FTS)/source/account/status/location/date range |
| GET | `/api/videos/:id` | admin | one video with effective settings summary |
| GET | `/api/videos/:id/history` | admin | `video_changes` timeline |
| GET | `/api/videos/:id/stats` | admin | counter time series for charts |
| GET | `/api/videos/:id/media/:mediaId` | admin | stream a media file, HTTP Range supported |
| GET | `/api/videos/:id/captions/:lang` | admin | WebVTT captions |
| GET | `/api/videos/:id/thumbnail/:variant` | admin | stored thumbnail variant |
| POST | `/api/videos/:id/download-now` | admin | queue a download immediately |
| POST | `/api/videos/:id/recheck` | admin | queue a metadata recheck |
| POST | `/api/videos/trash` | admin | `{ ids[] }`: per-video override pri 0 + immediate pri-0 sweep |
| POST | `/api/videos/bulk-download` | admin | `{ ids[], template }` -> streamed ZIP (store, no compression) |
| PUT | `/api/videos/:id/overrides` | admin | set/clear the per-video `video` rule effects |
| GET | `/api/rules` | admin | list rules in order |
| POST | `/api/rules` | admin | create a custom rule |
| PATCH | `/api/rules/:id` | admin | edit a rule (condition, effects, enabled, name) |
| DELETE | `/api/rules/:id` | admin | delete a rule |
| PUT | `/api/rules/order` | admin | persist the drag-and-drop order |
| POST | `/api/rules/preview` | admin | evaluate a condition: match count + sample |
| GET | `/api/inspect?id=<identifier>` | admin | normalised id, matched rules in priority order, effective settings with provenance |
| GET | `/api/locations` | admin | list locations |
| POST | `/api/locations` | admin | register a location (path, label, quota, enabled) |
| PATCH | `/api/locations/:id` | admin | edit a location |
| DELETE | `/api/locations/:id` | admin | remove a location (provisional shape) |
| GET | `/api/locations/:id/usage` | admin | used bytes, free bytes, quota headroom |
| GET | `/api/proxies` | admin | list proxy pool entries (no URLs) |
| POST | `/api/proxies` | admin | add a proxy |
| PATCH | `/api/proxies/:id` | admin | edit/enable/disable a proxy |
| DELETE | `/api/proxies/:id` | admin | remove a proxy |
| GET | `/api/settings` | admin | sparse global overrides |
| PUT | `/api/settings` | admin | set overrides; a null value clears one |
| GET | `/api/shares` | admin | paged share links (search/filter/sort, expiry) |
| POST | `/api/shares` | admin | create a link for a video (optional expiry) |
| POST | `/api/shares/:token/revoke` | admin | revoke one link (provisional shape) |
| POST | `/api/shares/revoke` | admin | bulk / select-all revoke (provisional shape) |
| GET | `/api/notifications` | admin | inbox |
| POST | `/api/notifications/:id/ack` | admin | acknowledge (provisional shape) |
| POST | `/api/notifications/subscribe` | admin | store a Web Push subscription |
| GET | `/api/notifications/vapid-public-key` | admin | VAPID public key |
| GET | `/api/activity` | admin | paged activity log |
| GET | `/api/jobs` | admin | paged jobs |
| GET | `/api/jobs/:id/log` | admin | per-job log files |
| POST | `/api/jobs/:id/cancel` | admin | cancel a job (provisional shape) |
| POST | `/api/jobs/:id/retry` | admin | retry a job (provisional shape) |
| GET | `/api/checks` | admin | self-check history |
| POST | `/api/checks/run` | admin | run the self-check now |
| GET | `/api/stats/daily` | admin | pre-aggregated daily chart points |
| GET | `/api/tools` | admin | yt-dlp / ffmpeg versions |
| POST | `/api/tools/update` | admin | update tools now |
| POST | `/api/takeout` | admin | multipart upload of a Takeout zip / json / csv |
| POST | `/api/actions/refresh-all` | admin | recheck all metadata, re-evaluate every rule |
| POST | `/api/actions/eval-now` | admin | run an evaluation pass now |
| POST | `/api/actions/reap-now` | admin | run the reaper now |
| POST | `/api/actions/ingest-now` | admin | run ingestion now |

### Public API (auth: public; rate-limited per IP; noindex)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/s/:token` | public | share page HTML |
| GET | `/s/:token/meta` | public | share metadata JSON |
| GET | `/s/:token/video` | public | video stream |
| GET | `/s/:token/audio` | public | audio |
| GET | `/s/:token/captions/:lang` | public | captions |
| GET | `/s/:token/thumbnail` | public | thumbnail |
| GET | `/s/:token/metadata.json` | public | downloadable metadata |
| GET | `/s/assets/*` | public | static share bundle assets |
| ANY | `/s/<anything else>` | public | the identical 404 HTML, `X-Robots-Tag: noindex, nofollow` |

### Conventions

- `GET /api/status` is the contract the shell uses: `insecureMode` drives the red
  banner, `tools` feeds About, `db.migrations` shows the applied count.
- SSE frames carry a named `event:` line, are `{ type, at, payload }`, and the payload
  contract is pinned in `shared/src/apiTypes.ts` and tested on both sides. Event
  families: `job.*` (queued, started, progress, finished, failed), plus status,
  notification and catalog changes as the UI needs them. A publisher may attach extra
  diagnostic fields without breaking a client.
- Errors: `DomainError` -> HTTP map; JSON error bodies; 5xx with a fixed message.
- Bulk download: `POST /api/videos/bulk-download` streams a ZIP with store (no
  compression); filenames come from the template renderer in `shared/`. The UI warns
  above 20 GB; there is no cap. Downloads of video/audio/captions are served as-is, no
  server-side transcode or caption baking.
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
  router is case-sensitive. `/S/nope` therefore redirects to the Access login (302)
  while `/s/nope` is a 404 from the app. This is documented in
  `docs/setup-cloudflare.md`, with the curl checks.
- Secrets at rest: OAuth refresh tokens, cookie jars and proxy URLs are encrypted with
  AES-256-GCM under `CELLAR_SECRET_KEY` (64 hex characters in `.env`) via
  `security/secrets.ts`. Startup fails fast if the key is missing or malformed when
  secrets exist. Decrypted cookies only ever touch a 0600 file under `/data/tmp/`,
  deleted in `finally`.
- Never log argv containing cookies or proxy credentials. The pino redaction list covers
  `cookie`, `authorization`, `cf-access-jwt-assertion`, `refresh_token`,
  `client_secret` and proxy URLs. No secrets in argv, URLs, logs, API responses or
  error messages.
- yt-dlp is invoked with an argv array (no shell); extra args come only from an
  allowlist. Regex conditions are guarded (length limit plus an `re2`-style check or a
  timeout via worker).
- Share tokens: 16 random bytes base64url, plaintext in the DB (locked decision),
  uniform 404 for revoked/expired/unknown, per-IP rate limit, noindex headers, no
  directory listing. The public bundle has no API access beyond `/s/:token/*`.
- SSRF note: cellar fetches user-supplied channel/video identifiers, but identifiers
  are parsed to a normalised id first and yt-dlp / the Data API are only ever given
  YouTube ids, never arbitrary URLs. Proxy URLs are owner-configured.
- Container: non-root `3100:3100`, `cap_drop: [ALL]`, `no-new-privileges`, datasets
  `chmod 750` (see "Deployment").
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
passed to yt-dlp as `--plugin-dirs`.

Container environment (set in the image, not `.env`): `NODE_ENV=production`,
`DATA_DIR=/data`, `PORT=8080`, and `HOME=/data` (uid 3100 has no passwd entry, so
tools that resolve `$HOME` would otherwise fail).

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
| Videos | server-side datatable, FTS search, filters (source, account, status, location, date range), bulk select, trash icon, bulk download |
| Video detail | player (`<video>` with `<track>` captions and a speed menu), metadata, history timeline, stats chart, media files, share links, per-video overrides |
| Inspect | paste any identifier -> normalised id -> matched rules in priority order -> effective settings with per-key provenance -> edit per-video overrides |
| Rules | reorderable list (drag and drop) + builder + live preview |
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
priority; later = higher). Stored as a JSON AST validated by the shared zod schema.
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
- Fake yt-dlp and ffmpeg/ffprobe shims live in `scripts/fake-bin/` (scripts on PATH that
  emit canned JSON/progress and write dummy files) for integration tests of the job
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
  (typecheck, ESLint, Prettier check, `scripts/check-ascii.mjs`), `test` (Node 26,
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

Multi-stage `node:26-bookworm-slim`. The builder runs `npm ci`, builds shared -> server
-> web, then `npm prune --omit=dev`. The runtime stage installs apt `ca-certificates
curl` (plus whatever the tools need), and under `/opt/cellar` the baseline tool set:
yt-dlp (`yt-dlp_linux`, sha256-verified), BtbN ffmpeg + ffprobe, and the bgutil PO-token
plugin. At boot the server copies these to `/data/bin`, and the updater swaps newer
versions in atomically. Environment: `NODE_ENV=production DATA_DIR=/data PORT=8080
HOME=/data`. `VOLUME /data`. `HEALTHCHECK curl -fsS http://127.0.0.1:8080/healthz`.
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
    read_only: true          # with tmpfs below; dropped (and noted in SECURITY.md) if it
    tmpfs:                   #   does not coexist with the nvidia runtime
      - /tmp
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
  # sidecars (below): bgutil, cellar-watchtower
```

- Sidecars: `cellar-watchtower` (`containrrr/watchtower:latest`, `WATCHTOWER_CLEANUP=true
  LABEL_ENABLE=true POLL_INTERVAL=120 ROLLING_RESTART=true`, mounts
  `/var/run/docker.sock` and `/root/.docker/config.json:/config.json:ro`; the GHCR
  login already exists on the NAS) and `bgutil` (PO-token provider on the internal
  network at `http://bgutil:4416`, no published ports).
- No published ports: the Cloudflare tunnel reaches the container by DNS alias.
- GPU: reserved with the mkvid pattern (`deploy.resources.reservations.devices`);
  `NVIDIA_VISIBLE_DEVICES=all`, `NVIDIA_DRIVER_CAPABILITIES=video,compute,utility`.
  Docker's default runtime on the NAS is `nvidia`. The NAS GPU is a GTX 1650 SUPER.
- Created through `sudo midclt call app.create` with `custom_app: true` (the exact
  payload shape is a provisional call; the documented fallback is pasting the compose
  in the Apps UI).

### Container hardening

- Unique UID/GID `3100:3100` (not present on the NAS OS). Datasets are owned by it with
  `chmod 750`, so the `apps` user (568) and other non-root users cannot read cellar's
  files, and vice versa.
- `cap_drop: [ALL]` and only what is needed added back (expected: none);
  `security_opt: [no-new-privileges:true]`; `read_only: true` with `tmpfs: /tmp` if it
  works with the nvidia runtime (otherwise dropped, noted in `SECURITY.md`).
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
  Access; `/s/nope` -> 404 (not 302); `/S/nope` -> 302 (Access is case-insensitive, the
  router is not).
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

These are the technical calls spec section 12 leaves to the implementers. Each entry
lists the spec's recommendation, which this document adopts as the PROVISIONAL decision,
"provisional until an implementer records the final call" (in the commit or PR that
implements it, plus a doc update here).

| # | Call | Provisional decision |
| --- | --- | --- |
| 1 | Container for NVENC HEVC output (mp4 with aac re-encode vs mkv keeping opus) | Keep the original audio; use `.mkv` when the audio is Opus and `.mp4` otherwise. Browser playback of mkv/hevc is on the owner's devices. |
| 2 | Exact yt-dlp flags for the JS runtime and the PO-token provider on the installed version | Determined at build time from the installed yt-dlp's `--help` and the bgutil README (`--js-runtimes node` or the current equivalent; provider URL passed via the plugin's extractor-arg). |
| 3 | Whether `read_only: true` rootfs coexists with the nvidia runtime | Try it with `tmpfs: /tmp`; if it does not coexist, drop it and note the exception in `SECURITY.md`. |
| 4 | `midclt call app.create` payload shape for a custom compose app on TrueNAS 25.10 | `custom_app: true` with `custom_compose_config`; if the API refuses, fall back to documenting the UI paste. |
| 5 | Rate limiter for `/s` | Per-IP token bucket in memory. |
| 6 | FTS query parsing | Quote user input; prefix match on the last term. |
| 7 | Takeout history entries without `titleUrl` (ads, removed videos) | Skip them and count them (the activity row reports the count). |
| 8 | Thumbnail variants to fetch | `maxresdefault`, `sddefault`, `hqdefault`, `mqdefault`, `default` (+ `hq720`); hash each, store on change only. |
| 9 | Default `cq`/`preset` for hevc_nvenc and `crf`/`preset` for SVT-AV1 | The starting points stand: hevc_nvenc `cq 28` / `p5`; SVT-AV1 `crf 35` / preset 8. |
| 10 | Whether to also ingest `:ytsubs` as a cheaper way to notice new uploads than per-channel UU polling | API `UU` polling is the locked source of truth; the `:ytsubs` feed may be added later as an optimisation only. |
| 11 | (from spec 3.7) Whether `video_stats` exists | Exists only as a derived chart index rebuilt from `video_changes`; dropped if charts can query `video_changes` fast enough. |
