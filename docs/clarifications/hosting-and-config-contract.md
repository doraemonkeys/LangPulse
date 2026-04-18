# Hosting And Config Contract

## Decisions

- Production hosting is Cloudflare-only. The deployed Worker serves both the public API and the frontend static assets from one origin.
- The frontend uses same-origin `/api/*` calls in production. CI builds the web bundle before deploying the Worker so the deployed asset graph and API routes remain coupled.
- `github_query_fragment` is the full GitHub search fragment owned by configuration. Collector code appends shared qualifiers such as `is:public`, `fork:true`, `pushed`, and `stars`, but it does not synthesize the language qualifier.
- `metrics.json` strings are canonical configuration, not user input. Leading or trailing whitespace is invalid and must be rejected instead of trimmed.
- `language.id` remains a stable slug and `active_from` must not precede `launch_date` for either languages or thresholds.
- Repository-wide validation is expressed through root-level `make` targets. `make ci` remains the local full-contract entry point, while GitHub `Validate` splits the `sloc-guard` policy into its dedicated action job and runs the remaining checks through `make ci-core`.

## Why

- Splitting static hosting and API hosting created an implicit base-URL dependency that the repository did not encode, so production correctness depended on out-of-band Cloudflare setup.
- Treating the collector query field as a bare language token made the config contract lie about what it could express and would silently break multi-word or syntax-sensitive GitHub queries.
- Silent trimming let different runtimes reinterpret the same config differently. Rejecting non-canonical strings keeps the public ID space and collector semantics deterministic.
- The previous documentation implied a root Go command that did not actually cover the collector module, which made the repo contract harder to reason about than the real CI path.
- `sloc-guard` produces GitHub-native diagnostics and SARIF more naturally through its upstream action than through repository-owned install glue, so the workflow should orchestrate it directly while the Makefile preserves a complete local entry point.
