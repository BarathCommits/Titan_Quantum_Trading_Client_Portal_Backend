# Titan Funds Platform — CLAUDE.md

This file provides build, test, run commands, and critical architectural rules for developers and AI assistants working on the Titan Funds Platform.

---

## 1. Project Directory Layout

* `/model` — Database schema DDL scripts (`schema.sql`).
* `/docs` — System design, data modeling specifications, and table schemas.
* `/backend-core` *(Proposed)* — NestJS backend managing identity, portfolios, RBAC, and the ledger.
* `/backend-payments` *(Proposed)* — Go backend managing bank transactions, polling, and cron queues.
* `/frontend-ui` *(Proposed)* — Next.js frontend serving both client and admin portals.

---

## 2. Common Development Commands

### 2.1 Multi-Service Dev Environment (Docker Compose)
* **Start all services:** `docker compose up --build`
* **Stop all services:** `docker compose down -v`
* **View logs:** `docker compose logs -f`

### 2.2 NestJS Core Backend (Port 3000)
* **Install dependencies:** `npm install`
* **Start in development (auto-reload):** `npm run start:dev`
* **Build production package:** `npm run build`
* **Run unit tests:** `npm run test`
* **Run integration tests:** `npm run test:e2e`
* **Format code:** `npm run format`

### 2.3 Go Payments & Notifications (Port 3003)
* **Install dependencies:** `go mod download`
* **Start in development:** `go run cmd/main.go`
* **Build production binary:** `go build -o bin/payments cmd/main.go`
* **Run tests:** `go test -v ./...`
* **Format code:** `go fmt ./...`

### 2.4 Next.js Frontend UI (Port 3001)
* **Install dependencies:** `npm install`
* **Start in development:** `npm run dev`
* **Build production app:** `npm run build`
* **Linter check:** `npm run lint`

---

## 3. Strict Architectural Commandments

All developers and coding assistants **must strictly enforce** the following structural bounds:

### 3.1 Schema Isolation
* **Rule:** The `core` (NestJS) and `payments` (Go) databases are logically isolated.
* **No Physical Cross-Schema Constraints:** No physical foreign keys or checks can cross the boundary between `core` and `payments` schemas.
* **Soft References Only:** If the Go service links a bank wire to a ledger record, store the UUID as a plain text string. Do not use database-enforced relations.
* **No Database Joins:** Application code must never perform joins across the schemas.

### 3.2 Financial Ledger Governance
* **Ledger Immutability:** Rows in `core.ledger_entries` are strictly append-only.
* **No Edits or Deletes:** Never perform `UPDATE` or `DELETE` queries on `core.ledger_entries`. All balances must be derived by credit and debit aggregation. Any balance corrections must be booked as offsetting entries (`PROFIT_REVERSAL`, `ROUNDING_ADJUSTMENT`, etc.).
* **Capacity Locking:** Always lock pools using `SELECT ... FOR UPDATE` before allocating deposits to prevent race conditions exceeding a pool's capacity.

### 3.3 Multi-Tenancy & Security
* **Tenant Isolation:** Enforce `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` on all user data tables.
* **Session Configuration:** All queries accessing client tables must run inside a connection transaction setting `SET LOCAL app.current_tenant_id = '<tenant-uuid>'`.
* **PII Isolation:** Personally Identifiable Information (address, IBANs, bank accounts) must be application-encrypted (AES-256-GCM) prior to insertion, storing data in `cipher:ciphertext:iv:tag` formatting.

---

## 4. Code Quality & Style Guidelines

### 4.1 Go Coding Styles
* Follow standard Go styling idioms (`gofmt`).
* Errors must be handled explicitly. Do not use `panic()` for control flow or standard exceptions.
* Handle database operations using context-aware transaction blocks (`pgx` transaction interfaces).

### 4.2 TypeScript & NestJS Coding Styles
* Prefer async/await over raw Promises or callbacks.
* Enforce strong types; avoid using `any` everywhere.
* Structure backend concerns into isolated NestJS modules (`AuthModule`, `LedgerModule`, `PoolModule`, `ProfileModule`).
