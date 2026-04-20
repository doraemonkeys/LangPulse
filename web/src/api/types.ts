export interface PublicLanguage {
  id: string;
  label: string;
  active_from: string;
  active_to: string | null;
}

export interface PublicThreshold {
  value: number;
  active_from: string;
  active_to: string | null;
}

export interface MetadataResponse {
  metric: string;
  timezone: string;
  window_days: number;
  launch_date: string;
  languages: PublicLanguage[];
  thresholds: PublicThreshold[];
}

export interface LatestSnapshotResponse {
  observed_date: string | null;
}

export interface SnapshotLanguageCount {
  id: string;
  label: string;
  count: number;
  previous_count: number | null;
}

export interface SnapshotResponse {
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

export interface CompareResponse {
  threshold: number;
  from: string;
  to: string;
  languages: CompareLanguageEntry[];
  series: CompareSeriesPoint[];
}

export interface SnapshotQueryInput {
  date: string;
  threshold: number;
  signal?: AbortSignal;
}

export interface CompareQueryInput {
  languages: string[];
  threshold: number;
  from: string;
  to: string;
  signal?: AbortSignal;
}

export interface QualityApi {
  getMetadata(signal?: AbortSignal): Promise<MetadataResponse>;
  getLatest(signal?: AbortSignal): Promise<LatestSnapshotResponse>;
  getSnapshot(input: SnapshotQueryInput): Promise<SnapshotResponse>;
  getCompare(input: CompareQueryInput): Promise<CompareResponse>;
}
