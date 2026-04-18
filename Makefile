.PHONY: ci ci-core verify verify-core setup clean check-go-env check-sloc-guard collector-test collector-lint collector-coverage collector-coverage-check worker-install web-install worker-check worker-coverage worker-build worker-lint web-check web-coverage web-build web-lint sloc

SHELL := /bin/bash
.SHELLFLAGS := -o pipefail -c

GO_MIN_COVERAGE ?= 90
WORKSPACE_RUNNER := node .github/scripts/run-workspace-command.mjs
SLOC_GUARD ?= sloc-guard
COLLECTOR_GOLANGCI_CONFIG := .golangci.yml

COLLECTOR_DIR := collector
WORKER_DIR := worker
WEB_DIR := web
CORE_VALIDATION_TARGETS := collector-lint collector-coverage-check web-check web-coverage worker-check worker-coverage worker-build worker-lint web-lint

# Keep package-manager detection in one place so local and CI validation use
# the same workspace resolution rules instead of drifting over time.
worker-install:
	$(WORKSPACE_RUNNER) $(WORKER_DIR) install

web-install:
	$(WORKSPACE_RUNNER) $(WEB_DIR) install

setup: worker-install web-install

# Windows developers often run make through Git Bash. Failing early here keeps
# coverage errors from masquerading as Go toolchain problems later in the run.
check-go-env:
	@case "$$(uname -s)" in \
		MINGW*|MSYS*|CYGWIN*) \
			if [ -z "$$(go env GOMODCACHE 2>/dev/null)" ] || [ -z "$$(go env GOPATH 2>/dev/null)" ]; then \
				echo ""; \
				echo "Go environment is not available in the current shell."; \
				echo "Run make from PowerShell or from a terminal with a working Go installation."; \
				echo ""; \
				exit 1; \
			fi \
		;; \
	esac

check-sloc-guard:
	@command -v $(SLOC_GUARD) >/dev/null 2>&1 || { \
		echo "sloc-guard is required."; \
		echo "Install it with: cargo install sloc-guard"; \
		exit 1; \
	}

collector-test: check-go-env
	cd $(COLLECTOR_DIR) && go test ./... -race

collector-lint: check-go-env
	cd $(COLLECTOR_DIR) && golangci-lint run --config $(COLLECTOR_GOLANGCI_CONFIG) ./...

collector-coverage: check-go-env
	cd $(COLLECTOR_DIR) && go test ./... -coverprofile=coverage.out -covermode=atomic -race

collector-coverage-check: collector-coverage
	@coverage_report="$$(cd $(COLLECTOR_DIR) && go tool cover -func=coverage.out)"; \
	printf '%s\n' "$$coverage_report"; \
	coverage_percent="$$(printf '%s\n' "$$coverage_report" | awk '/^total:/ { gsub(/%/, "", $$3); print $$3 }')"; \
	test -n "$$coverage_percent" || { \
		echo "Unable to determine collector coverage percentage"; \
		exit 1; \
	}; \
	if awk -v actual="$$coverage_percent" -v minimum="$(GO_MIN_COVERAGE)" 'BEGIN { exit !(actual + 0 < minimum + 0) }'; then \
		echo "Collector Go coverage $$coverage_percent% is below required $(GO_MIN_COVERAGE)%"; \
		exit 1; \
	fi

worker-check:
	$(WORKSPACE_RUNNER) $(WORKER_DIR) script check

worker-coverage: web-build
	$(WORKSPACE_RUNNER) $(WORKER_DIR) script coverage:check

# The deployed Worker now owns the static frontend too, so build the web bundle
# first and keep the dry-run pointed at the exact same asset graph as production.
worker-build: web-build
	$(WORKSPACE_RUNNER) $(WORKER_DIR) script build

worker-lint:
	$(WORKSPACE_RUNNER) $(WORKER_DIR) script lint

web-check:
	$(WORKSPACE_RUNNER) $(WEB_DIR) script check

web-coverage:
	$(WORKSPACE_RUNNER) $(WEB_DIR) script coverage:check

web-build:
	$(WORKSPACE_RUNNER) $(WEB_DIR) script build

web-lint:
	$(WORKSPACE_RUNNER) $(WEB_DIR) script lint

sloc: check-sloc-guard
	$(SLOC_GUARD) check

ci-core: setup $(CORE_VALIDATION_TARGETS)

ci: ci-core sloc

verify-core: $(CORE_VALIDATION_TARGETS)

verify: verify-core sloc

clean:
	rm -rf $(COLLECTOR_DIR)/coverage.out $(WEB_DIR)/coverage $(WEB_DIR)/dist $(WORKER_DIR)/coverage $(WORKER_DIR)/.wrangler
