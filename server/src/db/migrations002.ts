/**
 * Migration 002: job queue, activity log, notifications, proxies, self-check
 * history. Appended by the orchestrator so wave 1 implementers share one
 * schema without touching migrations.ts concurrently.
 */
export const jobsAndNotifications = `
-- Persistent job queue (jobs/scheduler.ts). status: queued | running | done |
-- failed | cancelled. run_after gates retries with backoff.
CREATE TABLE jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  type         TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  priority     INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT    NOT NULL DEFAULT '{}',
  account_id   INTEGER NULL REFERENCES accounts (id) ON DELETE SET NULL,
  video_id     TEXT    NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_after    INTEGER NOT NULL DEFAULT 0,
  started_at   INTEGER NULL,
  finished_at  INTEGER NULL,
  error        TEXT    NULL,
  log_dir      TEXT    NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX jobs_status_run_after ON jobs (status, run_after, priority);
CREATE INDEX jobs_video ON jobs (video_id);
CREATE INDEX jobs_type_status ON jobs (type, status);

-- What the Activity page lists. level: debug | info | warn | error.
CREATE TABLE activity (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        INTEGER NOT NULL,
  level     TEXT    NOT NULL DEFAULT 'info',
  kind      TEXT    NOT NULL,
  message   TEXT    NOT NULL,
  video_id  TEXT    NULL,
  job_id    INTEGER NULL,
  data_json TEXT    NULL
);
CREATE INDEX activity_at ON activity (at DESC);
CREATE INDEX activity_video ON activity (video_id);

-- In-app notification inbox; pushed_at set once Web Push delivered it.
CREATE TABLE notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT    NOT NULL,
  title      TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  data_json  TEXT    NULL,
  video_id   TEXT    NULL,
  created_at INTEGER NOT NULL,
  acked_at   INTEGER NULL,
  pushed_at  INTEGER NULL
);
CREATE INDEX notifications_created ON notifications (created_at DESC);
CREATE INDEX notifications_unacked ON notifications (acked_at) WHERE acked_at IS NULL;

-- Per-type rate limiting (1 per 6 h unless acknowledged).
CREATE TABLE notification_state (
  type         TEXT    PRIMARY KEY,
  last_sent_at INTEGER NOT NULL
);

-- Web Push subscriptions from the admin browser.
CREATE TABLE push_subscriptions (
  endpoint   TEXT    PRIMARY KEY,
  keys_json  TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

-- Proxy pool. The URL (which may carry credentials) is AES-256-GCM encrypted
-- as one blob (IV || tag || ciphertext, security/secrets.ts); url_redacted is
-- the scheme://host:port form shown in the UI.
CREATE TABLE proxies (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  label         TEXT    NOT NULL UNIQUE,
  url_blob      BLOB    NOT NULL,
  url_redacted  TEXT    NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  fail_count    INTEGER NOT NULL DEFAULT 0,
  skipped_until INTEGER NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Self-check history. trigger: boot | schedule | manual.
CREATE TABLE checks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at       INTEGER NOT NULL,
  trigger      TEXT    NOT NULL,
  results_json TEXT    NOT NULL,
  ok           INTEGER NOT NULL CHECK (ok IN (0, 1))
);
CREATE INDEX checks_run_at ON checks (run_at DESC);
`;
