# Titan Backend Payments — CLAUDE.md

This file provides specific development commands, coding conventions, and integration rules for the Go payments & notifications service.

---

## 1. Runtime Environment Specification

* **Go:** `go1.26.0 darwin/arm64` (module `payments`)
* **Background Queue:** River (PostgreSQL-backed job queue)
* **Database Driver:** `pgx/v5`

---

## 2. Service Development Commands

Run these commands inside the `/backend-payments` directory:
* **Download dependencies:** `go mod download`
* **Run in development:** `go run cmd/main.go`
* **Build production binary:** `go build -o bin/payments cmd/main.go`
* **Format source code:** `go fmt ./...`
* **Run static vet checks:** `go vet ./...`
* **Run unit tests:** `go test -v ./...`
* **Test coverage:** `go test -cover ./...`

---

## 3. Strict Pre-Commit Verification Workflow

Before staging or committing any Go source files, you **must**:
1. Run `go fmt ./...` to auto-format Go source code.
2. Run `go vet ./...` to detect static compile-time errors.
3. Run `go test -v ./...` to ensure all tests compile and pass.

---

## 4. Coding & Quality Standards

* **Error Propagation:** Always return errors explicitly as the last function return value. Never use `panic()` for standard error handling or control flow.
* **Context Propagation:** All database and external network API calls must accept and propagate a `context.Context` to handle cancellation and timeouts correctly.
* **Database Transactions:** Always run transactional commands inside standard transaction scopes (`pgx.Tx`), ensuring clean rollback on errors.
* **Async Workers:** Define River worker handlers in dedicated folders. Keep crons, background mailers, and polling consumers isolated in Go packages.

---

## 5. Bank Polling & Reconciliation Rules

* **Soft Schema Links:** Maintain loose coupling between `payments` and `core`. Refer to core record UUIDs using plain text fields without foreign keys.
* **Idempotency Reconciliation:** Bank of Ireland polling runs every 3 minutes. Before writing a ledger credit entry, query `core.ledger_entries` for `reference_id` matching the bank transaction reference. Silently discard duplicates to avoid double-crediting balances.
