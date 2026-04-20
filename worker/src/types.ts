export type MetricId = "quality_30d_snapshot";
export type Timezone = "UTC";

export interface WorkerEnv {
  DB: D1Database;
  INTERNAL_API_TOKEN: string;
  RUN_LEASE_DURATION_SECONDS?: string;
  HEALTH_RATE_LIMITER: RateLimit;
}

export interface LanguageRegistryEntry {
  id: string;
  label: string;
  github_query_fragment: string;
  active_from: string;
  active_to: string | null;
}

export interface ThresholdRegistryEntry {
  value: number;
  active_from: string;
  active_to: string | null;
}

export interface MetricsRegistry {
  timezone: Timezone;
  window_days: number;
  launch_date: string;
  languages: LanguageRegistryEntry[];
  thresholds: ThresholdRegistryEntry[];
}

export interface PublicLanguageEntry {
  id: string;
  label: string;
  active_from: string;
  active_to: string | null;
}

export interface PublicThresholdEntry {
  value: number;
  active_from: string;
  active_to: string | null;
}

export const RUN_STATUSES = {
  running: "running",
  failed: "failed",
  expired: "expired",
  complete: "complete",
} as const;

export type RunStatus = (typeof RUN_STATUSES)[keyof typeof RUN_STATUSES];

export interface QualityRunRecord {
  run_id: string;
  observed_date: string;
  attempt_no: number;
  observed_at: string;
  status: RunStatus;
  lease_expires_at: string;
  last_heartbeat_at: string;
  expected_rows: number;
  actual_rows: number;
  error_summary: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface QualityRunRowRecord {
  run_id: string;
  language_id: string;
  threshold_value: number;
  count: number;
  collected_at: string;
}

export interface QualityPublicationRecord {
  observed_date: string;
  run_id: string;
  published_at: string;
}

export interface RuntimeDependencies {
  now: () => Date;
  randomUUID: () => string;
  registry: MetricsRegistry;
  runLeaseDurationSeconds: number;
}

export interface RequestContext {
  env: WorkerEnv;
  runtime: RuntimeDependencies;
}

export interface CreateQualityRunRequest {
  observed_date: string;
  expected_rows: number;
}

export interface UpsertQualityRunRowRequest {
  count: number;
  collected_at: string;
}

export interface FinalizeQualityRunRequest {
  status: "complete" | "failed";
  error_summary?: string | null;
}

export interface SnapshotLanguageCount {
  id: string;
  label: string;
  count: number;
  previous_count: number | null;
}

export interface QualitySnapshotResponse {
  observed_date: string;
  threshold: number;
  previous_date: string | null;
  languages: SnapshotLanguageCount[];
}

export interface CompareLanguageEntry {
  id: string;
  label: string;
}

export interface CompareSeriesPoint {
  observed_date: string;
  counts: Record<string, number>;
}

export interface QualityCompareResponse {
  threshold: number;
  from: string;
  to: string;
  languages: CompareLanguageEntry[];
  series: CompareSeriesPoint[];
}
