# Titan Funds Platform — Database Models & Data Handling Reference

**Document Type:** Database Model Reference & Data Flow Handbook  
**Target Audience:** Developers, QA engineers, and anyone implementing features against the Titan database  
**Purpose:** Shows every table, every field, every valid state, and exactly how data moves through the database during real operations.

> **Related documents:**  
> — `data_modeling.md` explains *why* we made these design decisions  
> — `schema.sql` contains the raw SQL DDL to create everything  
> — `TECHNICAL_ARCHITECTURE.md` contains the full Mermaid ERD

> **Last reviewed:** Zerodha-style engineering review applied. All P0/P1/P2/P3 fixes from review are reflected in this document and in `schema.sql`.

---

## Schema Overview

```
PostgreSQL (single instance, Docker)
│
├── schema: core          (owned by NestJS Core Backend)
│     ├── admins
│     ├── trading_accounts
│     ├── users
│     ├── user_profiles
│     ├── pools
│     ├── investments
│     ├── investment_risk_splits
│     ├── investment_pool_allocations
│     ├── ledger_entries              ← append-only, never UPDATE/DELETE
│     ├── monthly_balance_snapshots
│     ├── withdrawal_requests
│     ├── withdrawal_tasks
│     ├── outbox_events
│     └── audit_log
│
└── schema: payments       (owned by Go Payments Service)
      └── bank_transactions
      (+ River queue tables — auto-created by River library)
```

**Rule:** No foreign keys or joins cross between `core` and `payments`. They communicate via the outbox pattern only.

---

## Table 1: `core.admins`

Stores internal staff accounts. All admin accounts are created by a SUPER_ADMIN. No self-registration.

| Field | Type | Nullable | Description |
|---|---|---|---|
| `id` | UUID | No | Primary key. Auto-generated. |
| `email` | TEXT | No | Unique. Login identifier. Validated format. |
| `password_hash` | TEXT | No | bcrypt hash. Plaintext password never stored. |
| `role` | ENUM | No | Controls what this admin can see and do. |
| `created_by` | UUID → admins | Yes | Which SUPER_ADMIN created this account. Null only for the first SUPER_ADMIN seeded at setup. |
| `is_active` | BOOLEAN | No | `true` by default. Set to `false` to deactivate without deleting. |
| `last_login_at` | TIMESTAMPTZ | Yes | Updated on every successful login. Used for audit and access monitoring. |
| `deactivated_at` | TIMESTAMPTZ | Yes | **Set when `is_active` transitions to `false`.** Makes the exact time of access removal directly queryable for compliance audits. Without this, the removal timestamp must be dug out of the audit log. |
| `created_at` | TIMESTAMPTZ | No | Immutable. Set once at creation. |

### Admin Roles

| Role | Who Uses It | What It Controls |
|---|---|---|
| `SUPER_ADMIN` | CEO, senior leadership | Full access to everything. Creates other admins. Sees all pools, all admins, all clients. Required for split investment allocations. |
| `POOL_MANAGER` | Staff managing specific trading accounts | Can create and manage their own pools. Can map deposits to their own pools. Cannot see other Pool Managers' data. |
| `FINANCE_APPROVER` | Finance team | Can approve withdrawal tasks. Can initiate outgoing bank transfers. Cannot manage pools or map deposits. |

### Rules
- A SUPER_ADMIN can deactivate any other admin, including another SUPER_ADMIN
- At least two SUPER_ADMINs should be active at all times (different timezones recommended)
- Admin sessions timeout after 30 minutes of inactivity
- All login attempts (success and failure) are written to `core.audit_log`
- 2FA (TOTP) is mandatory for all admin accounts

---

## Table 2: `core.trading_accounts`

Represents the external brokerage or custodian accounts where client capital is actually deployed. This is reference data — it is set up once and pools are linked to it.

| Field | Type | Nullable | Description |
|---|---|---|---|
| `id` | UUID | No | Primary key. |
| `label` | TEXT | No | Human-readable name, e.g. `Account A`, `Account B`. Used in pool naming and UI display. |
| `broker_name` | TEXT | No | Name of the brokerage firm managing this account. |
| `account_number` | TEXT | No | The account number at the broker. For reference only — no live API connection. |
| `is_active` | BOOLEAN | No | Inactive accounts cannot have new pools created against them. |
| `created_at` | TIMESTAMPTZ | No | Immutable. |

### Relationship to Pools
Each pool belongs to one trading account. The pool naming convention is `{ACCOUNT}-{RISK}-{SEQUENCE}` where `ACCOUNT` maps to the trading account label (e.g. `ACCA` for Account A).

---

## Table 3: `core.users`

The authentication record for every client. Separated from personal data intentionally — see `user_profiles`.

| Field | Type | Nullable | Description |
|---|---|---|---|
| `id` | UUID | No | Primary key. The anchor UUID that links all financial records to this person, even after GDPR erasure. |
| `tenant_id` | UUID | No | Multi-tenancy isolation key. Row-Level Security (RLS) enforces that one tenant cannot read another's data. |
| `type` | ENUM | No | `INDIVIDUAL` or `ENTERPRISE`. Determines which profile fields are required. |
| `email` | TEXT | No | Unique. Login identifier. Replaced with `deleted-{hash}@noreply` on GDPR erasure. |
| `password_hash` | TEXT | No | bcrypt hash. |
| `status` | ENUM | No | The user's current position in the onboarding and investment lifecycle. |
| `kyc_status` | ENUM | No | Tracked but not enforced as a gate in V1. Module is designed and pluggable. |
| `created_at` | TIMESTAMPTZ | No | Immutable. |
| `updated_at` | TIMESTAMPTZ | No | Auto-updated by database trigger on every change. |

### User Status State Machine

```
[PENDING_PROFILE]
    │ User submits profile form
    ▼
[PENDING_AGREEMENT]
    │ User scrolls to end + confirms checkbox
    ▼
[PENDING_INVESTMENT]
    │ User selects risk profile, maturity, views deposit instructions
    ▼
[PENDING_DEPOSIT]
    │ Admin maps an inbound bank transaction to this investment
    ▼
[ACTIVE]
    │ Cron job detects investment.maturity_date = today
    │ (Cron MUST filter: AND status = 'ACTIVE' — guard against double-processing on retry)
    ▼
[MATURED]  ← stays here until client acts or admin intervenes
    │ Client withdraws all capital and profit, all withdrawal_tasks = COMPLETED
    ▼
[CLOSED]   ← Investment lifecycle fully complete

From any state:
    Admin action → [SUSPENDED]
    GDPR erasure → [GDPR_ANONYMISED]  ← PII row deleted, users.email anonymised, ledger retained
```

> **Note:** `CLOSED` and `GDPR_ANONYMISED` are in the ENUM. Both were missing in an earlier version of the schema and would have caused a PostgreSQL type error on GDPR erasure attempts.

### KYC Status Values

| Value | Meaning |
|---|---|
| `NOT_STARTED` | Client has not submitted any KYC documents (V1 default — KYC module designed but not activated) |
| `PENDING` | Documents submitted, awaiting verification |
| `APPROVED` | Identity verified |
| `REJECTED` | Verification failed — admin decides next step |

---

## Table 4: `core.user_profiles`

Stores all Personally Identifiable Information (PII). One-to-one with `users`. Kept separate from `users` so that a compromise of the authentication layer does not automatically expose personal data.

| Field | Type | Nullable | Description |
|---|---|---|---|
| `id` | UUID | No | Primary key. |
| `user_id` | UUID → users | No | Unique. One-to-one with users. Cascades delete if user is deleted. |
| `full_name` | TEXT | No | Individual: full legal name. Enterprise: company name. |
| `contact_person` | TEXT | Yes | Enterprise only. Primary contact person's name. |
| `phone` | TEXT | No | Client phone number. |
| `address` | TEXT | No | **AES-256-GCM encrypted** at application layer before storage. Format: `cipher:ciphertext:iv:authtag` |
| `city` | TEXT | No | City of residence/registration. |
| `country` | TEXT | No | Country of residence/registration. |
| `bank_account_number` | TEXT | No | **AES-256-GCM encrypted.** Used for outgoing withdrawal transfers. |
| `bank_routing_info` | TEXT | No | **AES-256-GCM encrypted.** JSON containing IBAN / SWIFT / ABA as applicable. |
| `currency_preference` | TEXT | No | `EUR` default. V1 is EUR-only (CEO confirmed EU scope). Field is pre-built for multi-currency V2. **Default was incorrectly `USD` — corrected to `EUR`.** |
| `created_at` | TIMESTAMPTZ | No | Immutable. |
| `updated_at` | TIMESTAMPTZ | No | Auto-updated by database trigger. |

### How Encrypted Fields Work

Sensitive fields are encrypted at the NestJS application layer **before** reaching PostgreSQL. The stored value is a structured string in this format:

```
cipher:<base64_ciphertext>:<base64_iv>:<base64_authtag>
```

- **Cipher**: always `cipher` — identifies this as an encrypted field, not plaintext
- **Ciphertext**: the AES-256-GCM encrypted value
- **IV**: a fresh 12-byte cryptographically random initialization vector generated uniquely for every write
- **Auth tag**: the GCM authentication tag that proves the ciphertext was not tampered with

The IV is random per write — encrypting the same address twice produces completely different stored values. This prevents statistical frequency analysis attacks.

### On GDPR Erasure

When a client requests data deletion, this entire row is deleted from the database. The parent `users` row is retained (to keep the financial ledger anchor) but is anonymised as described in the `users` table section.

---

## Table 5: `core.pools`

Sub-ledgers that group client investments by risk profile and trading account. Each pool is owned by one admin. The pool naming convention makes every pool self-describing.

| Field | Type | Nullable | Description |
|---|---|---|---|
| `id` | UUID | No | Primary key. |
| `pool_code` | TEXT | No | Unique. Format: `ACCA-HIGH-001`. Auto-suggested, admin can edit. |
| `trading_account_id` | UUID → trading_accounts | No | Which brokerage account this pool's capital is deployed into. |
| `trading_account_label` | TEXT | No | Denormalised copy of the label for display without a join. |
| `risk_profile` | ENUM | No | `LOW`, `MEDIUM`, or `HIGH`. Fixed at creation. Investments can only map to matching risk pools. |
| `maturity_months` | INTEGER | No | `6`, `12`, or `24`. The maturity period this pool serves. |
| `status` | ENUM | No | Current operational state of the pool. |
| `max_transactions` | INTEGER | No | The maximum number of investment allocations this pool can hold. Admin sets this at creation. |
| `current_transaction_count` | INTEGER | No | Starts at 0. Increments on each allocation. Protected by a CHECK constraint. |
| `owned_by` | UUID → admins | Yes | The Pool Manager who manages this pool day-to-day. Can be reassigned by SUPER_ADMIN. |
| `created_by` | UUID → admins | No | Immutable. Records who originally created the pool. |
| `created_at` | TIMESTAMPTZ | No | Immutable. |

### Pool Status Values

| Status | Meaning |
|---|---|
| `OPEN` | Accepting new investment allocations |
| `FULL` | `current_transaction_count = max_transactions`. No new allocations. |
| `CLOSED` | Manually closed by admin. No new allocations. Existing allocations continue. |
| `SUSPENDED` | Temporarily suspended. No new allocations or admin actions. |

### Pool Naming Convention

```
{ACCOUNT}-{RISK}-{SEQUENCE}

ACCA-HIGH-001  → Account A, High Risk, Pool 1
ACCA-HIGH-002  → Account A, High Risk, Pool 2 (overflow when 001 is full)
ACCB-MED-001   → Account B, Medium Risk, Pool 1
ACCC-LOW-001   → Account C, Low Risk, Pool 1
```

When a pool fills, the system recommends creating an overflow pool with the next sequence number. The name is auto-suggested and editable.

### Race Condition Protection

The capacity check uses two layers:
1. **`SELECT ... FOR UPDATE`** — application acquires a row-level write lock on the pool row before reading capacity. Concurrent requests wait.
2. **`CHECK (current_transaction_count <= max_transactions)`** — database constraint rejects any insert or update that would exceed the cap, regardless of what the application does.

---

## Table 6: `core.investments`

Represents a single client investment contract. One user can hold multiple investments simultaneously. Risk profile and maturity are locked once the deposit is confirmed.

| Field | Type | Nullable | Description |
|---|---|---|---|
| `id` | UUID | No | Primary key. |
| `user_id` | UUID → users | No | The client who owns this investment. |
| `pool_id` | UUID → pools | Yes | **Null until admin maps the deposit.** Assigned when investment becomes ACTIVE. |
| `risk_profile` | ENUM | No | `LOW`, `MEDIUM`, or `HIGH`. Fixed at creation by client. |
| `target_return_pct` | NUMERIC(5,2) | No | The target return percentage for this risk level. e.g. `20.00`, `25.00`, `30.00`. |
| `maturity_months` | INTEGER | No | `6`, `12`, or `24`. Fixed at creation by client. |
| `amount_category` | TEXT | No | `20K`, `50K`, `100K`, or `ABOVE_100K`. The deposit size bracket. |
| `start_date` | DATE | Yes | **Null until deposit is confirmed.** Set to the mapping date. |
| `maturity_date` | DATE | Yes | **Null until deposit is confirmed.** Computed as `start_date + maturity_months`. |
| `status` | ENUM | No | Lifecycle stage of this investment. |
| `minimum_capital_floor` | NUMERIC(18,2) | No | The minimum capital that must remain in the investment. Default: 5,000. Admin-adjustable. Waived on full exit. |
| `currency` | TEXT | No | Default `EUR`. The currency for the minimum capital floor. |
| `created_at` | TIMESTAMPTZ | No | Immutable. |
| `updated_at` | TIMESTAMPTZ | No | Auto-updated by trigger. |

### Investment Status Values

| Status | Meaning |
|---|---|
| `PENDING_DEPOSIT` | Investment created. Client has seen deposit instructions. Waiting for bank wire to arrive and be mapped. |
| `ACTIVE` | Deposit confirmed and mapped to a pool. Capital is deployed. Profit can be allocated. |
| `MATURED` | `maturity_date` has passed. Client can withdraw. Investment stays in this state until client acts. |
| `CLOSED` | All capital and profit withdrawn. Investment is complete. |

### Split Investments

When a client deposits and wants different risk profiles (e.g. 40% HIGH / 30% MEDIUM / 30% LOW), the system creates **one investment record per risk slice**. Each investment has its own pool assignment, its own ledger history, and its own withdrawal workflow.

From the client's perspective, they see one total deposit. Internally, it is three separate investments linked by being created in the same onboarding session.

---

## Table 7: `core.investment_risk_splits`

Stores the risk split percentages for investments that are not 100% in a single risk profile. One row per risk slice per investment.

| Field | Type | Nullable | Description |
|---|---|---|---|
| `id` | UUID | No | Primary key. |
| `investment_id` | UUID → investments | No | The parent investment this split belongs to. Cascades delete. |
| `risk_profile` | ENUM | No | Which risk profile this slice represents. |
| `percentage` | NUMERIC(5,2) | No | The percentage of the total deposit going to this risk. e.g. `40.00`. All slices for one investment must sum to 100. |
| `amount` | NUMERIC(18,2) | No | Computed: `percentage × total_deposit / 100`. The actual base currency value for this slice. |
| `currency` | TEXT | No | Default `EUR`. The currency in which the split amount is denominated. |
| `created_at` | TIMESTAMPTZ | No | Immutable. |

### Example: €100,000 deposit with 40/30/30 split

```
investment_id: INV-456 (parent)
  Row 1: risk_profile=HIGH,   percentage=40.00, amount=40000.00
  Row 2: risk_profile=MEDIUM, percentage=30.00, amount=30000.00
  Row 3: risk_profile=LOW,    percentage=30.00, amount=30000.00
```

Three corresponding `investments` rows are created. Each is tracked independently in the ledger.

---

## Table 8: `core.investment_pool_allocations`

The core multi-admin tracking table. When an investment (or risk slice) is allocated to a pool, this table records exactly which pool and which admin holds it. If one investment is split across two admins, there are two rows here.

| Field | Type | Nullable | Description |
|---|---|---|---|
| `id` | UUID | No | Primary key. |
| `investment_id` | UUID → investments | No | Which investment is being allocated. |
| `pool_id` | UUID → pools | No | Which pool it is going into. |
| `owned_by_admin_id` | UUID → admins | No | Which Pool Manager owns this slice. Determines who sees it and who handles withdrawals. |
| `amount` | NUMERIC(18,2) | No | Base currency value allocated to this pool. |
| `currency` | TEXT | No | Default `EUR`. The currency in which the pool allocation is denominated. |
| `percentage` | NUMERIC(5,2) | No | Percentage of the investment total. All rows for one investment must sum to 100. |
| `status` | ENUM | No | Tracks withdrawal state for this specific slice. |
| `allocated_at` | TIMESTAMPTZ | No | When the allocation was confirmed. |
| `allocated_by` | UUID → admins | No | Which SUPER_ADMIN created this allocation. |

> **Integrity rule (enforced by database trigger):** All `investment_pool_allocations` rows for a given `investment_id` must have percentages summing to exactly 100. This mirrors the same rule on `investment_risk_splits`.

### Allocation Status Values

| Status | Meaning |
|---|---|
| `ACTIVE` | Capital is fully deployed in this pool |
| `PARTIALLY_WITHDRAWN` | Some capital has been returned via a withdrawal |
| `FULLY_WITHDRAWN` | All capital from this slice has been returned |

### Example: €100,000 investment across two admins

```
investment_id: INV-456A (HIGH risk)
  Row 1: pool=ACCA-HIGH-001, owned_by=Admin-1, amount=€60,000, pct=60%
  Row 2: pool=ACCB-HIGH-001, owned_by=Admin-2, amount=€40,000, pct=40%
```

Admin 1 sees only Row 1. Admin 2 sees only Row 2. SUPER_ADMIN sees both.

---

## Table 9: `core.ledger_entries`

**The most important table in the system.** The append-only double-entry financial ledger. Every financial event — deposit, profit, reversal, withdrawal, loss, fee, rounding — is recorded here as a new row. Rows are never modified or deleted.

| Field | Type | Nullable | Description |
|---|---|---|---|
| `id` | UUID | No | Primary key. |
| `user_id` | UUID → users | No | The client this entry belongs to. |
| `investment_id` | UUID → investments | Yes | Which investment this entry relates to. |
| `pool_id` | UUID → pools | Yes | Which pool this entry relates to. |
| `entry_type` | ENUM | No | The specific type of financial event. |
| `direction` | ENUM | No | `CREDIT` (money in) or `DEBIT` (money out). |
| `amount` | NUMERIC(18,2) | No | Base currency value of this ledger transaction. Represented in platform base currency. |
| `currency` | TEXT | No | Default `EUR`. The platform base currency at the time of booking. |
| `original_amount` | NUMERIC(18,2) | No | The amount in the client's original currency. Same as `amount` in V1 (EUR only). |
| `original_currency` | TEXT (3 chars) | No | ISO 4217 currency code of the original wire. `EUR` for all V1 transactions. |
| `fx_rate` | NUMERIC(12,6) | No | Exchange rate at time of booking. `1.000000` for V1. Ready for multi-currency V2. |
| `reference_id` | TEXT | No | **Unique.** External bank transaction ID or system-generated idempotency key. Prevents duplicate processing. |
| `status` | ENUM | No | Processing state of this entry. |
| `created_at` | TIMESTAMPTZ | No | **Immutable.** The database trigger blocks any write to this field after creation. |
| `metadata` | JSONB | Yes | Flexible audit data: bank memo, admin notes, source IP, profit period label. |

### Entry Types

| Entry Type | Direction | When It Is Created |
|---|---|---|
| `DEPOSIT` | CREDIT | Admin maps a bank wire to an investment. Confirms the client's capital is received. |
| `PROFIT_ALLOCATION` | CREDIT | Admin enters profit for a pool period. One entry per investor in the pool. Released liquid profit withdrawable by client. |
| `PROFIT_REVERSAL` | DEBIT | Admin reverses an incorrect profit entry. One reversal per original allocation. |
| `ACCRUED_DIVIDEND` | CREDIT | Pool manager enters monthly pool outcome. Automatically split proportionally to all active lot allocations as accrued (locked) dividends. |
| `DIVIDEND_RELEASE` | DEBIT | Created at maturity by cron to zero out the accumulated `ACCRUED_DIVIDEND` balance of the maturing investment. |
| `CAPITAL_LOSS` | DEBIT | Admin enters a negative return for a pool period. Capital decreases. Triggers immediate client email. |
| `CAPITAL_WITHDRAWAL` | DEBIT | Capital successfully returned to a client. Created when withdrawal task reaches `TRANSFER_DONE`. |
| `PROFIT_WITHDRAWAL` | DEBIT | Profit payout successfully completed. |
| `FEE` | DEBIT | Platform fee charged to an investment. |
| `ROUNDING_ADJUSTMENT` | CREDIT or DEBIT | The fractional cent difference from profit distribution. Keeps the books balanced to the exact cent. |

> **Append-only enforcement:** A PostgreSQL trigger (`enforce_ledger_append_only`) blocks any `UPDATE` or `DELETE` on this table at the engine level. The application rule and the trigger both exist — the trigger is the final defence that cannot be bypassed.

### Ledger Status Values

| Status | Meaning |
|---|---|
| `PENDING` | Entry created when bank wire detected. Waiting for admin to map it. |
| `CONFIRMED` | Admin has mapped and confirmed the entry. Counts towards balance. |
| `FAILED` | Processing failed (e.g. bank rejected transfer). Trigger a reversal. |
| `REVERSED` | This entry has been offset by a reversal. Still visible in history. |

### How Balance Is Calculated

Balances are never stored as mutable columns. They are derived from the ledger using the snapshot + delta pattern to optimize query speeds.

#### 1. Total Portfolio Value (Capital + All Profit/Dividends)
This represents the client's entire asset value on the platform, including active capital, monthly accrued dividends, and liquid profits. It is computed as the sum of all confirmed ledger entries:

$$\text{Total Portfolio Value} = \sum(\text{CREDITs}) - \sum(\text{DEBITs})$$

Where all entries for the investment (`DEPOSIT`, `PROFIT_ALLOCATION`, `ACCRUED_DIVIDEND`, `ROUNDING_ADJUSTMENT`) are added as credits, and all debits (`CAPITAL_WITHDRAWAL`, `PROFIT_WITHDRAWAL`, `CAPITAL_LOSS`, `DIVIDEND_RELEASE`, `FEE`) are subtracted. 
*Note: Because `DIVIDEND_RELEASE` (DEBIT) and `PROFIT_ALLOCATION` (CREDIT) are booked in equal amounts upon maturity, their combined effect on this total sum is exactly `$0.00`, ensuring the portfolio value remains continuous and accurate before, during, and after release.*

#### 2. Liquid Withdrawable Profit Balance
This represents profit that the client can actually withdraw (available only at or after maturity). It **excludes** locked, monthly accrued dividends that have not yet reached maturity.

$$\text{Withdrawable Profit} = \sum(\text{PROFIT\_ALLOCATION CREDITs}) + \sum(\text{ROUNDING\_ADJUSTMENT CREDITs}) - \sum(\text{PROFIT\_WITHDRAWAL DEBITs}) - \sum(\text{PROFIT\_REVERSAL DEBITs})$$

By omitting `ACCRUED_DIVIDEND` entries from this query, the accumulated dividends remain completely locked and non-withdrawable. On the maturity date, the release transaction debiting `ACCRUED_DIVIDEND` (via `DIVIDEND_RELEASE`) and crediting `PROFIT_ALLOCATION` instantly migrates the entire accumulated sum into this withdrawable total.

#### 3. High-Speed Query Optimization
To bypass reading millions of historical rows, balance queries start from the latest monthly snapshot:

```
Current Balance = 
    Latest monthly snapshot balance
    +
    SUM of CONFIRMED entries since the start of the current month
      (CREDITs add, DEBITs subtract)
```

This bounds the summation scan to at most 31 days of entries, regardless of account age.

---

## Table 10: `core.monthly_balance_snapshots`

Closing balances captured on the 1st of every month. These are the performance anchor for the balance calculation and the source of data for monthly summary emails.

| Field | Type | Nullable | Description |
|---|---|---|---|
| `id` | UUID | No | Primary key. |
| `investment_id` | UUID → investments | No | Which investment this snapshot is for. |
| `user_id` | UUID → users | No | Denormalised for query efficiency. |
| `snapshot_month` | DATE | No | The first day of the month. e.g. `2025-01-01`. Constrained to always be a month-start date. Unique per investment per month. |
| `snapshot_balance` | NUMERIC(18,2) | No | The total CONFIRMED balance as of the last day of the previous month. |
| `currency` | TEXT | No | Default `EUR`. The currency in which the snapshots are denominated. |
| `created_at` | TIMESTAMPTZ | No | Immutable. When the snapshot was taken. |

### Monthly Cron Sequencing

These snapshots are created by a Go River cron job at **00:01 UTC on the 1st of every month**. The monthly summary email job runs at **08:00 UTC** on the same day. The email job must never run before the snapshot job completes. If the snapshot job fails, the email job is blocked and a SUPER_ADMIN alert fires.

## Table 11: `core.notice_period_config`

Stores the valid notice period configurations for withdrawal requests, allowing dynamic adjustment of tiers (e.g. 15, 30, 45 days) by the CEO without altering the database schema.

| Field | Type | Nullable | Description |
|---|---|---|---|
| `id` | UUID | No | Primary key. |
| `notice_days` | INTEGER | No | Unique. The length of the notice period in days. Used as a FK validation target by `withdrawal_requests`. |
| `label` | TEXT | No | Human-readable label for display, e.g. `Standard (15 days)`. |
| `is_active` | BOOLEAN | No | Inactive configs cannot be chosen for new withdrawal requests. |
| `created_at` | TIMESTAMPTZ | No | Immutable. |

---

## Table 12: `core.withdrawal_requests`

Created when a client submits a withdrawal request. One record per withdrawal request regardless of how many pools are involved.

| Field | Type | Nullable | Description |
|---|---|---|---|
| `id` | UUID | No | Primary key. |
| `user_id` | UUID → users | No | The client requesting withdrawal. |
| `investment_id` | UUID → investments | No | Which investment is being withdrawn from. |
| `type` | ENUM | No | `PROFIT` or `CAPITAL`. Determines which flow applies. |
| `amount_requested` | NUMERIC(18,2) | No | The amount the client wants. Validated against capital floor for CAPITAL type. |
| `currency` | TEXT | No | Default `EUR`. The currency in which the withdrawal is requested. |
| `notice_days` | INTEGER | No | References core.notice_period_config(notice_days). The notice period in days for this withdrawal. |
| `status` | ENUM | No | The current stage in the withdrawal lifecycle. |
| `notice_start_date` | DATE | Yes | Set when status moves to `NOTICE_PERIOD`. |
| `ready_date` | DATE | Yes | Computed: `notice_start_date + notice_days`. The daily cron checks this field. |
| `approved_by` | UUID → admins | Yes | The admin who gave final approval for the overall request. |
| `approved_at` | TIMESTAMPTZ | Yes | When final approval was given. |
| `transfer_reference` | TEXT | Yes | The final outgoing bank transfer reference. Set when the consolidated client transfer completes. |
| `created_at` | TIMESTAMPTZ | No | Immutable. |
| `updated_at` | TIMESTAMPTZ | No | Auto-updated by trigger. |

### Withdrawal Status State Machine

```
[SUBMITTED]
    │ For CAPITAL type: notice period begins
    ▼
[NOTICE_PERIOD]
    │ Daily cron detects ready_date = today
    ▼
[READY_FOR_APPROVAL]
    │ Admin reviews and approves. System generates withdrawal tasks.
    ▼
[TASKS_PENDING]
    │ All withdrawal_tasks reach TRANSFER_DONE
    ▼
[TASKS_COMPLETE]
    │ FINANCE_APPROVER or SUPER_ADMIN initiates consolidated client transfer
    ▼
[COMPLETED]   ← Client receives one email with one transfer reference

From NOTICE_PERIOD:
    Client cancels → [CANCELLED]

From any state:
    Admin cancels → [CANCELLED]

Note: PROFIT withdrawals skip NOTICE_PERIOD for profit amounts.
      Capital withdrawals always go through NOTICE_PERIOD.
```

---

## Table 13: `core.withdrawal_tasks`

One row per pool involved in a withdrawal. When a client's investment spans multiple admin-owned pools, the system auto-generates one task per pool. Each admin sees only their own task.

| Field | Type | Nullable | Description |
|---|---|---|---|
| `id` | UUID | No | Primary key. |
| `withdrawal_request_id` | UUID → withdrawal_requests | No | The parent request this task belongs to. Cascades delete. |
| `pool_id` | UUID → pools | No | Which pool this task sources funds from. |
| `admin_id` | UUID → admins | No | The Pool Manager responsible for this task. |
| `amount` | NUMERIC(18,2) | No | The amount this admin must source from their pool. |
| `currency` | TEXT | No | Default `EUR`. The currency in which this task amount is denominated. |
| `percentage` | NUMERIC(5,2) | No | Their percentage of the total withdrawal. All tasks for one request sum to 100. |
| `status` | ENUM | No | The current state of this individual task. |
| `failure_reason` | TEXT | Yes | Populated when status = `FAILED`. e.g. "Bank rejected IBAN — account closed". |
| `approved_by` | UUID → admins | Yes | Who approved this specific task. |
| `approved_at` | TIMESTAMPTZ | Yes | When this task was approved. |
| `transfer_reference` | TEXT | Yes | The outgoing transfer reference for this pool's contribution. |
| `notes` | TEXT | Yes | Admin notes, e.g. liquidity comments. |
| `created_at` | TIMESTAMPTZ | No | Immutable. |

### Withdrawal Task Status Values

| Status | Meaning |
|---|---|
| `PENDING` | Task created. Admin has been notified. Awaiting action. |
| `ADMIN_APPROVED` | Admin confirmed they can source the funds. Transfer being arranged. |
| `TRANSFER_DONE` | Admin has completed the bank transfer. Reference recorded. |
| `FAILED` | Bank rejected the transfer. `failure_reason` is populated. Reversal entry created in ledger. |

### How the Master Request Progresses

The `withdrawal_request.status` moves from `TASKS_PENDING` to `TASKS_COMPLETE` only when **all** withdrawal tasks for that request have reached `TRANSFER_DONE`. The SUPER_ADMIN can see which specific admin is blocking a withdrawal and can nudge them or override directly.

---

## Table 14: `core.outbox_events`

Stores events that need to trigger downstream actions (emails, notifications, queue jobs). Written in the same database transaction as the ledger entry. Picked up by the Go outbox worker every second.

| Field | Type | Nullable | Description |
|---|---|---|---|
| `id` | UUID | No | Primary key. |
| `event_type` | TEXT | No | Identifies what happened. e.g. `DEPOSIT_PENDING`, `INVESTMENT_ACTIVATED`, `MATURITY_REACHED`, `BACKUP_FAILED`. |
| `payload` | JSONB | No | All data the consumer needs to process this event. e.g. user ID, investment ID, amount, recipient email. |
| `published` | BOOLEAN | No | `false` until the outbox worker picks it up and enqueues it to River. |
| `published_at` | TIMESTAMPTZ | Yes | Set when published. |
| `created_at` | TIMESTAMPTZ | No | Immutable. Used for ordering by the outbox worker. |

### How the Outbox Worker Uses This Table

```
Go outbox worker (every 1 second):
  1. SELECT * FROM core.outbox_events WHERE published = false ORDER BY created_at ASC LIMIT 100
  2. For each event:
       Enqueue job to River queue (inside a database transaction)
       UPDATE core.outbox_events SET published = true, published_at = NOW() WHERE id = ?
```

A partial index on `(created_at) WHERE published = false` makes the poll query instant regardless of how many millions of historical published events exist.

---

## Table 15: `core.audit_log`

Immutable record of every significant action taken by any admin, user, or system process. Append-only like the ledger.

| Field | Type | Nullable | Description |
|---|---|---|---|
| `id` | UUID | No | Primary key. |
| `actor_id` | UUID | No | The admin, user, or system process that performed the action. |
| `actor_type` | ENUM | No | `ADMIN`, `USER`, or `SYSTEM`. |
| `action` | TEXT | No | What happened. e.g. `POOL_CREATED`, `TRANSACTION_MAPPED`, `WITHDRAWAL_APPROVED`, `ADMIN_DEACTIVATED`. |
| `entity_type` | TEXT | No | What kind of record was affected. e.g. `pool`, `ledger_entry`, `withdrawal_request`, `user`. |
| `entity_id` | UUID | No | The specific record that was affected. |
| `before_state` | JSONB | Yes | Snapshot of the record's state before the action. |
| `after_state` | JSONB | Yes | Snapshot of the record's state after the action. |
| `ip_address` | TEXT | Yes | Source IP of the request. |
| `created_at` | TIMESTAMPTZ | No | Immutable. |

### What Generates Audit Entries

- All admin login attempts (success and failure)
- Pool creation, modification, closure, and ownership reassignment
- Every transaction mapping action
- Every profit entry and reversal
- Every withdrawal approval step
- Admin account creation and deactivation
- User account suspension and reinstatement
- GDPR anonymisation actions
- Any SUPER_ADMIN override action

---

## Table 16: `payments.bank_transactions`

Records every bank transaction pulled from the Bank of Ireland AIS (Account Information Service) API. This table is in the `payments` schema, owned exclusively by the Go Payments Service. It has no physical foreign key to any `core` table.

| Field | Type | Nullable | Description |
|---|---|---|---|
| `id` | UUID | No | Primary key. |
| `bank_reference_id` | TEXT | No | **Unique.** The Bank of Ireland's unique identifier for this transaction. Used as the idempotency key to prevent duplicate processing. |
| `amount_eur` | NUMERIC(18,2) | No | The amount received, in EUR. |
| `remitter_name` | TEXT | No | The name of the person or company who sent the wire. |
| `remitter_iban` | TEXT | No | The IBAN the wire came from. |
| `remitter_bic` | TEXT | Yes | The BIC/SWIFT of the remitter's bank. |
| `memo` | TEXT | Yes | The payment reference/memo field. Should contain the client's investment reference code. |
| `value_date` | DATE | No | The date the funds were valued by the bank. |
| `status` | ENUM | No | Whether this transaction has been matched to an investment. |
| `mapped_ledger_entry_id` | UUID | Yes | **Soft reference only — no FK constraint.** Stores the `core.ledger_entries.id` once mapped. No database constraint enforces this link to preserve schema decoupling. |
| `created_at` | TIMESTAMPTZ | No | Immutable. When this record was created by the polling job. |
| `updated_at` | TIMESTAMPTZ | No | Auto-updated by trigger. |

### Bank Transaction Status Values

| Status | Meaning |
|---|---|
| `PENDING` | Transaction detected by polling. Placed in admin's pending deposits queue. Not yet linked to an investment. |
| `MAPPED` | Admin has successfully linked this transaction to a client investment. `mapped_ledger_entry_id` is set. |
| `UNMAPPED` | Cannot be matched to any investment reference. In the unmatched deposits queue. |
| `IGNORED` | Admin has decided this transaction does not relate to a client investment (e.g. a bank fee or internal transfer). |

### How Bank Polling Works

```
Go Payments Service cron (every 3 minutes via River):
  1. Call BOI AIS API → GET /accounts/{id}/transactions (last 5 minutes, CREDIT direction)
  2. For each transaction in the API response:
       Check: does this bank_reference_id already exist in payments.bank_transactions?
       If yes → skip (idempotency guard)
       If no  → INSERT into payments.bank_transactions with status=PENDING
                INSERT into core.outbox_events (DEPOSIT_PENDING) in same transaction
  3. Go outbox worker picks up DEPOSIT_PENDING event → emails admin
```

---

## Data Flow 1: Client Deposit End-to-End

This shows exactly which records are created and how their states change during a deposit.

```
CLIENT WIRE ARRIVES AT BANK
        │
        ▼
[Go cron polls BOI every 3 minutes]
        │
        ├── CREATE payments.bank_transactions (status=PENDING)
        └── CREATE core.outbox_events (DEPOSIT_PENDING)
              ↑ Both in one transaction — atomic
        │
        ▼
[Go outbox worker picks up event]
        │
        └── Email admin: "New deposit — User reference: USER-123-INV-456"
        │
        ▼
[Admin logs into portal, sees pending deposit]
        │
[Admin clicks "Map Transaction"]
        │ NestJS Core Backend:
        ├── SELECT pool FOR UPDATE  (acquires row lock — no race condition)
        ├── INSERT core.investment_pool_allocations (amount, pool, admin)
        ├── UPDATE core.ledger_entries.status = CONFIRMED  (the PENDING entry becomes confirmed)
        ├── UPDATE core.investments.status = ACTIVE, start_date = today, maturity_date = today + months
        ├── UPDATE core.pools.current_transaction_count + 1
        └── INSERT core.outbox_events (INVESTMENT_ACTIVATED)
              ↑ All in one transaction — if anything fails, nothing commits
        │
        ▼
[Go outbox worker picks up INVESTMENT_ACTIVATED event]
        │
        └── Email client: "Your deposit is confirmed. Investment active. Maturity date: [date]"
```

---

## Data Flow 2: Monthly Profit Entry and Distribution

```
ADMIN NAVIGATES TO POOL → CLICKS "ENTER PROFIT"
        │
        ▼
Admin enters: Period = "Q1 2025", Total profit = €10,000
        │
[System calculates distribution — Largest Remainder Method]
        │
        ├── Find all active investment_pool_allocations for this pool
        ├── For each investor: raw_share = (their_amount / pool_total) × profit
        ├── Floor each share to 2 decimal places
        ├── Rank by fractional loss — distribute remaining cents one at a time
        │   Tiebreaker: oldest investor (earliest created_at) gets the cent
        └── Build preview table: User | Capital | % | Profit Allocated
        │
        ▼
[Admin sees preview and clicks "Confirm & Book"]
        │
        ├── For each investor:
        │     INSERT core.ledger_entries (
        │       entry_type=PROFIT_ALLOCATION,
        │       direction=CREDIT,
        │       amount=their_share
        │     )
        │
        ├── If rounding adjustment exists:
        │     INSERT core.ledger_entries (entry_type=ROUNDING_ADJUSTMENT)
        │
        └── INSERT core.outbox_events (PROFIT_ALLOCATED) for each affected user
              ↑ All in one transaction
        │
        ▼
[Go outbox worker processes events]
        │
        └── Email each client: "Profit allocated for Q1 2025 — €X added to your investment"
```

---

## Data Flow 3: Capital Withdrawal with Multiple Admins

```
CLIENT REQUESTS CAPITAL WITHDRAWAL (€100,000 from HIGH risk investment)
        │
[NestJS creates withdrawal_request]
        ├── INSERT core.withdrawal_requests (type=CAPITAL, status=SUBMITTED)
        └── System generates withdrawal tasks automatically:
              Reads investment_pool_allocations for this investment:
                Pool ACCA-HIGH-001 (Admin 1) → 60% → €60,000
                Pool ACCB-HIGH-001 (Admin 2) → 40% → €40,000
              INSERT core.withdrawal_tasks (Admin 1, €60K, status=PENDING)
              INSERT core.withdrawal_tasks (Admin 2, €40K, status=PENDING)
              UPDATE core.withdrawal_requests.status = NOTICE_PERIOD
        │
        ▼
[Daily cron at 00:01 UTC checks: ready_date = today?]
        │ When notice period expires:
        └── UPDATE withdrawal_request.status = READY_FOR_APPROVAL
            INSERT core.outbox_events (WITHDRAWAL_READY_FOR_APPROVAL)
        │
        ▼
[Admin 1 logs in, sees their task: "Source €60,000 from ACCA-HIGH-001"]
        │
        ├── Admin 1 initiates bank transfer of €60,000
        ├── Records transfer reference in the system
        └── UPDATE withdrawal_task.status = TRANSFER_DONE (Admin 1's task)
        │
[Admin 2 does the same for their €40,000 task]
        │
[System detects ALL tasks for withdrawal_request = TRANSFER_DONE]
        │
        └── UPDATE withdrawal_request.status = TASKS_COMPLETE
        │
[FINANCE_APPROVER initiates consolidated client transfer (€100,000 total)]
        │
        ├── INSERT core.ledger_entries (entry_type=CAPITAL_WITHDRAWAL, direction=DEBIT, amount=100000)
        ├── UPDATE withdrawal_request.status = COMPLETED
        ├── UPDATE withdrawal_request.transfer_reference = "TRF-FINAL-XXX"
        └── INSERT core.outbox_events (WITHDRAWAL_COMPLETED)
        │
[Go outbox worker]
        └── Email client: "Your withdrawal of €100,000 is complete. Reference: TRF-FINAL-XXX"
```

---

## Data Flow 4: GDPR Erasure Request

```
CLIENT SUBMITS GDPR RIGHT-TO-ERASURE REQUEST
        │
[NestJS executes in single transaction]
        │
        ├── DELETE core.user_profiles WHERE user_id = ?
        │     (destroys: full_name, phone, address ciphertext, bank details)
        │
        ├── UPDATE core.users SET
        │     email = 'deleted-{sha256hash}@noreply',
        │     status = 'GDPR_ANONYMISED'
        │   WHERE id = ?
        │
        └── [Everything else stays untouched]
              core.ledger_entries    → retained (financial law)
              core.investments       → retained (financial audit trail)
              core.withdrawal_*      → retained (financial audit trail)
              core.audit_log         → retained (actor_id preserved, but name mapping severed)
        │
        ▼
INSERT core.audit_log (action=GDPR_ERASURE_COMPLETED, entity_type=user, entity_id=?)
        │
        ▼
Result:
  ✅ GDPR satisfied — all PII permanently destroyed
  ✅ Financial law satisfied — all transaction history intact
  ✅ The ledger_entries still exist under the user UUID
  ❌ No way to trace which person's entries they are from the database alone
```

---

## Data Flow 5: Monthly Snapshot and Summary Email

```
1ST OF EVERY MONTH — 00:01 UTC
[Go River cron: Snapshot Job]
        │
        ├── For every investment WHERE status IN (ACTIVE, MATURED):
        │     Calculate balance: last snapshot + current month delta
        │     INSERT core.monthly_balance_snapshots (
        │       investment_id, user_id,
        │       snapshot_month = first day of THIS month,
        │       snapshot_balance_usd = balance as of last day of PREVIOUS month
        │     )
        │
        ├── Job completes successfully → marks complete in River
        │
        └── IF job fails → INSERT core.outbox_events (SNAPSHOT_JOB_FAILED)
                           → Email SUPER_ADMIN: "Monthly snapshot failed — email job blocked"
        │
        ▼
1ST OF EVERY MONTH — 08:00 UTC
[Go River cron: Monthly Summary Email Job]
        │
        ├── Reads freshly created snapshots
        ├── For each ACTIVE client:
        │     Build email: capital deployed, profit to date, maturity countdowns
        └── INSERT core.outbox_events (MONTHLY_SUMMARY) per client
        │
[Go outbox worker processes events]
        └── Email each client their monthly summary
```

---

## Key Constraints Reference

A quick reference to the database-enforced rules that protect data integrity:

| Constraint | Table | What It Enforces |
|---|---|---|
| `UNIQUE (email)` | `users` | No two accounts share the same email |
| `UNIQUE (user_id)` | `user_profiles` | One profile per user — strict 1:1 |
| `UNIQUE (pool_code)` | `pools` | No duplicate pool codes |
| `CHECK (current_transaction_count <= max_transactions)` | `pools` | Pool cannot exceed capacity — enforced alongside `SELECT FOR UPDATE` app-level lock |
| `UNIQUE (reference_id)` | `ledger_entries` | No duplicate bank transactions processed — idempotency key |
| `UNIQUE (investment_id, snapshot_month)` | `monthly_balance_snapshots` | One snapshot per investment per month — prevents cron double-firing |
| `UNIQUE (bank_reference_id)` | `payments.bank_transactions` | BOI polling cannot create duplicate records |
| `CHECK (snapshot_month = date_trunc('month', snapshot_month))` | `monthly_balance_snapshots` | Snapshots must always be the first day of a month |
| `CHECK (maturity_months IN (6, 12, 24))` | `investments`, `pools` | Only valid maturity periods |
| FK Reference (notice_days) | `withdrawal_requests` | Validates that notice period matches an active record in `notice_period_config` table (Issue 6 Fix) |
| TRIGGER: `enforce_ledger_append_only` | `ledger_entries` | Blocks all UPDATE and DELETE at engine level — cannot be bypassed by any code path |
| TRIGGER: `enforce_risk_splits_sum` | `investment_risk_splits` | Mid-transaction check: blocks split updates/inserts exceeding 100% |
| TRIGGER: `enforce_risk_splits_complete` | `investment_risk_splits` | Commit-time deferred check: enforces splits sum to exactly 100% (Issue 1 Fix) |
| TRIGGER: `enforce_withdrawal_tasks_sum` | `withdrawal_tasks` | Mid-transaction check: blocks task updates/inserts exceeding 100% |
| TRIGGER: `enforce_withdrawal_tasks_complete` | `withdrawal_tasks` | Commit-time deferred check: enforces tasks sum to exactly 100% (Issue 2 Fix) |
| TRIGGER: auto-update `updated_at` | All mutable tables | Timestamps always reflect last change |

---

## Index Strategy Summary

| Index | Type | Purpose |
|---|---|---|
| All FK columns | B-Tree | Eliminates full scans on parent cascades and joins |
| `ledger_entries(investment_id, status, created_at) INCLUDE (amount, direction)` | Covered index | Balance calculations never touch the heap — Index-Only Scan |
| `monthly_balance_snapshots(investment_id, snapshot_month DESC)` | Composite descending | Latest snapshot lookup in under 1ms |
| `outbox_events(created_at) WHERE published = false` | Partial index | Outbox worker poll stays fast as historical rows accumulate |
| `bank_transactions(status, bank_reference_id) INCLUDE (amount_eur, value_date)` | Covered index | Reconciliation queries without heap fetch |
| `audit_log(actor_id, created_at DESC)` *(P1 fix)* | B-Tree composite | Admin activity panel query — "show me all actions by admin X" |
| `audit_log(entity_id, entity_type, created_at DESC)` *(P1 fix)* | B-Tree composite | Compliance drill-down — "show me all events affecting this investment/user" |
| `pools(trading_account_id, status)` *(P3 fix)* | B-Tree composite | Pool list view filters by account + status on every admin page load |
| `withdrawal_requests(status, ready_date) WHERE status IN (...)` *(P2 fix)* | Partial composite | Daily cron and admin withdrawal queue — only scans open requests, not completed history |
| `investments(maturity_date, status) WHERE status = 'ACTIVE'` *(P2 fix)* | Partial composite | Maturity cron — only scans active investments, not closed or matured history |
