export const TEST_SCHEMA_STATEMENTS = [
  "DROP TABLE IF EXISTS quality_30d_publications",
  "DROP TABLE IF EXISTS quality_30d_run_rows",
  "DROP TABLE IF EXISTS quality_30d_runs",
  `CREATE TABLE quality_30d_runs (
    run_id             TEXT NOT NULL PRIMARY KEY,
    observed_date      TEXT NOT NULL,
    attempt_no         INTEGER NOT NULL,
    observed_at        TEXT NOT NULL,
    status             TEXT NOT NULL,
    lease_expires_at   TEXT NOT NULL,
    last_heartbeat_at  TEXT NOT NULL,
    expected_rows      INTEGER NOT NULL,
    actual_rows        INTEGER NOT NULL DEFAULT 0,
    error_summary      TEXT,
    started_at         TEXT NOT NULL,
    finished_at        TEXT,
    UNIQUE (observed_date, attempt_no)
  )`,
  `CREATE TABLE quality_30d_run_rows (
    run_id            TEXT NOT NULL,
    language_id       TEXT NOT NULL,
    threshold_value   INTEGER NOT NULL,
    count             INTEGER NOT NULL,
    collected_at      TEXT NOT NULL,
    PRIMARY KEY (run_id, language_id, threshold_value),
    FOREIGN KEY (run_id) REFERENCES quality_30d_runs(run_id)
  )`,
  `CREATE TABLE quality_30d_publications (
    observed_date     TEXT NOT NULL PRIMARY KEY,
    run_id            TEXT NOT NULL UNIQUE,
    published_at      TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES quality_30d_runs(run_id)
  )`,
  `CREATE UNIQUE INDEX idx_quality_running_date
    ON quality_30d_runs(observed_date)
    WHERE status = 'running'`,
  `CREATE INDEX idx_quality_runs_date_status
    ON quality_30d_runs(observed_date, status)`,
  `CREATE INDEX idx_quality_rows_run_language_threshold
    ON quality_30d_run_rows(run_id, language_id, threshold_value)`,
];
