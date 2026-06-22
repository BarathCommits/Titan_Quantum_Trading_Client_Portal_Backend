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

-- D2. ONBOARDING DRAFTS TABLE (Temporary progress save)
CREATE TABLE core.onboarding_drafts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID UNIQUE NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE core.onboarding_drafts IS 'Temporary JSON storage of client profile onboarding drafts before final submission.';

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
    minimum_capital_floor NUMERIC(18,4) NOT NULL DEFAULT 5000.0000 CHECK (minimum_capital_floor >= 0.0000),
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
    amount NUMERIC(18,4) NOT NULL CHECK (amount >= 0.0000),
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
    amount NUMERIC(18,4) NOT NULL CHECK (amount > 0.0000),
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
    amount NUMERIC(18,4) NOT NULL CHECK (amount >= 0.0000),
    currency TEXT NOT NULL DEFAULT 'EUR' CHECK (length(currency) = 3), -- Neutral amount column structure
    original_amount NUMERIC(18,4) NOT NULL CHECK (original_amount >= 0.0000),
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
    snapshot_balance NUMERIC(18,4) NOT NULL,
    currency TEXT NOT NULL DEFAULT 'EUR' CHECK (length(currency) = 3), -- Neutral amount column structure
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (investment_id, snapshot_month)
);

COMMENT ON TABLE core.monthly_balance_snapshots IS 'End-of-month closing balance aggregations. Bounds dynamic summation scans to a maximum of 31 days.';

-- K1. NOTICE PERIOD CONFIGURATION TABLE (Allows dynamic tiers without DDL migrations - Issue 6 fix)
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
    amount_requested NUMERIC(18,4) NOT NULL CHECK (amount_requested > 0.0000),
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
    amount NUMERIC(18,4) NOT NULL CHECK (amount > 0.0000),
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
    amount_eur NUMERIC(18,4) NOT NULL,
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
-- idx_pools_trading_account_id removed (Issue 7 Fix: redundant as idx_pools_account_status leading column covers this)
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
INCLUDE (amount, direction); -- Updated amount_usd to amount

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

-- C. Decoupled Schema Auto-Update Trigger Function (Issue 3 Fix: isolates payments from core)
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
    RAISE EXCEPTION 'INTEGRITY ERROR: Risk split percentages for investment_id=% exceed 100%%. Current total: %%%', NEW.investment_id, total_pct;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_risk_splits_sum
AFTER INSERT OR UPDATE ON core.investment_risk_splits
FOR EACH ROW EXECUTE FUNCTION core.validate_risk_splits_sum();

-- Commit-Time Guard (Issue 1 Fix: checks SUM = 100 at commit time deferred)
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
    RAISE EXCEPTION 'INTEGRITY ERROR: Risk splits for investment_id=% must sum to exactly 100.00%%. Current total: %%%', NEW.investment_id, total_pct;
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
    RAISE EXCEPTION 'INTEGRITY ERROR: Withdrawal task percentages for request_id=% exceed 100%%. Current total: %%%', NEW.withdrawal_request_id, total_pct;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_withdrawal_tasks_sum
AFTER INSERT OR UPDATE ON core.withdrawal_tasks
FOR EACH ROW EXECUTE FUNCTION core.validate_withdrawal_tasks_sum();

-- Commit-Time Guard (Issue 2 Fix: checks SUM = 100 at commit time deferred)
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
    RAISE EXCEPTION 'INTEGRITY ERROR: Withdrawal tasks for request_id=% must sum to exactly 100.00%%. Current total: %%%', NEW.withdrawal_request_id, total_pct;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER enforce_withdrawal_tasks_complete
AFTER INSERT OR UPDATE ON core.withdrawal_tasks
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION core.validate_withdrawal_tasks_complete();


-- ============================================================================
-- 6. ROW LEVEL SECURITY (RLS) POLICIES (Tenant Isolation - Issue 5 Fix)
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
ALTER TABLE core.onboarding_drafts ENABLE ROW LEVEL SECURITY;

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

-- B2. Onboarding Drafts Tenant Isolation Policy
CREATE POLICY tenant_isolation_policy ON core.onboarding_drafts
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
