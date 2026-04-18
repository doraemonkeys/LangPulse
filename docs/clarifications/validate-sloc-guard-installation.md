# Validate sloc-guard Integration

## Decisions

- The `Validate` workflow delegates `sloc-guard` to the upstream `doraemonkeys/sloc-guard` GitHub Action instead of maintaining repository-owned install logic.
- Root-level validation is split into `ci-core` and `sloc`, so GitHub Actions can run `make ci-core` plus the dedicated `sloc-guard` job while local developers still get the full contract from `make ci`.

## Why

- The upstream action already owns the binary-download and fallback behavior for GitHub runners, so duplicating that logic in this repository increases maintenance without improving validation semantics.
- `sloc-guard` can emit SARIF and problem-matchers directly inside GitHub Actions, which belongs in the workflow layer rather than in the portable `make` contract.
