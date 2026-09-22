SHELL := /bin/sh
.DEFAULT_GOAL := help

GOLANGCI_VERSION := v2.13.2
GOVULNCHECK_VERSION := v1.8.0
GOLANGCI := $(CURDIR)/.bin/golangci-lint-$(GOLANGCI_VERSION)
GOVULNCHECK := $(CURDIR)/.bin/govulncheck-$(GOVULNCHECK_VERSION)

.PHONY: help install tools up down logs dev-db dev-api dev-web fmt fmt-check lint test typecheck vuln check build smoke

help: ## Show available commands
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  %-14s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: tools ## Install locked application dependencies and pinned Go tools
	go mod download
	pnpm --dir web install --frozen-lockfile

tools: $(GOLANGCI) $(GOVULNCHECK)

$(GOLANGCI):
	@mkdir -p .bin
	GOBIN=$(CURDIR)/.bin go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@$(GOLANGCI_VERSION)
	mv .bin/golangci-lint $(GOLANGCI)

$(GOVULNCHECK):
	@mkdir -p .bin
	GOBIN=$(CURDIR)/.bin go install golang.org/x/vuln/cmd/govulncheck@$(GOVULNCHECK_VERSION)
	mv .bin/govulncheck $(GOVULNCHECK)

up: ## Build and start the complete application in Docker
	docker compose up --build --wait

down: ## Stop the containers, preserving PostgreSQL data
	docker compose down

logs: ## Follow application and database logs
	docker compose logs -f

dev-db: ## Start only PostgreSQL for local development
	docker compose up -d --wait db

dev-api: ## Run the API locally (loads .env when present)
	@set -a; if [ -f .env ]; then . ./.env; fi; set +a; go run ./cmd/api

dev-web: ## Run Vite with hot reload in another terminal
	pnpm --dir web dev

fmt: tools ## Format Go and frontend sources
	$(GOLANGCI) fmt
	pnpm --dir web format

fmt-check: tools ## Check formatting without changing files
	$(GOLANGCI) fmt --diff
	pnpm --dir web format:check

lint: tools ## Run Go and frontend linters
	$(GOLANGCI) run
	pnpm --dir web lint

test: ## Run Go race tests and frontend tests
	go test -race ./...
	pnpm --dir web test

typecheck: ## Check frontend types
	pnpm --dir web typecheck

vuln: tools ## Check reachable Go vulnerabilities
	$(GOVULNCHECK) ./...

check: fmt-check lint typecheck test vuln ## Run the same quality checks as CI

build: ## Build the Go binary and production frontend
	@mkdir -p .bin
	CGO_ENABLED=0 go build -trimpath -o .bin/hooklane ./cmd/api
	pnpm --dir web build

smoke: ## Verify Compose, database recovery, persistence, and shutdown in isolation
	sh scripts/smoke.sh
