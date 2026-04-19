export interface ErrorPayload {
  error: {
    code: string;
    message: string;
    details: Record<string, unknown> | undefined;
  };
}

export class HttpError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(payload), {
    ...init,
    headers,
  });
}

export function errorResponse(error: HttpError): Response {
  const payload: ErrorPayload = {
    error: {
      code: error.code,
      message: error.message,
      details: error.details,
    },
  };

  return jsonResponse(payload, { status: error.status });
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must contain valid JSON.");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "invalid_json", "Request body must be a JSON object.");
  }

  return parsed as Record<string, unknown>;
}
