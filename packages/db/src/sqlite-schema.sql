-- SQLite Schema for YOUPI PG
-- Native Local / Zero-Dependency Execution

-- 1. Merchants Table
CREATE TABLE IF NOT EXISTS merchants (
    id TEXT PRIMARY KEY,
    business_name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    contact_email TEXT NOT NULL,
    contact_phone TEXT NOT NULL,
    webhook_url TEXT,
    webhook_secret TEXT NOT NULL,
    api_key TEXT,
    branding TEXT NOT NULL DEFAULT '{"primaryColor":"#2563eb","appName":"YOUPI PG","logoUrl":null}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2. Payment Receiving Accounts
CREATE TABLE IF NOT EXISTS payment_receiving_accounts (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    upi_id TEXT NOT NULL,
    payee_name TEXT NOT NULL,
    is_merchant_enabled INTEGER NOT NULL DEFAULT 1,
    is_active INTEGER NOT NULL DEFAULT 1,
    is_slot_busy INTEGER NOT NULL DEFAULT 0,
    current_active_session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_single_active_vpa_per_merchant ON payment_receiving_accounts (merchant_id) WHERE is_active = 1;

-- 3. Customers Table (Gateway-owned Customer Identity with WhatsApp Berry OTP)
CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    mobile_number TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    otp_code TEXT,
    otp_expires_at TEXT,
    is_phone_verified INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    last_login_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_email ON customers (email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_mobile ON customers (mobile_number);

-- 3b. Customer Sessions Table (Server-authoritative session engine)
CREATE TABLE IF NOT EXISTS customer_sessions (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    ip_address TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_customer_sessions_token ON customer_sessions (token, is_active);
CREATE INDEX IF NOT EXISTS idx_customer_sessions_customer ON customer_sessions (customer_id);

-- 4. Payment Sessions Table
CREATE TABLE IF NOT EXISTS payment_sessions (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
    receiving_account_id TEXT REFERENCES payment_receiving_accounts(id),
    order_id TEXT NOT NULL,
    amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
    currency TEXT NOT NULL DEFAULT 'INR',
    method TEXT NOT NULL DEFAULT 'UPI',
    status TEXT NOT NULL DEFAULT 'INITIATED',
    queue_position INTEGER DEFAULT 0,
    slot_acquired_at TEXT,
    expires_at TEXT,
    processing_started_at TEXT,
    processing_expires_at TEXT,
    completed_at TEXT,
    return_url TEXT,
    attributed_observation_id TEXT,
    idempotency_key TEXT,
    device_id TEXT REFERENCES devices(id),
    verification_level INTEGER DEFAULT 0,
    verification_sources TEXT DEFAULT '[]',
    verification_tag TEXT DEFAULT 'UNVERIFIED',
    confirmation_status TEXT NOT NULL DEFAULT 'UNCONFIRMED',
    confirmed_at TEXT,
    confirmed_by TEXT,
    confirmation_note TEXT,
    checkout_token_hash TEXT,
    checkout_token_expires_at TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(merchant_id, order_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_sessions_active ON payment_sessions (receiving_account_id, status);

-- 5b. Canonical Bank Transaction Ledger (P1-02): one row per observed bank credit
-- reference per receiving account, uniquely reserved once by one order.
CREATE TABLE IF NOT EXISTS bank_transaction_ledger (
    id TEXT PRIMARY KEY,
    receiving_account_id TEXT NOT NULL REFERENCES payment_receiving_accounts(id) ON DELETE CASCADE,
    merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    bank_reference TEXT,
    amount_paise INTEGER NOT NULL,
    observed_at TEXT,
    first_observation_id TEXT,
    first_source TEXT,
    consumed_by_session_id TEXT REFERENCES payment_sessions(id) ON DELETE SET NULL,
    provenance TEXT NOT NULL DEFAULT 'OBSERVED',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_txn_unique_ref
    ON bank_transaction_ledger (receiving_account_id, bank_reference)
    WHERE bank_reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bank_txn_consumer ON bank_transaction_ledger (consumed_by_session_id);

-- 7b. Durable Webhook Outbox: rows are written in the SAME transaction as the
-- payment state transition, then flushed to webhook_deliveries (at-least-once).
CREATE TABLE IF NOT EXISTS payment_events_outbox (
    id TEXT PRIMARY KEY,
    payment_id TEXT NOT NULL REFERENCES payment_sessions(id) ON DELETE CASCADE,
    event TEXT NOT NULL,
    flushed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_pending_event
    ON payment_events_outbox (payment_id, event) WHERE flushed = 0;
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON payment_events_outbox (flushed, created_at);

-- 5a-0. Observer security tables (audit P0-03/P0-04/P0-05):
-- single-use short-lived pairing challenges (token stored hashed) and the
-- replay guard for signed observer/device requests.
CREATE TABLE IF NOT EXISTS observer_pairing_tokens (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pairing_token_hash ON observer_pairing_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_pairing_token_expiry ON observer_pairing_tokens (expires_at);

CREATE TABLE IF NOT EXISTS observer_request_nonces (
    nonce TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 5a-2. Dedicated observer credentials (observer hardening sprint item 1):
-- observation ingest authenticates with its OWN credential, never with a merchant
-- or admin API key. Only the (encrypted) secret is stored; the caller presents the
-- public key_id and signs with the secret.
CREATE TABLE IF NOT EXISTS observer_credentials (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    key_id TEXT NOT NULL UNIQUE,
    label TEXT,
    secret_enc TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    rotated_at TEXT,
    revoked_at TEXT,
    last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_observer_credential_merchant ON observer_credentials (merchant_id, status);

-- 7c. Authoritative bank/acquirer confirmations. A row here is the ONLY automatic
-- source of BANK_CONFIRMED provenance; corroborated observer reports can raise
-- evidence but can never confirm a payment on their own.
CREATE TABLE IF NOT EXISTS bank_confirmations (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    receiving_account_id TEXT NOT NULL REFERENCES payment_receiving_accounts(id) ON DELETE CASCADE,
    bank_reference TEXT NOT NULL,
    amount_paise INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'ACQUIRER',
    confirmed_by TEXT NOT NULL,
    raw_payload TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_confirmation_unique
    ON bank_confirmations (receiving_account_id, bank_reference);

-- 5. Payment Observations Table
CREATE TABLE IF NOT EXISTS payment_observations (
    id TEXT PRIMARY KEY,
    receiving_account_id TEXT NOT NULL REFERENCES payment_receiving_accounts(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    amount_paise INTEGER NOT NULL,
    observed_at TEXT NOT NULL,
    ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
    sender_vpa TEXT,
    bank_reference_number TEXT,
    fingerprint_hash TEXT NOT NULL,
    raw_payload TEXT NOT NULL DEFAULT '{}',
    attribution_status TEXT NOT NULL DEFAULT 'UNATTRIBUTED',
    attributed_payment_id TEXT REFERENCES payment_sessions(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_observations_match ON payment_observations (receiving_account_id, amount_paise, attribution_status);

-- 6. Android Devices Table
CREATE TABLE IF NOT EXISTS android_devices (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    device_name TEXT NOT NULL,
    device_model TEXT,
    signing_key_hash TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    last_heartbeat_at TEXT,
    last_observation_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 7. Webhook Deliveries Table
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    payment_id TEXT NOT NULL REFERENCES payment_sessions(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    endpoint_url TEXT NOT NULL,
    response_status INTEGER,
    response_body TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 1,
    is_successful INTEGER NOT NULL DEFAULT 0,
    next_retry_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 8. Support Tickets & Ticket Messages
CREATE TABLE IF NOT EXISTS support_tickets (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    payment_id TEXT REFERENCES payment_sessions(id) ON DELETE SET NULL,
    subject TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ticket_messages (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    sender_type TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    message TEXT NOT NULL,
    attachments TEXT DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 9. Audit Logs Table
CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    merchant_id TEXT REFERENCES merchants(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    details TEXT NOT NULL DEFAULT '{}',
    ip_address TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 10. Security Events Table (Forensic evidence for fraud, automatic and manual bans)
CREATE TABLE IF NOT EXISTS security_events (
    id TEXT PRIMARY KEY,
    merchant_id TEXT,
    customer_id TEXT,
    payment_session_id TEXT,
    event_type TEXT NOT NULL,
    source TEXT,
    sender TEXT,
    device_info TEXT,
    raw_message TEXT NOT NULL,
    normalized_message TEXT,
    extracted_amount TEXT,
    extracted_reference TEXT,
    parser_results TEXT DEFAULT '{}',
    verification_results TEXT DEFAULT '{}',
    fraud_reason TEXT NOT NULL,
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_security_events_customer ON security_events (customer_id);
CREATE INDEX IF NOT EXISTS idx_security_events_session ON security_events (payment_session_id);
CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events (event_type);

-- 11. Devices Table (Cryptographic Device Binding & Hardware Context Fingerprinting)
CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
    public_key TEXT NOT NULL,
    fingerprint_hash TEXT NOT NULL,
    user_agent TEXT,
    platform TEXT,
    browser TEXT,
    timezone TEXT,
    language TEXT,
    screen_signature TEXT,
    device_token TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_devices_customer ON devices (customer_id);
CREATE INDEX IF NOT EXISTS idx_devices_fingerprint ON devices (fingerprint_hash);
CREATE INDEX IF NOT EXISTS idx_devices_token ON devices (device_token);
CREATE INDEX IF NOT EXISTS idx_payment_sessions_device ON payment_sessions (device_id);



-- Reconciliation queue for bank credits that cannot be attributed to a live
-- payment (late arrival after terminal state, or unmatchable credit). Evidence
-- only: a case never changes payment status and never produces SUCCESS.
CREATE TABLE IF NOT EXISTS payment_review_cases (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    receiving_account_id TEXT NOT NULL REFERENCES payment_receiving_accounts(id) ON DELETE CASCADE,
    payment_session_id TEXT REFERENCES payment_sessions(id) ON DELETE SET NULL,
    observation_id TEXT UNIQUE,
    amount_paise INTEGER NOT NULL,
    bank_reference TEXT,
    source TEXT,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT,
    resolved_by TEXT,
    resolution_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_payment_review_status ON payment_review_cases (status, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_review_merchant ON payment_review_cases (merchant_id, status);
