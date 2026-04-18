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

  const providedAuthorization = request.headers.get("authorization") ?? "";
  const expectedAuthorization = `${INTERNAL_AUTH_SCHEME} ${configuredToken}`;
  if (!constantTimeEquals(providedAuthorization, expectedAuthorization)) {
    throw new HttpError(401, "unauthorized", "Service authentication is required.");
  }
}

// Bytewise XOR accumulator avoids early-exit timing leaks on the bearer secret.
// TextEncoder is stable across Workers runtime and @cloudflare/vitest-pool-workers.
function constantTimeEquals(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) {
    return false;
  }

  let mismatch = 0;
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    mismatch |= leftBytes[index] ^ rightBytes[index];
  }

  return mismatch === 0;
}
