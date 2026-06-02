# Funds Platform — System Design Document

**Version:** 1.0  
**Status:** Draft — Pending Barath N Review  
**Prepared by:** Balaji Segu Krishnaiah & SAI SHREYAS G H
**Document Type:** System & User Flow Design  
**Last Updated:** May 2026

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [What the Platform Does (and Does Not Do)](#2-what-the-platform-does)
3. [Architecture](#3-architecture)
4. [Technology Stack](#4-technology-stack)
5. [Cloud & Infrastructure](#5-cloud--infrastructure)
6. [Data Model](#6-data-model)
7. [RBAC — Admin Roles & Permissions](#7-rbac--admin-roles--permissions)
8. [User Flows](#8-user-flows)
9. [Admin Flows](#9-admin-flows)
10. [Payment Integration](#10-payment-integration)
11. [Notification System](#11-notification-system)
12. [Currency Handling](#12-currency-handling)
13. [Agreement Signing](#13-agreement-signing)
14. [Critical Engineering Fixes](#14-critical-engineering-fixes)
15. [Key Design Decisions & Rationale](#15-key-design-decisions--rationale)
15a. [GDPR — Right to Erasure](#15a-gdpr--right-to-erasure)
16. [Open Items — CEO Confirm](#16-open-items--ceo-confirm)
17. [V1 Release Scope Recommendation](#17-v1-release-scope-recommendation)
18. [Complete Journey Map](#18-complete-journey-map)

---

## 1. Executive Summary

This document defines the complete system design for a **funds aggregation, tracking, and administration platform** serving Individual and Enterprise clients globally.

The platform enables clients to:
- Onboard with full PII profile collection
- Sign an investment agreement (forced-read, binary confirmation)
- Configure investments across risk profiles and maturity periods
- Deposit funds internationally to an Irish account
- Track capital and profit performance through a client portal
- Request profit and capital withdrawals

An admin portal handles:
- Pool creation and management
- Inbound transaction mapping to pools
- Manual profit entry and proportional distribution
- Withdrawal approval and outgoing transfer initiation
- Full audit trail of every financial action

**No trading logic lives in this platform.** All trading is handled externally by the firm's brokers and quants. This system tracks money in, money out, and performance reporting only.

---

## 2. What the Platform Does

### In Scope

| Capability | Description |
|---|---|
| Client Onboarding | Sign up, PII collection, agreement signing, investment configuration |
| Deposit Handling | Clients wire funds globally to Irish account; system tracks via bank polling |
| Pool Management | Admin creates pools, maps transactions, links to trading accounts |
| Ledger & Accounting | Immutable double-entry ledger; balances always derived, never stored |
| Profit Distribution | Admin enters pool-level profit; system splits proportionally by capital stake |
| Withdrawal Processing | Profit and capital withdrawals with configurable notice periods |
| Notifications | Event-driven emails at every lifecycle stage + monthly summary |
| Reporting | Client dashboard + admin AUM view + exportable data |

### Out of Scope (V1)

- Trade execution or brokerage API connections
- Real-time market data feeds
- Investment advice or return guarantees
- KYC identity verification (module designed and pluggable, not activated in V1)
- DocuSign / e-signature API (V1 uses in-house forced-read flo## 3. Architecture

### 3.1 Pattern: 3 Microservices on Docker (Hybrid Stack: Go + Node.js)

The system runs as **3 focused services** in Docker containers on a single Hetzner CX22 server. Each service is isolated by concern:
- **Payments & Notifications Service** is written in **Go (Golang)** for a near-zero memory footprint (~15 MB RAM) and rock-solid concurrency using the **River PostgreSQL Queue**.
- **Core Backend Service** is written in **Node.js (NestJS)** to manage secure transaction records, auth states, and multi-tenant ledger entries.
- **Frontend UI** is written in **Node.js (Next.js)** to render the client portal and admin dashboards, completely separated from backend API logic to ensure zero operational coupling.

This hybrid stack balances **developer velocity** with **extreme infrastructure efficiency and perfect UI/API decoupling**:

> **Why Docker Compose and not Kubernetes at V1?** Kubernetes adds control plane overhead with zero benefit at this scale. Docker Compose runs everything with one config file. Same Docker images deploy to Kubernetes when needed.

![alt text](hld_1.png)

### 3.2 Service Breakdown

| Service | Port | Language / Stack | Responsibilities |
|---|---|---|---|
| **Nginx API Gateway** | 80 / 443 | C / Nginx | Routes all external traffic; SSL termination via Let's Encrypt; API rate limiting. |
| **Payments & Notifications** | 3003 | **Go (Golang)** | BOI AIS polling (inbound deposits), BOI PIS (outgoing transfers), transactional outbox consumer, **River background job queue**, all email sending via Resend, cron jobs (maturity notices, notice period checking, monthly summaries, backups). |
| **Core Backend Service** | 3000 | **Node.js (NestJS)** | Sign up, sign in, stateless JWT auth token generation, user profile management (AES-256 encrypted PII), double-entry ledger transactions, monthly balance snapshots, pool creation & capacity checks, admin RBAC portal API. |
| **Frontend UI** | 3001 | **Node.js (Next.js)** | Client dashboard UI, admin portal screens, forced-scroll investment agreement views, portfolio performance interactive charts. |

### 3.3 Why These Three Groups

**Payments & Notifications (Go)** — Written in Go to guarantee low memory footprint and high concurrency. Payments and Notifications are naturally two halves of the same event loop (payments trigger notifications, crons trigger notifications). Isolating this service acts as a strict **security sandbox**: your sensitive Bank of Ireland API credentials, certificates, and SMTP keys live *only* in this container. A security exploit in the public frontend or core backend cannot expose your banking APIs.

**Core Backend Service (NestJS)** — Manages the stateful Postgres ledger and identity tables. Enforcing ACID compliance on ledger allocations and pool boundaries is vastly simpler in a single backend service, completely avoiding distributed transaction overhead.

**Frontend UI (Next.js)** — Keeps the frontend completely decoupled from database access, schemas, and credentials. Separating the UI prevents security compromises on the presentation layer from affecting ledger operations or database credentials. It also allows front-end devs to iterate on client feedback with zero risk to backend stability.

### 3.4 API Gateway Routing (Nginx)

```nginx
/api/payments/*     → payments-notification-service:3003
/api/*              → core-backend:3000
/*                  → frontend-ui:3001
```

All services listen only on Docker's **internal network**. Only Nginx is publicly reachable on ports 80 and 443.

### 3.5 Database Strategy: Shared Postgres, Separate Schemas

One PostgreSQL instance in Docker. Each service owns its own schema — no cross-schema joins in application code.

```
postgres (Docker — single instance on CX22)
  ├── schema: core         ← Core Backend (Auth, profiles, pools, ledger, snapshots)
  └── schema: payments     ← Payments & Notifications (Bank transaction list, River queue tables)
```

When a service needs isolation, extract its schema into a dedicated Postgres instance. One service at a time, when load proves it.

### 3.6 Single Server RAM Layout

```
Hetzner CX22 (2 vCPU · 4 GB RAM · 40 GB NVMe)

Nginx                                    ~50 MB
Payments & Notifications Service (Go)     ~15 MB   ← Go's extremely lightweight runtime
Core Backend Service (NestJS)            ~150 MB   ← isolated Node.js backend runtime
Frontend UI (Next.js)                    ~150 MB   ← isolated Node.js UI server runtime
PostgreSQL                               ~300 MB
OS + Docker overhead                    ~400 MB
────────────────────────────────────────────────
Total used                             ~1.065 GB of 4 GB available
Free headroom                          ~2.935 GB
```

No Redis — removed. Sessions handled by stateless JWT. Rate limiting handled by in-memory throttler configs per service.

### 3.7 Async Event Flow — Outbox + River Queue

No separate queue service. The **River queue** runs inside PostgreSQL — zero extra cost, zero extra container, and 100% durable under Postgres WAL protection.

```
BOI AIS poll detects new deposit (Payments & Notifications Service - Go)
    │
    ├── BEGIN TRANSACTION (payments schema)
    │     INSERT INTO payments.bank_transactions (status=PENDING)
    │     ENQUEUE River Job (NotifyAdminOfDeposit)
    │ COMMIT ← atomic, both or neither (Transactional Enqueueing)
    │
River worker (instant, inside Go Service)
    → Payments & Notifications Service → emails admin via Resend Go SDK

Admin maps deposit → Core Backend (Node.js)
    │
    ├── BEGIN TRANSACTION (core schema)
    │     SELECT pool FOR UPDATE (capacity lock)
    │     INSERT INTO core.investment_pool_allocations
    │     UPDATE core.ledger_entries SET status=CONFIRMED
    │     INSERT INTO core.outbox_events (INVESTMENT_ACTIVATED)
    │ COMMIT
    │
Payments & Notifications Outbox Worker
    → Enqueues River Job (SendDepositConfirmation)
    → Payments & Notifications Service → emails client
```

![alt text](./deposit.png)

---

## 4. Technology Stack

| Layer | Choice | Rationale |
|---|---|---|
| **Payments Backend** | **Go (Golang)** | Compiled performance, near-zero memory footprint (~15MB), bulletproof concurrency via Goroutines, and type-safe River job handling. |
| **Core Backend** | NestJS (Node.js / TypeScript) | Microservice-ready module system; strong dependency injection enforces boundaries; rapid developer velocity. |
| **Frontend** | Next.js (React / TypeScript) | SSR for fast initial load; single codebase for client and admin portals. |
| **API Gateway** | Nginx (Docker — free) | Routes to 3 services; SSL via Let's Encrypt; rate limiting; lightweight. |
| **Primary DB** | PostgreSQL (Docker — free) | ACID transactions; row-level security; 2 separate schemas; no managed DB cost. |
| **Cache / Sessions** | None — removed | JWT is stateless — no session store needed; rate limiting in-memory. |
| **File Storage** | Hetzner Object Storage | S3-compatible; €4.99/month base includes 1TB; EU data residency; same AWS SDK. |
| **Event Queue** | **River (PostgreSQL-backed — free)** | Runs inside existing Postgres; supports transactional enqueueing (atomic job creation); 100% durable. |
| **Email** | Resend | 3,000 emails/month free; EU sending; DKIM verified. |
| **Auth** | JWT (15 min TTL) + Refresh tokens (7 days, HTTP-only cookies) | Stateless; secure; no server-side session store. |
| **Agreement (V1)** | In-house forced-scroll + checkbox | No third-party cost; interface ready for DocuSign upgrade. |
| **Containerisation** | Docker + Docker Compose | All 3 services + Postgres run in Docker on one CX22; entirely free. |
| **CI/CD** | GitLab CI/CD | CEO preferred; `.gitlab-ci.yml` pipeline; GitLab Container Registry; free tier. |
| **Version Control** | GitLab | Code, CI/CD, container registry, issues — one platform. |
| **DNS** | Cloudflare (DNS only — no CDN) | Free; no CDN needed for EU-only V1. |
| **SSL** | Let's Encrypt via Certbot | Free; auto-renews every 90 days. |
| **Monitoring** | Sentry (free) + Docker logs + UptimeRobot (free) | Error tracking; native container logs; uptime alerts — zero cost, zero ops overhead. |
| **Secrets** | Doppler | Runtime injection; never visible in any dashboard; protects AES-256 PII keys. |
| **Hosting** | Hetzner CX22 (Germany) — single server | See Section 5. |

---

## 5. Cloud & Infrastructure

### 5.1 Platform: Hetzner Cloud (Germany)

All infrastructure runs on **Hetzner Cloud** in Germany (Nuremberg `nbg1` or Falkenstein `fsn1`). Hetzner is a German company founded in 1997 that owns and operates its own data centres — not a cloud reseller. All data stays physically in Germany, inside the EU. CEO preferred choice.

**Why Hetzner:**
- German-owned data centres — GDPR compliance is native.
- 3–5× cheaper than AWS or DigitalOcean for equivalent compute.
- 20TB traffic included per server — effectively unlimited for this use case.
- S3-compatible Object Storage for files and backups.
- Private network between servers is free.
- Firewall security rules are free.

---

### 5.2 Recommended Setup at 100 Users — Single Server
 
#### Why 3 Services, Not 4 or 8
 
The initial design had 8 microservices, which we consolidated first to 4, and finally to **3 focused services** to achieve maximum security sandboxing, operational simplicity, and dynamic decoupled presentation. The guiding principle remains: **services that share the same reason to change, same data boundaries, and strict security profiles should live together, while keeping the client and admin frontend views isolated to prevent dynamic rendering issues and dependency bloating.**
 
| Service | Consisted Of | Rationale |
|---|---|---|
| **Payments & Notifications** | Payments + Notifications + Crons | **Go (Golang).** Tightly couples the bank polling and transactional event messaging. Sandbox security: locks sensitive Bank of Ireland APIs and certificates away from the public dashboard. Written in Go to guarantee low memory usage (~15MB) and bulletproof River background queuing on port 3003. |
| **Core Backend Service** | Identity + Investment + Ledger + Pools + Admin APIs | **Node.js (NestJS).** Avoids complex distributed transactions by running multi-tenant authorization, profiles, ledger accounting, and pool capacity checks in a single atomic database context on port 3000. |
| **Frontend UI** | Client dashboard + Admin dashboard screens | **Node.js (Next.js).** Serving isolated client and admin portals on port 3001, keeping the public presentation layer completely decoupled from backend schemas, database credentials, and stateful calculations. |
 
**Result:** 8 services → 3 services. Zero cross-service network lag for core ledger operations, strict API sandbox security, dynamic isolated frontends, and a tiny overall memory footprint.
 
---
 
**Everything runs on one CX22.** At 100 users there is no justification for two servers. PostgreSQL serving 100 users uses ~300MB RAM and minimal CPU — it does not need its own machine.
 
#### Single Server: CX22 — €3.79/month
**2 vCPU · 4 GB RAM · 40 GB NVMe · 20 TB traffic**
 
Runs all Docker containers:
 
| Container | Est. RAM |
|---|---|
| Nginx | ~50 MB |
| Payments & Notifications Service (Go) | ~15 MB |
| Core Backend Service (NestJS) | ~150 MB |
| Frontend UI (Next.js) | ~150 MB |
| PostgreSQL | ~300 MB |
| OS + Docker overhead | ~400 MB |
| **Total used** | **~1.065 GB of 4 GB** |
 
**2.94 GB free headroom.** The River queue runs natively inside PostgreSQL, saving additional memory overhead. Sessions are stateless JWT. Rate limiting is handled in-memory.
 
#### Hetzner Volume — 100 GB: €4.76/month
 
PostgreSQL data directory mounts from this Volume — not the server's built-in NVMe. The server is fully disposable. The data is not.
 
```
CX22 built-in NVMe (40 GB)
  └── OS, Docker images, application code
 
Hetzner Volume (100 GB) — attached to CX22
  └── /var/lib/postgresql/data  ← all financial data here
```
 
If the CX22 ever needs replacing: detach Volume → new CX22 → reattach → `docker compose up`. Back in 5 minutes, zero data loss.
 
#### Supporting Services
 
| Service | Provider | Cost |
|---|---|---|
| Object Storage (agreements, exports, backups) | Hetzner | €4.99/month |
| Cloudflare DNS | Cloudflare | Free |
| Let's Encrypt SSL | Let's Encrypt | Free |
| GitLab CI/CD | GitLab.com | Free tier |
| Resend (email) | Resend | Free (3,000/month) |
| Doppler (secrets) | Doppler | Free tier |
| Sentry (errors) | Sentry | Free tier |
| UptimeRobot (uptime) | UptimeRobot | Free (50 monitors) |
 
#### Total Monthly Cost
 
| Item | Cost |
|---|---|
| Hetzner CX22 (single server) | €3.79 |
| Hetzner Volume 100 GB | €4.76 |
| Hetzner Object Storage | €4.99 |
| Everything else | €0.00 |
| **Total (ex VAT)** | **€13.54/month** |
 
> 3 microservices + PostgreSQL + Nginx + file storage + daily backups + CI/CD + email + error tracking + SSL — for **€13.54/month**. Equivalent AWS stack costs ~€180/month.
 
---
### 5.3 Hetzner Server Specifications & Pricing

> All prices exclude VAT. Hetzner applied a price adjustment from April 2026 — verify latest at hetzner.com/cloud.

| Plan | vCPU | RAM | NVMe SSD | Traffic | IPv4 | Price/month |
|---|---|---|---|---|---|---|
| **CX22** | 2 (shared) | 4 GB | 40 GB | 20 TB | 1 included | **€3.79** |
| **CX32** | 4 (shared) | 8 GB | 80 GB | 20 TB | 1 included | **€6.80** |
| **CX42** | 8 (shared) | 16 GB | 160 GB | 20 TB | 1 included | **€16.40** |
| **CX52** | 16 (shared) | 32 GB | 320 GB | 20 TB | 1 included | **€32.40** |

**Additional Hetzner services:**

| Service | Description | Price |
|---|---|---|
| **Volumes** | Persistent block storage — survives server reinstalls | €0.0476/GB/month |
| **Object Storage** | S3-compatible bucket storage for files, backups | €4.99/month base (1TB storage + 1TB egress included) |
| **Load Balancer LB11** | Distributes traffic across multiple servers | €5.39/month |
| **Private Network** | Internal network between servers | **Free** |
| **Firewall** | Network-level allow/deny rules | **Free** |
| **Snapshots** | Point-in-time server snapshots | €0.01176/GB/month |

---




### 5.4 Upgrade Path

**When RAM consistently hits 3 GB** under normal load:

**Option A — Resize server (5 minutes, zero data loss):**
```
Hetzner console → resize CX22 to CX32 (4 vCPU · 8 GB RAM)
Cost: €6.80/month
Volume stays attached — no data migration needed
```

**Option B — Split app and database (30 minutes, zero data loss):**
```
1. Provision second CX22 for PostgreSQL only
2. Detach Volume from single server
3. Attach Volume to new DB server
4. Update DB_HOST in Doppler → redeploy
Cost: €7.58/month (two CX22s)
```

---

### 5.5 Database Backups

Postgres runs in Docker — backups are our responsibility.

**Automated backup strategy (3 layers):**

```
Daily 02:00 UTC (Go River cron):
  pg_dump -Fc all schemas
  → gzip → backup-YYYY-MM-DD.sql.gz
  → upload Hetzner Object Storage /backups/daily/
  → delete dumps older than 30 days
  → alert SUPER_ADMIN if job fails

Weekly Sunday 03:00 UTC:
  Hetzner Snapshot of CX22 (full disk image)
  → retain last 4 snapshots (~€0.50/month)

Monthly 1st of month (Go River cron):
  pg_dump → /backups/monthly/backup-YYYY-MM.sql.gz
  → retain for 7 years (EU regulatory requirement)
  → ~50MB per dump, well within Object Storage free tier
```

**Recovery scenarios:**

| Scenario | Method | Time | Data loss |
|---|---|---|---|
| Accidental table drop | Restore daily dump | ~15 min | Up to 24 hours |
| Server completely dies | New CX22 + reattach Volume | ~5 min | Zero |
| Volume corrupted | Restore weekly snapshot | ~10 min | Up to 7 days |
| Regulatory audit | Monthly dump available | N/A | N/A |

---

### 5.6 Cloudflare — DNS Only, No CDN

Cloudflare DNS only — proxy OFF (grey cloud). SSL via Let's Encrypt on the server.

- EU-only scope — all users within 50ms of a German server
- No CDN needed at this stage
- Enable Cloudflare proxy with one click when US/global clients added

---

### 5.7 Migration Path

```
V1 (0–100 users)
  Single Hetzner CX22 + Volume + Object Storage
  Docker Compose · Nginx · Let's Encrypt · Cloudflare DNS
  €13.54/month

V2 (100–500 users)
  Resize to CX32 or split into 2 × CX22
  €7–10/month

V3 (500–2000 users)
  Hetzner dedicated OR AWS eu-west-1 (Dublin)
  Managed Postgres · Kubernetes
  ~€200/month
```

`[TEAMMATE: ADD DIAGRAM HERE — Single Hetzner CX22: Nginx + 3 services + Postgres in Docker, Volume attached for Postgres data, Object Storage for backups and agreements, Cloudflare DNS pointing to server]`

---

## 6. Data Model

### 6.1 Multi-Tenancy

The platform is **multi-tenant**. A `tenant_id` column exists on every user-owned table, enforced via PostgreSQL **Row-Level Security (RLS)** policies. Data isolation is enforced at the database layer — not just the application layer. Even if application logic has a bug, one tenant cannot read another's data.

### 6.2 Core Tables

#### `users`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `tenant_id` | UUID FK | Multi-tenancy isolation key |
| `type` | ENUM | `INDIVIDUAL` \| `ENTERPRISE` |
| `email` | TEXT UNIQUE | Login identifier |
| `password_hash` | TEXT | bcrypt; never plaintext |
| `status` | ENUM | `PENDING_PROFILE` \| `PENDING_AGREEMENT` \| `PENDING_INVESTMENT` \| `PENDING_DEPOSIT` \| `ACTIVE` \| `MATURED` \| `SUSPENDED` |
| `kyc_status` | ENUM | `NOT_STARTED` \| `PENDING` \| `APPROVED` \| `REJECTED` — checked when KYC module activated |
| `created_at` | TIMESTAMPTZ | Immutable |
| `updated_at` | TIMESTAMPTZ | Auto-updated via DB trigger |

---

#### `user_profiles`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID FK → users | One-to-one |
| `full_name` | TEXT | Individual: full name \| Enterprise: company name |
| `contact_person` | TEXT | Enterprise only |
| `phone` | TEXT | |
| `address` | TEXT ENCRYPTED | PII — AES-256 encrypted at rest |
| `city` | TEXT | |
| `country` | TEXT | |
| `bank_account_number` | TEXT ENCRYPTED | For outgoing withdrawals |
| `bank_routing_info` | JSONB ENCRYPTED | IBAN / SWIFT / ABA as applicable |
| `currency_preference` | TEXT | `USD` default; `EUR` for EU clients |

---

#### `investments`

> A user can hold multiple investments simultaneously. Each is independent with its own pool, maturity date, and profit tracking. Risk profile and maturity are **fixed once deposit is confirmed**.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID FK | |
| `pool_id` | UUID FK → pools | Assigned by admin after deposit is mapped |
| `risk_profile` | ENUM | `LOW` \| `MEDIUM` \| `HIGH` |
| `target_return_pct` | NUMERIC(5,2) | 20.00 / 25.00 / 30.00 |
| `maturity_months` | INTEGER | 6 \| 12 \| 24 |
| `amount_category` | TEXT | `20K` \| `50K` \| `100K` \| `ABOVE_100K` |
| `start_date` | DATE | Set when deposit confirmed |
| `maturity_date` | DATE | Computed: start_date + maturity_months |
| `status` | ENUM | `PENDING_DEPOSIT` \| `ACTIVE` \| `MATURED` \| `CLOSED` |
| `minimum_capital_floor` | NUMERIC(18,2) | Admin-configurable per investment e.g. 5,000 |

---

#### `investment_risk_splits` (for split investments)

> When a user deposits $10,000 and wants 40% HIGH / 30% MEDIUM / 30% LOW, each split is a separate row. Each split gets independently tracked in the ledger.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `investment_id` | UUID FK | Parent investment |
| `risk_profile` | ENUM | `LOW` \| `MEDIUM` \| `HIGH` |
| `percentage` | NUMERIC(5,2) | e.g. 40.00 — must sum to 100 across splits |
| `amount` | NUMERIC(18,2) | Computed from percentage × total deposit |
| `currency` | TEXT | Currency of split, defaults to EUR |

---

#### `ledger_entries` — THE CORE TABLE

> **Append-only. No UPDATE or DELETE ever.** Balance is never stored — always derived from this table.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID FK | |
| `investment_id` | UUID FK | |
| `pool_id` | UUID FK | |
| `entry_type` | ENUM | `DEPOSIT` \| `PROFIT_ALLOCATION` \| `PROFIT_REVERSAL` \| `CAPITAL_LOSS` \| `CAPITAL_WITHDRAWAL` \| `PROFIT_WITHDRAWAL` \| `FEE` \| `ROUNDING_ADJUSTMENT` |
| `direction` | ENUM | `CREDIT` \| `DEBIT` |
| `amount` | NUMERIC(18,2) | Amount of the entry |
| `currency` | TEXT | Currency of entry, defaults to EUR |
| `original_amount` | NUMERIC(18,2) | Client's original currency amount |
| `original_currency` | TEXT | `USD` \| `EUR` \| `GBP` etc. |
| `fx_rate` | NUMERIC(12,6) | Exchange rate at time of booking |
| `reference_id` | TEXT UNIQUE | Bank transaction ID — idempotency key |
| `status` | ENUM | `PENDING` \| `CONFIRMED` \| `FAILED` \| `REVERSED` |
| `created_at` | TIMESTAMPTZ | Immutable |
| `metadata` | JSONB | Bank memo, admin notes, source IP for audit |

> `ROUNDING_ADJUSTMENT` entry type handles the largest remainder method for profit distribution — see Section 6 Design Note on the Penny Problem.

**Balance derivation query — uses snapshot + delta (Fix 5):**
```sql
-- Fast query: snapshot balance + only current month's new entries
-- Never scans full history regardless of account age
SELECT 
  COALESCE(s.snapshot_balance, 0) +
  COALESCE((
    SELECT SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END)
    FROM ledger_entries
    WHERE investment_id = $1
      AND status = 'CONFIRMED'
      AND created_at >= date_trunc('month', NOW())
  ), 0) AS current_balance
FROM monthly_balance_snapshots s
WHERE s.investment_id = $1
ORDER BY s.snapshot_month DESC
LIMIT 1;
```

---

#### `monthly_balance_snapshots`

> Created by a cron job on the 1st of every month. Prevents unbounded ledger summation as the platform ages. Without this, a 5-year-old account would require summing thousands of rows on every dashboard load.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `investment_id` | UUID FK | |
| `user_id` | UUID FK | |
| `snapshot_month` | DATE | First day of the month e.g. `2025-01-01` |
| `snapshot_balance` | NUMERIC(18,2) | Confirmed balance as of end of previous month |
| `currency` | TEXT | Currency of snapshot, defaults to EUR |
| `created_at` | TIMESTAMPTZ | When snapshot was taken |

---

#### `outbox_events` — TRANSACTIONAL OUTBOX

> Solves the dual-write problem. Every event that must trigger a downstream action (notification, admin alert, queue job) is written to this table **in the same database transaction** as the ledger entry. A separate worker polls this table and enqueues to River inside the Go service. If the app crashes between DB commit and queue publish, the worker picks it up on restart. Zero financial events are ever lost.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `event_type` | TEXT | e.g. `DEPOSIT_PENDING`, `INVESTMENT_ACTIVATED`, `MATURITY_REACHED` |
| `payload` | JSONB | Full event data needed by the consumer |
| `published` | BOOLEAN | Default `false` — set to `true` after worker publishes to queue |
| `published_at` | TIMESTAMPTZ | |
| `created_at` | TIMESTAMPTZ | |

**Outbox worker (runs every 1 second inside Go Payments & Notifications service):**
```
SELECT * FROM outbox_events WHERE published = false ORDER BY created_at ASC LIMIT 100
→ for each event: enqueue to River queue
→ UPDATE outbox_events SET published = true, published_at = NOW() WHERE id = $1
```

---

#### `pools`

> **Pool naming convention:** `{ACCOUNT}-{RISK}-{SEQUENCE}` e.g. `ACCA-HIGH-001`, `ACCB-MED-002`, `ACCC-LOW-001`. This makes every pool self-describing — risk profile and trading account are visible at a glance without clicking into the record.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `pool_code` | TEXT UNIQUE | Format: `ACCA-HIGH-001` — auto-suggested on creation, editable |
| `trading_account_id` | UUID FK | Links to `trading_accounts` table |
| `trading_account_label` | TEXT | e.g. `Account A`, `Account B` |
| `risk_profile` | ENUM | Pool's designated risk profile — `LOW` \| `MEDIUM` \| `HIGH` |
| `maturity_months` | INTEGER | Pool's designated maturity period |
| `status` | ENUM | `OPEN` \| `CLOSED` \| `SUSPENDED` \| `FULL` |
| `max_transactions` | INTEGER | Admin-set cap e.g. 10 or 20 |
| `current_transaction_count` | INTEGER | Auto-incremented on each allocation — protected by DB constraint |
| `owned_by` | UUID FK → admins | Pool Manager who manages this pool day-to-day |
| `created_by` | UUID FK → admins | Who originally created it (may differ from owner) |
| `created_at` | TIMESTAMPTZ | |

**Database-level capacity enforcement (Fix 3 — Race Condition):**
```sql
-- Hard constraint: database rejects any increment beyond max_transactions
-- Cannot be bypassed by application logic bugs or concurrent requests
ALTER TABLE pools ADD CONSTRAINT pool_capacity_check
  CHECK (current_transaction_count <= max_transactions);

-- Application-level row lock before reading capacity
-- Prevents two simultaneous requests both seeing "1 slot available"
SELECT * FROM pools WHERE id = $1 FOR UPDATE;
-- Second concurrent request waits here until first commits or rolls back
```

> Two-layer protection: `FOR UPDATE` prevents the race condition at the application level. The `CHECK` constraint is the final safety net at the database level. Even if someone bypasses the application lock, the database will reject the insert.

> **Ownership vs Creation:** `created_by` is immutable — records who made the pool. `owned_by` can be reassigned by SUPER_ADMIN if a Pool Manager leaves or pools are rebalanced across the team.

---

#### `investment_pool_allocations`

> This table is the core of multi-admin pool tracking. When one investment (or one risk slice of a split investment) is spread across multiple admin-owned pools, each slice gets a row here. This enables full traceability: every dollar is tracked to exactly which pool and which admin owns it.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `investment_id` | UUID FK → investments | The investment this allocation belongs to |
| `pool_id` | UUID FK → pools | Which pool this slice went into |
| `owned_by_admin_id` | UUID FK → admins | Which Pool Manager owns this slice |
| `amount` | NUMERIC(18,2) | Amount allocated to this pool |
| `currency` | TEXT | Currency of allocation, defaults to EUR |
| `percentage` | NUMERIC(5,2) | % of investment total e.g. 60.00 — all allocations for one investment must sum to 100 |
| `status` | ENUM | `ACTIVE` \| `PARTIALLY_WITHDRAWN` \| `FULLY_WITHDRAWN` |
| `allocated_at` | TIMESTAMPTZ | When allocation was confirmed |
| `allocated_by` | UUID FK → admins | SUPER_ADMIN who created the allocation split |

**Example — $100K HIGH investment split across two Pool Managers:**
```
investment_id: INV-456A (HIGH risk, $100K total)
  row 1: pool=ACCA-HIGH-001, owned_by=Admin-1, amount=$60,000, pct=60%
  row 2: pool=ACCB-HIGH-001, owned_by=Admin-2, amount=$40,000, pct=40%
```

**Client sees:** "$100,000 invested — HIGH RISK"
**Admin sees:** which pools and which managers hold their slice
**SUPER_ADMIN sees:** full picture across all admins

---

#### `withdrawal_requests`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID FK | |
| `investment_id` | UUID FK | |
| `type` | ENUM | `PROFIT` \| `CAPITAL` |
| `amount_requested` | NUMERIC(18,2) | Must be ≥ minimum_capital_floor for capital type |
| `currency` | TEXT | Currency of request, defaults to EUR |
| `notice_days` | INTEGER | 15 \| 30 \| 45 — set from config at request time |
| `status` | ENUM | `SUBMITTED` \| `NOTICE_PERIOD` \| `READY_FOR_APPROVAL` \| `TASKS_PENDING` \| `TASKS_COMPLETE` \| `COMPLETED` \| `CANCELLED` |
| `notice_start_date` | DATE | |
| `ready_date` | DATE | `notice_start_date + notice_days` |
| `approved_by` | UUID FK → admins | Final approver (SUPER_ADMIN or FINANCE_APPROVER) |
| `approved_at` | TIMESTAMPTZ | |
| `transfer_reference` | TEXT | Final outgoing bank transfer reference to client |

> When an investment has allocations across multiple admin pools, the system automatically generates one `withdrawal_task` per pool. The withdrawal request stays in `TASKS_PENDING` until every task is `TRANSFER_DONE`. Only then does it move to `COMPLETED` and the client is notified.

---

#### `withdrawal_tasks`

> One withdrawal task per admin pool involved in a withdrawal. Enables each Pool Manager to independently handle their portion of a multi-pool withdrawal. SUPER_ADMIN monitors all tasks and can see exactly which admin is holding things up.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `withdrawal_request_id` | UUID FK → withdrawal_requests | Parent withdrawal |
| `pool_id` | UUID FK → pools | Which pool this task sources funds from |
| `admin_id` | UUID FK → admins | Pool Manager responsible for this task |
| `amount` | NUMERIC(18,2) | Amount to be sourced from this specific pool |
| `currency` | TEXT | Currency of task, defaults to EUR |
| `percentage` | NUMERIC(5,2) | % of total withdrawal this task covers |
| `status` | ENUM | `PENDING` \| `ADMIN_APPROVED` \| `TRANSFER_DONE` \| `FAILED` |
| `failure_reason` | TEXT | Bank rejection reason — populated when status = FAILED |
| `approved_by` | UUID FK → admins | |
| `approved_at` | TIMESTAMPTZ | |
| `transfer_reference` | TEXT | This pool's outgoing transfer reference |
| `notes` | TEXT | Admin notes e.g. liquidity comments |
| `created_at` | TIMESTAMPTZ | |

**Example — $100K HIGH capital withdrawal:**
```
withdrawal_request_id: WR-789 (amount=$100K, status=TASKS_PENDING)
  task 1: pool=ACCA-HIGH-001, admin=Admin-1, amount=$60K, status=TRANSFER_DONE ✅
  task 2: pool=ACCB-HIGH-001, admin=Admin-2, amount=$40K, status=PENDING ⏳

WR-789 stays in TASKS_PENDING until task 2 is TRANSFER_DONE.
SUPER_ADMIN can see Admin-2 has not acted yet.
```

---

#### `admins`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `email` | TEXT UNIQUE | |
| `password_hash` | TEXT | bcrypt |
| `role` | ENUM | `SUPER_ADMIN` \| `POOL_MANAGER` \| `FINANCE_APPROVER` |
| `created_by` | UUID FK → admins | Only SUPER_ADMIN can create admins |
| `is_active` | BOOLEAN | SUPER_ADMIN can deactivate |
| `last_login_at` | TIMESTAMPTZ | |
| `created_at` | TIMESTAMPTZ | |

---

#### `audit_log`

> Every financial and admin action writes a row here. Immutable.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `actor_id` | UUID | Admin or user who performed the action |
| `actor_type` | ENUM | `ADMIN` \| `USER` \| `SYSTEM` |
| `action` | TEXT | e.g. `POOL_CREATED`, `TRANSACTION_MAPPED`, `WITHDRAWAL_APPROVED` |
| `entity_type` | TEXT | e.g. `pool`, `ledger_entry`, `withdrawal_request` |
| `entity_id` | UUID | |
| `before_state` | JSONB | Snapshot before change |
| `after_state` | JSONB | Snapshot after change |
| `ip_address` | TEXT | |
| `created_at` | TIMESTAMPTZ | Immutable |


![ER Diagram](./er_diag.png)
---

## 7. RBAC — Admin Roles & Permissions

> V1 ships with **SUPER_ADMIN only**. The role structure is fully built so additional roles can be activated when employees are onboarded — no code change needed, only role assignment.

### 7.1 Permission Matrix

| Permission | SUPER_ADMIN | POOL_MANAGER | FINANCE_APPROVER |
|---|:---:|:---:|:---:|
| Create / manage admin accounts | ✅ | ❌ | ❌ |
| Assign roles to admins | ✅ | ❌ | ❌ |
| Deactivate any admin account | ✅ | ❌ | ❌ |
| View all other SUPER_ADMIN accounts and activity | ✅ | ❌ | ❌ |
| Create pools | ✅ | ✅ | ❌ |
| Own / manage their own pools | ✅ | ✅ | ❌ |
| View other Pool Manager's pools (read-only) | ✅ | ❌ | ❌ |
| Map transactions to pools | ✅ | ✅ (own pools only) | ❌ |
| Split investment allocations across multiple pools | ✅ | ❌ | ❌ |
| Enter profit allocations for own pools | ✅ | ✅ | ❌ |
| View profit entries across all pools | ✅ | ❌ | ❌ |
| Approve withdrawal tasks (own pools) | ✅ | ✅ | ✅ |
| Approve withdrawal tasks (any pool) | ✅ | ❌ | ❌ |
| View withdrawal task status across all admins | ✅ | ❌ | ✅ |
| Initiate outgoing bank transfers | ✅ | ❌ | ✅ |
| View all users and portfolios | ✅ | ✅ | ✅ |
| View investment pool allocations (internal splits) | ✅ | Own only | ❌ |
| Suspend user accounts | ✅ | ❌ | ❌ |
| Export all reports | ✅ | Own pools only | ✅ |
| View full audit log | ✅ | Own actions only | Own actions only |

### 7.2 Key Rules

**SUPER_ADMIN sees everything — including other SUPER_ADMINs:**
- All SUPER_ADMIN accounts are visible to each other
- All pools — regardless of which admin owns them
- All withdrawal tasks — regardless of which admin they're assigned to
- Full audit log of every action by every admin
- This is intentional: SUPER_ADMIN acts as the oversight layer across the entire operation

**Pool Manager sees only their own:**
- Only pools where `owned_by = their admin_id`
- Only withdrawal tasks assigned to their pools
- Cannot see other Pool Managers' pools, allocations, or clients

**SUPER_ADMIN creates all admin accounts:**
- No self-registration for admins — ever
- SUPER_ADMIN sets email + role → system sends invite → new admin sets password
- SUPER_ADMIN can deactivate any admin including another SUPER_ADMIN

**Client portal is completely separate:**
- No admin role has access to the client portal login
- No client can access the admin portal
- Credentials are entirely separate systems

---

## 8. User Flows

### 8.1 User Account State Machine

```
[REGISTERED]
    │ User submits profile form
    ▼
[PENDING_AGREEMENT]
    │ User scrolls to end + checks "I have read and agree"
    ▼
[PENDING_INVESTMENT]
    │ User submits risk profile + maturity + views deposit instructions
    ▼
[PENDING_DEPOSIT]
    │ Admin maps inbound bank transaction to this user's investment
    ▼
[ACTIVE]
    │ System cron detects maturity date reached
    ▼
[MATURED] ── reminder at 7d / 30d / 90d SUPER_ADMIN alert if no action ──► stays MATURED
    │ User withdraws all capital and profit
    ▼
[CLOSED]

Any state ── Admin suspends ──► [SUSPENDED]
Any state ── GDPR erasure request ──► [GDPR_ANONYMISED] (PII removed, financial records retained)
```

> **Post-maturity behaviour:** Investment stays in MATURED indefinitely until client acts or admin intervenes. Does NOT auto-renew without explicit instruction. **[CEO CONFIRM: should matured investments auto-renew on same terms after X days of inaction?]**

![user state machine](./user_state_1.png)
---

### 8.2 Sign Up & Onboarding Flow

#### Step 1 — Account Creation
1. User clicks **Create Account**
2. Selects type: **Individual** or **Enterprise**
3. Enters: Email, Password (min 12 chars, 1 uppercase, 1 number, 1 special char), Confirm Password
4. System sends verification email with signed link (expires 24h)
5. User clicks link → account activated → redirect to profile form
6. After first login, user is **prompted to enable 2FA** (TOTP — Google Authenticator / Authy). Optional in V1 with a persistent banner until enabled. Mandatory in a later version.

> **Why 2FA matters here:** A compromised client account gives an attacker access to withdrawal requests and the client's registered bank details. Unlike a social media account, the consequence is direct financial loss.

#### Step 2 — Profile Form

**Individual fields:**
- Full Name
- Phone Number
- Email (pre-filled, read-only)
- Street Address, City, Country
- Bank Account Number (for withdrawals)
- IBAN / SWIFT / Routing Number
- Currency Preference (USD default | EUR for EU clients)

**Enterprise additional fields:**
- Company Name
- Contact Person Name
- Contact Person Phone

> All PII fields are AES-256 encrypted at rest. Access is logged in the audit trail. Contact person reassignment for enterprises is an admin function added in a later version — V1 assumes the enterprise manages this internally.

#### Step 3 — Agreement

- Full agreement text rendered in a scrollable panel
- User **must scroll to the bottom** before the checkbox activates — enforced client-side with a scroll position listener
- Once at bottom, checkbox appears: **"I have read and understood the full agreement"**
- User checks box → clicks **"I Agree & Continue"**
- System records: `agreement_signed = true`, `signed_at = now()`, stores PDF copy in S3
- State is **binary** — no percentage saved. If user closes browser, they restart the scroll on next visit. Agreement panel is not paginated.

<!-- `[TEAMMATE: ADD DIAGRAM HERE — Wireframe/screenshot of the agreement forced-scroll UI]` -->

#### Step 4 — Investment Configuration

User selects:
1. **Investment Amount Category:** $20K | $50K | $100K | Above $100K
2. **Risk Split:** User can allocate their deposit across risk profiles
   - Option A: 100% to one profile (Low / Medium / High)
   - Option B: Custom split — e.g. 40% High, 30% Medium, 30% Low (must sum to 100%)
3. **Maturity Period:** 6 Months | 1 Year | 2 Years

> Each combination of risk profile + maturity creates a **separate investment record**. A user depositing $100K split 40/30/30 gets three investment records, each tracked independently in the ledger.

4. System displays **deposit instructions:**
   - Irish account IBAN
   - SWIFT/BIC code
   - Reference format: `[USER-ID]-[INVESTMENT-ID]` (admin uses this to map the incoming transfer)
5. User clicks **"I'm Ready to Transfer"** → status moves to `PENDING_DEPOSIT`

<!-- `[TEAMMATE: ADD DIAGRAM HERE — Full onboarding sequence diagram from Sign Up → Profile → Agreement → Investment Config → Deposit Instructions]` -->

---

### 8.3 Client Dashboard — Pre-Deposit (Empty State)

When user status is `PENDING_DEPOSIT`, dashboard shows:

- **Onboarding checklist** with progress (✅ Profile, ✅ Agreement, ✅ Investment configured, ⏳ Awaiting deposit confirmation)
- **Deposit instructions panel** — IBAN, SWIFT, reference code, how to format the wire
- **Investment calculator** — interactive illustrative figures only: "If you invest $X at Medium risk for 1 year, estimated return: $X". Every figure accompanied by mandatory disclaimer: *"This is an illustration based on target returns, not a guarantee. Actual returns depend on trading performance and may be lower. Capital is at risk."* `[CEO CONFIRM: exact calculator logic]`
- **About the platform** — brief section on who manages the pools, why to invest, the firm's approach [TEAMMATE: Add copy from website reference e.g. Dezerv-style content you mentioned]
- **FAQ section** — common questions about SEPA/SWIFT transfers, timelines, etc.

---

### 8.4 Client Dashboard — Active Investment State

After deposit is confirmed and mapped to a pool:

| Card | Shows |
|---|---|
| Total Invested | Sum of all confirmed capital across all active investments (in USD) |
| Estimated Portfolio Value | Capital + profit allocated to date |
| Active Investments | Count of ACTIVE investments |
| Next Maturity | Countdown to nearest maturity date |

**Sections:**
- **My Investments table** — one row per investment: Risk Profile, Amount, Pool ID, Start Date, Maturity Date, Current Profit, Status
- **Allocation breakdown** — pie chart: % per risk profile
- **Maturity timeline** — visual bar showing when each investment matures
- **Performance chart** — profit over time (populated from admin profit entries)
- **Notifications panel** — recent events (deposit confirmed, profit updated, maturity approaching)
- **Quick Actions:** Request Withdrawal | View Agreement | Update Bank Details

<!-- `[TEAMMATE: ADD DIAGRAM HERE — Dashboard wireframe/mockup showing the above layout]` -->

---

### 8.5 Withdrawal Flow — Profit

Profit withdrawal is available **at or after maturity date**.

1. User clicks **"Withdraw Profits"** on investment card
2. System shows available profit balance for that investment
3. User confirms withdrawal amount (can be partial or full profit)
4. System creates `withdrawal_request` with `type = PROFIT`
5. Admin receives notification: "Profit withdrawal requested — User X, Investment Y, Amount $Z"
6. Admin reviews → clicks **Approve**
7. Admin initiates outgoing bank transfer from Irish account to user's registered bank
8. System records `transfer_reference`, updates withdrawal status to `TRANSFER_INITIATED`
9. Once confirmed: status → `COMPLETED`, ledger entry created (`PROFIT_WITHDRAWAL DEBIT`)
10. User receives email: "Your profit withdrawal of $X has been processed. Transfer reference: XXXX"

**Failed transfer handling:** If the bank rejects the outgoing transfer (wrong IBAN, closed account, compliance hold):
- Withdrawal task status → `FAILED`
- Admin notified immediately
- Client notified: transfer could not be completed, asked to verify bank details
- Ledger entry for the withdrawal is automatically reversed (`PROFIT_WITHDRAWAL REVERSAL CREDIT`)
- Withdrawal request stays open — admin re-initiates once client updates bank details

> **Profit withdrawal notice period:** `[CEO CONFIRM]` — current assumption is 7–15 days. System config makes this adjustable per investment.

---

### 8.6 Withdrawal Flow — Capital

Capital withdrawal has stricter rules due to the notice period admin needs to rebalance the pool.

**Rules:**
- User cannot withdraw below the **minimum capital floor** (configured per investment, e.g. $5,000)
  - Example: User invested $100K, floor = $5K → max withdrawable = $95K
  - If user wants full exit → balance goes to $0 (floor waived on full closure)
- Capital withdrawal triggers a **notice period** to allow admin time to source funds from the pool
- Notice period options (admin-configurable per investment tier): **15 days | 30 days | 45 days** `[CEO CONFIRM: exact tiers]`

**Flow:**
1. User clicks **"Withdraw Capital"** on investment card
2. System shows: current capital balance, minimum floor, maximum withdrawable amount
3. User enters withdrawal amount (validated against floor rule)
4. System creates `withdrawal_request` with `type = CAPITAL`, sets `notice_start_date = today`, computes `ready_date`
5. Admin notified immediately
6. System sends user confirmation: "Capital withdrawal requested. Notice period: X days. Funds available from: [ready_date]"
7. Daily cron job checks: `WHERE type='CAPITAL' AND status='NOTICE_PERIOD' AND ready_date <= today`
8. On ready_date → status → `READY_FOR_APPROVAL`, admin notified
9. Admin cross-checks pool liquidity → approves → initiates outgoing transfer
10. Status updates: `ADMIN_APPROVED` → `TRANSFER_INITIATED` → `COMPLETED`
11. User notified at each stage with email

**Cancellation:** User can cancel a `CAPITAL` withdrawal **before** `ready_date`. After that, it requires admin intervention.

**Failed transfer handling:** Same as profit withdrawal — task moves to `FAILED`, ledger reversal is booked automatically, withdrawal stays open pending client bank detail update.

**Floor waiver on full exit:** If the client explicitly requests full closure (balance to $0), the minimum capital floor is waived. System flags this clearly: "You are requesting full exit. Your entire capital balance of $X will be returned. This investment will close permanently."

![Capital withdrawal workflow](./withdrwal_program.png)

---

### 8.7 Multiple Simultaneous Investments

A user can hold multiple active investments at the same time. Example:

| Investment | Amount | Risk | Maturity | Status |
|---|---|---|---|---|
| INV-001 | $20,000 | LOW | 1 Year | ACTIVE |
| INV-002 | $50,000 (40% HIGH / 60% MEDIUM) | Split | 2 Years | ACTIVE |
| INV-003 | $30,000 | HIGH | 6 Months | MATURED |

Each investment has its own pool assignment, profit tracking, and withdrawal workflow. Dashboard aggregates all of them into the summary cards while allowing drill-down per investment.

---

## 9. Admin Flows

### 9.1 Admin Login

- Completely separate portal at `admin.yourdomain.com`
- No crossover with client login
- Standard email + password
- 2FA enforced (TOTP — e.g. Google Authenticator) for all admin accounts
- Session timeout: 30 minutes of inactivity
- All login attempts (success + failure) logged in audit_log

---

### 9.2 Admin Dashboard Overview

The dashboard renders differently based on the logged-in admin's role.

**SUPER_ADMIN Dashboard — Full Visibility:**

| Widget | Shows |
|---|---|
| Total AUM | Sum of all confirmed capital across ALL pools across ALL admins (USD) |
| Active Pools | Count of all OPEN pools across all Pool Managers |
| Pending Deposits | All inbound transactions not yet mapped — any admin |
| Pending Withdrawal Tasks | All withdrawal tasks across all admins — with who is blocking |
| Upcoming Maturities | Investments maturing in next 30 days — all pools |
| Admin Activity Feed | Live audit log — every action by every admin |
| Pool Health by Admin | Visual panel showing each admin's pools, fill level, capital, status |

**Pool Health Panel (SUPER_ADMIN only):**
```
ADMIN 1 — Pool Manager A          [View All] [Message]
  🔴 ACCA-HIGH-001  ████████████████░░░░  16/20  $800K   OPEN
  🟡 ACCA-MED-001   ████████░░░░░░░░░░░░   8/20  $400K   OPEN

ADMIN 2 — Pool Manager B          [View All] [Message]
  🔴 ACCB-HIGH-001  ████████████░░░░░░░░  12/20  $600K   OPEN
  🟢 ACCB-LOW-001   ████████████████████  20/20  $1.0M   FULL ⛔

ADMIN 3 — Pool Manager C          [View All] [Message]
  🟡 ACCC-MED-001   ████░░░░░░░░░░░░░░░░   4/20  $200K   OPEN

OTHER SUPER ADMINS
  Super Admin 2     Last active: 2 hours ago   [View Activity]
  Super Admin 3     Last active: 1 day ago     [View Activity]
```

**Pending Withdrawal Tasks Panel (SUPER_ADMIN only):**
```
WR-789 — John Smith — $100K HIGH RISK — Capital Withdrawal
  ├── Task 1 → Admin 1  ACCA-HIGH-001  $60K  ✅ TRANSFER_DONE
  └── Task 2 → Admin 2  ACCB-HIGH-001  $40K  ⏳ PENDING  [Nudge]

WR-790 — Jane Corp — $50K MEDIUM RISK — Profit Withdrawal
  └── Task 1 → Admin 3  ACCC-MED-001   $50K  ⏳ PENDING  [Nudge]
```

---

**POOL_MANAGER Dashboard — Own Pools Only:**

| Widget | Shows |
|---|---|
| My AUM | Sum of capital in pools I own |
| My Active Pools | Count of my OPEN pools |
| Pending Deposits | Deposits waiting for me to map — my pools only |
| My Withdrawal Tasks | Tasks assigned to my pools needing action |
| Upcoming Maturities | Maturities in my pools — next 30 days |
| My Recent Activity | My last 20 actions only |

<!-- `[TEAMMATE: ADD DIAGRAM HERE — POOL_MANAGER dashboard wireframe — scoped view with no cross-admin data]` -->

---

### 9.3 Pool Management Flow

**Pool Naming Convention:**

All pools follow the format `{ACCOUNT}-{RISK}-{SEQUENCE}`:

| Example Code | Means |
|---|---|
| `ACCA-HIGH-001` | Account A, High Risk, Pool 1 |
| `ACCA-HIGH-002` | Account A, High Risk, Pool 2 (overflow when 001 fills) |
| `ACCB-MED-001` | Account B, Medium Risk, Pool 1 |
| `ACCC-LOW-001` | Account C, Low Risk, Pool 1 |

System auto-suggests the next code in sequence when admin creates a pool. Admin can override. This naming makes every pool self-describing — no clicking into a pool to know what it is.

**Create Pool:**
1. Admin clicks **"Create Pool"**
2. System auto-fills Pool Code based on convention (editable)
3. Admin selects: Trading Account, Risk Profile (pre-filled from code), Maturity Period, Max Transactions
4. Pool is automatically `owned_by` the creating admin
5. SUPER_ADMIN can reassign ownership after creation
6. Pool created with status `OPEN` → visible in pool list immediately

**Pool List View — Visual Grouping:**

Pools are displayed grouped by risk profile (colour-coded), then by owner admin:

```
🔴 HIGH RISK POOLS
  ├── [Admin 1]
  │     ACCA-HIGH-001  ████████████████░░░░  16/20  $800K  OPEN
  │     ACCA-HIGH-002  ███░░░░░░░░░░░░░░░░░   3/20  $150K  OPEN
  └── [Admin 2]
        ACCB-HIGH-001  ████████████████████  20/20  $1.0M  FULL ⛔

🟡 MEDIUM RISK POOLS
  └── [Admin 3]
        ACCC-MED-001   ████░░░░░░░░░░░░░░░░   4/20  $200K  OPEN

🟢 LOW RISK POOLS
  └── [Admin 2]
        ACCB-LOW-001   ████████░░░░░░░░░░░░   8/20  $400K  OPEN
```

> **Pool Managers see only their own pools.** SUPER_ADMIN sees all pools grouped by admin as shown above. This prevents Pool Managers from accidentally mapping to another admin's pool.

**Pool Detail View:**
- All `investment_pool_allocations` mapped to this pool (not raw transactions — allocations)
- Per-allocation: User name, investment ID, amount, date allocated
- Capital total, profit allocated to date, client count
- Withdrawal tasks pending for this pool
- Trading account link
- Action buttons: Enter Profit, Close Pool (SUPER_ADMIN only: Reassign Owner)
<!-- 
`[TEAMMATE: ADD DIAGRAM HERE — Pool list view wireframe showing colour-coded risk grouping with fill progress bars and owner admin labels]`

`[TEAMMATE: ADD DIAGRAM HERE — Pool detail view wireframe showing allocation list + profit history + pending withdrawal tasks]` -->

---

### 9.4 Transaction Mapping Flow

#### A10 — Single Risk Investment (Simple Mapping)

When a client deposits $50K with 100% MEDIUM risk:

1. Bank polling detects transaction → Payment Module creates `ledger_entry` with `status=PENDING`
2. System parses reference → identifies user + investment
3. Admin (POOL_MANAGER) sees in their pending deposits queue:
   - Tx ID, Amount: $50,000, Risk: MEDIUM, User: John Smith
4. Admin clicks **"Map Transaction"**
5. Dropdown shows **only OPEN MEDIUM pools they own** — cannot select wrong risk or another admin's pool
6. Admin selects pool (system pre-selects pool with most available capacity)
7. Confirms → system:
   - Creates 1 row in `investment_pool_allocations` (100%, $50K, this pool, this admin)
   - Updates `ledger_entry.status = CONFIRMED`
   - Sets `investment.status = ACTIVE`, `start_date = today`
   - Increments `pool.current_transaction_count`
8. Client notified: "Deposit confirmed, investment active"

#### A11 — Split Risk Investment (Multi-Pool Allocation)

When a client deposits $100K split 40% HIGH / 30% MEDIUM / 30% LOW:

1. Bank polling detects transaction → one bank transaction arrives for €100K
2. System parses reference → finds investment group with 3 risk slices:
   - INV-456A: HIGH 40% = $40,000
   - INV-456B: MEDIUM 30% = $30,000
   - INV-456C: LOW 30% = $30,000
3. **SUPER_ADMIN** handles split allocation (Pool Managers cannot split across admins)
4. SUPER_ADMIN sees the mapping UI:

```
┌──────────────────────────────────────────────────────────────┐
│ 🔔 SPLIT INVESTMENT DEPOSIT                                  │
│ User: John Smith    Total: $100,000                          │
│ Reference: USER-123-GRP-456                                  │
│                                                              │
│ This deposit has 3 risk allocations:                         │
│                                                              │
│  🔴 HIGH    40%  $40,000  → Pool: [ACCA-HIGH-001 ▼]         │
│                             Owner: Admin 1                    │
│  🟡 MEDIUM  30%  $30,000  → Pool: [ACCB-MED-001  ▼]         │
│                             Owner: Admin 3                    │
│  🟢 LOW     30%  $30,000  → Pool: [ACCB-LOW-001  ▼]         │
│                             Owner: Admin 2                    │
│                                                              │
│  ⚠️ ACCA-HIGH-001 has 4 slots remaining — will use 1 slot   │
│                                                              │
│ [ Cancel ]                  [ Confirm All 3 Allocations ]   │
└──────────────────────────────────────────────────────────────┘
```

5. Dropdowns are **pre-filtered by risk profile** — HIGH dropdown shows only OPEN HIGH pools. Cannot cross risk profiles.
6. System pre-selects best pool per risk (most available capacity)
7. SUPER_ADMIN can override any selection but not the risk filter
8. On confirm → system creates 3 rows in `investment_pool_allocations`, activates all 3 investments, notifies client once all 3 are confirmed

#### A12 — Pool Full Mid-Allocation

If ACCA-HIGH-001 has 0 slots left when admin tries to map:

```
⚠️ ACCA-HIGH-001 is FULL (20/20 transactions)
   Recommended: Create overflow pool ACCA-HIGH-002
   [ Create ACCA-HIGH-002 and map here ] [ Choose different pool ]
```

System auto-names the overflow pool following the naming convention.

<!-- `[TEAMMATE: ADD DIAGRAM HERE — Transaction mapping wireframe: simple single-risk vs split-risk side by side, showing risk-filtered dropdowns and confirm flow]`

`[TEAMMATE: ADD DIAGRAM HERE — Multi-admin allocation flow: SUPER_ADMIN splits $100K across Admin 1 HIGH pool + Admin 3 MEDIUM pool + Admin 2 LOW pool, each admin sees their slice only]` -->

#### SUPER_ADMIN Coverage for Split Allocations

Split allocations require SUPER_ADMIN action. To prevent single-point-of-failure:
- Minimum **two SUPER_ADMINs** should be active at all times — ideally in different timezones for US + EU coverage
- Configurable **allocation timeout alert**: if a split deposit sits unallocated for more than X hours during business hours, all SUPER_ADMINs receive an escalation notification
- A deposit never silently waits while everyone assumes someone else handled it

#### A12 — Handle Unmatched Deposit

When a deposit arrives with no recognisable client reference:

1. Admin sees deposit in **Unmatched Deposits queue** — separate from normal pending deposits, highlighted prominently in red
2. A **48-hour escalation timer** starts — if unresolved, all SUPER_ADMINs receive an alert
3. Admin has three resolution options:
   - **Link manually** — search by client name/email, match to an investment, proceed as normal mapping
   - **Contact client** — send platform notification asking client to confirm the transfer with their reference code
   - **Flag for return** — if unresolvable after configured SLA `[CEO CONFIRM: 5 business days recommended]`, admin initiates return transfer to originating account and records return reference
4. All activity logged in audit trail with timestamps and resolution notes

> Unmatched deposits must never sit indefinitely. Unidentified funds with no action is an AML exposure — resolution within the SLA is a compliance requirement.

<!-- `[TEAMMATE: ADD DIAGRAM HERE — Unmatched deposit: arrives → unmatched queue → 48h escalation → link / contact client / return path]` -->

---

### 9.5 Profit Entry & Distribution Flow (Automated Monthly Dividends)

To eliminate manual error and scaling bottlenecks, Pool Managers never calculate individual payouts. They simply enter the overall monthly trading outcome for a pool, and the system **automatically divides** it proportionally across all active lot allocations.

1. Admin navigates to pool → clicks **"Enter Profit/Outcome"**
2. Enters: Month/Period (e.g., May 2026) and the outcome using one of two options:
   - **Option A (Rate-Based)**: Return percentage rate (e.g., `+1.25%` or `-0.50%`).
   - **Option B (Amount-Based)**: Total pool profit/loss (e.g., `$15,000` or `-$5,000`).
3. **Confirmation gate for large amounts:** If the absolute profit figure exceeds a configurable threshold (e.g., $50,000), the system shows a hard stop: *"You are about to book $X in profit to N investors. Type the amount to confirm."* The admin must retype the exact figure.
4. Clicks **"Calculate Distribution"**
5. **System Automated Calculations**:
   - **For Rate-Based Inputs**: The system multiplies the rate by each active allocation's deployed capital:
     $$\text{lot\_profit} = \text{lot\_amount} \times \text{return\_rate}$$
   - **For Amount-Based Inputs**: The system automatically divides the total profit proportionally using the **Largest Remainder Method** to resolve the penny rounding problem:
     ```
     Step 1: Calculate raw share per lot allocation:
       lot_profit_raw = (lot_amount / pool_total_capital) × pool_total_profit

     Step 2: Floor each share to 2 decimal places:
       lot_profit_floored = FLOOR(lot_profit_raw × 100) / 100

     Step 3: Find total remainder:
       remainder = pool_total_profit - SUM(all floored amounts)

     Step 4: Sort allocations by their fractional loss descending:
       (raw_amount - floored_amount), largest first

     Step 5: Distribute remainder one cent at a time to the top N allocations by fractional loss
       (tiebreaker: oldest investor gets the cent)
     ```
6. The system displays a preview table to the admin showing: Investor | Deployed Capital | Share % | Accrued profit share to book.
7. Admin reviews → clicks **"Confirm & Book"**
8. **Double-Entry Ledger Booking**: The system executes a single, atomic database transaction that:
   - Creates one `ledger_entry` per user with `entry_type = ACCRUED_DIVIDEND` and `status = CONFIRMED`.
   - **Direction**: **`CREDIT`** for positive returns (profits), or **`DEBIT`** for negative returns (losses), netting against the final payout.
   - If rounding adjustment applied, one additional `ROUNDING_ADJUSTMENT` entry is created in the same transaction for audit clarity.
9. Each client's dashboard updates immediately, showing updated **Total Portfolio Value** (including their new accrued balance). However, these accrued dividends are **locked** and cannot be withdrawn until maturity.
10. The system enqueues a River job to email clients their monthly summary on the 1st of the next month.

---

### 9.5a Below-Target and Negative Profit Entry

**Below-target return:** Admin enters actual profit. If pool returned 8% instead of 20%, admin enters 8% of pool capital. System distributes proportionally. Client dashboard shows actual profit, not target. No special flow — same as normal profit entry.

**Zero return:** Admin enters $0 profit. No ledger entries created. Client capital unchanged. Dashboard shows $0 profit for that period.

**Negative return (Monthly Trading Loss - Option A):** If the monthly trading outcome is negative, it is booked as an **`ACCRUED_DIVIDEND`** entry with direction **`DEBIT`** per lot allocation.
- This nets directly against positive monthly returns within the accrued pool.
- It does **not** decrease the client's active deployed capital balance immediately.
- Instead, the accumulated net accrued dividend balance is evaluated at maturity. If there is a net negative accrued dividend at maturity, it is reconciled at exit under the capital protection netting terms.
- Triggers an **immediate email notification** to all affected investors to inform them of the monthly performance outcome (does not wait for the standard monthly summary).
- The same double-confirmation gate (retyping the amount) is enforced for entering negative figures.

*Note on CAPITAL_LOSS:* A separate entry type `CAPITAL_LOSS` exists in the schema to handle rare, permanent capital reductions (which would directly decrease active capital), but standard monthly trading losses are always handled via the `ACCRUED_DIVIDEND` DEBIT netting flow.

---

### 9.5b Profit Entry Reversal Flow

When an admin enters the wrong profit figure and confirms it:

1. SUPER_ADMIN navigates to the incorrect profit entry in pool history
2. Clicks **"Initiate Reversal"**
3. System shows the original entries and the proposed reversal amounts — one DEBIT per investor equal to their original CREDIT
4. SUPER_ADMIN confirms — entry type: `PROFIT_REVERSAL, direction = DEBIT`
5. System creates reversal entries, restoring each investor's balance to pre-error state
6. Correct profit entries are then booked as a fresh entry batch
7. Audit log shows: original entries → reversal entries → corrected entries in sequence
8. All affected clients receive an email notification of the correction

> No existing ledger entry is ever modified or deleted. Reversal is always additive — new rows only.

---

### 9.6 Withdrawal Approval Flow (Admin)

#### How It Works With Multiple Pool Owners

When a client requests withdrawal and their investment spans multiple admin pools, the system automatically breaks the withdrawal into tasks — one per pool involved.

**Step 1 — System generates withdrawal tasks:**

```
Client: John Smith withdraws $100K HIGH RISK capital

investment_pool_allocations for this investment:
  ACCA-HIGH-001 (Admin 1) → $60K (60%)
  ACCB-HIGH-001 (Admin 2) → $40K (40%)

System auto-creates:
  withdrawal_task 1 → Admin 1, ACCA-HIGH-001, $60K, status=PENDING
  withdrawal_task 2 → Admin 2, ACCB-HIGH-001, $40K, status=PENDING

withdrawal_request status → TASKS_PENDING
```

**Step 2 — Each Pool Manager sees only their task:**

Admin 1 sees in their withdrawal queue:
```
TASK — John Smith — HIGH RISK — Source $60,000 from ACCA-HIGH-001
  Investment: INV-456A   Pool: ACCA-HIGH-001   Amount: $60,000
  [ View Client Details ]   [ Approve & Mark Transfer Done ]
```

Admin 2 sees in their withdrawal queue:
```
TASK — John Smith — HIGH RISK — Source $40,000 from ACCB-HIGH-001
  Investment: INV-456A   Pool: ACCB-HIGH-001   Amount: $40,000
  [ View Client Details ]   [ Approve & Mark Transfer Done ]
```

Neither admin sees the other's task or amount. Each handles their slice independently.

**Step 3 — SUPER_ADMIN monitors overall progress:**

```
WR-789 — John Smith — $100K — HIGH RISK — Capital Withdrawal
  Task 1 → Admin 1  ACCA-HIGH-001  $60K  ✅ TRANSFER_DONE  Ref: TRF-001
  Task 2 → Admin 2  ACCB-HIGH-001  $40K  ⏳ PENDING        [Nudge Admin 2]

Overall: TASKS_PENDING — waiting on 1 of 2 tasks
```

SUPER_ADMIN can nudge Admin 2 (sends an in-app notification) or override and approve directly.

**Step 4 — All tasks complete → client transfer:**

When all tasks reach `TRANSFER_DONE`:
- `withdrawal_request.status` → `TASKS_COMPLETE`
- FINANCE_APPROVER or SUPER_ADMIN initiates the single outgoing client transfer (sum of all task amounts)
- Transfer reference recorded → status → `COMPLETED`
- Client receives one email: "Your withdrawal of $100,000 has been processed. Reference: TRF-FINAL-XXX"

> The client never sees multiple transfers or multiple pool references — they receive one consolidated transfer for their full withdrawal amount.

**Profit Withdrawal (simpler — usually single pool):**

For profit withdrawals, the same task system applies but in most cases profit from one investment comes from one pool → one task → one admin approves → one transfer.

<!-- `[TEAMMATE: ADD DIAGRAM HERE — Multi-admin withdrawal task flow: withdrawal request → system generates tasks → each admin approves own task → SUPER_ADMIN sees consolidated view → all tasks done → single client transfer]`

`[TEAMMATE: ADD DIAGRAM HERE — SUPER_ADMIN withdrawal monitor wireframe showing task status per admin with nudge button]` -->

---

## 10. Payment Integration

### 10.1 Bank of Ireland (BOI) — Company's Preferred Bank

Bank of Ireland is the designated bank for the Irish account receiving client deposits. BOI provides a **PSD2-compliant Open Banking API** via their developer portal (`developer.bankofireland.com`).

| API | Purpose | How we use it |
|---|---|---|
| **AIS — Account Information Services** | Read-only access to account transaction history | Payments & Notifications Service (Go) polls every 3 minutes for new inbound deposits |
| **PIS — Payment Initiation Services** | Initiate outgoing transfers programmatically | Admin triggers client withdrawal payouts — no manual bank portal login |

**Important: BOI does not push real-time webhooks for inbound transfers.**

Unlike fintech banking APIs (Modulr, Stripe), BOI's Open Banking AIS is **pull-based** — your system polls it, BOI does not push. This is standard for traditional banks under PSD2.

**How inbound deposit detection works:**

```
Payments & Notifications Service (Go) cron (every 3 minutes via River):
  1. Call BOI AIS API → GET /accounts/{id}/transactions
  2. Filter: last 5 minutes, direction=CREDIT
  3. For each new transaction:
     - Check reference_id NOT in ledger_entries (idempotency)
     - If new:
       BEGIN TRANSACTION
         INSERT INTO ledger.ledger_entries (status=PENDING)
         INSERT INTO ledger.outbox_events (DEPOSIT_PENDING)
       COMMIT
  4. Go River picks up event → admin notified
```

**BOI API authentication requirements:**
- eIDAS QWAC certificate (PSD2 regulatory requirement for direct API access)
- OAuth 2.0 consent flow
- mTLS (Mutual TLS) on all API calls

> **[CEO CONFIRM]:** Does the company already have an eIDAS QWAC certificate? Required before BOI API goes live. Issued by a Qualified Trust Service Provider (QTSP) — typically €100–300/year. This is a pre-launch dependency.

**Alternative if BOI API access is delayed:** An aggregator like **TrueLayer** or **Plaid** connects to BOI under PSD2 without requiring a direct eIDAS certificate — they provide webhooks on top of BOI's polling. Slightly higher cost but faster to integrate.

### 10.2 Outbound Transfers (Client Withdrawals)

Admin approves withdrawal → Core Backend (Node.js) calls Payments & Notifications Service (Go) → Payments & Notifications Service calls BOI PIS API → BOI processes transfer to client's IBAN → transfer reference recorded → client notified.

**Supported rails via BOI:**
- **SEPA Credit Transfer** — EU IBANs, same-day, low cost
- **SWIFT** — International, 1–5 business days
- **Faster Payments** — UK sort codes (BOI UK entity)

### 10.3 Idempotency

Before processing any polled transaction, Payments & Notifications Service (Go) checks:
```sql
SELECT id FROM ledger.ledger_entries WHERE reference_id = $1;
-- Exists → skip. Not exists → process.
```
Polling may see the same transaction twice — this check prevents any duplicate ledger entries.

---

## 11. Notification System

All emails sent via **Resend** (V1) → **AWS SES** (V3). Templates stored in codebase (HTML + plain text fallback). Payments & Notifications Service (Go) consumes events from River queue via the outbox worker.

### 11.1 Event-Driven Notifications

| Event | Recipient | Email Content |
|---|---|---|
| Deposit received (PENDING) | Admin | Tx ID, amount, client reference, "Map this transaction" link |
| Deposit confirmed (CONFIRMED) | Client | Amount confirmed, investment active, pool reference, maturity date |
| Profit allocated | Client | Period, profit amount, new total portfolio value |
| Negative profit / capital loss booked | Client | **Immediate** — amount of capital decrease, new balance, contact details |
| Profit entry reversal | Client | Correction notice — original amount, corrected amount, reason |
| Maturity reached | Client | Investment matured, profit available to withdraw, CTA to portal |
| Maturity reminder (7 days) | Client | "Your investment matured 7 days ago — funds are waiting" |
| Maturity reminder (30 days) | Client | Second reminder — escalation note |
| Maturity 90-day alert | SUPER_ADMIN | Client has not acted on maturity — manual outreach required |
| Withdrawal submitted | Admin | Request details, notice period end date |
| Withdrawal ready for approval | Admin | "Ready to approve" alert, link to admin panel |
| Withdrawal transfer failed | Admin + Client | Admin: task FAILED, action required. Client: transfer unsuccessful, verify bank details |
| Withdrawal completed | Client | Amount, transfer reference, expected arrival timeframe |
| Withdrawal cancelled | Client | Confirmation of cancellation |
| Unmatched deposit (48h) | All SUPER_ADMINs | Escalation: deposit has been unmatched for 48 hours |
| Allocation timeout | All SUPER_ADMINs | Split deposit has been unallocated for X hours |
| 2FA nudge | Client | Persistent: "Enable two-factor authentication to protect your account" |

### 11.2 Monthly Summary (Cron Job)

**Sequencing — critical:** Two jobs run on the 1st of every month. Order and execution are managed by River queue priorities and scheduling:

1. **00:01 UTC — Balance snapshot job** runs first. Creates `monthly_balance_snapshots` for every active investment. This job must complete before the email job starts.
2. **08:00 UTC — Monthly summary email job** runs second. Reads from snapshots just created. Client always receives figures that match their dashboard.

> If the snapshot job fails at 00:01, the email job is blocked and an alert fires to SUPER_ADMIN. Never send monthly emails with stale balance data.

**Email contains** `[CEO CONFIRM: exact content]`:
- Current capital deployed across all active investments
- Profit allocated to date per investment
- Maturity date countdown per investment
- Quick link to dashboard

---

## 12. Currency — EUR Only (V1)

V1 operates in **EUR only**. All ledger amounts, profit calculations, and withdrawals are in EUR. No FX conversion logic in V1.

| Scenario | Handling |
|---|---|
| EU client deposits EUR | Booked directly in EUR |
| Non-EUR inbound transfer | `[CEO CONFIRM]` — reject and return to sender, or admin books manually in EUR equivalent |
| Dashboard display | EUR throughout |
| Profit entry by admin | EUR |
| Withdrawal payouts | EUR via SEPA (EU) or SWIFT |

**Future multi-currency (V2+):** Ledger schema already includes `original_currency` and `fx_rate` columns. Adding USD support activates FX lookups — data structure is already ready.

---

## 13. Agreement Signing

### V1 — In-House Forced Read

- Agreement text rendered in a fixed-height scrollable `<div>`
- JavaScript scroll event listener on the div
- "I Agree" checkbox and button are **disabled** until `scrollTop + clientHeight >= scrollHeight - 10px`
- Once enabled, user checks checkbox → clicks "I Agree & Continue"
- System records: `agreement_signed = true`, `signed_at = TIMESTAMPTZ`, `agreement_version = 'v1.0'`
- Static PDF of the agreement stored in S3, linked to user record

### Future — DocuSign / HelloSign

- Module interface already defined with `AgreementService.send()` and `AgreementService.verify()`
- Swap implementation from in-house to API call without touching other modules

---

## 14. Critical Engineering Fixes

> These six issues were identified during technical review of the initial design. Each represents a real production failure mode for a financial platform. All six are addressed in this design — this section documents what the problem was, why it matters, and exactly how it is fixed.

---

### Fix 1 — The Penny Problem (Fractional Rounding)

**Problem:** Proportional profit distribution using simple division produces fractional cents. Three users at 33.33% of a $10.00 profit pool each get $3.33 = $9.99 total. $0.01 is orphaned. Reconciliation audits fail.

**Why it matters:** Every reconciliation run flags a discrepancy. At scale this compounds across thousands of pools and periods into meaningful unaccounted amounts.

**Fix:** Largest Remainder Method. Raw shares floored to 2 decimal places. Remaining cents distributed one at a time to users ranked by fractional loss, oldest investor as tiebreaker. Total always equals exactly the input profit. `ROUNDING_ADJUSTMENT` ledger entry provides audit trail. See Section 9.5.

### Fix 2 — Transactional Outbox Pattern (Dual-Write Problem)

**Problem:** Writing a ledger entry to PostgreSQL then publishing to a queue are two separate operations. App crash between them = money recorded, workflow dead. Admin never notified, investment never activated.

**Why it matters:** Silent failure on the most critical path in the system — a client deposit that goes unprocessed.

**Fix:** Outbox pattern. Every event written to `outbox_events` table **in the same DB transaction** as the ledger entry. Separate Go outbox worker polls and enqueues to River. App crash = worker picks it up on restart. Zero financial events ever lost. See Section 3.4.

### Fix 3 — Pool Capacity Race Condition

**Problem:** Two simultaneous mapping requests for a pool with one slot remaining both read capacity as available, both map — pool exceeds `max_transactions`.

**Why it matters:** Pool integrity broken. More clients mapped than the trading account supports.

**Fix:** `SELECT ... FOR UPDATE` row lock at application level + `CHECK (current_transaction_count <= max_transactions)` hard constraint at DB level. Two-layer enforcement. See Section 6 pools table.

### Fix 4 — Encryption Key Management

**Problem:** AES-256 PII encryption is correct, but storing the key in Docker environment variables or any hosting dashboard makes it visible to anyone with server/dashboard access. One compromised admin account = all client bank details exposed.

**Why it matters:** GDPR breach, regulatory action, total loss of client trust.

**Fix:** Doppler — secrets injected at runtime, never visible in any dashboard, full audit log. Docker environment variables used only for non-sensitive config (port numbers, log levels). AES-256 key lives in Doppler only. Migration to AWS KMS at V3.

### Fix 5 — Unbounded Ledger Summation

**Problem:** Balance derived by summing all `ledger_entries` for an investment. A 3-year-old account requires summing hundreds of rows on every dashboard load.

**Why it matters:** Dashboard performance degrades with account age. Must be designed for now to avoid painful migration later.

**Fix:** `monthly_balance_snapshots` table. Balance query sums only current month's entries + latest snapshot. Max scan is always ~31 days regardless of account age. See Section 6.

### Fix 6 — Go Channels (In-Memory Queue) Volatility for Financial Events

**Problem:** Go channels are blazing fast but completely in-memory and volatile. If the Go Payments & Notifications service crashes or restarts (e.g. during a CI/CD redeploy), all queued background events are permanently lost.

**Why it matters:** A client wires $50,000. Bank confirms it. System loses the event midway. Money sits unrecorded, no admin notification, no investment activation.

**Fix:** River — Go PostgreSQL-backed job queue. Jobs are stored in the same database as the ledger, protected by the same WAL guarantees. Financial events cannot be lost without losing the database. This keeps our environment pristine and avoids running another container (like Redis), saving critical memory.

---

## 15. Key Design Decisions & Rationale

| Decision | What We Chose | Why |
|---|---|---|
| Architecture | 3 microservices (Hybrid Go/Node.js) on Docker (single CX22) | Right-sized for 100 users; Payments & Notifications in Go for near-zero RAM footprint and security sandboxing of banking APIs; Core Backend in Node.js (NestJS) for high developer velocity; Frontend UI in Next.js for isolated presentation |
| No Redis | Removed entirely | JWT is stateless — no session store; `@nestjs/throttler` handles rate limiting in-memory; saves one container, one failure point |
| Single server | Hetzner CX22 (€3.79) | 3 services + Postgres use ~1.065 GB of 4 GB RAM; 2.935 GB headroom; Hetzner Volume means server is fully replaceable without data loss |
| API Gateway | Nginx (Docker — free) | Lightweight; SSL termination; rate limiting; routing; upgrade to Kong when advanced plugin needs arise |
| Container orchestration | Docker Compose (V1) → Kubernetes (V3) | Single config file runs entire stack; same Docker images deploy to Kubernetes when needed |
| Version control + CI/CD | GitLab | CEO preference; single platform — code, CI/CD, container registry, issues |
| Bank | Bank of Ireland (BOI) AIS + PIS | Company's preferred bank; PSD2-compliant; AIS polling for inbound; PIS for outgoing transfers |
| Inbound deposit detection | BOI AIS polling every 3 minutes | BOI has no push webhooks; polling is the standard approach with traditional banks; delay acceptable |
| Currency | EUR only (V1) | CEO confirmed EU-only scope; simplifies ledger and withdrawals; multi-currency in V2 |
| Cloud | Hetzner Cloud (Germany) | CEO preferred; German-owned data centres; GDPR native; 3–5× cheaper than AWS; 20TB traffic included |
| Database | PostgreSQL in Docker (free) | Full control; separate schemas per service; Hetzner Volume for persistence; pg_dump to Object Storage for backups |
| Cache | None — removed | Sessions are stateless JWT; rate limiting is handled in-memory and at Nginx level; saves RAM/infra resources |
| File storage | Hetzner Object Storage | S3-compatible; €4.99/month base; EU residency; same AWS SDK |
| Job queue | River in PostgreSQL (free) | Runs natively inside Go service; uses existing Postgres; zero extra cost; 100% durable |
| DNS | Cloudflare DNS only (no CDN) | Free; fast; no CDN proxy for EU-only V1; one-click CDN enable when global |
| SSL | Let's Encrypt via Certbot | Free; auto-renews; runs on Hetzner via Nginx |
| Ledger | Append-only double-entry | Industry standard; full audit trail; balance always derivable |
| Multi-tenancy | PostgreSQL Row-Level Security | Data isolation at DB layer, not just app layer |
| Profit distribution | Largest Remainder Method | Ledger balances to the cent every time |
| Profit reversal | Additive DEBIT entries only | Ledger immutability preserved; full audit trail |
| Idempotency | `reference_id` check before processing | BOI polling may see same transaction twice; prevents duplicate ledger entries |
| GDPR erasure | Anonymise PII, retain financial records | Right to erasure satisfied; legally required transaction history preserved |
| Cron sequencing | Snapshot at 00:01 before email at 08:00 | Monthly emails always show fresh figures |
| Profit distribution math | Proportional division per lot allocation (supporting Return % rate or flat USD profit inputs via Largest Remainder Method) | Eliminates manual math, prevents rounding/penny errors, and automates operations. |
| Accrued dividend separation | Separate locked `ACCRUED_DIVIDEND` ledger entry type | Isolates monthly profit accruals from client early withdrawals while keeping portfolio valuation accurate. |
| Maturity release automation | Automated daily cron ledger transfer at maturity | Removes manual admin overhead and settlement delays by automatically running double-entry transfers. |
| Negative trading months | Netting as negative accrued dividends (DEBIT `ACCRUED_DIVIDEND`) | Preserves capital protection netting structures until final maturity settlement, maintaining ledger integrity. |

---

## 15a. GDPR — Right to Erasure

GDPR gives clients the right to request deletion of their personal data. This is in direct tension with financial record-keeping requirements — ledger entries must be retained for typically 6–7 years.

**Resolution — Anonymise PII, retain financial records:**

When a client submits an erasure request:

| Data Type | Action |
|---|---|
| Name, phone, address | Replaced with NULL |
| Email | Replaced with `deleted-{hash}@noreply` |
| Bank account number / IBAN / SWIFT | Replaced with NULL (encrypted fields wiped) |
| Profile record | Marked `status = GDPR_ANONYMISED` |
| Ledger entries | **Retained** — legally required financial records |
| Pool allocations | **Retained** — financial audit trail |
| Withdrawal history | **Retained** — financial audit trail |
| Audit log actor IDs | **Retained** — but mapping from actor ID to personal data is severed |

Result: financial history is preserved and auditable. The individual behind it is no longer identifiable from the database alone. Both GDPR and financial record-keeping obligations are satisfied. This is standard practice for regulated fintech platforms.

---

## 16. Open Items — CEO Confirm

> These items came up during design but no answer was available at time of writing. Each needs to be resolved before finalising the spec.

| # | Item | Options / Recommendation |
|---|---|---|
| 1 | BOI eIDAS QWAC certificate | Does the company have one? Required for direct BOI PSD2 API access. QTSP-issued, ~€100–300/year. Pre-launch dependency |
| 2 | Non-EUR inbound transfers | If a client sends USD or GBP — reject and return, or admin manually converts and books in EUR? |
| 3 | Profit withdrawal notice period | Recommendation: 7–15 days. Needs a specific number |
| 4 | Capital withdrawal notice period tiers | Recommendation: 15 / 30 / 45 days based on amount |
| 5 | Minimum capital floor | Recommendation: €5,000 default, admin-adjustable |
| 6 | Monthly email content | Confirm exact fields in the monthly client summary |
| 7 | Agreement document | Legal text for the agreement PDF — from CEO or legal counsel |
| 8 | KYC activation timeline | KYC module designed and pluggable. When does it go live? |
| 9 | Trading account list | How many trading accounts? Names/labels for pool setup |
| 10 | Post-maturity auto-renew | Should matured investments auto-renew if client takes no action after X days? |
| 11 | Capital loss possibility | Is client capital guaranteed? Changes negative profit flow and agreement wording |
| 12 | Profit entry confirmation threshold | Amount triggering double-confirmation gate. Recommendation: €50,000 |
| 13 | Unmatched deposit SLA | Days before deposit must be resolved or returned. Recommendation: 5 business days |
| 14 | SUPER_ADMIN count at launch | Minimum two recommended |
| 15 | Client 2FA mandatory date | Optional in V1 with nudge banner. When does it become mandatory? |
| 16 | Pre-deposit dashboard copy | Content for platform info and calculator section |

---

## 17. V1 Release Scope Recommendation

Based on the CEO's requirements and the design above, the recommended V1 includes:

### In V1
- ✅ Full client onboarding (signup, profile, agreement, investment config with risk splits)
- ✅ Client 2FA — optional with persistent nudge banner
- ✅ Deposit instructions and PENDING_DEPOSIT state
- ✅ Unmatched deposit queue with 48h escalation + 5-day SLA
- ✅ Admin portal — pool creation, transaction mapping, split allocation
- ✅ SUPER_ADMIN allocation timeout alert
- ✅ Ledger (double-entry, append-only, with monthly snapshots)
- ✅ Profit entry with largest remainder distribution + confirmation gate
- ✅ Profit entry reversal flow (SUPER_ADMIN only)
- ✅ Below-target and negative profit / capital loss entry
- ✅ Client dashboard (empty state + active state, with risk disclaimer on calculator)
- ✅ Profit withdrawal flow with failed transfer handling
- ✅ Capital withdrawal flow with notice period, floor rule, failed transfer handling
- ✅ Post-maturity reminder emails (7d, 30d, 90d SUPER_ADMIN alert)
- ✅ Multi-admin withdrawal tasks with override
- ✅ SUPER_ADMIN cross-admin monitoring dashboard
- ✅ Event-driven email notifications + monthly summary cron (snapshot-first sequencing)
- ✅ SUPER_ADMIN role + full RBAC structure for future roles
- ✅ Audit log (immutable)
- ✅ GDPR right-to-erasure anonymisation flow
- ✅ Transactional outbox + River queue

### Deferred to Later Versions
- ⏳ KYC integration (Onfido/Sumsub) — module designed, needs activation
- ⏳ Client 2FA mandatory enforcement
- ⏳ DocuSign/HelloSign — upgrade from in-house agreement flow
- ⏳ POOL_MANAGER and FINANCE_APPROVER role activation
- ⏳ Enterprise contact person management via admin
- ⏳ Mobile app (React Native)
- ⏳ Bank API for automated outgoing transfers (admin-manual at V1)
- ⏳ Advanced analytics and reporting

---

## 18. Complete Journey Map

This section maps every journey that exists in the platform — user-facing, admin-facing, and automated system processes. Each journey maps to at least one screen or background process. Use this as the master checklist for UI design, QA test cases, and sprint planning.

---

### 🟦 User Journeys — Authentication & Onboarding

| # | Journey | Trigger | V1 |
|---|---|---|---|
| U1 | Sign Up — Individual | New individual client registers | ✅ |
| U2 | Sign Up — Enterprise | New company registers | ✅ |
| U3 | Sign In | Returning user logs in | ✅ |
| U4 | Forgot Password / Reset | User cannot access account | ✅ |
| U5 | Email Verification | After sign up, verify email before proceeding | ✅ |
| U6 | Profile Setup — Individual | After email verified, fill PII fields | ✅ |
| U7 | Profile Setup — Enterprise | Same as U6 with company + contact person fields | ✅ |
| U8 | Agreement Signing | After profile complete, forced scroll + checkbox confirm | ✅ |
| U9 | Investment Configuration | Risk split + maturity period + view deposit instructions | ✅ |

---

### 🟦 User Journeys — Active Investment Management

| # | Journey | Trigger | V1 |
|---|---|---|---|
| U10 | Dashboard — Empty State (pre-deposit) | Investment configured, waiting for admin to map deposit | ✅ |
| U11 | Dashboard — Active State | Deposit confirmed, investment live | ✅ |
| U12 | Add New Investment | Existing active user wants a separate additional investment | ✅ |
| U13 | View Investment Detail | User drills into one specific investment card | ✅ |
| U14 | Update Bank Details | User changes their withdrawal bank account | ✅ |
| U15 | View Ledger History | Full history of deposits, profits, withdrawals for one investment | ✅ |

---

### 🟦 User Journeys — Withdrawals

| # | Journey | Trigger | V1 |
|---|---|---|---|
| U16 | Profit Withdrawal Request | At or after maturity, user requests profit payout | ✅ |
| U17 | Capital Withdrawal Request | User requests partial or full capital (minimum floor enforced) | ✅ |
| U18 | Withdrawal Status Tracking | User tracks progress of a submitted withdrawal request | ✅ |
| U19 | Cancel Withdrawal | User cancels a capital withdrawal during the notice period | ✅ |

---

### 🟧 Admin Journeys — Authentication & Account Management

| # | Journey | Trigger | V1 |
|---|---|---|---|
| A1 | Admin Sign In | Admin logs into separate portal at admin.yourdomain.com | ✅ |
| A2 | Create New Admin Account | SUPER_ADMIN creates admin + assigns role | ✅ |
| A3 | Deactivate / Reactivate Admin | SUPER_ADMIN disables a staff account when they leave | ✅ |
| A4 | View & Edit User Profile | Admin inspects any client's full profile and investment history | ✅ |
| A5 | Suspend / Reactivate User Account | Admin locks or unlocks a client account | ✅ |

---

### 🟧 Admin Journeys — Pool Management

| # | Journey | Trigger | V1 |
|---|---|---|---|
| A6 | Create Pool | Admin creates new pool, links to trading account | ✅ |
| A7 | View Pool Detail | Admin sees all transactions, capital total, profit history for one pool | ✅ |
| A8 | Edit Pool Config | Admin updates max transactions or other pool settings | ✅ |
| A9 | Close Pool | Admin closes a pool when maturity reached or capacity full | ✅ |

---

### 🟧 Admin Journeys — Transaction & Deposit Handling

| # | Journey | Trigger | V1 |
|---|---|---|---|
| A10 | Map Transaction → Existing Pool | Inbound deposit arrives, admin maps to an existing open pool | ✅ |
| A11 | Map Transaction → New Pool | Inbound deposit arrives, admin creates pool inline then maps | ✅ |
| A12 | Handle Unmatched Deposit | Deposit arrives with no recognisable client reference — admin investigates manually | ✅ |

---

### 🟧 Admin Journeys — Profit Management

| # | Journey | Trigger | V1 |
|---|---|---|---|
| A13 | Enter Pool Profit | Admin inputs total profit earned by a pool for a period | ✅ |
| A14 | Review Profit Distribution Preview | Before confirming, admin sees per-user breakdown with amounts | ✅ |
| A15 | Confirm & Book Profit | Admin confirms distribution → system writes ledger entries per user | ✅ |

---

### 🟧 Admin Journeys — SUPER_ADMIN Cross-Admin Monitoring

| # | Journey | Trigger | V1 |
|---|---|---|---|
| A20 | View All Admins & Pool Health | SUPER_ADMIN monitors all Pool Managers and their pool fill status | ✅ |
| A21 | View Another SUPER_ADMIN's Activity | SUPER_ADMIN audits another SUPER_ADMIN's actions in audit log | ✅ |
| A22 | Nudge Admin on Pending Withdrawal Task | SUPER_ADMIN sees a task is delayed and sends in-app notification to responsible admin | ✅ |
| A23 | Override / Directly Approve Withdrawal Task | SUPER_ADMIN bypasses a slow admin and approves their withdrawal task directly | ✅ |
| A24 | Reassign Pool Ownership | SUPER_ADMIN transfers a pool from one Pool Manager to another | ✅ |
| A25 | View Investment Allocation Split | SUPER_ADMIN drills into any investment to see which pools and admins hold which slice | ✅ |

---

### 🟧 Admin Journeys — Withdrawals & Reports

| # | Journey | Trigger | V1 |
|---|---|---|---|
| A16 | Review Profit Withdrawal Request | Profit withdrawal arrives, admin checks and approves | ✅ |
| A17 | Review Capital Withdrawal Request | Notice period ends, admin checks pool liquidity and approves | ✅ |
| A18 | Record Outgoing Transfer Reference | After bank transfer done manually, admin pastes reference into system | ✅ |
| A19 | Export Report | Admin exports pool summary, user holdings, or ledger as CSV/PDF | ✅ |

---

### 🟥 System / Background Journeys (No UI — Automated)

These run automatically with no human trigger. They must be designed, built, and monitored even though they have no front-end screen.

| # | Journey | Schedule / Trigger | V1 |
|---|---|---|---|
| S1 | Bank Polling — Inbound Deposit | Detects when bank receives a new credit to the Irish account | ✅ |
| S2 | Maturity Check Cron | Runs daily 00:01 UTC — finds active investments maturing today, automatically releases accrued dividends to liquid profit, and sets status to MATURED | ✅ |
| S3 | Notice Period Check Cron | Runs daily 00:01 UTC — finds withdrawals where `ready_date = today` | ✅ |
| S4 | Monthly Summary Email Cron | Runs 1st of every month 08:00 UTC — sends performance summary to all ACTIVE clients | ✅ |
| S5 | KYC Webhook Handler | KYC vendor fires result → updates `kyc_status` → notifies admin if rejected | ⏳ Future |

---

### S2: Maturity Check Cron & Dividend Payout Sequence

Runs automatically daily at 00:01 UTC. It performs the **entire dividend payout and status transition with zero manual admin intervention**.

1. **Find Maturing Investments**:
   The Go cron job queries PostgreSQL for investments that mature today:
   ```sql
   SELECT id, user_id FROM core.investments 
   WHERE maturity_date = CURRENT_DATE AND status = 'ACTIVE';
   ```
   *Note (P2 Cron Guard): The query MUST filter by `status = 'ACTIVE'` to prevent double-processing on retries.*

2. **Sum Accrued Dividends**:
   For each maturing investment found, the cron sums up all monthly accrued dividends (credits minus debits):
   ```sql
    SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0.00)
   FROM core.ledger_entries 
   WHERE investment_id = :investment_id AND entry_type = 'ACCRUED_DIVIDEND' AND status = 'CONFIRMED';
   ```

3. **Atomic Payout Ledger Booking**:
   If the accumulated sum is positive (greater than 0), the system executes an atomic transaction containing a **balancing release pair**:
   - **Debit ACCRUED_DIVIDEND** (via `DIVIDEND_RELEASE` type) for the accumulated sum.
   - **Credit PROFIT_ALLOCATION** (liquid/withdrawable) for the exact same sum.
   - **Update Status**: Set `investments.status = 'MATURED'` and `users.status = 'MATURED'` (if they have no other active investments).
   - **Outbox Event**: Create a `core.outbox_events` record with `event_type = 'MATURITY_REACHED'`.
   
   *Netting Policy (Trading Losses)*: If the total accrued sum is negative due to netting monthly losses, the net deficit is adjusted against the capital deployment payout at exit, ensuring capital protection bounds are mathematically enforced without violating double-entry balance.

4. **Event-Driven Client Notification**:
   The Go River worker picks up the `MATURITY_REACHED` event and emails the client:
   *"Your investment has matured! Deployed capital and accrued dividends are now fully liquid and withdrawable in your dashboard. Login to request transfer."*

<!-- `[TEAMMATE: ADD DIAGRAM HERE — S1 bank polling sequence: bank polling detects transaction → Payment Module creates PENDING ledger entry → SQS event → Notification Module emails admin]` -->

`[TEAMMATE: ADD DIAGRAM HERE — S2 maturity cron sequence: cron triggers → query investments where maturity_date = today → update status to MATURED → SQS event → email each affected client]`

`[TEAMMATE: ADD DIAGRAM HERE — S3 notice period cron: query withdrawal_requests where ready_date = today AND status = NOTICE_PERIOD → update to READY_FOR_APPROVAL → email admin]` -->
<!-- 
### Journey Count Summary

| Category | Total Journeys | V1 | Future |
|---|---|---|---|
| User — Auth & Onboarding | 9 | 9 | 0 |
| User — Active Investment | 6 | 6 | 0 |
| User — Withdrawals | 4 | 4 | 0 |
| Admin — Auth & Account Management | 5 | 5 | 0 |
| Admin — Pool Management | 4 | 4 | 0 |
| Admin — Transactions & Deposits | 3 | 3 | 0 |
| Admin — Profit Management | 3 | 3 | 0 |
| Admin — Withdrawals & Reports | 4 | 4 | 0 |
| Admin — SUPER_ADMIN Cross-Monitoring | 6 | 6 | 0 |
| System / Background | 5 | 4 | 1 |
| **Total** | **49** | **48** | **1** |

--- -->
<!-- 
### Priority Order for Diagram / Wireframe Work

Build diagrams in this order — these are the journeys the CEO will walk through first:

| Priority | Journey | Type |
|---|---|---|
| 1 | S1 — Bank polling → ledger → admin notification | Sequence diagram |
| 2 | U1/U2 — Sign up Individual vs Enterprise | Flow diagram |
| 3 | U9 — Investment configuration + risk split | Wireframe |
| 4 | A10/A11 — Transaction mapping | Flow diagram |
| 5 | U8 — Agreement forced scroll | Wireframe |
| 6 | U10/U11 — Dashboard empty vs active | Wireframe |
| 7 | U17 — Capital withdrawal state machine | State machine diagram |
| 8 | A13/A14/A15 — Profit entry + distribution preview | Flow diagram + wireframe |
| 9 | S2/S3 — Maturity and notice period crons | Flow diagram |

--- -->

*End of Document — Version 1.0*
*Next review: After CEO walkthrough session*

<!-- ---

**All Diagram Placeholders (for teammate — 34 total):**

Section 3.1 — High-level architecture diagram
Section 3.4 — Deposit async event sequence diagram
Section 5.4 — Render infrastructure diagram
Section 8.1 — User account state machine
Section 17 (U1/U2) — Sign up branching flow
Section 17 (U3) — Sign in flow
Section 17 (U4) — Forgot password flow
Section 17 (U6/U7) — Profile setup wireframe
Section 17 (U8) — Agreement forced scroll UI wireframe
Section 17 (U9) — Investment configuration wireframe
Section 17 (U10) — Dashboard empty state wireframe
Section 17 (U11) — Dashboard active state wireframe
Section 17 (U13) — Investment detail view wireframe
Section 17 (U16) — Profit withdrawal flow
Section 17 (U17) — Capital withdrawal flow with floor validation
Section 17 (U17/U19) — Capital withdrawal state machine
Section 17 (U18) — Withdrawal tracker UI
Section 17 (A1) — Admin sign in with 2FA
Section 17 (A2) — Create admin flow
Section 17 (A6) — Create pool form wireframe
Section 17 (A7) — Pool detail view wireframe
Section 17 (A10/A11) — Transaction mapping flow: single risk vs split risk
Section 17 (A11) — Multi-admin allocation flow across Pool Managers
Section 17 (A12) — Pool full / overflow pool creation flow
Section 17 (A13–A15) — Profit entry and distribution flow
Section 17 (A16/A17) — Multi-admin withdrawal task flow
Section 17 (A17) — SUPER_ADMIN withdrawal monitor wireframe
Section 17 (A20) — SUPER_ADMIN cross-admin monitoring panel
Section 17 (A22/A23) — Withdrawal task nudge and override flow
Section 9.2 — SUPER_ADMIN dashboard wireframe with pool health panel
Section 9.2 — POOL_MANAGER scoped dashboard wireframe
Section 9.3 — Pool list view with colour-coded risk grouping
Section 9.3 — Pool detail view wireframe
Section 17 (S1) — Bank polling sequence diagram
Section 17 (S2) — Maturity cron sequence
Section 17 (S3) — Notice period cron flow
 -->