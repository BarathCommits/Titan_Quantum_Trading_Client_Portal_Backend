# Titan Funds Platform — Technical Architecture & Engineering Guide

**Document Type:** Deep-Dive Engineering Specification  
**Target Audience:** Architects, Software Engineers, DevOps, and Security Auditors  
**Companion Document:** See [README.md](file:///Users/balajisk/Downloads/titan/README.md) for the Business & Executive Briefing.

---

## 1. System Topology & Internal Networking

The Titan Funds Platform operates as a decoupled **3-Service Hybrid Split** running on a single **Hetzner CX32 instance** (selected for resource safety and GC spikes under load) inside isolated Docker containers. External traffic is mediated by Nginx, which acts as the singular public-facing gateway. All downstream containers are strictly bound to Docker's internal bridge network.

```
       [ Client Browser / Admin Dashboard ]
                       │
                       │ Ports 80 / 443 (HTTPS)
                       ▼
             [ Nginx API Gateway ]
                       │
         ┌─────────────┼─────────────┐
  /api/payments/*      │ /api/*      │ /*
         ▼             ▼             ▼
   [ Payments ]   [ Core Backend ] [ Frontend ]
     Go Engine      NestJS API      Next.js UI
    Port 3003      Port 3000       Port 3001
         │             │
         └──────┬──────┘
                ▼
        [ PostgreSQL DB ]
         Port 5432 (Internal)
```

### 1.1 Nginx API Gateway Routing Rules
Nginx performs rate limiting, SSL termination (via Let's Encrypt), and routes traffic internally using the following routing policies:

```nginx
# Nginx Internal Routing Logic
location /api/payments/ {
    proxy_pass http://payments-notification-service:3003;
    proxy_set_header X-Real-IP $remote_addr;
}

location /api/ {
    proxy_pass http://core-backend:3000;
    proxy_set_header X-Real-IP $remote_addr;
}

location / {
    proxy_pass http://frontend-ui:3001;
    proxy_set_header X-Real-IP $remote_addr;
}
```

---

## 2. Deep Dive: Go Concurrency & Network I/O Resolution

The Payments & Notifications Service is written in **Go (Golang)** to handle network-bound I/O bottlenecks without propagating latency or starving CPU resources.

### 2.1 The Network Latency Thread-Blocking Bottleneck
In Node.js, network requests (such as polling the Bank of Ireland (BOI) AIS API or sending SMTP packets via Resend) are executed asynchronously on a single event loop thread. If the BOI API is slow or drops connection packets (taking 8–15 seconds to timeout), the single-threaded event loop must continuously maintain these active async call states. 

Under concurrent user volume, this network bottleneck results in **event loop starvation**, leading to delayed ledger writes and slow dashboard responses.

### 2.2 Go's M:N Scheduler & Goroutines
Go completely resolves this bottleneck through its compiled runtime scheduler, which manages logical **Goroutines** over a pool of physical OS threads:
* **Memory Footprint:** Each Goroutine starts with only **2 KB of stack space**, compared to Node's heavy thread allocation. We can scale to millions of concurrent polling tasks without memory exhaustion.
* **Non-Blocking Network Poller:** The Go scheduler utilizes an M:N scheduling model. When a Goroutine blocks waiting for the BOI bank API to respond, the runtime yields that CPU thread and schedules active computational tasks (like executing ledger writes or processing incoming cron notifications).

```
   [ Traditional Node.js Single Thread ]
   Requests ──► [ Event Loop Thread ] ──► [ BOI API Call (Latent — Blocks Thread) ]
                                            ▲
                                            └─ Subsequent operations queue here

   [ Go M:N Multi-Core Scheduler ]
   Requests ──┬─► [ Goroutine A (2 KB) ] ──► [ Polling BOI (Latent) ]  ──► (Thread Yielded)
              ├─► [ Goroutine B (2 KB) ] ──► [ Sending Emails ]      ──► (Executed Instantly)
              └─► [ Goroutine C (2 KB) ] ──► [ Ledger Outbox Job ]   ──► (Executed Instantly)
```

---

## 3. Relational Transactional Outbox & Go River Queue

To prevent **Dual-Write Drift** (where a database write succeeds but a subsequent network message to a queue broker fails), the platform enforces the **Transactional Outbox Pattern** directly inside PostgreSQL. We completely eliminated Redis, saving **150MB of RAM** and reducing infrastructure dependencies.

### 3.1 Step-by-Step Transaction Flow
Instead of writing to separate database and queue containers, all operations occur within a single ACID-compliant PostgreSQL transaction:

```
[ NestJS Core Backend ]
     │
     ├── 1. BEGIN TRANSACTION (core schema)
     │        INSERT INTO core.ledger_entries (DEPOSIT, $10,000)
     │        INSERT INTO core.outbox_events (Type: INVESTMENT_ACTIVATED, Payload: {...})
     └── 2. COMMIT (Atomic: both write or both fail. Zero financial drift.)
              │
[ Go Payments Outbox Worker ]
     │
     ├── 3. Polls `core.outbox_events` table (Every 1 second)
     ├── 4. ENQUEUES Job to `payments.river_job` table via database transaction
     └── 5. UPDATE `published = true` in outbox table
              │
[ Go River Worker Engine ]
     └── 6. Executes Goroutine to poll BOI AIS / dispatch Resend verification emails.
```

### 3.2 SQL RLS & Schema-Level Isolation
To ensure high-security boundaries while sharing a single PostgreSQL instance, database-level schemas are segregated. Under no circumstances are cross-schema joins permitted in application code:

```
                                [ PostgreSQL Engine ]
                                         │
                 ┌───────────────────────┴───────────────────────┐
                 ▼                                               ▼
         [ Schema: core ]                                [ Schema: payments ]
         • Managed by NestJS Backend API                 • Managed by Go Payments Service
         • Tables: `users`, `ledger_entries`,            • Tables: `bank_transactions`,
           `pools`, `monthly_snapshots`                    `river_jobs`, `river_leaders`
```

Additionally, PostgreSQL **Row-Level Security (RLS)** is active on all user tables, ensuring that a bug in application-level routing logic cannot leak tenant data.

---

## 4. Financial Ledger Immutability & Performance Scaling

### 4.1 Append-Only Ledger Constraints
To pass regulatory financial audits, the `ledger_entries` table is strictly **append-only**. `UPDATE` and `DELETE` queries are restricted at the database user permission layer. Reversals or losses are recorded as additive `DEBIT` entries of types `PROFIT_REVERSAL` or `CAPITAL_LOSS`.

### 4.2 High-Performance Monthly Balance Snapshots
Calculating user account balances by performing a sum query on all historical ledger records degrades under account age. We solve this by taking balance snapshots on the 1st of every month:

```sql
-- Fast Query: Snapshot Balance + Current Month's Delta
SELECT 
  COALESCE(s.snapshot_balance_usd, 0) +
  COALESCE((
    SELECT SUM(CASE WHEN direction = 'CREDIT' THEN amount_usd ELSE -amount_usd END)
    FROM ledger_entries
    WHERE investment_id = $1
      AND status = 'CONFIRMED'
      AND created_at >= date_trunc('month', NOW())
  ), 0) AS current_balance_usd
FROM monthly_balance_snapshots s
WHERE s.investment_id = $1
ORDER BY s.snapshot_month DESC
LIMIT 1;
```

> [!TIP]
> **Performance Metric:** By capping the database scan range to a maximum of 31 days of active logs, query performance remains **sub-15 milliseconds** indefinitely, regardless of account age.

---

## 5. Ephemeral Infrastructure & Disaster Recovery

The single-server **Hetzner CX32 (€6.80/month)** is designed to be fully disposable. We chose the **CX32 (4 vCPU, 8 GB RAM, 80 GB NVMe)** to replace the under-provisioned CX22, providing 6+ GB of RAM headroom to absorb transient NestJS and Next.js garbage collection (GC) spikes without risk of Out-Of-Memory (OOM) event loop lockups. Docker images are ephemeral and can be rebuilt instantly from our **GitLab CI/CD container registry**. 

### 5.1 Volume Separation strategy
All persistent database storage is mapped to a dedicated **Hetzner Volume (100 GB NVMe)**, which lives independently of the VM lifecycle.

```
Hetzner CX32 Ephemeral Disk (80 GB NVMe)
  └── OS, Nginx configs, Docker system files, compiled service binaries

Hetzner Block Volume (100 GB NVMe) — Mounted to VM
  └── /var/lib/postgresql/data  ◄─── All financial data, ledgers, and logs
```

### 5.2 Recovery Runbook (Mean Time to Repair < 5 Minutes)
If the host server experiences a critical OS failure or hardware crash:
1. Provision a new **Hetzner CX32 instance** in the same region.
2. Detach the **Hetzner Volume** from the crashed server via the Hetzner Cloud Console.
3. Attach the Volume to the new instance.
4. Mount the volume data directory.
5. Execute `docker compose up -d` using our injected Doppler secrets. The platform is restored back to service with **zero data loss**.

---

## 6. PII Security & Automated Backup Implementation

### 6.1 PII Cryptographic Encryption (AES-256-GCM)
To prevent data exposure in the event of database access compromise, all Personally Identifiable Information (PII) columns (e.g. client names, phone numbers, raw home addresses, bank routing details, and IBANs) are dynamically encrypted at the application layer inside the **Core Backend (NestJS)** before reaching the Postgres query layer.

* **Cipher Standard:** **AES-256-GCM** (Advanced Encryption Standard in Galois/Counter Mode).
* **Initialization Vector (IV):** A cryptographically secure random 12-byte IV is generated **for every individual encryption run**. This guarantees that encrypting the same text twice yields completely different ciphertexts, preventing statistical frequency-analysis attacks.
* **Key Lifecycle:** Keys are dynamically injected as environmental secrets into container runtimes via **Doppler**. They are never committed to the repository, written to local logs, or stored in plaintext on disk volumes.

#### Database Column Design & NestJS Pseudo-Code
PII fields are stored in the database using the format: `cipher:base64_encoded_ciphertext:base64_encoded_iv:base64_encoded_auth_tag`.

```typescript
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

export function encryptPII(plainText: string, encryptionKeyHex: string): string {
    const key = Buffer.from(encryptionKeyHex, 'hex'); // 32-byte key
    const iv = randomBytes(12); // Secure 12-byte IV
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    
    let encrypted = cipher.update(plainText, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag().toString('base64');
    
    // Return standard formatted serialization
    return `cipher:${encrypted}:${iv.toString('base64')}:${authTag}`;
}

export function decryptPII(cipherTextWithMetadata: string, encryptionKeyHex: string): string {
    const parts = cipherTextWithMetadata.split(':');
    if (parts[0] !== 'cipher' || parts.length < 4) return cipherTextWithMetadata; // Plaintext fallback
    
    const key = Buffer.from(encryptionKeyHex, 'hex');
    const [, encrypted, ivBase64, authTagBase64] = parts;
    
    const iv = Buffer.from(ivBase64, 'base64');
    const authTag = Buffer.from(authTagBase64, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}
```

### 6.2 Database RLS (Row-Level Security) DDL
PostgreSQL Row-Level Security (RLS) is used to isolate tenant data. Each request executes within a database session transaction where the active `tenant_id` context is set as a session variable.

```sql
-- Enable RLS on all client data tables
ALTER TABLE core.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.investments ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.investment_risk_splits ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.investment_pool_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.withdrawal_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.monthly_balance_snapshots ENABLE ROW LEVEL SECURITY;

-- A. Users Tenant Isolation Policy
CREATE POLICY tenant_isolation_policy ON core.users
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- B. Other User-related Tables Tenant Isolation Policy (checked via core.users tenant subquery)
CREATE POLICY tenant_isolation_policy ON core.user_profiles
  FOR ALL
  USING (user_id IN (
    SELECT id FROM core.users WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  ));

CREATE POLICY tenant_isolation_policy ON core.investments
  FOR ALL
  USING (user_id IN (
    SELECT id FROM core.users WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  ));

CREATE POLICY tenant_isolation_policy ON core.ledger_entries
  FOR ALL
  USING (user_id IN (
    SELECT id FROM core.users WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  ));

CREATE POLICY tenant_isolation_policy ON core.withdrawal_requests
  FOR ALL
  USING (user_id IN (
    SELECT id FROM core.users WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  ));

CREATE POLICY tenant_isolation_policy ON core.monthly_balance_snapshots
  FOR ALL
  USING (user_id IN (
    SELECT id FROM core.users WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  ));

-- C. Nested Tables Tenant Isolation Policy (checked via core.investments parent subquery)
CREATE POLICY tenant_isolation_policy ON core.investment_risk_splits
  FOR ALL
  USING (investment_id IN (
    SELECT id FROM core.investments WHERE user_id IN (
      SELECT id FROM core.users WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    )
  ));

CREATE POLICY tenant_isolation_policy ON core.investment_pool_allocations
  FOR ALL
  USING (investment_id IN (
    SELECT id FROM core.investments WHERE user_id IN (
      SELECT id FROM core.users WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    )
  ));
```
During a NestJS service invocation, the connection context executes:
`SET LOCAL app.current_tenant_id = 'user-tenant-uuid-here';`
Even a bug in application routing will be blocked by the PostgreSQL engine if it attempts to query cross-tenant boundaries.

### 6.3 Automated Backup Cron Execution
The backup system is executed inside the **Payments & Notifications Service (Go)** via a River cron job scheduler. 

* **Daily Cron Setup:** Runs at `02:00 UTC` daily.
* **Storage Endpoint:** Uploaded securely using HTTPS mTLS directly into a private **Hetzner Object Storage S3 bucket**.
* **Backup Shell Script Command:**
```bash
#!/bin/bash
set -e

# Configuration
BACKUP_DIR="/tmp/backups"
TIMESTAMP=$(date +"%Y-%m-%d_%H%M%S")
DB_HOST="postgres"
DB_USER="postgres"
DB_NAME="titan"
S3_BUCKET="titan-vault-backups"
BACKUP_FILE="${BACKUP_DIR}/titan_backup_${TIMESTAMP}.dump" -- Custom dump file (Issue 5 Part 2 Fix: remove gzip double compression)

mkdir -p ${BACKUP_DIR}

# Execute pg_dump using native Custom format (-Fc) for all schemas (built-in compression)
PGPASSWORD="${DB_PASSWORD}" pg_dump -h ${DB_HOST} -U ${DB_USER} -d ${DB_NAME} -Fc -f ${BACKUP_FILE}

# Upload directly to Hetzner Object Storage using AWS-CLI S3 API
aws --endpoint-url https://nbg1.your-object-storage.host \
  s3 cp ${BACKUP_FILE} s3://${S3_BUCKET}/daily/titan_backup_${TIMESTAMP}.dump

# Housekeeping: clean local temporary folder
rm -f ${BACKUP_FILE}
```
Instead of running error-prone cleanup scripts inside VM cron files, backup retention is governed at the storage tier using an **S3 Bucket Lifecycle Policy** (Issue 5 Part 2 Fix):
```bash
# Apply lifecycle rule once to delete daily backups older than 30 days automatically
aws --endpoint-url https://nbg1.your-object-storage.host \
  s3api put-bucket-lifecycle-configuration \
  --bucket ${S3_BUCKET} \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "delete-old-backups",
      "Status": "Enabled",
      "Filter": {"Prefix": "daily/"},
      "Expiration": {"Days": 30}
    }]
  }'
```
If this daily job fails to execute or return a `0` code, Go River triggers an automatic transactional outbox alert (`BACKUP_FAILED`) that emails the `SUPER_ADMIN` immediately.

---

## 7. Database Schema & Data Models Deep-Dive

To enforce absolute financial auditability, high throughput, and total separation of concerns, the database architecture leverages two isolated logical schemas (`core` and `payments`) on a shared PostgreSQL instance. 

> [!IMPORTANT]
> **Schema Isolation Rule (V2/V3 Database Split Path):**  
> All tables in the `payments` schema are strictly decoupled from the `core` schema. No database-level foreign key constraints, joins, or cross-schema views are permitted between them. Any mapping (such as matching a bank wire to an investment ledger entry) is executed via a **logical soft ID reference** and resolved at the application layer or via the Transactional Outbox. This enables the database to be physically split onto two isolated servers in V3 with zero schema or SQL refactoring.

### 7.1 Entity-Relationship Diagram (ERD)

The following diagram defines the physical database structure, showing entity attributes, primary keys, foreign keys, and relationships.

```mermaid
erDiagram
    core_users ||--|| core_user_profiles : "has profile (1:1)"
    core_users ||--o{ core_investments : "owns (1:N)"
    core_investments ||--o{ core_investment_risk_splits : "risk splits (1:N)"
    core_investments ||--o{ core_ledger_entries : "ledger history (1:N)"
    core_investments ||--o{ core_monthly_balance_snapshots : "snapshots balance (1:N)"
    core_investments ||--o{ core_investment_pool_allocations : "pool allocations (1:N)"
    core_investments ||--o{ core_withdrawal_requests : "requests withdrawals (1:N)"
    
    core_pools ||--o{ core_investments : "assigned to (1:N)"
    core_pools ||--o{ core_investment_pool_allocations : "linked allocations (1:N)"
    core_pools ||--o{ core_withdrawal_tasks : "sources funds (1:N)"
    
    core_trading_accounts ||--o{ core_pools : "funds (1:N)"
    
    core_admins ||--o{ core_pools : "manages (1:N)"
    core_admins ||--o{ core_investment_pool_allocations : "owns slices (1:N)"
    core_admins ||--o{ core_withdrawal_requests : "approves (1:N)"
    core_admins ||--o{ core_withdrawal_tasks : "executes (1:N)"
    core_admins ||--o{ core_admins : "creates (1:N)"
    
    core_withdrawal_requests ||--o{ core_withdrawal_tasks : "spawns (1:N)"
    
    %% Logical soft link (no physical foreign keys to allow database decoupling)
    payments_bank_transactions .o{ core_ledger_entries : "logical soft reference (reference_id)"
    
    core_users {
        uuid id PK
        uuid tenant_id
        text type
        text email UK
        text password_hash
        text status
        text kyc_status
        timestamptz created_at
        timestamptz updated_at
    }
    
    core_user_profiles {
        uuid id PK
        uuid user_id FK "1:1 core_users"
        text full_name
        text contact_person
        text phone
        text address "Encrypted AES-256"
        text city
        text country
        text bank_account_number "Encrypted AES-256"
        text bank_routing_info "Encrypted JSON"
        text currency_preference
        timestamptz created_at
        timestamptz updated_at
    }

    core_investments {
        uuid id PK
        uuid user_id FK
        uuid pool_id FK
        text risk_profile
        numeric target_return_pct
        integer maturity_months
        text amount_category
        date start_date
        date maturity_date
        text status
        numeric minimum_capital_floor_usd
        timestamptz created_at
        timestamptz updated_at
    }

    core_investment_risk_splits {
        uuid id PK
        uuid investment_id FK
        text risk_profile
        numeric percentage
        numeric amount_usd
        timestamptz created_at
    }

    core_ledger_entries {
        uuid id PK
        uuid user_id FK
        uuid investment_id FK
        uuid pool_id FK
        text entry_type
        text direction
        numeric amount_usd
        numeric original_amount
        text original_currency
        numeric fx_rate
        text reference_id UK
        text status
        timestamptz created_at
        jsonb metadata
    }

    core_monthly_balance_snapshots {
        uuid id PK
        uuid investment_id FK
        uuid user_id FK
        date snapshot_month UK
        numeric snapshot_balance_usd
        timestamptz created_at
    }

    core_pools {
        uuid id PK
        text pool_code UK
        uuid trading_account_id FK
        text trading_account_label
        text risk_profile
        integer maturity_months
        text status
        integer max_transactions
        integer current_transaction_count
        uuid owned_by FK "core_admins"
        uuid created_by FK "core_admins"
        timestamptz created_at
    }

    core_investment_pool_allocations {
        uuid id PK
        uuid investment_id FK
        uuid pool_id FK
        uuid owned_by_admin_id FK "core_admins"
        numeric amount_usd
        numeric percentage
        text status
        timestamptz allocated_at
        uuid allocated_by FK "core_admins"
    }

    core_withdrawal_requests {
        uuid id PK
        uuid user_id FK
        uuid investment_id FK
        text type
        numeric amount_requested_usd
        integer notice_days
        text status
        date notice_start_date
        date ready_date
        uuid approved_by FK "core_admins"
        timestamptz approved_at
        text transfer_reference
        timestamptz created_at
        timestamptz updated_at
    }

    core_withdrawal_tasks {
        uuid id PK
        uuid withdrawal_request_id FK
        uuid pool_id FK
        uuid admin_id FK "core_admins"
        numeric amount_usd
        numeric percentage
        text status
        text failure_reason
        uuid approved_by FK "core_admins"
        timestamptz approved_at
        text transfer_reference
        text notes
        timestamptz created_at
    }

    core_admins {
        uuid id PK
        text email UK
        text password_hash
        text role
        uuid created_by FK "core_admins"
        boolean is_active
        timestamptz last_login_at
        timestamptz created_at
    }

    core_trading_accounts {
        uuid id PK
        text label
        text broker_name
        text account_number
        boolean is_active
        timestamptz created_at
    }

    core_outbox_events {
        uuid id PK
        text event_type
        jsonb payload
        boolean published
        timestamptz published_at
        timestamptz created_at
    }

    payments_bank_transactions {
        uuid id PK
        text bank_reference_id UK
        numeric amount_eur
        text remitter_name
        text remitter_iban
        text remitter_bic
        text memo
        date value_date
        text status
        uuid mapped_ledger_entry_id
        timestamptz created_at
        timestamptz updated_at
    }
```

### 7.2 Database Creation Scripts (DDL SQL)

Below are the complete, production-ready SQL scripts to instantiate the schemas, tables, indices, and validation rules. 

```sql
-- ============================================================================
-- TITAN FUNDS MASTER SCHEMA DEFINITION DDL
-- Database Compatibility: PostgreSQL 13+
-- Purpose: Complete standalone database initialization script
-- Authors: Titan Software Engineering Team
-- ============================================================================

-- Create isolated logical schemas (V2/V3 Database Split path)
CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS payments;

-- gen_random_uuid() is used throughout (built-in, PostgreSQL 13+)
-- uuid-ossp retained for compatibility if migrating to older PostgreSQL versions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- 1. CUSTOM ENUM TYPE CREATIONS (Strong Integrity Controls)
-- ============================================================================

CREATE TYPE core.user_type AS ENUM ('INDIVIDUAL', 'ENTERPRISE');

CREATE TYPE core.user_status AS ENUM (
  'PENDING_PROFILE', 
  'PENDING_AGREEMENT', 
  'PENDING_INVESTMENT', 
  'PENDING_DEPOSIT', 
  'ACTIVE', 
  'MATURED',
  'SUSPENDED',
  'CLOSED',           -- All capital and profit fully withdrawn and settled. Investment lifecycle complete.
  'GDPR_ANONYMISED'   -- P0 Fix: PII wiped on GDPR erasure request. Financial records retained.
);

CREATE TYPE core.kyc_status AS ENUM ('NOT_STARTED', 'PENDING', 'APPROVED', 'REJECTED');

CREATE TYPE core.risk_profile AS ENUM ('LOW', 'MEDIUM', 'HIGH');

CREATE TYPE core.investment_status AS ENUM ('PENDING_DEPOSIT', 'ACTIVE', 'MATURED', 'CLOSED');

CREATE TYPE core.ledger_entry_type AS ENUM (
  'DEPOSIT', 
  'PROFIT_ALLOCATION', 
  'PROFIT_REVERSAL', 
  'ACCRUED_DIVIDEND',    -- Accrued monthly dividend (locked until investment maturity date)
  'DIVIDEND_RELEASE',    -- Debit entry that releases accrued dividends to liquid balance at maturity
  'CAPITAL_LOSS', 
  'CAPITAL_WITHDRAWAL', 
  'PROFIT_WITHDRAWAL', 
  'FEE', 
  'ROUNDING_ADJUSTMENT'
);

CREATE TYPE core.ledger_direction AS ENUM ('CREDIT', 'DEBIT');

CREATE TYPE core.ledger_status AS ENUM ('PENDING', 'CONFIRMED', 'FAILED', 'REVERSED');

CREATE TYPE core.pool_status AS ENUM ('OPEN', 'CLOSED', 'SUSPENDED', 'FULL');

CREATE TYPE core.allocation_status AS ENUM ('ACTIVE', 'PARTIALLY_WITHDRAWN', 'FULLY_WITHDRAWN');

CREATE TYPE core.withdrawal_type AS ENUM ('PROFIT', 'CAPITAL');

CREATE TYPE core.withdrawal_status AS ENUM (
  'SUBMITTED', 
  'NOTICE_PERIOD', 
  'READY_FOR_APPROVAL', 
  'TASKS_PENDING', 
  'TASKS_COMPLETE', 
  'COMPLETED', 
  'CANCELLED'
);

CREATE TYPE core.withdrawal_task_status AS ENUM ('PENDING', 'ADMIN_APPROVED', 'TRANSFER_DONE', 'FAILED');

CREATE TYPE core.admin_role AS ENUM ('SUPER_ADMIN', 'POOL_MANAGER', 'FINANCE_APPROVER');

CREATE TYPE core.actor_type AS ENUM ('ADMIN', 'USER', 'SYSTEM');

CREATE TYPE payments.bank_transaction_status AS ENUM ('PENDING', 'MAPPED', 'UNMAPPED', 'IGNORED');


-- ============================================================================
-- 2. TABLE DDL SCRIPTING (Dependency Order Rules)
-- ============================================================================

-- A. ADMINS TABLE
CREATE TABLE core.admins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL CHECK (email ~* '^[A-Za-z0-9._%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,4}$'),
    password_hash TEXT NOT NULL,
    role core.admin_role NOT NULL DEFAULT 'POOL_MANAGER',
    created_by UUID REFERENCES core.admins(id),
    is_active BOOLEAN NOT NULL DEFAULT true,
    last_login_at TIMESTAMPTZ,
    deactivated_at TIMESTAMPTZ,                    -- P3 Fix: Set when is_active transitions to false. Access removal timestamp directly auditable for compliance.
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE core.admins IS 'Internal administrative staff, pool managers, and finance approvers.';

-- B. TRADING ACCOUNTS TABLE
CREATE TABLE core.trading_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    label TEXT NOT NULL,
    broker_name TEXT NOT NULL,
    account_number TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE core.trading_accounts IS 'External brokerage or custodian accounts holding physical assets.';

-- C. USERS TABLE (Multi-tenant base)
CREATE TABLE core.users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL, -- Enforces database tenant boundary for Row-Level Security
    type core.user_type NOT NULL DEFAULT 'INDIVIDUAL',
    email TEXT UNIQUE NOT NULL CHECK (email ~* '^[A-Za-z0-9._%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,4}$'),
    password_hash TEXT NOT NULL,
    status core.user_status NOT NULL DEFAULT 'PENDING_PROFILE',
    kyc_status core.kyc_status NOT NULL DEFAULT 'NOT_STARTED',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE core.users IS 'Platform client accounts (both individual retail investors and corporate enterprises).';

-- D. USER PROFILES TABLE (PII cryptographically isolated)
CREATE TABLE core.user_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID UNIQUE NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
    full_name TEXT NOT NULL,
    contact_person TEXT, -- Used for enterprise company representatives
    phone TEXT NOT NULL,
    address TEXT NOT NULL, -- Format: cipher:ciphertext:iv:tag (AES-256-GCM application encrypted)
    city TEXT NOT NULL,
    country TEXT NOT NULL,
    bank_account_number TEXT NOT NULL, -- Format: cipher:ciphertext:iv:tag (AES-256-GCM application encrypted)
    bank_routing_info TEXT NOT NULL, -- Format: cipher:ciphertext:iv:tag (AES-256-GCM application encrypted JSON)
    currency_preference TEXT NOT NULL DEFAULT 'EUR', -- P1 Fix: V1 is EUR-only (CEO confirmed EU scope).
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE core.user_profiles IS 'Personally Identifiable Information (PII) encrypted at the application layer to defend against table dump leaks.';

-- E. POOLS TABLE (Multi-Admin sub-ledgers)
CREATE TABLE core.pools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_code TEXT UNIQUE NOT NULL, -- Format enforced via app: e.g. ACCA-HIGH-001
    trading_account_id UUID NOT NULL REFERENCES core.trading_accounts(id),
    trading_account_label TEXT NOT NULL,
    risk_profile core.risk_profile NOT NULL,
    maturity_months INTEGER NOT NULL CHECK (maturity_months IN (6, 12, 24)),
    status core.pool_status NOT NULL DEFAULT 'OPEN',
    max_transactions INTEGER NOT NULL CHECK (max_transactions > 0),
    current_transaction_count INTEGER NOT NULL DEFAULT 0 CHECK (current_transaction_count >= 0),
    owned_by UUID REFERENCES core.admins(id),
    created_by UUID NOT NULL REFERENCES core.admins(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pool_capacity_check CHECK (current_transaction_count <= max_transactions)
);

COMMENT ON TABLE core.pools IS 'Allocated sub-ledgers mapping capital splits to discrete broker accounts managed by individual admins.';

-- F. INVESTMENTS TABLE
CREATE TABLE core.investments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES core.users(id),
    pool_id UUID REFERENCES core.pools(id), -- Null until mapped by SUPER_ADMIN
    risk_profile core.risk_profile NOT NULL,
    target_return_pct NUMERIC(5,2) NOT NULL CHECK (target_return_pct >= 0.00),
    maturity_months INTEGER NOT NULL CHECK (maturity_months IN (6, 12, 24)),
    amount_category TEXT NOT NULL CHECK (amount_category IN ('20K', '50K', '100K', 'ABOVE_100K')),
    start_date DATE,
    maturity_date DATE,
    status core.investment_status NOT NULL DEFAULT 'PENDING_DEPOSIT',
    minimum_capital_floor NUMERIC(18,2) NOT NULL DEFAULT 5000.00 CHECK (minimum_capital_floor >= 0.00),
    currency TEXT NOT NULL DEFAULT 'EUR' CHECK (length(currency) = 3), -- Multi-currency V1/V2 design
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT valid_dates CHECK (maturity_date IS NULL OR start_date IS NULL OR maturity_date >= start_date)
);

COMMENT ON TABLE core.investments IS 'Master client investment contracts. Risk profiles and returns are locked upon confirmation.';

-- G. INVESTMENT RISK SPLITS TABLE (Multi-risk aggregation splits)
CREATE TABLE core.investment_risk_splits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    investment_id UUID NOT NULL REFERENCES core.investments(id) ON DELETE CASCADE,
    risk_profile core.risk_profile NOT NULL,
    percentage NUMERIC(5,2) NOT NULL CHECK (percentage > 0.00 AND percentage <= 100.00),
    amount NUMERIC(18,2) NOT NULL CHECK (amount >= 0.00),
    currency TEXT NOT NULL DEFAULT 'EUR' CHECK (length(currency) = 3), -- Neutral amount column structure
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE core.investment_risk_splits IS 'Allocations dividing a single investment deposit into multiple risk profiles (e.g. 40% HIGH / 30% MED / 30% LOW).';

-- H. INVESTMENT POOL ALLOCATIONS (Internal multi-pool tracing slices)
CREATE TABLE core.investment_pool_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    investment_id UUID NOT NULL REFERENCES core.investments(id),
    pool_id UUID NOT NULL REFERENCES core.pools(id),
    owned_by_admin_id UUID NOT NULL REFERENCES core.admins(id),
    amount NUMERIC(18,2) NOT NULL CHECK (amount > 0.00),
    currency TEXT NOT NULL DEFAULT 'EUR' CHECK (length(currency) = 3), -- Neutral amount column structure
    percentage NUMERIC(5,2) NOT NULL CHECK (percentage > 0.00 AND percentage <= 100.00),
    status core.allocation_status NOT NULL DEFAULT 'ACTIVE',
    allocated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    allocated_by UUID NOT NULL REFERENCES core.admins(id)
);

COMMENT ON TABLE core.investment_pool_allocations IS 'Traces active allocations linking a client investment slice to a specific manager pool.';

-- I. LEDGER ENTRIES TABLE (Append-Only Unified Ledger)
CREATE TABLE core.ledger_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES core.users(id),
    investment_id UUID REFERENCES core.investments(id),
    pool_id UUID REFERENCES core.pools(id),
    entry_type core.ledger_entry_type NOT NULL,
    direction core.ledger_direction NOT NULL,
    amount NUMERIC(18,2) NOT NULL CHECK (amount >= 0.00),
    currency TEXT NOT NULL DEFAULT 'EUR' CHECK (length(currency) = 3), -- Neutral amount column structure
    original_amount NUMERIC(18,2) NOT NULL CHECK (original_amount >= 0.00),
    original_currency TEXT NOT NULL CHECK (length(original_currency) = 3),
    fx_rate NUMERIC(12,6) NOT NULL DEFAULT 1.000000 CHECK (fx_rate > 0),
    reference_id TEXT UNIQUE NOT NULL, -- External txn ID or unique system reference (Idempotency key)
    status core.ledger_status NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB
);

COMMENT ON TABLE core.ledger_entries IS 'Strictly append-only unified ledger books. Mutation is blocked via database triggers to preserve regulatory compliance.';

-- J. MONTHLY BALANCE SNAPSHOTS TABLE (High-speed balance query target)
CREATE TABLE core.monthly_balance_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    investment_id UUID NOT NULL REFERENCES core.investments(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
    snapshot_month DATE NOT NULL CHECK (snapshot_month = date_trunc('month', snapshot_month)::date),
    snapshot_balance NUMERIC(18,2) NOT NULL,
    currency TEXT NOT NULL DEFAULT 'EUR' CHECK (length(currency) = 3), -- Neutral amount column structure
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (investment_id, snapshot_month)
);

COMMENT ON TABLE core.monthly_balance_snapshots IS 'End-of-month closing balance aggregations. Bounds dynamic summation scans to a maximum of 31 days.';

-- K1. NOTICE PERIOD CONFIGURATION TABLE (Allows dynamic tiers without DDL migrations)
CREATE TABLE core.notice_period_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    notice_days INTEGER UNIQUE NOT NULL CHECK (notice_days > 0),
    label TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE core.notice_period_config IS 'Stores the valid notice period configurations for withdrawal requests.';

-- K2. WITHDRAWAL REQUESTS TABLE
CREATE TABLE core.withdrawal_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES core.users(id),
    investment_id UUID NOT NULL REFERENCES core.investments(id),
    type core.withdrawal_type NOT NULL,
    amount_requested NUMERIC(18,2) NOT NULL CHECK (amount_requested > 0.00),
    currency TEXT NOT NULL DEFAULT 'EUR' CHECK (length(currency) = 3), -- Neutral amount column structure
    notice_days INTEGER NOT NULL REFERENCES core.notice_period_config(notice_days), -- FK reference replacing hardcoded CHECK
    status core.withdrawal_status NOT NULL DEFAULT 'SUBMITTED',
    notice_start_date DATE,
    ready_date DATE,
    approved_by UUID REFERENCES core.admins(id),
    approved_at TIMESTAMPTZ,
    transfer_reference TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT valid_notice_dates CHECK (ready_date IS NULL OR notice_start_date IS NULL OR ready_date >= notice_start_date)
);

COMMENT ON TABLE core.withdrawal_requests IS 'Requests submitted by clients to extract interest profits or redeem matured capital investments.';

-- L. WITHDRAWAL TASKS TABLE (Individual sub-tasks for multi-admin pools)
CREATE TABLE core.withdrawal_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    withdrawal_request_id UUID NOT NULL REFERENCES core.withdrawal_requests(id) ON DELETE CASCADE,
    pool_id UUID NOT NULL REFERENCES core.pools(id),
    admin_id UUID NOT NULL REFERENCES core.admins(id),
    amount NUMERIC(18,2) NOT NULL CHECK (amount > 0.00),
    currency TEXT NOT NULL DEFAULT 'EUR' CHECK (length(currency) = 3), -- Neutral amount column structure
    percentage NUMERIC(5,2) NOT NULL CHECK (percentage > 0.00 AND percentage <= 100.00),
    status core.withdrawal_task_status NOT NULL DEFAULT 'PENDING',
    failure_reason TEXT,
    approved_by UUID REFERENCES core.admins(id),
    approved_at TIMESTAMPTZ,
    transfer_reference TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE core.withdrawal_tasks IS 'Admin-level liquidation sub-tasks spawned automatically when a withdrawal covers multiple aggregated pools.';

-- M. TRANSACTIONAL OUTBOX TABLE (Solves the dual-write drift challenge)
CREATE TABLE core.outbox_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    published BOOLEAN NOT NULL DEFAULT false,
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE core.outbox_events IS 'Stores outward-bound events transactionally locked inside core updates, picked up by the Go background queue.';

-- N. AUDIT LOG TABLE (Immutable user and admin trails)
CREATE TABLE core.audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id UUID NOT NULL,
    actor_type core.actor_type NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id UUID NOT NULL,
    before_state JSONB,
    after_state JSONB,
    ip_address TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE core.audit_log IS 'Immutable platform audit log recording modifications to profiles, allocations, admin accesses, and RLS configurations.';

-- O. BANK TRANSACTIONS TABLE (Isolated payments schema - V2/V3 Split native)
CREATE TABLE payments.bank_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bank_reference_id TEXT UNIQUE NOT NULL, -- Bank of Ireland unique transaction identifier
    amount_eur NUMERIC(18,2) NOT NULL,
    remitter_name TEXT NOT NULL,
    remitter_iban TEXT NOT NULL,
    remitter_bic TEXT,
    memo TEXT,
    value_date DATE NOT NULL,
    status payments.bank_transaction_status NOT NULL DEFAULT 'PENDING',
    mapped_ledger_entry_id UUID, -- Logical soft reference: no physical FK to preserve db decoupling!
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE payments.bank_transactions IS 'Logs transactions pulled via bank APIs. Mappings to ledger_entries are handled via soft references to allow physical schema separation.';


-- ============================================================================
-- 3. ADVANCED INDEX OPTIMIZATIONS (B-Tree & Composite Tuning)
-- ============================================================================

-- A. Foreign Key Indexing (Eliminates full table scans on cascading deletions/joins)
CREATE INDEX idx_admins_created_by ON core.admins(created_by);
CREATE INDEX idx_user_profiles_user_id ON core.user_profiles(user_id);
CREATE INDEX idx_pools_owned_by ON core.pools(owned_by);
CREATE INDEX idx_pools_created_by ON core.pools(created_by);
CREATE INDEX idx_investments_user_id ON core.investments(user_id);
CREATE INDEX idx_investments_pool_id ON core.investments(pool_id);
CREATE INDEX idx_investment_risk_splits_investment_id ON core.investment_risk_splits(investment_id);
CREATE INDEX idx_investment_pool_allocations_investment_id ON core.investment_pool_allocations(investment_id);
CREATE INDEX idx_investment_pool_allocations_pool_id ON core.investment_pool_allocations(pool_id);
CREATE INDEX idx_investment_pool_allocations_admin_id ON core.investment_pool_allocations(owned_by_admin_id);
CREATE INDEX idx_ledger_entries_user_id ON core.ledger_entries(user_id);
CREATE INDEX idx_ledger_entries_investment_id ON core.ledger_entries(investment_id);
CREATE INDEX idx_ledger_entries_pool_id ON core.ledger_entries(pool_id);
CREATE INDEX idx_monthly_balance_snapshots_investment_id ON core.monthly_balance_snapshots(investment_id);
CREATE INDEX idx_monthly_balance_snapshots_user_id ON core.monthly_balance_snapshots(user_id);
CREATE INDEX idx_withdrawal_requests_user_id ON core.withdrawal_requests(user_id);
CREATE INDEX idx_withdrawal_requests_investment_id ON core.withdrawal_requests(investment_id);
CREATE INDEX idx_withdrawal_requests_approved_by ON core.withdrawal_requests(approved_by);
CREATE INDEX idx_withdrawal_tasks_request_id ON core.withdrawal_tasks(withdrawal_request_id);
CREATE INDEX idx_withdrawal_tasks_pool_id ON core.withdrawal_tasks(pool_id);
CREATE INDEX idx_withdrawal_tasks_admin_id ON core.withdrawal_tasks(admin_id);
CREATE INDEX idx_withdrawal_tasks_approved_by ON core.withdrawal_tasks(approved_by);

-- B. Composite Covered Index for Ledger Balance Calculations
CREATE INDEX idx_ledger_balance_calc 
ON core.ledger_entries(investment_id, status, created_at) 
INCLUDE (amount, direction);

-- C. Ordered Descending Composite Index for Monthly Balance Snapshots
CREATE INDEX idx_snapshots_latest_lookup 
ON core.monthly_balance_snapshots(investment_id, snapshot_month DESC);

-- E. Partial Index for Queue Outbox Worker
CREATE INDEX idx_outbox_events_unprocessed 
ON core.outbox_events(created_at) 
WHERE (published = false);

-- F. Covering Index for Payments Reconciliation
CREATE INDEX idx_bank_txns_recon_covering 
ON payments.bank_transactions(status, bank_reference_id)
INCLUDE (amount_eur, value_date);

-- G. Audit Log Indexes
CREATE INDEX idx_audit_log_actor_id ON core.audit_log(actor_id, created_at DESC);
CREATE INDEX idx_audit_log_entity   ON core.audit_log(entity_id, entity_type, created_at DESC);

-- H. Composite Pool Status Index
CREATE INDEX idx_pools_account_status ON core.pools(trading_account_id, status);

-- I. Withdrawal Requests Status Index
CREATE INDEX idx_withdrawal_requests_status ON core.withdrawal_requests(status, ready_date)
  WHERE status IN ('NOTICE_PERIOD', 'READY_FOR_APPROVAL', 'TASKS_PENDING');

-- J. Investments Maturity Check Index
CREATE INDEX idx_investments_maturity_cron ON core.investments(maturity_date, status)
  WHERE status = 'ACTIVE';


-- ============================================================================
-- 4. BUSINESS & AUDIT LOGIC TRIGGERS (Automated Database Defense)
-- ============================================================================

-- A. Strict Append-Only Trigger for Ledger Entries
CREATE OR REPLACE FUNCTION core.prevent_ledger_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'CRITICAL AUDIT ERROR: Ledger entries are append-only. UPDATE and DELETE actions are forbidden.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_ledger_append_only
BEFORE UPDATE OR DELETE ON core.ledger_entries
FOR EACH ROW EXECUTE FUNCTION core.prevent_ledger_modification();

-- B. Auto-update Timestamp Triggers (Enforces structural hygiene)
CREATE OR REPLACE FUNCTION core.update_timestamp_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_users_modtime
BEFORE UPDATE ON core.users
FOR EACH ROW EXECUTE FUNCTION core.update_timestamp_column();

CREATE TRIGGER update_profiles_modtime
BEFORE UPDATE ON core.user_profiles
FOR EACH ROW EXECUTE FUNCTION core.update_timestamp_column();

CREATE TRIGGER update_investments_modtime
BEFORE UPDATE ON core.investments
FOR EACH ROW EXECUTE FUNCTION core.update_timestamp_column();

CREATE TRIGGER update_withdrawal_requests_modtime
BEFORE UPDATE ON core.withdrawal_requests
FOR EACH ROW EXECUTE FUNCTION core.update_timestamp_column();

-- C. Decoupled Schema Auto-Update Trigger Function
CREATE OR REPLACE FUNCTION payments.update_timestamp_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_bank_transactions_modtime
BEFORE UPDATE ON payments.bank_transactions
FOR EACH ROW EXECUTE FUNCTION payments.update_timestamp_column();


-- ============================================================================
-- 5. DATA INTEGRITY TRIGGERS (Enforces mathematical splits and deferred complete checks)
-- ============================================================================

-- A. Risk Split Triggers
-- Mid-Transaction Guard (Checks SUM <= 100 on every row insert/update)
CREATE OR REPLACE FUNCTION core.validate_risk_splits_sum()
RETURNS TRIGGER AS $$
DECLARE
  total_pct NUMERIC(6,2);
BEGIN
  SELECT COALESCE(SUM(percentage), 0)
    INTO total_pct
    FROM core.investment_risk_splits
   WHERE investment_id = NEW.investment_id;

  IF total_pct > 100.00 THEN
    RAISE EXCEPTION 'INTEGRITY ERROR: Risk split percentages for investment_id=% exceed 100%%. Current total: %%', NEW.investment_id, total_pct;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_risk_splits_sum
AFTER INSERT OR UPDATE ON core.investment_risk_splits
FOR EACH ROW EXECUTE FUNCTION core.validate_risk_splits_sum();

-- Commit-Time Guard (Deferred check ensuring final splits SUM = 100 at commit)
CREATE OR REPLACE FUNCTION core.validate_risk_splits_complete()
RETURNS TRIGGER AS $$
DECLARE
  total_pct NUMERIC(6,2);
BEGIN
  SELECT COALESCE(SUM(percentage), 0)
    INTO total_pct
    FROM core.investment_risk_splits
   WHERE investment_id = NEW.investment_id;

  IF total_pct != 100.00 THEN
    RAISE EXCEPTION 'INTEGRITY ERROR: Risk splits for investment_id=% must sum to exactly 100.00%%. Current total: %%', NEW.investment_id, total_pct;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER enforce_risk_splits_complete
AFTER INSERT OR UPDATE ON core.investment_risk_splits
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION core.validate_risk_splits_complete();


-- B. Withdrawal Task Triggers
-- Mid-Transaction Guard (Checks SUM <= 100 on every row insert/update)
CREATE OR REPLACE FUNCTION core.validate_withdrawal_tasks_sum()
RETURNS TRIGGER AS $$
DECLARE
  total_pct NUMERIC(6,2);
BEGIN
  SELECT COALESCE(SUM(percentage), 0)
    INTO total_pct
    FROM core.withdrawal_tasks
   WHERE withdrawal_request_id = NEW.withdrawal_request_id;

  IF total_pct > 100.00 THEN
    RAISE EXCEPTION 'INTEGRITY ERROR: Withdrawal task percentages for request_id=% exceed 100%%. Current total: %%', NEW.withdrawal_request_id, total_pct;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_withdrawal_tasks_sum
AFTER INSERT OR UPDATE ON core.withdrawal_tasks
FOR EACH ROW EXECUTE FUNCTION core.validate_withdrawal_tasks_sum();

-- Commit-Time Guard (Deferred check ensuring final tasks SUM = 100 at commit)
CREATE OR REPLACE FUNCTION core.validate_withdrawal_tasks_complete()
RETURNS TRIGGER AS $$
DECLARE
  total_pct NUMERIC(6,2);
BEGIN
  SELECT COALESCE(SUM(percentage), 0)
    INTO total_pct
    FROM core.withdrawal_tasks
   WHERE withdrawal_request_id = NEW.withdrawal_request_id;

  IF total_pct != 100.00 THEN
    RAISE EXCEPTION 'INTEGRITY ERROR: Withdrawal tasks for request_id=% must sum to exactly 100.00%%. Current total: %%', NEW.withdrawal_request_id, total_pct;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER enforce_withdrawal_tasks_complete
AFTER INSERT OR UPDATE ON core.withdrawal_tasks
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION core.validate_withdrawal_tasks_complete();


-- ============================================================================
-- 6. ROW LEVEL SECURITY (RLS) POLICIES (Tenant Isolation)
-- ============================================================================

-- Enable RLS on all user data tables
ALTER TABLE core.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.investments ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.investment_risk_splits ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.investment_pool_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.withdrawal_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.monthly_balance_snapshots ENABLE ROW LEVEL SECURITY;

-- A. Users Tenant Isolation Policy
CREATE POLICY tenant_isolation_policy ON core.users
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- B. User Profiles Tenant Isolation Policy
CREATE POLICY tenant_isolation_policy ON core.user_profiles
  FOR ALL
  USING (user_id IN (
    SELECT id FROM core.users WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  ));

-- C. Investments Tenant Isolation Policy
CREATE POLICY tenant_isolation_policy ON core.investments
  FOR ALL
  USING (user_id IN (
    SELECT id FROM core.users WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  ));

-- D. Ledger Entries Tenant Isolation Policy
CREATE POLICY tenant_isolation_policy ON core.ledger_entries
  FOR ALL
  USING (user_id IN (
    SELECT id FROM core.users WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  ));

-- E. Risk Splits Tenant Isolation Policy
CREATE POLICY tenant_isolation_policy ON core.investment_risk_splits
  FOR ALL
  USING (investment_id IN (
    SELECT id FROM core.investments WHERE user_id IN (
      SELECT id FROM core.users WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    )
  ));

-- F. Pool Allocations Tenant Isolation Policy
CREATE POLICY tenant_isolation_policy ON core.investment_pool_allocations
  FOR ALL
  USING (investment_id IN (
    SELECT id FROM core.investments WHERE user_id IN (
      SELECT id FROM core.users WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    )
  ));

-- G. Withdrawal Requests Tenant Isolation Policy
CREATE POLICY tenant_isolation_policy ON core.withdrawal_requests
  FOR ALL
  USING (user_id IN (
    SELECT id FROM core.users WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  ));

-- H. Monthly Balance Snapshots Tenant Isolation Policy
CREATE POLICY tenant_isolation_policy ON core.monthly_balance_snapshots
  FOR ALL
  USING (user_id IN (
    SELECT id FROM core.users WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  ));


-- ============================================================================
-- 7. SEED INITIAL CONFIGURATIONS
-- ============================================================================

-- Seed default tiers for notice periods
INSERT INTO core.notice_period_config (notice_days, label) VALUES 
(15, 'Standard Notice (15 Days)'),
(30, 'Extended Notice (30 Days)'),
(45, 'Maximum Notice (45 Days)')
ON CONFLICT (notice_days) DO NOTHING;
```

---

## 8. Database Reliability & Query Strategy

To run seamlessly within the resource constraints of a single-server setup without performance bottlenecking, we implement two primary structural strategies:

### 8.1 Ledger Balance Calculation Execution Strategy
The application layer **never** aggregates the entire historical record set of `core.ledger_entries` directly. Balance calculations are driven by combining:
1. **Closing Balance Snapshots:** Pulled from `core.monthly_balance_snapshots` (representing the closing state of the previous calendar month).
2. **Current Month Delta:** Sourced via `idx_ledger_balance_calc` which covers only the un-snapshotted entries in the current active month.

This limits active indexing scans to a maximum ceiling of **31 days of transactional records per investment profile**, keeping computational query latency under **15 milliseconds** indefinitely, even after decades of continuous operational tracking.

### 8.2 Lock Order Rule for Pool Allocation
To prevent relational database deadlocks under simultaneous multi-pool transactions, the Core Backend enforces a strict **ascending natural ordering** lock protocol. When a request allocates funds across pools, the service compiles the list of `pool_ids`, sorts them alphabetically/numerically, and locks rows using the sorted key array:
```typescript
// NestJS Core Locking Protocol
const sortedPoolIds = [...poolIds].sort();
for (const poolId of sortedPoolIds) {
  await queryRunner.manager.query(
    'SELECT * FROM core.pools WHERE id = $1 FOR UPDATE;', 
    [poolId]
  );
}
```
Sorting target ids guarantees that concurrent multi-pool threads acquiring locks simultaneously never encounter cross-wait conditions, locking queries safely and ensuring maximum database durability.

---

## 9. Automated Pool Allocation Engine & Algorithm

To eliminate administrative bottlenecks and manual error, the platform integrates an **Automated Pool Allocation Engine** that resolves incoming deposits to open active pools matching the client's risk profiles.

### 9.1 Core Trigger & Workflow
1. **Inbound Wire Detection:** The Bank of Ireland poller detects a wire transaction and posts a record to `payments.bank_transactions`.
2. **Deposit Confirmation:** The system matches the wire to an investment. The admin confirms the mapping, creating a `DEPOSIT` ledger credit and transitioning `investments.status` to `ACTIVE`.
3. **Auto-Allocation Invocation:** The Core Backend detects the transition to `ACTIVE` and runs the allocation engine.

### 9.2 The Allocation Algorithm (Weight Splits and Capacity Matching)
For a given investment with capital amount $C$ and risk profile splits $S$:
1. **Split Resolution:** Retrieve risk splits (e.g. 40% HIGH, 30% MEDIUM, 30% LOW). Calculate split amounts (e.g. $C_{HIGH} = 0.40 \times C$).
2. **Pool Selection Query:** For each risk split, query open pools:
   ```sql
   SELECT id, max_transactions, current_transaction_count
   FROM core.pools
   WHERE risk_profile = :split_risk_profile
     AND status = 'OPEN'
     AND current_transaction_count < max_transactions
   ORDER BY (max_transactions - current_transaction_count) DESC, created_at ASC;
   ```
3. **Capacity Validation & Assignment:**
   * If a suitable pool has capacity:
     * Check if allocating the split amount exceeds the pool bounds.
     * Insert a row into `core.investment_pool_allocations` linking the investment to the selected pool.
     * Increment the pool's `current_transaction_count` (enforced via row-level locking `FOR UPDATE` to prevent race conditions).
   * If no open pool has sufficient capacity:
     * Flag the allocation task as `MANUAL_OVERRIDE` in `core.withdrawal_tasks` or spawn a high-priority system notification.
     * Queue the exception in `core.outbox_events` to alert the `SUPER_ADMIN` to create a new pool tier.

