# Titan Funds Platform — Data Modeling & Database Design Decisions

**Document Type:** Architecture Decision Record (ADR) & Onboarding Guide  
**Source of Truth:** This document was written directly from `final_system_desgin.md`, the master system design authored by Balaji Segu Krishnaiah & Sai Shreyas G H.  
**Target Audience:** New engineers joining the team, future architects, database administrators, security auditors  
**Purpose:** To explain *why* the database is structured the way it is — the reasoning, trade-offs, constraints, and decisions made during V1 design. This is not a technical reference. It is a thinking record.

> If you are a new engineer reading this: by the end of this document you should understand not just *what* the database looks like, but *why every major decision was made*, what alternatives were considered, what problems were fixed, and what rules you must never break.

---

## 1. What This Platform Actually Does (and Does Not Do)

Before understanding any database decision, you need to understand what Titan is and is not.

**Titan is a funds aggregation, tracking, and administration platform.** It tracks money in, money out, and performance reporting for client investments. That is all.

**No trading logic lives in this platform.** All trading is handled externally by the firm's brokers and quants who operate completely outside this system. Titan does not place trades, connect to markets, or make any investment decisions. Its sole job is to record what happens with client money and give clients and admins a clear view of it.

This distinction matters enormously for data design. Because we are not a trading system, we do not need tick data, order books, or real-time pricing. But because we do handle real client money and are subject to European financial regulations, every design decision around the database had to be made with audit integrity, GDPR compliance, and financial record-keeping requirements as the primary constraints — not performance optimisation or developer convenience.

---

## 2. The Five Constraints That Drove Every Decision

Everything in the database design flows from these five realities:

**1. Money cannot be edited.**  
Every cent must be traceable back to a source event. If a balance is wrong, you cannot fix it by updating a number. You must add a new correction record so the full history of how that balance was reached remains visible. Regulators and auditors will always ask: *show me every transaction that led to this balance.*

**2. Personal data must be protected but also retained.**  
We hold client names, home addresses, phone numbers, bank account numbers, and IBANs. A database breach cannot expose these. At the same time, European AML/CFT laws require keeping financial records for 6–7 years. These two requirements pull in opposite directions and must both be satisfied simultaneously.

**3. The system must stay within €20/month infrastructure cost.**  
The CEO mandated a €20/month ceiling. Every database design choice — removing Redis, keeping a single PostgreSQL instance, using PostgreSQL as the job queue — was shaped by this constraint. Elegant solutions that cost more money were rejected, and simpler solutions that fit the budget were chosen deliberately.

**4. 100–500 clients in V1 but must scale cleanly to V3.**  
The system is being designed for a small initial scale. But the database schema and service boundaries must not paint us into a corner. Decisions that would require rewrites when we grow were avoided from the start.

**5. Multiple admins manage different portions of client money.**  
Different pool managers own different slices of client capital. The database must track exactly which dollar is in which pool owned by which admin, while maintaining a clean view for clients who only care about their total.

---

## 3. Why We Went from 8 Services to 3

The initial design had 8 microservices. Through design review, this was consolidated to 4, and finally to 3. Understanding why matters for the data design because the service boundaries directly define which tables belong where.

The consolidation principle was: **services that share the same reason to change, the same data boundaries, and the same security profile should live together.**

The final 3 services are:

**Payments & Notifications (Go, Port 3003)** — Bank polling, email sending, background job queue, all cron jobs. These are in Go because they are network I/O bound and benefit from Go's concurrency model. They are grouped together because payments always trigger notifications — they are two halves of the same event loop. The critical security reason: the Bank of Ireland API credentials, eIDAS certificates, and SMTP tokens live *only* in this container. A security breach in the public-facing frontend or the core backend cannot touch these credentials.

**Core Backend Monolith (NestJS, Port 3000)** — Identity, profiles, ledger, pool capacity checks, admin RBAC. These are grouped together because enforcing ACID compliance on ledger allocations and pool boundaries is vastly simpler when everything happens in a single backend context. Distributed transactions across multiple services for financial operations introduce too much complexity and risk.

**Frontend UI (Next.js, Port 3001)** — Client dashboard and admin portal screens. Completely decoupled from the database. Frontend developers can push UI changes without touching the backend. A security compromise on the presentation layer cannot affect the ledger or database credentials.

Everything runs on a single Hetzner CX32 server (€6.80/month) and uses approximately 1.17 GB of the 8 GB available RAM, leaving 6.83 GB of headroom (allowing the platform to safely handle database/garbage collection memory spikes).

---

## 4. The Database: One Instance, Two Schemas, Zero Cross-Schema Joins

### The Core Decision

We run one PostgreSQL instance shared by all services, but the tables are split into two completely isolated logical namespaces:

- **`core` schema** — owned exclusively by the NestJS Core Backend. Contains: users, profiles, investments, risk splits, ledger entries, balance snapshots, pools, pool allocations, withdrawal requests, withdrawal tasks, outbox events, admins, trading accounts, and the audit log.
- **`payments` schema** — owned exclusively by the Go Payments Service. Contains: bank transaction records pulled from the Bank of Ireland API, and the River queue job tables (created automatically by the River library).

### The Rule That Cannot Be Broken

There are **zero physical foreign key constraints** between `core` and `payments`. No join query in any application code crosses this schema boundary. If the Go service needs to associate a bank wire with a ledger entry, it stores the ledger entry's UUID as a plain text column with no database constraint enforcing the link. This is called a soft reference.

### Why This Rule Exists

In V1 we cannot afford two separate database servers. But in V3, when the platform has grown significantly, the payments service may need its own dedicated database to handle the polling load. If we had built cross-schema foreign keys or joins into the design, migrating would require rewriting large portions of both services' database queries — a painful and risky operation on a live financial system.

Because we enforced zero coupling from the start, moving `payments` to its own PostgreSQL server in V3 is a pure infrastructure operation. No application code needs to change.

Think of it as building two self-contained apartments inside a shared house. If you ever need to split into two separate houses, the apartments just move — nothing inside them needs to be rebuilt.

### Why Not Two Separate Database Instances from Day One?

Because two PostgreSQL instances on Hetzner would cost approximately twice as much and add operational complexity (two backup jobs, two connection strings, two maintenance schedules) with zero benefit at 100-user scale. When load proves the need, the schema decoupling makes the split trivial.

---

## 5. Multi-Tenancy: Row-Level Security at the Database Layer

The platform is multi-tenant. A `tenant_id` column exists on every user-owned table. PostgreSQL Row-Level Security (RLS) policies enforce that one tenant cannot read another's data.

The key decision here: **data isolation is enforced at the database layer, not just the application layer.**

This matters because application-level isolation can have bugs. A routing error, an incorrect query parameter, or a future code change could accidentally expose one client's data to another if the only protection is in the application. PostgreSQL RLS enforces the boundary at the database engine level. Even if a bug exists in the application code, the database rejects the query before returning any data.

Each database session sets a `app.current_tenant_id` session variable when a connection is opened. The RLS policy checks that any row returned matches the session's tenant ID. A bug that forgets to set this variable gets an empty result set, not another tenant's data.

---

## 6. The User State Machine

Understanding the user status states is essential because the database flow and the admin workflows all depend on which state a user is in.

A user progresses through these states in sequence:

`PENDING_PROFILE` → `PENDING_AGREEMENT` → `PENDING_INVESTMENT` → `PENDING_DEPOSIT` → `ACTIVE` → `MATURED` → `CLOSED`

At any point, a SUPER_ADMIN can move a user to `SUSPENDED`. A GDPR erasure request moves them to `GDPR_ANONYMISED` (PII removed, financial records retained — see Section 10).

The `PENDING_DEPOSIT` state is particularly important for the database: an investment exists in the database but is not yet active. The admin has not yet mapped a bank transaction to it. The pool is not yet assigned. The ledger entry for the deposit is in `PENDING` status. The database must hold this incomplete state cleanly without creating any partial financial records.

Post-maturity behaviour: the investment stays in `MATURED` indefinitely until the client acts or the admin intervenes. It does not auto-renew. The CEO needs to confirm whether matured investments should auto-renew after a period of inaction — this is an open item that will affect the state machine.

---

## 7. The Ledger: The Most Important Table in the System

### What the Ledger Is

`core.ledger_entries` is the financial record of everything that happens with money on this platform. It is a **double-entry, append-only ledger** — the same fundamental concept used by banks and accounting systems for centuries.

Every financial event — a deposit, a profit allocation, a reversal, a capital loss, a withdrawal, a rounding adjustment — is recorded as a new row. Rows are never modified. Rows are never deleted.

### Why Append-Only

The alternative — storing a running balance as a mutable column (e.g. `balance = balance + $10,000`) — destroys auditability. You can see the current number but not how it was reached. Regulatory auditors will always want the full history, not just the result.

With an append-only ledger, a balance is derived by replaying all credits and debits. This means:
- Every balance can be traced transaction by transaction
- Mistakes cannot erase history — they are corrected by adding new correction entries
- The history is permanent and tamper-evident

This approach is not invented here. It is how financial accounting has worked for centuries. We followed it because it is proven.

### Why Balance Is Never Stored

A stored balance column is always at risk of drifting out of sync with the ledger history. If a bug writes to one but not the other, the stored balance becomes wrong and the ledger history is correct — but now you have a disagreement and no easy way to know which one to trust.

By deriving balance from the ledger every time, there is only one source of truth. The derivation is deterministic. Given the same ledger history, you always get the same balance.

### The Direction Field

Each ledger entry has a direction: CREDIT (money coming in) or DEBIT (money going out). The current balance is calculated as sum of credits minus sum of debits. This mirrors standard double-entry bookkeeping.

### Why There Are Eight Distinct Entry Types

Having a single generic "TRANSACTION" type would make reporting and auditing impossible. Each type exists for a specific business and regulatory reason:

- **DEPOSIT** — the origin event. The client's capital entering the system. Auditors need to trace every balance back to a deposit event.
- **PROFIT_ALLOCATION** — an admin books profit for a pool period. Must be traceable per admin, per pool, per period.
- **PROFIT_REVERSAL** — corrects an incorrect profit entry. Never edits the original. Creates a new debit that cancels it out.
- **CAPITAL_LOSS** — if a trading period results in a genuine loss. Creates an explicit record so clients are notified and the balance reduction is clearly labelled.
- **CAPITAL_WITHDRAWAL** — principal returned to a client. Distinguished from profit for tax and regulatory reporting.
- **PROFIT_WITHDRAWAL** — profit paid out. Kept separate from capital withdrawal for the same reason.
- **FEE** — any platform charge. Regulatory disclosure requires explicit fee records.
- **ROUNDING_ADJUSTMENT** — the fractional cent difference from profit distribution (see Section 8). Keeps the audit trail clean.

### How Ledger Immutability Is Enforced

We do not trust the application layer alone to never modify ledger entries. A PostgreSQL trigger blocks any `UPDATE` or `DELETE` operation on `core.ledger_entries` at the database engine level. If any code — from the application, from a database admin tool, or from an SQL injection attack — attempts to modify an existing ledger row, the database raises an exception and blocks the operation.

The application rule and the database trigger both exist. The trigger is the final defence that cannot be bypassed.

---

## 8. Fix 1: The Penny Problem and the Largest Remainder Method

This was formally identified as Critical Engineering Fix 1 during the design review. It is the most subtle financial correctness issue in the system.

### The Problem

When profit is distributed across a pool proportionally by each investor's capital stake, simple division produces fractional cents. 

Example from the design document: three equal investors, $10.00 profit pool. Each investor's raw share is $3.3333... Simple rounding gives each $3.33. Total distributed: $9.99. The $0.01 is orphaned — no account receives it. The books do not balance. Every reconciliation run flags a discrepancy.

At small scale this seems trivial. At scale across hundreds of pools and thousands of distribution periods, it compounds into meaningful unaccounted amounts that fail regulatory audits.

### The Solution: Largest Remainder Method

The profit distribution algorithm, documented explicitly in Section 9.5 of the master design, works as follows:

1. Calculate each investor's raw share by multiplying their capital percentage by the total pool profit
2. Floor each share to exactly 4 decimal places (not round — floor)
3. Sum all floored shares — they will total slightly less than the pool profit due to the flooring
4. Rank investors by the size of their fractional loss (the difference between their raw share and their floored share), largest first
5. Distribute the remaining units (at the 4th decimal place) one at a time to the top-ranked investors
6. In case of a tie in fractional loss, the oldest investor (earliest `created_at`) receives the cent

The design document gives the concrete example: Alice (oldest), Bob, and Carol each have equal stakes in a $10.00 profit pool. All get floored to $3.33, leaving $0.01 unallocated. Alice gets the cent by tiebreaker rule. Final distribution: $3.34 + $3.33 + $3.33 = $10.00 exactly.

If after applying the Largest Remainder Method any residual still exists (this should not happen with correct implementation, but as an audit safety net), a `ROUNDING_ADJUSTMENT` ledger entry is created. This makes the adjustment explicit and visible in the audit trail rather than silently absorbed.

### Why the Tiebreaker Is "Oldest Investor"

The oldest investor being chosen as the tiebreaker is deterministic — given the same inputs, the algorithm always produces the same output. Any consistent tiebreaker would work, but "oldest investor" has an intuitive fairness argument (they have been in the pool longest) and is easily auditable.

---

## 9. Fix 2: The Transactional Outbox and Why There Is No Redis

### The Problem (Dual-Write Drift)

This was formally identified as Critical Engineering Fix 2. Consider the most critical path in the system: a client wires money, the bank polling detects it, and the system needs to both record the ledger entry and notify an admin.

If we write the ledger entry to PostgreSQL and then publish a notification event to a separate queue service (like Redis or RabbitMQ), these are two separate operations. If the application crashes, the network fails, or the queue service is temporarily unavailable between these two operations, the deposit is recorded in the ledger but the admin never gets notified, and the investment is never activated. Money sits unprocessed with no alert.

This is called Dual-Write Drift. It is a silent failure on the most critical path in the system.

### Fix 6 Connection: Why Not Go Channels

Go channels (in-memory queues) were considered but rejected, also documented as Critical Engineering Fix 6. Go channels are fast but volatile — if the Go Payments Service crashes during a CI/CD deployment or unexpected error, everything in the channel is permanently lost. A client could wire money, the bank confirm it, the system detect it, enqueue a processing event to a Go channel, and then a deployment restarts the service — the event is gone. The money sits unrecorded with no alert.

### The Solution: Transactional Outbox + River Queue

Every event that triggers a downstream action is written to `core.outbox_events` **inside the same database transaction** as the ledger entry. If the transaction commits, both the ledger entry and the outbox event are committed atomically. If the transaction rolls back, both roll back. They cannot be out of sync.

The Go outbox worker runs inside the Payments Service and polls the outbox table every second. It picks up unpublished events, enqueues them as jobs in the River queue (which stores jobs in the same PostgreSQL database), and marks them as published. If the Go service crashes between polling and publishing, the events are still in the outbox with `published = false`. When the service restarts, the worker picks them up immediately.

River stores its jobs in PostgreSQL tables, protected by the same Write-Ahead Logging (WAL) guarantees as the ledger. Financial events cannot be lost without losing the entire database.

### Why This Eliminates the Need for Redis

Redis was removed from the architecture entirely. It would have cost approximately 150 MB of RAM and an additional container. Since River is backed by PostgreSQL which already runs for the ledger, the job queue costs nothing additional. Sessions are stateless JWT (no session store needed). Rate limiting is handled in-memory by the application services. The €20/month ceiling is preserved.

---

## 10. Fix 3: Pool Capacity Race Condition

### The Problem

This was Critical Engineering Fix 3. When a pool has one remaining slot and two admins try to map deposits simultaneously, both read the current count, both see one slot remaining, both proceed — and the pool ends up with more investments than its `max_transactions` limit allows.

This breaks pool integrity. More clients are mapped than the trading account is designed to support.

### The Two-Layer Fix

Both layers work together because one alone is insufficient:

**Application layer** — before attempting to map a transaction, the Core Backend queries the pool with a `SELECT ... FOR UPDATE` row lock. The `FOR UPDATE` clause prevents any other session from reading or modifying that pool row until the current transaction commits or rolls back. The second concurrent request must wait until the first completes before it can read the current count.

**Database layer** — a `CHECK` constraint on the pools table prevents `current_transaction_count` from ever exceeding `max_transactions`, regardless of what the application does. Even if the application lock is somehow bypassed (a bug, a direct database connection, a future code change that forgets the lock), the database constraint is the final barrier that cannot be crossed.

The application lock is fast and avoids unnecessary constraint violations. The database constraint is the unfoolable last line of defence.

---

## 11. Fix 4: Encryption Key Management

### The Problem

AES-256 encryption of PII columns is correct. But storing the encryption key in a Docker environment variable or any hosting dashboard means anyone with server access or dashboard access can see the key. One compromised admin account exposes every client's bank details.

### The Fix: Doppler

The AES-256 encryption key lives only in Doppler, a secrets management service. It is injected into the container runtime when the service starts and is never written to disk, never visible in any configuration dashboard, and is fully audit-logged. Docker environment variables are used only for non-sensitive configuration (port numbers, log levels).

When the platform grows to V3, the plan is to migrate to AWS KMS for hardware-backed key management.

### Why the PII Encryption Format Includes a Per-Write IV

Sensitive columns (address, bank account number, IBAN/SWIFT routing info) are stored in the format `cipher:ciphertext:iv:authtag`. The IV (initialization vector) is a random 12-byte value generated freshly for every single encryption operation.

If a fixed IV were used, encrypting the same plaintext twice would produce identical ciphertext. An attacker who cannot decrypt the data could still deduce that two clients share the same address by observing that two ciphertexts are identical — a statistical frequency attack. With a unique random IV per write, identical plaintexts always produce completely different ciphertexts. Statistical analysis reveals nothing.

---

## 12. Fix 5: Monthly Balance Snapshots

### The Problem

This was Critical Engineering Fix 5. Balance is derived by summing all ledger entries for an investment. A 3-year-old account with monthly profit allocations, periodic withdrawals, and rounding adjustments could have hundreds of ledger rows. Summing all of them on every dashboard load becomes increasingly expensive as accounts age.

On our single Hetzner CX32 server with shared PostgreSQL resources, running unbounded aggregation queries across millions of rows for hundreds of concurrent users would cause serious performance degradation over time.

### The Fix: Monthly Closing Balance Snapshots

On the 1st of every month at 00:01 UTC, a Go River cron job creates a balance snapshot for every active investment. The snapshot captures the total confirmed balance at the end of the previous month.

From that point forward, calculating an investment's current balance requires only two things:
1. The most recent snapshot (one row, retrieved instantly)
2. The sum of ledger entries created since the snapshot date (at most 31 days of entries)

The maximum scan window is always 31 days — for a 10-year-old account and a 1-month-old account alike. The query performance does not degrade with account age.

### The Critical Sequencing Rule

The design document establishes an explicit dependency: the monthly summary email job must never run before the snapshot job completes. If the snapshot fails at 00:01 UTC, the email job is blocked and a SUPER_ADMIN alert fires. Sending a monthly performance summary email with stale balance data would be a client trust failure.

The River queue manages this sequencing through job priorities and scheduling. The snapshot job completes first. The email job reads from the freshly created snapshots at 08:00 UTC.

---

## 13. The Pool and Investment Pool Allocation Design

### Why Pools Exist at All

A simple design would have each investment directly associated with a trading account. But the platform has multiple admins each managing different portions of client capital across different brokerage accounts at different risk levels. A client's $100,000 HIGH risk investment might be split: $60,000 managed by Admin 1 in Account A, and $40,000 managed by Admin 2 in Account B.

Without pools, there is no way to track which admin is responsible for which slice of which client's money, or to generate withdrawal tasks correctly, or to enforce admin-level visibility boundaries.

### The Pool Naming Convention and Why It Was Chosen

Pools are named using the format `{ACCOUNT}-{RISK}-{SEQUENCE}`, for example `ACCA-HIGH-001`, `ACCB-MED-002`, `ACCC-LOW-001`. The system auto-suggests the next name in sequence when an admin creates a pool.

This naming was chosen deliberately so every pool is self-describing. An admin looking at a pool list instantly knows which account it belongs to, what risk profile it serves, and whether it is the first or an overflow pool — without clicking into any detail view. When a pool fills up, the overflow pool is named `ACCA-HIGH-002` automatically.

### The `investment_pool_allocations` Table

This table is the core of multi-admin pool tracking. When one investment (or one risk slice of a split investment) is spread across multiple admin-owned pools, each slice gets a row here. Every dollar of a client's investment is traceable to exactly one pool and exactly one admin.

This design enables:
- Clients to see their total investment without knowing the internal pool structure
- Pool managers to see only their own slices
- SUPER_ADMINs to see the full picture across all admins
- The withdrawal system to automatically generate the correct tasks per admin

---

## 14. The Withdrawal Two-Table Design

### Why Two Tables

Withdrawals use `core.withdrawal_requests` (the master request from the client) and `core.withdrawal_tasks` (one sub-task per admin pool involved in the withdrawal).

When a client withdraws from an investment that spans multiple admin pools, the funds must come from each pool proportionally. Admin 1 cannot handle Admin 2's portion. Each admin needs their own task with their own amount, their own approval action, and their own transfer reference.

The `withdrawal_tasks` table creates one task per pool. Each admin sees only their task. The master `withdrawal_request` stays in `TASKS_PENDING` until every task reaches `TRANSFER_DONE`. Only then does the system mark it `COMPLETED` and notify the client.

The SUPER_ADMIN sees the full picture — all tasks, which admin owns each one, and whether anyone is blocking the withdrawal. A "nudge" function sends an in-platform notification to a blocking admin. If needed, the SUPER_ADMIN can override and approve directly.

The client receives one consolidated transfer for the full withdrawal amount, not multiple separate transfers from different admins. The internal multi-pool structure is invisible to the client.

### The Capital Floor Rule

A client cannot withdraw capital below the minimum capital floor configured for their investment (default: €5,000, adjustable by admin). If they want to close completely, the floor is waived and explicitly confirmed. This protects pool liquidity — admins need some notice to rebalance positions before a large capital exit.

### The Notice Period and Its Status Machine

Capital withdrawals go through a defined sequence: `SUBMITTED` → `NOTICE_PERIOD` → `READY_FOR_APPROVAL` → `TASKS_PENDING` → `TASKS_COMPLETE` → `COMPLETED`. A daily cron job at 00:01 UTC checks withdrawal requests where `ready_date = today` and automatically advances them from `NOTICE_PERIOD` to `READY_FOR_APPROVAL`, notifying the admin.

The notice period options (15, 30, or 45 days, configurable per investment tier) give admins time to source funds from the pool. Capital in an actively managed trading account may need time to liquidate.

---

## 15. The Idempotency Design on the `reference_id` Field

The Bank of Ireland API is pull-based — there are no push webhooks. The Go Payments Service polls for new transactions every 3 minutes. The same transaction can appear in multiple consecutive polls (it was new in the 3-minute window but will also appear in subsequent calls until the filter window advances).

The `reference_id` column on `core.ledger_entries` is a `UNIQUE` constraint. Before processing any polled bank transaction, the Go service checks whether this bank transaction's reference ID already exists in the ledger. If it does, the transaction is skipped. If it does not, it is processed and inserted with the bank reference as `reference_id`.

This prevents any bank transaction from generating more than one ledger entry, regardless of how many times it appears in polling results. The `UNIQUE` constraint on `reference_id` is the database-level guarantee. The application-level check is a fast early exit that avoids unnecessary constraint violation exceptions.

---

## 16. GDPR Right to Erasure vs. 7-Year Financial Retention

### The Legal Conflict

European law creates a direct conflict for financial platforms. GDPR Article 17 gives clients the right to demand deletion of all their personal data. Anti-Money Laundering Directives (AMLD) and MiFID II require keeping financial transaction records for 6–7 years.

We cannot delete ledger entries (illegal under financial law). We cannot keep personal data permanently (illegal under GDPR if a client requests erasure). Both must be satisfied simultaneously.

### What Actually Happens When a Client Requests Erasure

Per the design document, the following fields are handled:

| Data | Action |
|---|---|
| Name, phone, address | Replaced with NULL |
| Email address | Replaced with `deleted-{hash}@noreply` — untraceable to any real person |
| Bank account number, IBAN, SWIFT | Replaced with NULL (encrypted fields wiped) |
| Profile record status | Marked `GDPR_ANONYMISED` |
| Ledger entries | **Retained** — legally required financial records |
| Pool allocations | **Retained** — financial audit trail |
| Withdrawal history | **Retained** — financial audit trail |
| Audit log actor IDs | **Retained** — but the mapping from actor ID to personal data is severed |

The result: financial history is preserved and auditable. The individual behind it is no longer identifiable from the database alone. Both GDPR and financial record-keeping obligations are satisfied. This is standard practice for regulated fintech platforms.

### Why Not Full Deletion

Full deletion of the user record would cascade to ledger entries (if foreign key constraints cascaded), breaking the financial audit trail. Keeping the user record but scrubbing all PII severs the identity connection while retaining the financial history.

### Why Not Pseudonymisation

Pseudonymisation (replacing names with codes while keeping a mapping table somewhere) is weaker — the mapping can be reversed. Our approach permanently destroys the mapping. There is no key that can reverse the anonymisation.

---

## 17. Currency: EUR Only in V1

The system is EUR-only for V1. The CEO confirmed an EU-only client scope for the initial release. This simplifies the ledger, eliminates FX conversion logic, and reduces the number of edge cases during the initial launch period.

However, the database schema was designed with multi-currency support in mind for V2. The `ledger_entries` table has `original_currency` and `fx_rate` columns. In V1 these always contain EUR and 1.000000 respectively. In V2, adding USD or GBP support means activating FX lookup logic — the data structure is already ready without a schema migration.

---

## 18. The Agreement Signing Data Model

The investment agreement (the legal document clients must read before investing) uses an in-house forced-scroll implementation in V1. A JavaScript scroll listener prevents the "I Agree" checkbox from activating until the client has scrolled to the bottom of the agreement text.

When signed, the database records: `agreement_signed = true`, `signed_at = TIMESTAMPTZ`, `agreement_version = 'v1.0'`. The signed agreement PDF is stored in Hetzner Object Storage (S3-compatible), linked to the user record.

The system interface is defined with `AgreementService.send()` and `AgreementService.verify()` methods. When the platform upgrades to DocuSign or HelloSign in a future version, only the implementation of these methods changes — no other code is affected.

---

## 19. The Unmatched Deposit SLA

When a client wire arrives with no recognisable reference code, it enters an unmatched deposits queue — displayed prominently in red and separate from the normal pending deposits list. A 48-hour escalation timer starts immediately. If the deposit is not resolved within 48 hours, all SUPER_ADMINs receive an alert.

The admin has three options: link manually (search by client name/email), contact the client to confirm the transfer with the correct reference, or flag for return (if unresolvable within the SLA, initiate a return transfer to the originating account).

The recommended unmatched deposit SLA is 5 business days (pending CEO confirmation). Unidentified funds sitting indefinitely with no action is an AML (Anti-Money Laundering) exposure — resolution within the SLA is a compliance requirement, not a convenience.

---

## 20. Open Items That Affect the Data Model

The following items from the design document were not resolved at the time of writing and may require database changes depending on the CEO's decisions:

| Item | Impact on Database |
|---|---|
| Does the company have a BOI eIDAS QWAC certificate? | Pre-launch dependency. Affects when bank polling can go live. |
| Non-EUR inbound transfers — reject and return, or admin converts to EUR manually? | Affects whether the `original_currency` and `fx_rate` columns need active FX lookup logic in V1 |
| Profit withdrawal notice period (recommendation: 7–15 days) | Affects the `notice_days` valid values on `withdrawal_requests` |
| Is client capital guaranteed against loss? | Determines whether the `CAPITAL_LOSS` entry type will ever actually be used, and affects the agreement text |
| Should matured investments auto-renew after X days of client inaction? | Would add a new state transition to the investment state machine |
| Post-maturity auto-renew | May require new investment records to be created automatically, affecting `investments` and `ledger_entries` |

---

## 21. Things You Must Never Do

If you are a new engineer on this project, these are the rules that must not be broken regardless of circumstances:

1. **Never UPDATE or DELETE rows in `core.ledger_entries`.** If you need to correct an entry, book a new offsetting entry. The database trigger will reject the modification anyway, but do not attempt it.

2. **Never write a cross-schema foreign key constraint** from `payments` to `core` or vice versa. The schema decoupling is intentional and essential for the V3 migration path.

3. **Never store a balance as a column anywhere.** Balance is always derived dynamically from the ledger. A stored balance will drift out of sync with the ledger and cannot be trusted.

4. **Never add a ROUNDING_ADJUSTMENT entry manually.** It must always be generated by the automated profit distribution algorithm. A manual entry bypasses the audit trail.

5. **Never skip the `FOR UPDATE` row lock when reading pool capacity before allocation.** The database check constraint is the last resort — the application lock must be the first protection.

6. **Never run the monthly summary email job before confirming the balance snapshot job completed.** Clients must never receive performance data from stale snapshots.

7. **Never decrypt PII fields in a log statement, background job output, or anywhere other than the specific authenticated API response that requires it.**

---

## 22. Summary of All Key Decisions

This table replicates and extends the master decisions table from Section 15 of `final_system_desgin.md`:

| Decision | What Was Chosen | What Was Rejected | Why |
|---|---|---|---|
| Database engine | PostgreSQL | MySQL, MongoDB | RLS, triggers, covered indexes, ACID, River queue compatibility |
| Database hosting | Self-hosted Docker | AWS RDS, managed cloud | €75/month managed vs €0/month self-hosted |
| Schema structure | Two isolated schemas | One monolithic schema / two separate database servers | Decoupled for V3 physical split, cheaper than two servers at V1 scale |
| Balance storage | Derived from ledger history | Stored column on investments | Auditability, no drift risk between balance and ledger |
| Ledger mutation | Append-only with trigger block | Mutable rows | Regulatory compliance, audit integrity |
| Profit rounding | Largest Remainder Method | Standard rounding | Zero balance sheet drift on reconciliation runs |
| Tiebreaker | Oldest investor gets the remainder cent | Random assignment | Deterministic, auditable, intuitive fairness argument |
| PII storage | Separate encrypted table with per-write random IV | Inline with user record, fixed IV | Blast radius reduction, GDPR, frequency analysis prevention |
| PII key management | Doppler (V1), AWS KMS (V3) | Docker env vars | One compromised admin account would expose all PII with env vars |
| GDPR erasure | Anonymisation isolation | Full deletion | Full deletion breaks the financial audit trail |
| Event queue | Transactional Outbox in PostgreSQL + River | Redis / RabbitMQ | €0/month, ~150 MB RAM saved, same durability guarantees |
| In-memory Go channels | Rejected | Used for financial events | Volatile on crash/redeploy — financial events cannot be lost |
| Balance performance | Monthly closing snapshots | Full historical summation | Sub-millisecond snapshot lookup regardless of account age |
| Cross-schema joins | Soft references only (no physical FK) | Physical foreign keys | Enables V3 database physical split without code changes |
| Pool race condition | FOR UPDATE lock + CHECK constraint | Application lock only | Dual-layer protection — neither alone is sufficient |
| Currency | EUR only in V1 | Multi-currency from start | CEO-confirmed EU scope; schema pre-built for V2 multi-currency |
| Service count | 3 services | 8 original / 4 intermediate | Right-sized: shared security/change boundaries merged; UI decoupled |
| Container orchestration | Docker Compose (V1), Kubernetes (V3) | Kubernetes from day one | Control plane overhead with zero benefit at 100-user scale |
| Idempotency | `reference_id` UNIQUE constraint | Application-level dedup only | BOI polling will see same transaction multiple times; DB constraint is the guarantee |
| Cron sequencing | Snapshot at 00:01, email at 08:00 | Simultaneous or email-first | Monthly emails must always show fresh, accurate figures |
| Admin portal | Completely separate at admin subdomain | Shared portal with role-based views | No crossover between client and admin credentials |
| 2FA for admins | Enforced (TOTP) | Optional | Admin accounts have direct financial and PII access — too high risk to make optional |

---

## 23. Decisions Made During Zerodha-Style Engineering Review

After the initial schema was completed, a critical engineering review was conducted using a Zerodha senior engineer / program manager lens. Zerodha is known for extreme simplicity, correctness over cleverness, and a zero-tolerance approach to silent failures in financial systems. The review identified 9 specific issues. All 9 were fixed. The decisions made during that review are recorded here so future engineers understand why these changes exist.

---

### Decision 23.1: Add `CLOSED` and `GDPR_ANONYMISED` to the `user_status` ENUM

**What was wrong:** The initial schema defined the `user_status` ENUM with 7 values. `CLOSED` (investment fully completed and settled) and `GDPR_ANONYMISED` (PII wiped after erasure request) were documented in the state machine in `final_system_desgin.md` but were missing from the actual ENUM definition.

**Why this was a P0 bug:** If any code path had tried to set a user's status to `GDPR_ANONYMISED` on a live system — which is exactly what happens when a client submits a GDPR erasure request — PostgreSQL would have thrown a type error and the operation would have crashed. A user's right to erasure would be legally required but technically impossible. `CLOSED` missing meant an investment that fully settled had no valid status to transition to.

**Decision made:** Both values were added to the ENUM with explicit comments explaining what each state means. `CLOSED` marks complete settlement of all capital and profit. `GDPR_ANONYMISED` marks that PII has been destroyed and only the financial shell remains.

**Alternative considered:** Storing status as a `TEXT` column instead of a typed ENUM, which would never throw this error. Rejected — typed ENUMs are a deliberate correctness choice. They enforce that only valid states can exist, which catches exactly this kind of omission early. The fix is to complete the ENUM correctly, not to weaken the type system.

---

### Decision 23.2: Trigger-Based Enforcement That Risk Split Percentages Sum to 100

**What was wrong:** The `investment_risk_splits` table had a `CHECK (percentage > 0.00 AND percentage <= 100.00)` constraint. This validates each row individually. It cannot validate that the total across all rows for one investment sums to exactly 100.00. A split of 40% + 40% + 40% = 120% would pass every row-level constraint without error.

**Why this was a P0 bug:** The entire profit distribution algorithm — the Largest Remainder Method — assumes that investor percentages sum to 100. If they do not, the raw share calculation for each investor (`(their_capital / pool_total) × profit`) produces wrong numbers. Every profit distribution for an affected investment would be mathematically incorrect, and the discrepancy would only surface during a reconciliation audit — after clients had already been paid wrong amounts.

**Why a simple CHECK constraint cannot fix this:** A CHECK constraint on one row cannot reference other rows in the same table. Summing all rows for a given `investment_id` requires a query across multiple rows, which means a trigger is the only database-native mechanism.

**Decision made:** A PostgreSQL trigger function `core.validate_risk_splits_sum()` fires `AFTER INSERT OR UPDATE` on `investment_risk_splits`. It sums all percentages for the affected `investment_id` and raises an exception if the total exceeds 100.00. This covers both new inserts and updates to existing splits.

**Why check `> 100` not `!= 100`:** The trigger checks the running total after each insert. During a multi-row insert operation (inserting all three splits in sequence), the total after the first insert is legitimately less than 100. Checking for `!= 100` would block every intermediate state. Checking for `> 100` catches over-allocation while permitting the building-up phase. Application code is responsible for ensuring the final total is exactly 100 before committing.

---

### Decision 23.3: Trigger-Based Enforcement That Withdrawal Task Percentages Sum to 100

**What was wrong:** The same issue existed on `withdrawal_tasks`. If the withdrawal task generation code had a bug and created tasks totalling 95% of the withdrawal amount, the client would receive 95% of their requested withdrawal with no database error raised.

**Why this was a P0 bug:** A client requesting a €100,000 withdrawal receiving €95,000 is a direct financial error. The missing €5,000 would sit in a pool with no ledger record. Unlike a profit distribution error which might surface in the next reconciliation cycle, a withdrawal shortfall is immediately visible to the client and constitutes a failure of the platform's core function.

**Decision made:** A second trigger function `core.validate_withdrawal_tasks_sum()` fires `AFTER INSERT OR UPDATE` on `withdrawal_tasks`. Same logic as the risk splits trigger — sums all task percentages for the affected `withdrawal_request_id` and raises an exception if the total exceeds 100.00.

**What the application must still do:** The triggers catch over-allocation at the engine level. The application is still responsible for ensuring every withdrawal request eventually has tasks totalling exactly 100.00 before the withdrawal is approved. The triggers are the safety net, not the primary enforcement.

---

### Decision 23.4: Fix `currency_preference` Default from `USD` to `EUR`

**What was wrong:** The `user_profiles` table had `currency_preference TEXT NOT NULL DEFAULT 'USD'`. The CEO confirmed at system design stage that V1 operates in EUR only, serving EU clients. All ledger amounts are in EUR. The default was wrong from the start.

**Why this matters:** This is a silent data corruption issue, not a crash. Every user profile created without an explicit currency preference would be stored as `USD`. The mismatch between the profile saying `USD` and every ledger entry being in `EUR` would create confusion in reporting, confuse future multi-currency logic in V2 (which reads `currency_preference` to determine how to display balances), and require a data migration to fix after the fact.

**Decision made:** Default changed to `EUR`. Added a comment in the schema explicitly referencing the CEO decision and the V1 EUR-only scope, so a future developer cannot change this back without understanding why.

**V2 consideration:** When multi-currency is activated in V2, the `currency_preference` column will be used to determine which currency to display balances and reports in. At that point, clients will be able to set this to `USD`, `GBP`, or other supported currencies. The column already exists with the right structure — only the default and the active FX logic needs to be added.

---

### Decision 23.5: Add `deactivated_at` Timestamp to `core.admins`

**What was wrong:** The `admins` table used `is_active = false` to mark deactivated admin accounts. This is the correct soft-delete pattern. But there was no `deactivated_at` timestamp. When a compliance auditor asks "when exactly was Admin X's access removed from the system?", the answer requires digging through the audit log to find the specific event — indirect, slower, and requires knowing which audit action to look for.

**Why this matters:** Financial platforms are regularly asked by regulators and insurers to demonstrate timely access revocation when staff leave. "We deactivated them" is not sufficient — "we deactivated them on [date] at [time], recorded as [timestamp]" is what a formal response requires. The `deactivated_at` field makes this answer instantly available without any log search.

**Decision made:** `deactivated_at TIMESTAMPTZ` added to `core.admins`. Application code sets this field when transitioning `is_active` to `false`. It remains `NULL` for currently active admins, making it queryable: "show me all admins deactivated in the last 90 days" is a simple `WHERE deactivated_at > NOW() - INTERVAL '90 days'`.

---

### Decision 23.6: Add Indexes on `core.audit_log`

**What was wrong:** The `audit_log` table had no indexes beyond the primary key. The two most common real-world query patterns — "show me all actions by this admin" (filter by `actor_id`) and "show me everything that happened to this investment" (filter by `entity_id` and `entity_type`) — were both full sequential scans.

**Why this matters at our scale:** The audit log grows with every admin action, every login, every allocation, every withdrawal step. At 500 active clients with 5 admins making 20+ actions per client per month, the audit log accumulates 50,000+ rows in the first year. At 2 years, 100,000+ rows. Without indexes, the admin activity panel — which loads audit data on every admin dashboard open — becomes progressively slower from month one. Unlike application query optimisations that can be deployed without schema changes, missing indexes require a schema migration on the live database to add later.

**Decision made:** Two composite indexes added:
- `idx_audit_log_actor_id` on `(actor_id, created_at DESC)` — supports the "admin activity feed" query sorted by most recent first
- `idx_audit_log_entity` on `(entity_id, entity_type, created_at DESC)` — supports the "audit trail for this specific record" query

**Why descending on `created_at`:** Admin activity displays are always most-recent-first. The descending order in the index means PostgreSQL can return the first page of results without sorting — the index is already in the right order.

---

### Decision 23.7: Add Partial Indexes for Cron Queries

**What was wrong:** The daily maturity cron queries `investments WHERE maturity_date = today`. Without a targeted index, this scans all investments — including closed, matured, and archived ones that will never match. Similarly, the withdrawal cron and admin queue queries filter `withdrawal_requests` by status, but no index on status existed.

**Why partial indexes instead of regular indexes:**

A regular index on `investments(maturity_date)` would include all investments — active, closed, and cancelled. The cron only ever needs to find active investments approaching maturity. A partial index with `WHERE status = 'ACTIVE'` contains only the rows that can ever match the cron query. As closed investments accumulate over years, a partial index stays small while a regular index keeps growing.

The same logic applies to `withdrawal_requests`: a partial index covering only `NOTICE_PERIOD`, `READY_FOR_APPROVAL`, and `TASKS_PENDING` statuses contains only the open requests the cron and admin queue ever need to touch. Completed and cancelled requests — the majority after a few months — are invisible to the index and never scanned.

**Decision made:** Two partial indexes added:
- `idx_investments_maturity_cron` on `(maturity_date, status) WHERE status = 'ACTIVE'`
- `idx_withdrawal_requests_status` on `(status, ready_date) WHERE status IN ('NOTICE_PERIOD', 'READY_FOR_APPROVAL', 'TASKS_PENDING')`

---

### Decision 23.8: Add Composite Index on `pools(trading_account_id, status)`

**What was wrong:** The pool list view — one of the most frequently loaded screens in the admin portal — filters pools by trading account and status on every page load. The only relevant index was on `trading_account_id` alone. PostgreSQL would use it to narrow by account, then apply a filter on `status` on the result set without index support.

**Decision made:** Composite index `idx_pools_account_status` on `(trading_account_id, status)` added. The query now uses the composite index to narrow by both account and status simultaneously without any post-index filtering.

---

### Decision 23.9: Document `notice_days` Hard-Coding Risk — Defer Config Table to V2

**What was identified:** The `withdrawal_requests` table has `CHECK (notice_days IN (15, 30, 45))`. This hard-codes the valid notice period tiers in the database schema. If the CEO decides to change the tiers (for example, to 7, 30, 60 days based on client feedback after launch), changing this constraint requires an `ALTER TABLE` migration on a live production database — a risky operation that requires a maintenance window.

**The better V2 design:** Create a `core.notice_period_config` table storing the valid options. Application code validates `notice_days` against this config table at runtime. Changing valid tiers becomes a single `INSERT` or `UPDATE` in the config table — no schema migration, no maintenance window, immediate effect.

**Why not do this in V1:** Adding a config table in V1 adds implementation complexity (config table must be seeded at startup, application must query it before every withdrawal validation) for a problem that may never occur — the CEO has not yet confirmed the exact tiers (open item). Building the config table before the tiers are confirmed risks building it for tiers that then change during design review.

**Decision made:** Keep the hard-coded CHECK constraint in V1 with an explicit code comment referencing this risk. When the CEO confirms the exact notice period tiers and the first request to change them arrives, that triggers the migration to a config table in V2. The comment in the schema ensures no future engineer removes it without understanding the trade-off.

---

### Decision 23.10: Document the Maturity Cron Guard in the Schema

**What was identified:** The daily cron job that checks for matured investments must always include `AND status = 'ACTIVE'` in its query. Without this guard, if the cron retries (a failed run is re-attempted), or if it is accidentally re-run manually, it would re-process investments already in `MATURED` status. This could trigger duplicate maturity notifications to clients who already received them.

**Why this is an application code rule, not a schema rule:** The database cannot enforce that a cron query includes a specific `WHERE` clause. The guard must be enforced in the application code that runs the cron.

**Decision made:** A `NOTE` comment added to `schema.sql` in the Design Notes section, explicitly calling out this requirement. It is also documented in `database_models.md` in the user status state machine. The guard is visible in two places so it cannot be missed during implementation.

---

## 24. Updated Summary Table — Including Review Decisions

The following rows extend the master decisions table (Section 22) with all decisions from the Zerodha engineering review:

| Decision | What Was Chosen | What Was Rejected | Why |
|---|---|---|---|
| `user_status` ENUM completeness | Added `CLOSED` and `GDPR_ANONYMISED` | Leaving them out / using TEXT column | Missing ENUM values cause type errors on live GDPR erasure; TEXT weakens the type system |
| Risk split percentage enforcement | Deferred constraint trigger enforcing exactly = 100% at commit + mid-transaction check ≤ 100% | Row-level CHECK constraint or mid-transaction check alone | Standard triggers only check intermediate steps; deferred checks ensure exact 100% allocation at transaction commit |
| Withdrawal task percentage enforcement | Deferred constraint trigger enforcing exactly = 100% at commit + mid-transaction check ≤ 100% | Application-level validation only | Mid-transaction check catches over-allocation early; deferred check at commit ensures the tasks sum to exactly 100% |
| `currency_preference` default | `EUR` | `USD` (was incorrectly set) | V1 is EUR-only by CEO decision; wrong default causes silent data mismatch with ledger |
| Admin deactivation timestamp | `deactivated_at TIMESTAMPTZ` on admins | Relying on audit log only | Compliance auditors need direct queryable access revocation timestamps |
| Audit log indexes | Composite indexes on `actor_id` and `entity_id` | No indexes | Without indexes, admin activity panel becomes progressively slower from month one |
| Maturity cron index | Partial index on `investments(maturity_date, status) WHERE status = 'ACTIVE'` | Full index on all investments | Partial index stays small as closed investments accumulate; full index grows unnecessarily |
| Withdrawal queue index | Partial index on open statuses only | Full index or no index | Only open requests are ever queried by cron and admin queue; closed history excluded |
| Pool list view index | Composite index on `(trading_account_id, status)` | Single-column index only | Admin pool list always filters by both columns simultaneously |
| `notice_days` config table | Dynamic `core.notice_period_config` table and foreign key | Hardcoded CHECK constraint | Allowed changing or adding notice period tiers dynamically via config table without schema alteration |
| Maturity cron double-processing | `AND status = 'ACTIVE'` guard documented in schema and models | No guard | Cron retry without the guard re-notifies already-matured clients |
| Monthly profit entry math | Automated proportional division per lot allocation | Manual user-by-user profit entry | Manual math is highly error-prone and a critical scaling bottleneck |
| Accrued dividend separation | Separate locked `ACCRUED_DIVIDEND` entry type | crediting withdrawable profit directly | Direct crediting allows illegal mid-cycle withdrawals, violating the pool lock policy |
| Maturity release automation | Automated daily cron ledger transfer | Manual payout processing by admins | Manual settlement introduces administrative delays and operational cost |
| Negative trading months | Netting as negative accrued dividends (DEBIT `ACCRUED_DIVIDEND`) | Immediate capital reductions | Netting monthly balances preserves capital protection constraints until final maturity settlement |
| Neutral currency representation | Split `amount` and `currency` columns | Hardcoded `_usd` columns | Rebranded columns to neutral naming to support EUR-only V1 while remaining future-proof for multi-currency V2 |

---

## 25. Architectural Decision Record: Automated Monthly Dividends & Maturity Payouts

### 25.1 Context & Problem Statement
Titan’s initial design assumed admins would manually compute and allocate profits directly to the client's withdrawable balances. However, as the fund aggression scales, this manual calculation is a massive operational liability:
1. **The Penny Problem & Math Error**: Splitting an absolute pool profit (like €15,000) across hundreds of investor lots manually will lead to rounding errors and cash discrepancies.
2. **Premature Withdrawals**: If monthly profits are credited directly as withdrawable profits, clients can request payouts mid-cycle. This violates pool liquidity agreements.
3. **Operational Overhead**: Manually converting and paying out profits when an investment matures introduces human delay, administrative cost, and compliance friction.

---

### 25.2 Decision: Two-Stage Ledger Accounting
We decided to isolate **Accrued (Locked) Profits** from **Liquid (Withdrawable) Profits** by introducing a two-stage ledger ledger structure:

1. **Accrual Stage (Monthly)**:
   - When a pool manager inputs the monthly pool outcome (supporting both Return % and total pool profit), the system **automatically divides** it.
   - It calculates each lot allocation's share proportionally based on its capital weight in the pool, resolving rounding fractions down to the cent via the **Largest Remainder Method**.
   - These allocations are booked to the ledger as `ACCRUED_DIVIDEND` with direction `CREDIT`. 
   - A negative month (loss) is booked as `ACCRUED_DIVIDEND` with direction `DEBIT`, netting down the accumulated accruals.
   - **Data Isolation**: The client's portfolio dashboard aggregates these to show total value, but they are excluded from the withdrawable profit balance query, rendering them locked.

2. **Payout Stage (Maturity)**:
   - On the maturity date, the daily cron job automatically detects the matured investment, sums all confirmed `ACCRUED_DIVIDEND` credits (minus debits) for that investment, and executes a **balancing ledger transaction**:
     - **Debit `ACCRUED_DIVIDEND`** (via `DIVIDEND_RELEASE`) for the accumulated sum.
     - **Credit `PROFIT_ALLOCATION`** (liquid) for the exact same amount.
   - This zero-sum ledger adjustment balances the accrued dividend account to `$0.00` while making the full amount withdrawable by the client instantly.

---

### 25.3 Rationale & Trade-offs
* **Pros**:
  - **100% Audit Trace**: Keeping separate accrued and released entry types preserves the strict, append-only double-entry bookkeeping history.
  - **Zero Manual Overhead**: The system handles both the monthly proportional splitting and the maturity releases automatically in the background.
  - **Absolute RLS Safety**: Calculations are done at the investment level, meaning database RLS policies naturally defend against cross-tenant data leaks.
* **Cons**:
  - **More Ledger Entries**: The ledger grows by one release transaction per investment on its maturity date. However, since the database is optimized with composite covering indexes, this has near-zero performance cost at scale.


