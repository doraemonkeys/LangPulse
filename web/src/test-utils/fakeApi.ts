import type {
  CompareQueryInput,
  CompareResponse,
  LatestSnapshotResponse,
  MetadataResponse,
  QualityApi,
  SnapshotQueryInput,
  SnapshotResponse,
} from "../api/types";

export interface FakeApiOptions {
  metadata?: MetadataResponse;
  latest?: LatestSnapshotResponse;
  snapshotByKey?: Record<string, SnapshotResponse>;
  compareByKey?: Record<string, CompareResponse>;
  snapshotError?: Error;
  compareError?: Error;
}

function snapshotKey(date: string, threshold: number): string {
  return `${date}|${threshold}`;
}

function compareKey(input: CompareQueryInput): string {
  return `${[...input.languages].sort().join(",")}|${input.threshold}|${input.from}|${input.to}`;
}

export interface FakeApiRecorder {
  api: QualityApi;
  snapshotCalls: SnapshotQueryInput[];
  compareCalls: CompareQueryInput[];
}

export function createFakeApi(options: FakeApiOptions): FakeApiRecorder {
  const snapshotCalls: SnapshotQueryInput[] = [];
  const compareCalls: CompareQueryInput[] = [];

  const api: QualityApi = {
    async getMetadata() {
      if (options.metadata === undefined) throw new Error("metadata not configured");
      return options.metadata;
    },
    async getLatest() {
      return options.latest ?? { observed_date: null };
    },
    async getSnapshot(input) {
      snapshotCalls.push(input);
      if (options.snapshotError !== undefined) throw options.snapshotError;
      const response = options.snapshotByKey?.[snapshotKey(input.date, input.threshold)];
      if (response === undefined) {
        throw new Error(`no snapshot configured for ${input.date} @ ${input.threshold}`);
      }
      return response;
    },
    async getCompare(input) {
      compareCalls.push(input);
      if (options.compareError !== undefined) throw options.compareError;
      const response = options.compareByKey?.[compareKey(input)];
      if (response === undefined) {
        return {
          threshold: input.threshold,
          from: input.from,
          to: input.to,
          languages: input.languages.map((id) => ({ id, label: id })),
          series: [],
        };
      }
      return response;
    },
  };

  return { api, snapshotCalls, compareCalls };
}

export const SAMPLE_METADATA: MetadataResponse = {
  metric: "quality_30d_snapshot",
  timezone: "UTC",
  window_days: 30,
  launch_date: "2026-04-01",
  languages: [
    { id: "go", label: "Go", active_from: "2026-04-01", active_to: null },
    { id: "rust", label: "Rust", active_from: "2026-04-01", active_to: null },
    { id: "python", label: "Python", active_from: "2026-04-01", active_to: null },
  ],
  thresholds: [
    { value: 0, active_from: "2026-04-01", active_to: null },
    { value: 2, active_from: "2026-04-01", active_to: null },
    { value: 10, active_from: "2026-04-01", active_to: null },
  ],
};
