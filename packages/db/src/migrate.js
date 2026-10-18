import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { getDatabase } from './database.js';
import { MerchantRepository } from './repositories/merchant.repository.js';
import { ReceivingAccountRepository } from './repositories/receiving-account.repository.js';
import { CustomerRepository } from './repositories/customer.repository.js';
import { migrateSecretRows } from '@youpi/common';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolves the seed/default merchant API key for environments where the
 * merchant has not stored one yet. Production never uses a predictable value:
 * a random key is generated (and must be retrieved from the DB or rotated
 * through the authenticated admin API).
 * @returns {string}
 */
function resolveDefaultMerchantApiKey() {
  if (process.env.MERCHANT_API_KEY) return process.env.MERCHANT_API_KEY;
  if (process.env.OPENUPI_MERCHANT_API_KEY) return process.env.OPENUPI_MERCHANT_API_KEY;
  if (process.env.NODE_ENV === 'test') return 'test_merchant_api_key_123';
  if (process.env.NODE_ENV !== 'production') return 'dev_merchant_api_key';
  return crypto.randomBytes(24).toString('hex');
}

/**
 * Runs database migrations and applies base seeds.
 * @param {import('./database.js').Database} [targetDb]
 */
export function runMigrations(targetDb) {
  const db = targetDb || getDatabase();
  const schemaPath = path.join(__dirname, 'sqlite-schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');

  // Detect if customers table has obsolete schema (phone_number/merchant_id instead of email/mobile_number or password_hash NOT NULL).
  // Destructive rebuild is now OPT-IN only (ALLOW_DESTRUCTIVE_MIGRATION=true).
  // Default behavior preserves existing customer/session/ticket records (P1-09):
  // an incompatible legacy schema fails the migration instead of silently wiping data.
  try {
    const tableInfo = db.query ? db.query("PRAGMA table_info(customers)") : [];
    const colNames = (tableInfo || []).map(c => c.name);
    const hasOldColumns = colNames.length > 0 && (
      !colNames.includes('email') ||
      colNames.includes('phone_number') ||
      colNames.includes('merchant_id') ||
      !colNames.includes('otp_code') ||
      tableInfo.some(c => c.name === 'password_hash' && c.notnull === 1)
    );
    if (hasOldColumns) {
      if (process.env.ALLOW_DESTRUCTIVE_MIGRATION === 'true') {
        // Explicit operator opt-in: legacy schema rebuild (will drop customer identity tables).
        try { db.exec("PRAGMA foreign_keys = OFF;"); } catch {}
        try { db.exec("UPDATE payment_sessions SET customer_id = NULL WHERE customer_id IS NOT NULL;"); } catch {}
        try { db.exec("DELETE FROM ticket_messages;"); } catch {}
        try { db.exec("DELETE FROM support_tickets;"); } catch {}
        try { db.exec("DROP TABLE IF EXISTS customer_sessions;"); } catch {}
        try { db.exec("DROP TABLE IF EXISTS customers;"); } catch {}
        try { db.exec("PRAGMA foreign_keys = ON;"); } catch {}
      } else {
        throw new Error(
          'Migration blocked: existing "customers" table has an incompatible legacy schema. ' +
          'Automatic data-destructive migration is disabled by default. ' +
          'Back up the database, then re-run with ALLOW_DESTRUCTIVE_MIGRATION=true to rebuild customer identity tables.'
        );
      }
    }
  } catch (err) {
    if (err && typeof err.message === 'string' && err.message.startsWith('Migration blocked:')) {
      throw err;
    }
    // Unknown inspection failure: fail closed instead of dropping customer data (P1-09).
    throw new Error(
      `Migration blocked: unable to verify customers table schema (${err?.message || 'unknown error'}). ` +
      'Refusing to run destructive migration by default. Back up the database and re-run with ALLOW_DESTRUCTIVE_MIGRATION=true if a legacy rebuild is intended.'
    );
  }

  // Fallback alter columns if customers/sessions table exists without new columns
  try { db.exec("ALTER TABLE customers ADD COLUMN email TEXT;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN mobile_number TEXT;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN otp_code TEXT;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN otp_expires_at TEXT;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN is_phone_verified INTEGER DEFAULT 0;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN ban_reason TEXT;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN banned_at TEXT;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN unbanned_at TEXT;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN last_device TEXT;"); } catch {}
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN device_id TEXT;"); } catch {}
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN verification_level INTEGER DEFAULT 0;"); } catch {}
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN verification_sources TEXT DEFAULT '[]';"); } catch {}
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN verification_tag TEXT DEFAULT 'UNVERIFIED';"); } catch {}

  // Execute schema DDL
  db.exec(schemaSql);

  // Alter table columns if migrating existing databases
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN verification_level INTEGER DEFAULT 0;"); } catch {}
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN verification_sources TEXT DEFAULT '[]';"); } catch {}
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN verification_tag TEXT DEFAULT 'UNVERIFIED';"); } catch {}
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN confirmation_status TEXT NOT NULL DEFAULT 'UNCONFIRMED';"); } catch {}
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN confirmed_at TEXT;"); } catch {}
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN confirmed_by TEXT;"); } catch {}
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN confirmation_note TEXT;"); } catch {}
  try { db.exec("ALTER TABLE merchants ADD COLUMN api_key TEXT;"); } catch {}
  // Canonical bank transaction ledger + durable webhook outbox (idempotent DDL).
  try { db.exec(`
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
  `); } catch {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_txn_unique_ref ON bank_transaction_ledger (receiving_account_id, bank_reference) WHERE bank_reference IS NOT NULL;"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_bank_txn_consumer ON bank_transaction_ledger (consumed_by_session_id);"); } catch {}
  try { db.exec(`
    CREATE TABLE IF NOT EXISTS payment_events_outbox (
      id TEXT PRIMARY KEY,
      payment_id TEXT NOT NULL REFERENCES payment_sessions(id) ON DELETE CASCADE,
      event TEXT NOT NULL,
      flushed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `); } catch {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_pending_event ON payment_events_outbox (payment_id, event) WHERE flushed = 0;"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_outbox_pending ON payment_events_outbox (flushed, created_at);"); } catch {}
  // Observer security (P0-03/P0-04/P0-05): single-use pairing challenges and replay guard.
  try { db.exec(`
    CREATE TABLE IF NOT EXISTS observer_pairing_tokens (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `); } catch {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_pairing_token_hash ON observer_pairing_tokens (token_hash);"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_pairing_token_expiry ON observer_pairing_tokens (expires_at);"); } catch {}
  try { db.exec(`
    CREATE TABLE IF NOT EXISTS observer_request_nonces (
      nonce TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_observer_nonce_created ON observer_request_nonces (created_at);"); } catch {}
  // Dedicated observer credentials, separated from merchant/admin API keys.
  try { db.exec(`
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
  `); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_observer_credential_merchant ON observer_credentials (merchant_id, status);"); } catch {}
  // Authoritative bank/acquirer confirmations (BANK_CONFIRMED provenance only).
  try { db.exec(`
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
  `); } catch {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_confirmation_unique ON bank_confirmations (receiving_account_id, bank_reference);"); } catch {}
  // Scoped, expiring checkout credential for payment-status polling.
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN checkout_token_hash TEXT;"); } catch {}
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN checkout_token_expires_at TEXT;"); } catch {}
  // Idempotent webhook delivery: one delivery row per (payment, event).
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_delivery_idempotency ON webhook_deliveries (payment_id, event_type);"); } catch {}
  // P2-03: independent unique constraint for merchant idempotency keys.
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_idempotency ON payment_sessions (merchant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;"); } catch {}
  try { db.exec("ALTER TABLE payment_receiving_accounts ADD COLUMN is_merchant_enabled INTEGER NOT NULL DEFAULT 1;"); } catch {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_single_active_vpa_per_merchant ON payment_receiving_accounts (merchant_id) WHERE is_active = 1;"); } catch {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_email ON customers (email);"); } catch {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_mobile ON customers (mobile_number);"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN ban_reason TEXT;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN banned_at TEXT;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN unbanned_at TEXT;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN last_device TEXT;"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_customer_sessions_token ON customer_sessions (token, is_active);"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_customer_sessions_customer ON customer_sessions (customer_id);"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_security_events_customer ON security_events (customer_id);"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_security_events_session ON security_events (payment_session_id);"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events (event_type);"); } catch {}
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN device_id TEXT REFERENCES devices(id);"); } catch {}
  try { db.exec(`
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
  `); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_devices_customer ON devices (customer_id);"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_devices_fingerprint ON devices (fingerprint_hash);"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_devices_token ON devices (device_token);"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_payment_sessions_device ON payment_sessions (device_id);"); } catch {}

  // Seed default merchant if empty
  const merchantRepo = new MerchantRepository(db);
  const existing = merchantRepo.findAll();

  let defaultMerchant;
  if (existing.length === 0) {
    defaultMerchant = merchantRepo.create({
      id: '00000000-0000-0000-0000-000000000001',
      businessName: 'YOUPI Demo Store',
      slug: 'demo-store',
      contactEmail: 'merchant@youpi.local',
      contactPhone: '9876543210',
      webhookUrl: process.env.COIN_STORE_WEBHOOK_URL || 'http://localhost:5000/api/webhook',
      webhookSecret: process.env.COIN_STORE_WEBHOOK_SECRET || 'merchant_webhook_secret_for_wallet_store',
      branding: {
        appName: 'YOUPI PG',
        primaryColor: '#2563eb',
        logoUrl: null
      }
    });
  } else {
    defaultMerchant = existing[0];
    if (!defaultMerchant.webhookSecret) {
      merchantRepo.update(defaultMerchant.id, {
        webhookUrl: 'http://localhost:5000/api/webhook',
        webhookSecret: 'merchant_webhook_secret_for_wallet_store'
      });
    }
  }

  // Ensure every merchant has a merchant API key (used to authenticate
  // merchant-server API calls such as payment creation). Production without
  // MERCHANT_API_KEY gets a random key that must be read from the database or
  // rotated via the authenticated admin API; dev/test get documented local defaults.
  for (const m of merchantRepo.findAll()) {
    if (!m.apiKey) {
      merchantRepo.update(m.id, { apiKey: resolveDefaultMerchantApiKey() });
    }
  }

  // Seal legacy plaintext secrets at rest (safe, idempotent migration): device
  // signing keys and observer credential secrets are re-written encrypted and the
  // plaintext copies are replaced in place.
  try {
    const deviceRows = db.query("SELECT id, signing_key_hash AS value FROM android_devices WHERE signing_key_hash IS NOT NULL").map(r => ({ id: r.id, value: r.value }));
    migrateSecretRows(deviceRows, (id, sealedValue) => {
      db.execute('UPDATE android_devices SET signing_key_hash = ? WHERE id = ?', [sealedValue, id]);
    });
  } catch {}

  try {
    const credRows = db.query("SELECT id, secret_enc AS value FROM observer_credentials WHERE secret_enc IS NOT NULL").map(r => ({ id: r.id, value: r.value }));
    migrateSecretRows(credRows, (id, sealedValue) => {
      db.execute('UPDATE observer_credentials SET secret_enc = ? WHERE id = ?', [sealedValue, id]);
    });
  } catch {}

  // Seed default UPI receiving account if none
  const accountRepo = new ReceivingAccountRepository(db);
  const accounts = accountRepo.findByMerchantId(defaultMerchant.id);
  if (accounts.length === 0) {
    accountRepo.create({
      id: '00000000-0000-0000-0000-000000000002',
      merchantId: defaultMerchant.id,
      upiId: 'merchant@upi',
      payeeName: defaultMerchant.businessName,
      isActive: true
    });
  }

  // Seed default customer if none exists
  const customerRepo = new CustomerRepository(db);
  const existingCust = customerRepo.findByMobile('9212339720');
  if (!existingCust) {
    customerRepo.create({
      id: '00000000-0000-0000-0000-000000000002',
      name: 'Gaurav Mehra',
      email: 'gauravmehra09876@gmail.com',
      mobileNumber: '9212339720',
      isPhoneVerified: true
    });
  }

  return {
    db,
    defaultMerchant
  };
}

/**
 * Completely wipes all customer identity records and active sessions,
 * reinitializing the customer identity store to a pristine state.
 * @param {import('./database.js').Database} [targetDb]
 */
export function reinitializeCustomerIdentity(targetDb) {
  const db = targetDb || getDatabase();
  try { db.exec("PRAGMA foreign_keys = OFF;"); } catch {}
  try { db.exec("UPDATE payment_sessions SET customer_id = NULL WHERE customer_id IS NOT NULL;"); } catch {}
  try { db.exec("DELETE FROM customer_sessions;"); } catch {}
  try { db.exec("DELETE FROM customers;"); } catch {}
  try { db.exec("PRAGMA foreign_keys = ON;"); } catch {}
  return { success: true, message: 'All old customer identity records wiped and reinitialized.' };
}

// Auto-run if executed directly as script
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log('Running YOUPI PG database migrations...');
  const result = runMigrations();
  console.log(`Migration completed successfully. Default merchant: ${result.defaultMerchant.businessName} (${result.defaultMerchant.id})`);
}
