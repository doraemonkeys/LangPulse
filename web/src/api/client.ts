import type {
  CompareQueryInput,
  CompareResponse,
  LatestSnapshotResponse,
  MetadataResponse,
  QualityApi,
  SnapshotQueryInput,
  SnapshotResponse,
} from "./types";

interface ApiErrorPayload {
  error?: { code?: string; message?: string };
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

async function readErrorMessage(response: Response): Promise<{ code?: string; message: string }> {
  try {
    const payload = (await response.json()) as ApiErrorPayload;
    const message = payload.error?.message;
    if (typeof message === "string" && message.length > 0) {
      return { code: payload.error?.code, message };
    }
  } catch {
    // Public endpoints are expected to return JSON errors, but gateways may not.
  }

  return { message: `Request failed with status ${response.status}.` };
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    const { code, message } = await readErrorMessage(response);
    throw new ApiError(response.status, message, code);
  }

  return (await response.json()) as T;
}

export function createQualityApi(baseUrl = ""): QualityApi {
  const base = trimBaseUrl(baseUrl);

  return {
    getMetadata(signal) {
      return fetchJson<MetadataResponse>(`${base}/api/metadata`, signal);
    },
    getLatest(signal) {
      return fetchJson<LatestSnapshotResponse>(`${base}/api/quality/latest`, signal);
    },
    getSnapshot(input: SnapshotQueryInput) {
      const params = new URLSearchParams({
        date: input.date,
        threshold: String(input.threshold),
      });
      return fetchJson<SnapshotResponse>(
        `${base}/api/quality/snapshot?${params.toString()}`,
        input.signal,
      );
    },
    getCompare(input: CompareQueryInput) {
      const params = new URLSearchParams({
        languages: input.languages.join(","),
        threshold: String(input.threshold),
        from: input.from,
        to: input.to,
      });
      return fetchJson<CompareResponse>(
        `${base}/api/quality/compare?${params.toString()}`,
        input.signal,
      );
    },
  };
}
