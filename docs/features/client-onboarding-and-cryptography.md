# Feature Record: V1 Client Authentication, Onboarding, and Cryptography

This document details the architecture, design decisions, implementation details, and current status of the V1 Authentication, Client Onboarding, and PII Cryptographic Vault.

---

## 1. Feature Context & Requirements

Targeting Irish and EU high-value clients investing in a private fund (rather than self-directed public stock retail trading), the platform requires secure, multi-tenant authentication alongside strict onboarding verification.

### Client Lifecycle & State Machine
The client's progress is managed via a strict sequential state machine in `core.users.status`:
1. **Registration (Signup)**: Creates a new user record in the `PENDING_PROFILE` status.
2. **Profile Completion**: The client fills out profile details. Status transitions to `PENDING_AGREEMENT`.
3. **Agreement Signing**: The client signs the fund agreement. Status transitions to `PENDING_INVESTMENT`.
4. **Funding & Activation**: Subsequent investment and deposit requests transition status to `PENDING_DEPOSIT` and `ACTIVE`.

---

## 2. Technical Architecture & Key Decisions

### Client Registration (Signup)
* **Decision**: Expose `POST /api/auth/register` to support retail client registration.
* **Deduplication**: Checks both the client (`core.users`) and administrative staff (`core.admins`) registries to prevent email collision or privilege overlapping.
* **Hashing**: Hashes passwords with `bcrypt` (salt rounds: 10). Enforces a minimum length of 8 characters.
* **Tenant Isolation**: Generates a random tenant UUID for the client if one isn't explicitly provided, ensuring immediate database Row-Level Security (RLS) partition.

### Client & Admin Login
* **Decision**: Provide a unified `/api/auth/login` endpoint that matches credentials against both registries.
* **Registry Matching Flow**:
  1. Checks the `core.admins` table first. If found, validates password and issues admin tokens.
  2. If not found in admins, checks the `core.users` table. If found, validates password, verifies user is not `SUSPENDED`, and issues client tokens.
* **JWT Token Issuance**: Returns a stateless JWT access token (15 mins) and sets an HTTP-only secure cookie for the refresh token (7 days). The client payload contains the mapped `tenantId` to trigger database RLS constraints on request.

### Cookie-based Refresh & Logout
* **Decision**: Refresh tokens are stored strictly in HTTP-only, secure, same-site cookies to defend against Cross-Site Scripting (XSS) token extraction.
* **Refresh Route (`POST /api/auth/refresh`)**: Validates the refresh token (cookie or fallback body) and re-issues a new pair of access/refresh tokens.
* **Logout Route (`POST /api/auth/logout`)**: Clears the HTTP-only refresh token cookie instantly.

### Single-Submit Form Saving
* **Decision**: All client onboarding profile details (contact info, address, bank routing/details) are collected entirely on the UI and sent in a single `POST /api/profiles/me` request.
* **Rationale**: This preserves `NOT_NULL` constraints in the database, ensures atomic backend validation, and avoids invalid partial profiles in the system.

### Transparent Application-Layer PII Vault
* **Decision**: Encrypt personally identifiable information (PII) inside the NestJS application layer before writing to the database using **AES-256-GCM**.
* **Encrypted Fields**:
  * `phone`
  * `address`
  * `bank_account_number` (IBAN)
  * `bank_routing_info` (BIC and Bank Name stored as encrypted JSON)
* **Cipher Format**: `cipher:ciphertext:iv:tag` (stored as base64-packed strings).
* **Migration Fallback**: If a database field is read that does not begin with the `cipher:` prefix, the vault transparently returns it as plaintext. This prevents application crashes during migrations or data seeding.

### Scrollable Agreement & Audit Trails
* **Decision**: Capture agreement signature details inside a single database transaction, generating both an immutable audit trail and a transactional outbox notification event.
* **Flow**:
  1. Validate that the client has a registered profile (cannot sign in the `PENDING_PROFILE` status).
  2. Transition client status to `PENDING_INVESTMENT`.
  3. Write an immutable signature record with IP Address, User-Agent, Signed Version, and Signed Timestamp to `core.audit_log`.
  4. Write an `AGREEMENT_SIGNED` event to `core.outbox_events` (published = `false`) to be picked up by the Go payments/notifications worker (outbox pattern).

### Request-Scoped Row-Level Security (RLS)
* **Decision**: Intercept HTTP routes using a global-friendly NestJS `RlsInterceptor` and `AsyncLocalStorage` transaction manager.
* **Syntax Resolution**: Standard PostgreSQL does not allow parameter placeholders (`$1`) in the `SET` command. The interceptor uses `SELECT set_config('app.current_tenant_id', $1, true)` to safely set the transaction-scoped tenant ID parameter.

---

## 3. Implementation Directory & File Maps

### Authentication & Sessions
* **Auth Controller**: [auth.controller.ts](file:///Users/balajisk/Downloads/titan/backend-core/src/auth/auth.controller.ts)
* **Auth Service**: [auth.service.ts](file:///Users/balajisk/Downloads/titan/backend-core/src/auth/auth.service.ts)
* **Global JWT Guard**: [jwt-auth.guard.ts](file:///Users/balajisk/Downloads/titan/backend-core/src/common/guards/jwt-auth.guard.ts)
* **Roles Guard**: [roles.guard.ts](file:///Users/balajisk/Downloads/titan/backend-core/src/common/guards/roles.guard.ts)
* **E2E Authentication Test Suite**: [auth.e2e-spec.ts](file:///Users/balajisk/Downloads/titan/backend-core/test/auth.e2e-spec.ts)

### Profiles & Encryption
* **Cryptographic Vault**: [crypto.ts](file:///Users/balajisk/Downloads/titan/backend-core/src/common/utils/crypto.ts)
* **Profile Entity**: [profile.entity.ts](file:///Users/balajisk/Downloads/titan/backend-core/src/users/entities/profile.entity.ts)
* **Validation DTOs**:
  * [save-profile.dto.ts](file:///Users/balajisk/Downloads/titan/backend-core/src/users/dto/save-profile.dto.ts)
  * [sign-agreement.dto.ts](file:///Users/balajisk/Downloads/titan/backend-core/src/users/dto/sign-agreement.dto.ts)
* **Profiles Controller**: [profiles.controller.ts](file:///Users/balajisk/Downloads/titan/backend-core/src/users/profiles.controller.ts)
* **Profiles Service**: [profiles.service.ts](file:///Users/balajisk/Downloads/titan/backend-core/src/users/profiles.service.ts)
* **E2E Onboarding Test Suite**: [profile.e2e-spec.ts](file:///Users/balajisk/Downloads/titan/backend-core/test/profile.e2e-spec.ts)

---

## 4. Current Code & Verification Status

### E2E Validation Suites
All E2E suites run sequentially (`--runInBand`) inside Jest E2E:
1. **Authentication tests (`auth.e2e-spec.ts`)**:
   * Registers clients (under random or designated tenant IDs), validating deduplication checks.
   * Logs in clients and admin accounts, verifying role payloads and blocking suspended accounts.
   * Tests session refreshes and cookie cleanup upon logouts.
2. **Onboarding tests (`profile.e2e-spec.ts`)**:
   * Saves onboarding profiles, verifying AES-256-GCM encryption storage directly in DB and transparent decryption on fetch.
   * Enforces client-to-client isolation at DB RLS policy level (via non-superuser `test_rls_role`).
   * Validates agreement signing, audit logging, outbox integration, and onboarding status upgrades.

### Validation Commands
```bash
cd backend-core
npm run lint         # Runs ESLint (0 errors)
npm run format       # Formats TS files
npm run test         # Unit testing (100% pass)
npm run test:e2e     # E2E integration tests (100% pass)
```
