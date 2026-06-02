# Titan Backend Core — CLAUDE.md

This file provides specific build, test, run commands, and database integrity guidelines for the NestJS backend-core service.

---

## 1. Development Commands

* **Install dependencies:** `npm install`
* **Start service (Dev):** `npm run start:dev`
* **Build application:** `npm run build`
* **Run unit tests:** `npm run test`
* **Run E2E tests:** `npm run test:e2e`
* **Lint codebase:** `npm run lint`
* **Format code:** `npm run format`

---

## 2. Coding Guidelines & Project Conventions

* **Language:** TypeScript. Ensure strict mode is enabled in `tsconfig.json`.
* **Imports:** Use clean ES module imports. Group external modules above local modules.
* **Architecture:** Enforce NestJS module isolation. Keep domain logic within isolated modules (e.g., `LedgerModule`, `AuthModule`, `PoolModule`, `ProfileModule`).

---

## 3. Strict Database & Ledger Constraints

* **Ledger Immutability:** The `core.ledger_entries` table is strictly append-only. Never write or execute `UPDATE` or `DELETE` queries on ledger records. Adjust balances by booking offsets (`PROFIT_REVERSAL`, `ROUNDING_ADJUSTMENT`, etc.).
* **RLS Isolation:** Enforce RLS session parameters. Always run queries accessing user-owned tables inside a transaction block setting `SET LOCAL app.current_tenant_id = '<tenant-uuid>'`.
* **Cross-Schema Separation:** Never join tables in the `core` schema with the `payments` schema. Use soft UUID text columns instead of foreign keys.
* **Pool Capacity Race Condition:** Always query pool state with a row lock `SELECT ... FOR UPDATE` before allocating a deposit to prevent concurrency issues.
