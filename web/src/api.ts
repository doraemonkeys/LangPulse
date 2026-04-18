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

export interface QualityThreshold {
  threshold_value: number;
  count: number;
}

export interface QualitySeriesPoint {
  observed_date: string;
  observed_at: string;
  published_at: string;
  thresholds: QualityThreshold[];
}

export interface QualityResponse {
  language: {
    id: string;
    label: string;
  };
  from: string;
  to: string;
  series: QualitySeriesPoint[];
}

export interface QualityQueryInput {
  language: string;
  from: string;
  to: string;
  signal?: AbortSignal;
}

export interface QualityApi {
  getMetadata(): Promise<MetadataResponse>;
  getLatest(): Promise<LatestSnapshotResponse>;
  getQuality(input: QualityQueryInput): Promise<QualityResponse>;
}

interface ApiErrorPayload {
  error?: {
    code?: string;
    message?: string;
  };
}

export class ApiError extends Error {
  public readonly status: number;
  public readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function trimBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function readErrorMessage(response: Response): Promise<{ code?: string; message: string }> {
  try {
    const payload = await readJson<ApiErrorPayload>(response);
    const message = payload.error?.message;
    if (typeof message === "string" && message.length > 0) {
      return {
        code: payload.error?.code,
        message,
      };
    }
  } catch {
    // Public endpoints are expected to return JSON errors, but gateways may not.
  }

  return {
    message: `Request failed with status ${response.status}.`,
  };
}

async function fetchJson<T>(request: Promise<Response>): Promise<T> {
  const response = await request;
  if (!response.ok) {
    const { code, message } = await readErrorMessage(response);
    throw new ApiError(response.status, message, code);
  }

  return readJson<T>(response);
}

export function createQualityApi(baseUrl = ""): QualityApi {
  const normalizedBaseUrl = trimBaseUrl(baseUrl);

  return {
    getMetadata() {
      return fetchJson<MetadataResponse>(fetch(`${normalizedBaseUrl}/api/metadata`));
    },
    getLatest() {
      return fetchJson<LatestSnapshotResponse>(fetch(`${normalizedBaseUrl}/api/quality/latest`));
    },
    getQuality(input) {
      const params = new URLSearchParams({
        language: input.language,
        from: input.from,
        to: input.to,
      });

      return fetchJson<QualityResponse>(
        fetch(`${normalizedBaseUrl}/api/quality?${params.toString()}`, { signal: input.signal }),
      );
    },
  };
}
