/**
 * Ordered migrations. Never edit one that has shipped; append a new entry.
 * The runner applies each pending migration inside its own transaction.
 *
 * Every timestamp column is epoch milliseconds (INTEGER). Rows seeded from SQL
 * use unixepoch('subsec') * 1000, the closest SQLite gets to Date.now().
 */
import { jobsAndNotifications } from "./migrations002.ts";
import { catalog } from "./migrations003.ts";
import { titleChangesIndex } from "./migrations004.ts";
import { hourlyStatsIndexes } from "./migrations005.ts";

export interface Migration {
  readonly name: string;
  readonly sql: string;
}

const init = `
-- Global settings registry: one JSON encoded value per key, validated against
-- the shared registry. Absent key = registry default.
CREATE TABLE settings (
  key        TEXT    PRIMARY KEY,
  value_json TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Small server owned state: installed_at, tool_versions, VAPID keys, ...
CREATE TABLE kv (
  key        TEXT    PRIMARY KEY,
  value_json TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Storage locations under the container's /media (or other mounts).
-- quota_bytes 0 means unlimited until the owner sets one.
CREATE TABLE locations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  label          TEXT    NOT NULL UNIQUE,
  container_path TEXT    NOT NULL UNIQUE,
  quota_bytes    INTEGER NOT NULL DEFAULT 0 CHECK (quota_bytes >= 0),
  enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  used_bytes     INTEGER NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  fs_free_bytes  INTEGER NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- Always seeded. When /media is not mounted the self-check flags it, which is
-- clearer than an empty locations page.
INSERT INTO locations (label, container_path, quota_bytes, enabled, created_at, updated_at)
VALUES (
  'media',
  '/media',
  0,
  1,
  CAST(unixepoch('subsec') * 1000 AS INTEGER),
  CAST(unixepoch('subsec') * 1000 AS INTEGER)
);

-- Linked Google accounts. status is free text on purpose: its value set is
-- owned by domain/accounts.ts, and a CHECK here would need a table rebuild to
-- extend.
CREATE TABLE accounts (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  label                  TEXT    NOT NULL,
  google_sub             TEXT    NULL UNIQUE,
  email                  TEXT    NULL,
  channel_id             TEXT    NULL,
  status                 TEXT    NOT NULL DEFAULT 'new',
  api_quota_reserved     INTEGER NOT NULL DEFAULT 0 CHECK (api_quota_reserved >= 0),
  scrape_budget_per_hour INTEGER NULL
    CHECK (scrape_budget_per_hour IS NULL OR scrape_budget_per_hour >= 0),
  last_api_ok_at         INTEGER NULL,
  last_cookie_ok_at      INTEGER NULL,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

-- AES-256-GCM under CELLAR_SECRET_KEY (security/secrets.ts). The IV and the
-- auth tag are stored in their own columns next to the ciphertext.
CREATE TABLE account_secrets (
  account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL CHECK (kind IN ('oauth_refresh', 'cookies')),
  ciphertext BLOB    NOT NULL,
  iv         BLOB    NOT NULL,
  tag        BLOB    NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, kind)
);
`;

export const migrations: readonly Migration[] = [
  { name: "001_init", sql: init },
  { name: "002_jobs_notifications", sql: jobsAndNotifications },
  { name: "003_catalog", sql: catalog },
  { name: "004_title_changes_index", sql: titleChangesIndex },
  { name: "005_hourly_stats_indexes", sql: hourlyStatsIndexes },
];
