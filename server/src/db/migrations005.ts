/**
 * Migration 005: indexes on the timestamps the live hourly charts
 * (GET /api/stats/hourly) range over. Each series reads one hour window per
 * request, and the page refreshes itself, so these keep it a range seek
 * instead of a full scan of media, jobs (never pruned) and videos. The daily
 * rollup's downloaded_at, created_at and gone_since reads use them too.
 */
export const hourlyStatsIndexes = `
CREATE INDEX media_downloaded_at ON media (downloaded_at);
CREATE INDEX jobs_finished_at ON jobs (finished_at);
CREATE INDEX videos_created_at ON videos (created_at);
CREATE INDEX videos_gone_since ON videos (gone_since) WHERE gone_since IS NOT NULL;
-- quota_usage's key leads with account_id; the hourly scrape read ranges over day.
CREATE INDEX quota_usage_day ON quota_usage (day);
`;
