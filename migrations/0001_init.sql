-- Runs own the retry and lease lifecycle so failed attempts remain auditable
-- without leaking into published reads.
CREATE TABLE quality_30d_runs (
    run_id             TEXT NOT NULL PRIMARY KEY,
    observed_date      TEXT NOT NULL CHECK (observed_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    attempt_no         INTEGER NOT NULL CHECK (attempt_no >= 1),
    observed_at        TEXT NOT NULL,
    status             TEXT NOT NULL CHECK (status IN ('running', 'failed', 'expired', 'complete')),
    lease_expires_at   TEXT NOT NULL,
    last_heartbeat_at  TEXT NOT NULL,
    expected_rows      INTEGER NOT NULL CHECK (expected_rows >= 0),
    actual_rows        INTEGER NOT NULL DEFAULT 0 CHECK (actual_rows >= 0 AND actual_rows <= expected_rows),
    error_summary      TEXT,
    started_at         TEXT NOT NULL,
    finished_at        TEXT,
    CHECK (finished_at IS NULL OR finished_at >= started_at),
    UNIQUE (observed_date, attempt_no)
);

-- Rows are keyed by the product dimensions so the ingest path can upsert one
-- observed result per language-threshold query.
CREATE TABLE quality_30d_run_rows (
    run_id            TEXT NOT NULL,
    language_id       TEXT NOT NULL,
    threshold_value   INTEGER NOT NULL CHECK (threshold_value >= 0),
    count             INTEGER NOT NULL CHECK (count >= 0),
    collected_at      TEXT NOT NULL,
    PRIMARY KEY (run_id, language_id, threshold_value),
    FOREIGN KEY (run_id) REFERENCES quality_30d_runs(run_id)
);

-- Publications freeze the single public winner for an observed UTC date.
CREATE TABLE quality_30d_publications (
    observed_date     TEXT NOT NULL PRIMARY KEY CHECK (observed_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    run_id            TEXT NOT NULL UNIQUE,
    published_at      TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES quality_30d_runs(run_id)
);

CREATE UNIQUE INDEX idx_quality_running_date
    ON quality_30d_runs(observed_date)
    WHERE status = 'running';

CREATE INDEX idx_quality_runs_date_status
    ON quality_30d_runs(observed_date, status);

CREATE INDEX idx_quality_rows_run_language_threshold
    ON quality_30d_run_rows(run_id, language_id, threshold_value);
