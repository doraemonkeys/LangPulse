# Collector Publication Boundary

## Decisions

- The scheduled collector workflow runs the collector process once for the target observed date.
- A nonzero collector exit fails the workflow immediately unless `/api/quality/latest` already exposes the target observed date.
- Publication polling is only for the post-success visibility check of `/api/quality/latest`; it does not rerun collection.

## Why

- Collector failures and public API visibility are different states. Treating a failed collector as "publication not visible yet" hides the failure cause and burns GitHub Actions minutes during fixed sleeps.
- The collector owns ingest run creation, row collection, and finalization. The workflow wrapper should only verify that the successful publication has become observable through the public API contract.
- Re-running the collector after a successful but not-yet-visible publication can turn a healthy run into a duplicate-ingest conflict. Polling latest preserves the idempotent boundary at the publication read model.
