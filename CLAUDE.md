# Titan Funds Platform — CLAUDE.md

This file provides environment specifications, git workflow guidelines, common commands, and architectural guardrails for AI coding assistants and developers.

---

## 1. System Environment & Version Specifications

Ensure your local development environment aligns with these exact runtime versions:
* **Node.js:** `v22.18.0` (npm `v10+`)
* **Go:** `go1.26.0 darwin/arm64`
* **Docker:** `v28.0.1` (Docker Compose `v2+`)
* **Database:** PostgreSQL `13+`

---

## 2. Directory Layout

* `/model` — Master DDL schemas (`schema.sql`).
* `/docs` — System specs, data models, and technical architecture records.
* `/backend-core` — NestJS core backend (Node.js).
* `/backend-payments` — Go payments & notifications service.
* `/frontend-ui` — Next.js frontend portal (managed in a separate repository).

---

## 3. Development Commands & Rulebooks

Refer to local `CLAUDE.md` guides inside sub-directories for service-specific commands:
* **NestJS Core Backend:** [backend-core/CLAUDE.md](file:///Users/balajisk/Downloads/titan/backend-core/CLAUDE.md)
* **Go Payments & Notifications:** [backend-payments/CLAUDE.md](file:///Users/balajisk/Downloads/titan/backend-payments/CLAUDE.md)

### 3.1 Orchestrated Parent Environment (Docker Compose)
Run these commands from the root directory:
* **Build and start services:** `docker compose up --build`
* **Stop all containers & wipe volumes:** `docker compose down -v`
* **View log streams:** `docker compose logs -f`

---

## 4. Git Workflow & Commit Guidelines

### 4.1 Branching Strategy
* **Never commit directly to `master`.**
* Before starting work on any feature or fix, create a new branch:
  ```bash
  git checkout -b feat/your-feature-name    # For features
  git checkout -b fix/bug-description       # For bug fixes
  git checkout -b chore/config-updates      # For configurations
  ```

### 4.2 Pre-Commit Code Validation
Before committing code, you **must run** formatters and linters:
1. **NestJS Backend:** Run `npm run lint` and `npm run format` inside `/backend-core`.
2. **Go Backend:** Run `go fmt ./...` and `go vet ./...` inside `/backend-payments`.

### 4.3 Pre-Push Verification
Before pushing changes to a remote branch or creating a pull request:
1. Verify the database schema logic by executing the scratch script against a local database transaction:
   ```bash
   psql -d titan_dev -f brain/f1fecaf7-2bba-443b-baec-63ae64b092ee/scratch/verify_dividends.sql
   ```
2. Run all unit and integration test suites and verify they pass 100%.

### 4.4 Commit Message Convention
Use structural commit messages matching the conventional commits specification:
* `feat: add user profile encryption triggers`
* `fix: correct largest remainder division ties`
* `chore: configure local docker compose registry`

---

## 5. Strict Architectural Commandments

### 5.1 Logical Schema Isolation
* **Zero physical foreign keys or database check constraints** can cross the boundary between `core` and `payments` schemas.
* Connect schemas logically in application code via soft UUID references (mapped as plain text columns).

### 5.2 Financial Ledger Governance
* **Immutability:** Never run `UPDATE` or `DELETE` on `core.ledger_entries` records. Modify ledger balances only by booking offsetting entries.
* **Pool Locking:** Query pool state using `SELECT ... FOR UPDATE` before allocating deposits to prevent capacity race conditions.
* **RLS Boundaries:** Enforce Row-Level Security on all user data. Always set connection variables using `SET LOCAL app.current_tenant_id` inside transactional queries.

---

## 6. Caveman Communication Rules (Response Compression)

To maximize context longevity and minimize token consumption:
* **Zero Conversational Filler:** Start responses directly with requested code, command executions, or technical answers. Remove pleasantries (e.g. "Sure, let's do that", "Here is the updated code").
* **Fluff-Free Rationale:** Explanations should be a maximum of 1–3 sentences focusing strictly on non-obvious design choices.
* **Artifact Integration:** Point to modified/created artifacts (plans, tasks, walkthroughs) using file links. Do not re-summarize their contents in the chat response.

