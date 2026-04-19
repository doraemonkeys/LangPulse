# CORS Intentionally Absent

## Decision

The Worker does not set any `Access-Control-Allow-*` headers and does not handle `OPTIONS` preflight. Public API routes (`/api/metadata`, `/api/quality/latest`, `/api/quality`, `/api/health`) assume same-origin access only.

## Why

`worker/wrangler.toml` serves the web bundle from `../web/dist` via the `[assets]` binding with `run_worker_first = ["/api/*", "/internal/*"]`. The frontend and API share one deployed origin, so browsers never issue cross-origin requests against the API in production. Adding CORS headers would be dead code that invites misuse (`*` wildcards, permissive branch in the error path) without serving a real consumer.

Internal ingest routes under `/internal/*` are called only by the Go collector with a Bearer token and are therefore never browser-facing; preflight support would be meaningless for them.

## How to apply

- Do not introduce `Access-Control-Allow-Origin` headers unless a specific external browser consumer is adopted.
- If that happens, the extension point is `worker/src/http.ts:jsonResponse` (and a sibling `optionsResponse` helper); apply only to the public `/api/*` read routes and drive allowed origins from an env-var whitelist — never `*` with credentials.
