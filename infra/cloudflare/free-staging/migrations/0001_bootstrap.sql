-- Applies only to the isolated icop-staging-db (Cloudflare D1 / SQLite).
-- No production credentials, users, tenants, or test/dummy customer records.
CREATE TABLE IF NOT EXISTS migration_history (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO migration_history (version)
VALUES ('0001_cf_free_staging_bootstrap');
