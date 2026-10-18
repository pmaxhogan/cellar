/**
 * Migration 003: the catalog (channels, videos, sources, history, media),
 * rules and effective settings, quotas, daily stats, share links and FTS.
 * Appended by the orchestrator (spec 4.2). Column semantics are documented in
 * docs/ARCHITECTURE.md "Data model".
 */
export const catalog = `
-- Channels (id = UC...).
CREATE TABLE channels (
  id                  TEXT    PRIMARY KEY,
  title               TEXT    NULL,
  handle              TEXT    NULL,
  uploads_playlist_id TEXT    NULL,
  thumbnail_url       TEXT    NULL,
  first_seen_at       INTEGER NOT NULL,
  last_checked_at     INTEGER NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- Why a channel is tracked. kind: subscription (per account) | manual
-- (account_id NULL). The unique index uses COALESCE so NULL account ids
-- collapse instead of being distinct as SQLite treats NULLs in a plain UNIQUE.
CREATE TABLE channel_sources (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id    TEXT    NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  account_id    INTEGER NULL REFERENCES accounts (id) ON DELETE CASCADE,
  kind          TEXT    NOT NULL CHECK (kind IN ('subscription', 'manual')),
  subscribed_at INTEGER NULL,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX channel_sources_unique
  ON channel_sources (channel_id, COALESCE(account_id, 0), kind);

-- The catalog. type: video | short | livestream | premiere.
-- privacy: public | unlisted | private | removed | unavailable.
-- content_signature: hash of contentDetails fields used to detect re-edits.
CREATE TABLE videos (
  id                           TEXT    PRIMARY KEY,
  channel_id                   TEXT    NULL REFERENCES channels (id),
  title                        TEXT    NULL,
  description                  TEXT    NULL,
  upload_date                  INTEGER NULL,
  published_at                 INTEGER NULL,
  duration_s                   INTEGER NULL,
  type                         TEXT    NULL,
  live_status                  TEXT    NULL,
  privacy                      TEXT    NULL,
  gone_since                   INTEGER NULL,
  consecutive_recheck_failures INTEGER NOT NULL DEFAULT 0,
  views                        INTEGER NULL,
  likes                        INTEGER NULL,
  comments                     INTEGER NULL,
  ryd_dislikes                 INTEGER NULL,
  ryd_ratio                    REAL    NULL,
  tags_json                    TEXT    NULL,
  category_id                  TEXT    NULL,
  default_language             TEXT    NULL,
  caption_available            INTEGER NULL,
  max_height                   INTEGER NULL,
  has_av1                      INTEGER NULL,
  has_vp9                      INTEGER NULL,
  has_h264                     INTEGER NULL,
  max_fps                      INTEGER NULL,
  is_hdr                       INTEGER NULL,
  formats_json                 TEXT    NULL,
  content_signature            TEXT    NULL,
  last_recheck_at              INTEGER NULL,
  next_recheck_at              INTEGER NULL,
  recheck_tier                 TEXT    NULL,
  created_at                   INTEGER NOT NULL,
  updated_at                   INTEGER NOT NULL
);
CREATE INDEX videos_channel ON videos (channel_id);
CREATE INDEX videos_next_recheck ON videos (next_recheck_at);
CREATE INDEX videos_upload_date ON videos (upload_date DESC);
CREATE INDEX videos_privacy ON videos (privacy);

-- Where a video came from. source: history | watch_later | liked |
-- subscription | channel. origin: live_feed | api | takeout.
CREATE TABLE video_sources (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id      TEXT    NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
  account_id    INTEGER NULL REFERENCES accounts (id) ON DELETE CASCADE,
  source        TEXT    NOT NULL
    CHECK (source IN ('history', 'watch_later', 'liked', 'subscription', 'channel')),
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  source_ts     INTEGER NULL,
  origin        TEXT    NOT NULL DEFAULT 'live_feed'
);
CREATE UNIQUE INDEX video_sources_unique
  ON video_sources (video_id, COALESCE(account_id, 0), source);
CREATE INDEX video_sources_account_source ON video_sources (account_id, source, last_seen_at);

-- Field level history: the one store for everything that changed.
CREATE TABLE video_changes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id   TEXT    NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
  recheck_id INTEGER NULL,
  field      TEXT    NOT NULL,
  old_json   TEXT    NULL,
  new_json   TEXT    NULL,
  seen_at    INTEGER NOT NULL
);
CREATE INDEX video_changes_video ON video_changes (video_id, seen_at);

-- Derived counter index for charts (rebuildable from video_changes).
CREATE TABLE video_stats (
  video_id     TEXT    NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
  at           INTEGER NOT NULL,
  views        INTEGER NULL,
  likes        INTEGER NULL,
  comments     INTEGER NULL,
  ryd_dislikes INTEGER NULL,
  PRIMARY KEY (video_id, at)
);

-- Every distinct thumbnail variant ever seen, stored under /data/meta.
CREATE TABLE thumbnails (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id      TEXT    NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
  variant       TEXT    NOT NULL,
  url           TEXT    NOT NULL,
  sha256        TEXT    NOT NULL,
  path          TEXT    NOT NULL,
  first_seen_at INTEGER NOT NULL,
  UNIQUE (video_id, variant, sha256)
);

-- Files on disk. kind: video | audio | captions | info. location_id NULL means
-- the file lives under /data/meta (captions, info) and is never reaped.
CREATE TABLE media (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id        TEXT    NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
  kind            TEXT    NOT NULL CHECK (kind IN ('video', 'audio', 'captions', 'info')),
  version         INTEGER NOT NULL DEFAULT 1,
  is_current      INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
  location_id     INTEGER NULL REFERENCES locations (id),
  rel_path        TEXT    NOT NULL,
  size_bytes      INTEGER NOT NULL DEFAULT 0,
  sha256          TEXT    NULL,
  vcodec          TEXT    NULL,
  acodec          TEXT    NULL,
  height          INTEGER NULL,
  fps             REAL    NULL,
  bitrate         INTEGER NULL,
  lang            TEXT    NULL,
  downloaded_at   INTEGER NULL,
  transcoded_from TEXT    NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX media_video ON media (video_id, kind, is_current);
CREATE INDEX media_location ON media (location_id, is_current);

-- Rules. kind: global (exactly one) | custom (ordered by position) | video
-- (one per video_id). condition_json is the shared AST (NULL = match all).
CREATE TABLE rules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT    NOT NULL CHECK (kind IN ('global', 'custom', 'video')),
  video_id       TEXT    NULL,
  position       INTEGER NOT NULL DEFAULT 0,
  name           TEXT    NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  condition_json TEXT    NULL,
  effects_json   TEXT    NOT NULL DEFAULT '{}',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX rules_video_unique ON rules (video_id) WHERE kind = 'video';
CREATE INDEX rules_kind_position ON rules (kind, position);

-- Resolved effective settings per video (shared/rules merge output).
CREATE TABLE video_effective (
  video_id         TEXT    PRIMARY KEY REFERENCES videos (id) ON DELETE CASCADE,
  effective_json   TEXT    NOT NULL,
  provenance_json  TEXT    NOT NULL,
  matched_rule_ids TEXT    NOT NULL,
  evaluated_at     INTEGER NOT NULL,
  next_eval_at     INTEGER NULL,
  reclaim_priority INTEGER NOT NULL,
  location_id      INTEGER NULL,
  include          INTEGER NOT NULL CHECK (include IN (0, 1))
);
CREATE INDEX video_effective_next ON video_effective (next_eval_at);
CREATE INDEX video_effective_pri ON video_effective (location_id, reclaim_priority);

CREATE TABLE rule_notify_counts (
  rule_id  INTEGER NOT NULL REFERENCES rules (id) ON DELETE CASCADE,
  video_id TEXT    NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (rule_id, video_id)
);

-- Daily budgets. day is YYYY-MM-DD in UTC. account_id 0 = project wide.
CREATE TABLE quota_usage (
  account_id      INTEGER NOT NULL DEFAULT 0,
  day             TEXT    NOT NULL,
  api_units       INTEGER NOT NULL DEFAULT 0,
  scrape_requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, day)
);

-- Pre-aggregated chart points (daily rollup). location_id 0 = all locations.
CREATE TABLE stats_daily (
  day         TEXT    NOT NULL,
  location_id INTEGER NOT NULL DEFAULT 0,
  bytes_used  INTEGER NOT NULL DEFAULT 0,
  downloads   INTEGER NOT NULL DEFAULT 0,
  catalog     INTEGER NOT NULL DEFAULT 0,
  gone        INTEGER NOT NULL DEFAULT 0,
  api_units   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, location_id)
);

-- Public share links. token = 16 random bytes base64url (22 chars), plaintext
-- by owner decision. expires_at NULL = never.
CREATE TABLE share_links (
  token          TEXT    PRIMARY KEY,
  video_id       TEXT    NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
  expires_at     INTEGER NULL,
  revoked_at     INTEGER NULL,
  access_count   INTEGER NOT NULL DEFAULT 0,
  last_access_at INTEGER NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX share_links_video ON share_links (video_id);

-- Full text search over the catalog (contentless fts5, kept in sync by the
-- triggers below; channel_title is joined from channels at trigger time, so a
-- channel rename needs a domain-level reindex of that channel's videos).
CREATE VIRTUAL TABLE videos_fts USING fts5 (
  id UNINDEXED,
  title,
  description,
  channel_title,
  tags,
  content = '',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER videos_fts_ai AFTER INSERT ON videos BEGIN
  INSERT INTO videos_fts (rowid, id, title, description, channel_title, tags)
  VALUES (
    new.rowid, new.id, COALESCE(new.title, ''), COALESCE(new.description, ''),
    COALESCE((SELECT title FROM channels WHERE id = new.channel_id), ''),
    COALESCE(new.tags_json, '')
  );
END;
CREATE TRIGGER videos_fts_ad AFTER DELETE ON videos BEGIN
  INSERT INTO videos_fts (videos_fts, rowid, id, title, description, channel_title, tags)
  VALUES ('delete', old.rowid, old.id, COALESCE(old.title, ''), COALESCE(old.description, ''),
    COALESCE((SELECT title FROM channels WHERE id = old.channel_id), ''),
    COALESCE(old.tags_json, ''));
END;
CREATE TRIGGER videos_fts_au AFTER UPDATE OF title, description, channel_id, tags_json ON videos BEGIN
  INSERT INTO videos_fts (videos_fts, rowid, id, title, description, channel_title, tags)
  VALUES ('delete', old.rowid, old.id, COALESCE(old.title, ''), COALESCE(old.description, ''),
    COALESCE((SELECT title FROM channels WHERE id = old.channel_id), ''),
    COALESCE(old.tags_json, ''));
  INSERT INTO videos_fts (rowid, id, title, description, channel_title, tags)
  VALUES (new.rowid, new.id, COALESCE(new.title, ''), COALESCE(new.description, ''),
    COALESCE((SELECT title FROM channels WHERE id = new.channel_id), ''),
    COALESCE(new.tags_json, ''));
END;
`;
