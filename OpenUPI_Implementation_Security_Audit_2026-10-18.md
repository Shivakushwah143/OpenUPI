# OpenUPI — Independent Implementation Security and Payment-Integrity Audit

**Audit date:** 18 October 2026  
**Material:** user-supplied `OpenUPI-main.zip`, exported from source commit `d7b27eb`  
**Scope:** payment creation and completion, authentication/authorization, SMS/Gmail/Android observation intake, transaction attribution, state transitions, webhook generation/retries, database schema, core HTTP layer, deployment defaults.  
**Method:** source-level trace across routes → orchestration → domain services → database; targeted structural checks; `node --check` of 151 JS/CJS/MJS files. **No banking credentials were connected, no customer payments were executed, and no end-to-end exploit was attempted.**

## Executive decision

**NO-GO for publicly exposed production service or automated fulfillment.** The implementation contains direct unauthenticated administration, an API route allowing arbitrary shell commands, weakly authenticated (or unauthenticated) payment observations, and success transitions that can occur without authoritative bank-credit confirmation. This is a real codebase with a meaningful modular design, but it is **not a reliable payment gateway in its current state**.

**Static verification performed:** 151 JavaScript source files passed Node.js syntax parsing (zero syntax errors). Found payment/checkout/observer/admin routes and SQLite schemas; examined key data flows. This **does not** establish successful application startup, security testing, correctness under load, actual bank reconciliation, or regulatory approval.

## Payment path traced

1. `apps/payment-api/src/routes/payments.routes.js:29-51,135-161,206-267`: a client supplies `orderId`, `amount`, optional `merchantId`, and optional `autoActivate`, and the API creates an `INITIATED` payment record (or activates it).
2. `apps/payment-api/src/routes/checkout.routes.js:617-751,878-939`: checkout binds a customer and activates a UPI slot; `payment-done` changes `ACTIVE` → `PROCESSING` without bank proof (this is reasonable only as a *pending* state).
3. `apps/payment-api/src/routes/pollers.routes.js:56-143,205-370`: a poller or Android observer posts claimed SMS/email transaction evidence.
4. `packages/core/src/verification-pipeline.js:120-139,298-417,424-519,553-744,1026-1070`: parse claimed message, compare amount/time/reference, and forward normalized observation to matching engine. Claimed sender and source are not cryptographic proof of a real bank-origin credit.
5. `packages/core/src/attribution-engine.js:54-179,182-206,274-391`: match an observation with a session by account/amount (with broader fallback), then finalize after a short grace period or on a second claimed source.
6. `packages/db/src/repositories/payment-session.repository.js:457-522`: `recordVerificationSource` updates DB status to `SUCCESS` based on observations, without requiring authoritative bank confirmation or enforcing the core state graph.
7. `apps/payment-api/src/index.js:151-163`; `packages/core/src/webhook-engine.js:25-107`: a `PAYMENT.SUCCESS` event attempts an outbound signed merchant webhook, which downstream applications may interpret as permission to fulfill an order.

**Core architectural defect:** the system effectively treats receipt of *an observer's statement* as proof of actual settlement. Amount/time/UTR pattern matching alone cannot guarantee that the bank credited the intended transaction.

## Findings — prioritize in this order

| ID | Severity | Confirmed source observation | Evidence | Required remediation |
|---|---|---|---|---|
| P0-01 | **CRITICAL** | Unauthenticated admin tunnel endpoint accepts command text and runs it in a shell. A remotely accessible API can become OS command execution. | `apps/payment-api/src/routes/admin.routes.js:1375-1406`; `apps/payment-api/src/services/tunnel-manager.js:43-68` | **Remove** arbitrary command execution from HTTP API. If tunnel management is needed, configure an allowlisted command outside application runtime and run with separate low-privilege identity. |
| P0-02 | **CRITICAL** | `POST /api/v1/admin/counter-confirm` accepts `paymentId` and caller-supplied `operatorId` without authorization and invokes `transitionToTerminal(...SUCCESS)` even for non-counter payment methods. The route emits a success event and webhook. | `apps/payment-api/src/routes/admin.routes.js:264-318`; `packages/db/src/repositories/payment-session.repository.js:208-258` | Require authenticated operator + merchant RBAC; restrict to cash/card counter sessions; audit authoritative evidence; require database compare-and-swap and refuse arbitrary UPI success. |
| P0-03 | **CRITICAL** | Universal observer ingest lacks authentication. Caller controls receiving-account ID, source and asserted transaction message. Accepted observations flow into pipeline/attribution and can finalize an order. | `apps/payment-api/src/routes/pollers.routes.js:56-143`; `packages/core/src/attribution-engine.js:274-391` | Private authenticated observer credentials, per-observer key/identity, MAC over exact raw body/timestamp, nonce, timestamp tolerance, receiving-account authorization, trusted source from server-side binding. Never accept `source`, `isTest`, or account identity as trusted client assertions. |
| P0-04 | **CRITICAL** | Android observer signature verification is optional: HMAC validation occurs only **if** both timestamp and signature headers are present. Knowledge of a registered device ID can bypass cryptographic verification. Heartbeat is likewise unsigned. | `apps/payment-api/src/routes/pollers.routes.js:221-252,372-389` | Reject unsigned requests; bind device to merchant/receiving account; reject repeated nonces; rotate/revoke keys; enforce body-size limits for the manually read JSON stream. |
| P0-05 | **CRITICAL** | Observer enrollment accepts embedded static tokens and a predictable token derived from merchant ID; an admin GET route returns the enrollment secret and device information without auth. | `apps/payment-api/src/routes/pollers.routes.js:25-26,145-203,392-459,463-500` | Authenticate admins, generate short-lived single-use pairing challenges, hash/rotate enrollment tokens, restrict valid merchant IDs, prohibit hardcoded secrets, require proof of physical pairing approval. |
| P0-06 | **CRITICAL** | Sensitive configuration is exposed in unauthenticated admin GET responses: `webhookSecret`, Gmail `clientSecret`, Gmail `refreshToken`, `apiKey`, and stored tunnel commands. | `apps/payment-api/src/routes/admin.routes.js:800-885,1414-1448` | Enforce RBAC before any admin route, never return stored secrets in API responses, encrypt at rest using separate key management, rotate anything already deployed/exposed. |
| P0-07 | **CRITICAL** | Admin/merchant identity can be chosen by `merchantId`/`x-merchant-id` instead of verified credentials; simulator's `checkSimulatorAuth` checks only whether the claimed merchant exists. Many admin endpoints have no check at all. | `apps/payment-api/src/routes/admin.routes.js:96-106,1910-1944,2025-2027`; `apps/payment-api/src/routes/payments.routes.js:29-46` | Centralized authentication middleware, separate merchant service credentials, role checks and tenant-scoped repositories. Caller-supplied merchant ID is a lookup filter, never authorization. |
| P0-08 | **CRITICAL** | Payment success is not constrained by the declared state graph. `transitionToTerminal` accepts arbitrary target from any nonterminal status; `recordVerificationSource` sets `SUCCESS` on `finalizeSuccess` with no `ACTIVE/PROCESSING` precondition, including a terminal unsuccessful session. | `packages/core/src/state-machine.js:7-33`; `packages/db/src/repositories/payment-session.repository.js:208-258,457-511` | Use the declared transitions in every repository update, DB conditional update (`status IN (...)` and affected-rows check), transaction-scoped state/event/outbox update, prohibit reopening terminal sessions; define separate manual reconciliation adjustments. |
| P0-09 | **CRITICAL** | Same-amount fallback searches **any active payment on the gateway** with no receiving-account/merchant restriction; pipeline similarly falls back to any active merchant/account/session. This permits incorrect attribution across tenants/accounts. | `packages/core/src/attribution-engine.js:150-180`; `packages/core/src/verification-pipeline.js:221-254,553-562` | No global same-amount fallback. Match merchant + receiving bank account + verified transaction reference + amount + time window; ambiguous cases must become `RECONCILIATION_REQUIRED`, not success. |
| P1-01 | **HIGH** | The source's `Single Verification` means one SMS/email observation can finalize payment after a 5-second delay; `Dual Verification` counts supplied source labels and does not establish independent bank proof. | `packages/core/src/attribution-engine.js:79-143,274-395`; `packages/db/src/repositories/payment-session.repository.js:462-481` | Define trust levels: claimed, observer-authenticated, independently reconciled, bank-confirmed. Do not expose final PAID to merchant integration without accepted verification standard. Independent evidence must refer to same bank transaction, not just different text sources. |
| P1-02 | **HIGH** | UTR deduplication is application-level and non-atomic. The schema has no database unique constraint for bank reference; duplicate check looks at the first attributed observation of prior successful sessions only. | `packages/core/src/verification-pipeline.js:668-731`; `packages/db/src/sqlite-schema.sql:101-118` | Canonical transaction ledger keyed by acquiring bank/account and transaction reference, with unique index; atomically reserve/consume once, and support cross-source observations of the same actual transaction. |
| P1-03 | **HIGH** | Matching validates amount and a permissive time window but does not require payer/order binding. The 5-minute backward slot tolerance plus account/amount fallback raises collision risk, especially for repeated ₹19/₹49 orders. | `packages/core/src/attribution-engine.js:150-206`; `packages/core/src/verification-pipeline.js:584-644` | Require exact receiving account, reliable bank reference, canonical event time, and source provenance; handle ambiguous same-amount receipts manually. Avoid relying on user-supplied `targetSessionId`. |
| P1-04 | **HIGH** | Customer checkout binding allows a raw `customerId` without valid session token; device access lets callers omit device ID, weakening the claimed binding. | `apps/payment-api/src/routes/checkout.routes.js:27-63,617-663,705-710` | Require an authenticated customer session; match principal ID to existing session; use high-entropy checkout access token and ownership checks, not a client-supplied customer ID/device header. |
| P1-05 | **HIGH** | Merchant webhook URL is configurable without target restrictions and fetched by backend; unauthenticated merchant settings modification makes arbitrary internal HTTP requests possible (SSRF). | `apps/payment-api/src/routes/admin.routes.js:887-905`; `packages/core/src/webhook-engine.js:25-75` | AuthN/AuthZ for configuration; require HTTPS; block loopback, link-local, RFC1918/internal and metadata endpoints, including DNS-rebind/redirect targets; explicit allowlists when possible. |
| P1-06 | **HIGH** | Webhook dispatch is outside a durable transaction; the first HTTP request occurs before delivery is recorded. `retryPending()` is implemented but no production call site was found. Process crash/network failure can lose notifications indefinitely. | `apps/payment-api/src/index.js:151-163`; `packages/core/src/webhook-engine.js:25-107,114-173`; repo-wide `retryPending(` reference scan | Write payment-state event and outbound-delivery row atomically; use periodic durable retry worker and dead-letter queue; stable event ID, at-least-once delivery, merchant deduplication and reconciliation endpoint. |
| P1-07 | **HIGH** | User-controlled `autoActivate` bypasses stated login-before-activation invariant; route permits arbitrary client-specified price and optional merchant ID. | `apps/payment-api/src/routes/payments.routes.js:29-51,135-161,206-267` | Only merchant-authenticated backend creates payment sessions; amount/order are looked up from server-side merchant order, not customer input. Disable test-only flags outside isolated test builds. |
| P1-08 | **HIGH** | Customer OTP uses `Math.random`, writes OTP into server logs, and returns dev OTP when `NODE_ENV` is not exactly `production`. Login/verification paths show no robust rate-limit/attempt-counter enforcement. | `apps/payment-api/src/routes/customer.routes.js:74-151`; `packages/db/src/repositories/customer.repository.js:210-227` | Cryptographic OTP generation, hash OTP at rest, no plaintext logs/responses, rate-limit per IP/phone/device, lockout and resend cooldown; default secure config. |
| P1-09 | **HIGH** | `runMigrations` drops customers, customer sessions and support tickets on schema mismatch, risking data loss on upgrade. | `packages/db/src/migrate.js:22-46` | Replace destructive best-effort migration with versioned, backed-up, reversible migration scripts and production migration gate. |
| P2-01 | **MEDIUM** | Default HTTP response helper sets `Access-Control-Allow-Origin: *` including admin and private responses; SSE defaults to wildcard. CORS is not an authentication layer, but exacerbates sensitive exposure. | `apps/payment-api/src/server.js:86-105,154-168` | Per-origin CORS for protected APIs and no public access to admin/private routes. |
| P2-02 | **MEDIUM** | Session cookie omits `Secure`, so browser session could traverse plaintext HTTP where reachable. | `apps/payment-api/src/routes/customer.routes.js:29-31` | HTTPS-only `Secure; HttpOnly; SameSite=Lax`/`Strict`, CSRF protections for cookie-authenticated writes, rotate tokens on login. |
| P2-03 | **MEDIUM** | Database schema models `amount_paise` as integer and uses integer-pa﻿ise arithmetic, which is good, but idempotency key is stored without an independent unique constraint. `orderId` retries get random suffixes, complicating exactly-once merchant fulfillment. | `packages/db/src/sqlite-schema.sql:69-99`; `apps/payment-api/src/routes/payments.routes.js:67-133` | Unique `(merchant_id, idempotency_key)` where present; immutable order/payment-attempt separation and conflict detection on key+body hash. |
| GOV-01 | **PUBLICATION BLOCKER** | README references `LICENSE` and states commercial/sovereign licensing; no `LICENSE`/`COPYING` was present in the submitted ZIP; root `package.json` says `"license": "Commercial"`. | `README.md:519-521`; `package.json` | Contact author and obtain written redistribution/commercial-use permission before republishing a fork/rebrand. This is separate from engineering readiness. |

## Existing strengths (do not discard)

- Separation of API routes, common types, core matching, queue/timers, persistence, and webhook engine.
- SQLite WAL mode, foreign keys and prepared statements (`packages/db/src/database.js:58-63,86-118`).
- Integer paise storage and parsing via `toPaise` (`payments.routes.js`, schema).
- HMAC and constant-time comparison primitives already exist (`packages/common/src/crypto.js:65-92`) but are not universally enforced.
- Separate explicit payment statuses and state graph (`packages/core/src/state-machine.js`).
- Receipt fingerprinting and source-audit metadata; good foundations, incomplete invariants.
- Some test coverage exists under `__tests__`; existence of tests alone doesn't prove runtime integrity.

## Highest priority fixes — recommended sequence

### Milestone A: Eliminate immediate exploitation paths (P0 security)

1. Disable **all** admin HTTP routes and observer-ingest endpoints at reverse proxy while auditing. Don't bind API/admin to public interface.
2. Remove the tunnel `/start` command-execution route and never shell out based on network input.
3. Add centralized server authentication and authorization for admin, merchant, observer, operator roles; no ID-based trust.
4. Remove direct manual `SUCCESS` transitions for UPI; require authenticated counter operator and physical-mode matching.
5. Seal secrets: never return Gmail refresh tokens/merchant webhook secrets; remove default pairing tokens; rotate compromised keys.
6. Require signed observer requests with timestamp + nonce + device ownership; internal sources cannot be selected by clients.

**Gate A:** anonymous calls to all protected routes return 401; wrong merchant/role returns 403; arbitrary command execution route no longer exists; signature omission/invalid signature/replay gets 401.

### Milestone B: Make payment finality deterministic (P0 integrity)

1. Define state machine in repository/DB: `INITIATED → QUEUED/ACTIVE → PROCESSING → [SUCCESS | FAILED]`. Use atomic compare-and-swap on every transition. Disallow `EXPIRED/FAILED/CANCELLED → SUCCESS` by ordinary observer intake.
2. Define *two truths*: `PAYMENT_REPORTED` (SMS/mail claim) and `PAYMENT_CONFIRMED` (bank-ledger/acquirer proof or independently reconciled manual bank-credit check). **Only confirmed triggers fulfillment**.
3. Maintain a canonical bank-transaction ledger: unique acquiring account + UTR (when trusted), provenance, exact credit amount and time, observation sources, immutable consumed-by order.
4. Match only within verified merchant/receiving account. No global amount-based fallback. If two orders share amount or evidence is ambiguous, enter `RECONCILIATION_REQUIRED`.
5. Keep synthetic/test observations physically segregated from production records and callbacks.

**Gate B:** one SMS alone never marks a real order bank-confirmed; replayed UTR cannot pay two orders; same-amount different orders don't cross-credit; terminal states cannot reopen; spoofed channel data cannot satisfy proof.

### Milestone C: Reliable commerce integration (P1)

1. Merchant servers create orders with authenticated API keys and backend-locked amounts, not by trusting browser forms.
2. Persist webhook events in a DB outbox in the *same transaction* as financial state; recurring worker delivers at least once and records retries.
3. Sign payload plus timestamp/event ID; client enforces freshness, verifies secret, and deduplicates stable event ID. Restrict outbound destinations.
4. Protect customer identity/session, enforce OTP throttling, audit merchant role isolation.
5. Versioned migrations, backups, health/metrics, latency and security telemetry, secrets management.

**Gate C:** simulate delayed bank messages, same-price concurrent orders, network timeouts, failed webhook delivery, process restart, replay, out-of-order events, wrong merchant, wrong receiving account, and database write failure. Then exercise a small number of reconciled live payments and refunds with explicit bank statements.

## Scenario matrix for controlled verification

| Scenario | Required expected result |
|---|---|
| Anonymous attempts to confirm manual payment | `401`, DB unchanged |
| Wrong merchant attempts to view/change another merchant's settings | `403`, no secret disclosure |
| Unauthenticated or unsigned bank-observation submission | `401`, no observation stored |
| Signed request timestamp replay/duplicate nonce | `401`/idempotent ignore, no financial transition |
| `FAILED` or `EXPIRED` session receives observed message | No automatic success; reconciliation case |
| Two ₹49 orders, one bank credit | At most one confirmed; otherwise ambiguous/manual review |
| Same UTR arrives via Gmail and Android SMS | One bank transaction ledger row, two observation links, one confirmed order |
| New amount matches other merchant's active order | No cross-merchant credit |
| Single plausible but unauthenticated SMS | No confirmed payment |
| Webhook endpoint offline at payment confirmation | Outbox pending; delivery resumes after recovery |
| Gateway restarts after DB update but before HTTP webhook | Pending outbox event survives and delivers |
| Client changes amount from ₹149 to ₹19 | Reject/ignore; server pricing wins |
| OTP sent repeatedly or guessed | Rate limit and attempt cap; no OTP logs |

## Architecture target

```text
Merchant backend (authenticated, controls order amount)
    → Checkout (short-lived order capability)
    → UPI deep link / dynamic QR
    → Trusted observer adapters (mutual auth / signed events)
    → Staged evidence ledger (append-only)
    → Reconciliation engine (merchant+bank account+UTR+amount+time)
        ├── UNVERIFIED / AMBIGUOUS → manual bank verification
        └── BANK_CONFIRMED → atomic payment success + outbox
    → Durable signed webhook (at-least-once)
    → Merchant backend verifies signature, event, amount, order, idempotency
    → Fulfillment
```

**Constraint:** SMS/Gmail observation does not itself constitute authoritative bank settlement verification. Without a bank/acquirer-backed confirmation channel, use independent account-statement review for funds release rather than automatic fulfillment. Self-hosting the app does not eliminate third-party banking conditions, regulatory obligations, hosting costs or fraud risk.

## Evidence, confidence and limitations

- **Confirmed code-path defects**: exposed admin handlers, shell execution route, missing observer authentication, optional Android HMAC, secrets in admin JSON, missing tenant-scoped fallback, success state update lacking state guards, unused webhook retry method; all directly supported by file/line inspection.
- **Architectural risks needing runtime proofs**: exploitation across real public networks, transaction collisions under concurrency, bank-message delivery delays, webhook loss under simulated crashes, full SDK/observer interoperability, regulatory and merchant-bank acceptance.
- **Syntax-only verification**: `node --check` executed on **151** JavaScript/CJS/MJS files, **0** parse failures. No `npm install`, runtime startup, database migration, network access, or upstream test suite was executed. No claim of successful end-to-end behavior is made.
- **Commercial permission unresolved**: no redistribution grant verified in submitted ZIP. Do not assume public visibility means open-source permission.

## Final release gates

- [ ] All P0 issues remediated and independently retested.
- [ ] Bank-observation channel strongly authenticated and tenant bound.
- [ ] Bank-credit confirmation distinguished from observed messages.
- [ ] No state-machine bypass or duplicate-credit under races/replays.
- [ ] Admin endpoints cannot leak secrets or invoke arbitrary shell.
- [ ] Durable webhook outbox, retry worker and consumer idempotency verified.
- [ ] Controlled real-money tests reconciled with bank records, reversals and dispute procedures documented.
- [ ] Authorization, backup, migration, operational security and licensing resolved.

**Deployment decision:** do not expose this build to the public internet or connect customer orders/payment credentials until the blockers are fixed and verified. A localhost-only isolated audit environment is appropriate.
