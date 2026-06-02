# Titan Backend Payments — CLAUDE.md

This file provides specific build, test, run commands, and guidelines for the Go payments & notifications service.

---

## 1. Development Commands

* **Download dependencies:** `go mod download`
* **Run in development:** `go run cmd/main.go`
* **Build production binary:** `go build -o bin/payments cmd/main.go`
* **Run test suite:** `go test -v ./...`
* **Format code:** `go fmt ./...`
* **Linter & static checks:** `go vet ./...`

---

## 2. Coding Guidelines & Go Style

* **Coding Standards:** Follow idiomatic Go guidelines and clean code patterns.
* **Error Handling:** Always handle error returns explicitly. Avoid using `panic()` or standard panics for normal flow operations.
* **Database Driver:** Use context-aware database transaction interfaces via `pgx`.
* **Async Workers:** All background cron tasks (maturity checks, notice period scans, backups) must be enqueued and consumed via the **River PostgreSQL Queue**.

---

## 3. Strict Integration & Reconciliation Rules

* **Cross-Schema Isolation:** The payments schema does not have physical foreign keys to core schemas. Association must be mapped using plain text soft-reference UUID columns.
* **Polling Idempotency:** Bank of Ireland polling runs every 3 minutes. Before writing a ledger credit entry, query `core.ledger_entries.reference_id` to confirm that the bank transaction's reference has not already been processed. Skip duplicate records silently.
