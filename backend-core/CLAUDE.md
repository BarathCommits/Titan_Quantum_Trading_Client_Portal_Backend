# Titan Backend Core — CLAUDE.md

This file provides specific development commands, coding conventions, and database rules for the NestJS core backend service.

---

## 1. Runtime Environment Specification

* **Node.js:** `v22.18.0` (npm `v10+`)
* **Framework:** NestJS `v10+`
* **Programming Language:** TypeScript (strict mode enabled in `tsconfig.json`)

---

## 2. Service Development Commands

Run these commands inside the `/backend-core` directory:
* **Install dependencies:** `npm install`
* **Start dev server (auto-reload):** `npm run start:dev`
* **Build production package:** `npm run build`
* **Run lint checks:** `npm run lint`
* **Auto-fix lint errors:** `npm run lint -- --fix`
* **Format source files:** `npm run format`
* **Run unit tests:** `npm run test`
* **Run integration tests:** `npm run test:e2e`

---

## 3. Strict Pre-Commit Verification Workflow

Before staging or committing any NestJS files, you **must**:
1. Run `npm run lint` to check for code violations.
2. Run `npm run format` to ensure stylistic consistency.
3. Run `npm run test` to verify that unit tests compile and pass.

---

## 4. Coding & Quality Standards

* **TypeScript Strictness:** Never use the `any` type. Explicitly define model, query, and response types.
* **Database ORM:** Use TypeORM (`@nestjs/typeorm`) for managing database connection states, entities, and migration runs.
* **Module Structure:** Group database tables, services, and controllers into isolated NestJS modules (e.g., `AuthModule`, `LedgerModule`, `PoolModule`, `ProfileModule`). Avoid circular dependencies.
* **Service Boundaries:** Keep HTTP Controllers lean. Place all business validations, ledger calculations, and transaction locking in Service layers.

---

## 5. Core Database & Ledger Rules

* **Ledger Immutability:** Never run `UPDATE` or `DELETE` on `core.ledger_entries`. All balances must be derived. Adjustments must use offsets.
* **RLS Tenant Isolation:** Enable database RLS. Wrap user-owned table queries in transaction blocks executing `SET LOCAL app.current_tenant_id = '<tenant-uuid>'` first.
* **Soft Schema Links:** Link `core` tables to `payments` using plain text UUIDs without database-level FK constraints.
* **Concurrency Locking:** Query pool state using `SELECT ... FOR UPDATE` inside transactions before allocating client deposits.
