import { INTERNAL_AUTH_SCHEME } from "./constants";
import { HttpError } from "./http";
import type { WorkerEnv } from "./types";

export function requireServiceAuth(request: Request, env: WorkerEnv): void {
  const configuredToken = env.INTERNAL_API_TOKEN?.trim();
  if (!configuredToken) {
    throw new HttpError(
      500,
      "internal_api_token_not_configured",
      "INTERNAL_API_TOKEN must be configured for internal ingest routes.",
    );
  }

  const providedAuthorization = request.headers.get("authorization");
  const expectedAuthorization = `${INTERNAL_AUTH_SCHEME} ${configuredToken}`;
  if (providedAuthorization !== expectedAuthorization) {
    throw new HttpError(401, "unauthorized", "Service authentication is required.");
  }
}
