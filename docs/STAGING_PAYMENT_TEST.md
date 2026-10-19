# Staging Payment Test — Real ₹10 UPI

This is the acceptance runbook for a **real ₹10 Paytm UPI payment** observed by the
Android notification observer on a single VPS, using host Nginx for HTTPS and the
minimal staging compose stack.

> Browser events and SMS/notification observations are **evidence only**. A session
> becomes `SUCCESS` only when the verification engine settles it. Never treat a
> notification, a browser event, or a `VERIFYING` status as bank confirmation.

---

## 1. What runs

| Container | Host bind | Public? | Purpose |
| :--- | :--- | :--- | :--- |
| `payment-api` | `127.0.0.1:6100` | via `pay-api.<domain>` (allowlisted paths) | state machine, verification, signed observer ingest, webhooks |
| `checkout-portal` | `127.0.0.1:7000` | via `pay.<domain>` | checkout page, `youpi.js`, `/api` proxy |
| `merchant-admin` | `127.0.0.1:6001` | **no** — SSH tunnel only | VPA setup, pairing QR, device list |

Not started: control-center, Gmail observer, Node SMS/browser automator, demo store,
WhatsApp session. Their source is untouched and can be re-enabled later.

Persistent state lives in the named volume `youpi-staging_youpi-data` at
`/data/youpi.sqlite` (SQLite WAL). The container runs as the unprivileged `node` user.

---

## 2. Prerequisites on the VPS

- Docker Engine 24+ with Compose v2 (`docker compose version`)
- Nginx already installed and serving other sites
- DNS `A` records for `pay.<domain>` and `pay-api.<domain>` pointing at the VPS
- Ports 80/443 free for Nginx; 6001/6100/7000 **not** opened in the firewall

---

## 3. Deploy the stack

```bash
git clone <repo-url> youpi && cd youpi
git checkout fix/payment-integrity-verified

cp .env.staging.example .env.staging
chmod 600 .env.staging
```

Edit `.env.staging` and replace at least:

```dotenv
CLOUDFLARE_DOMAIN=staging.example.com
BASE_CHECKOUT_URL=https://pay.staging.example.com
BASE_PAYMENT_API_URL=https://pay-api.staging.example.com
ADMIN_API_KEY=<64 hex chars>
MERCHANT_API_KEY=<separate strong value>
YOUPI_SECRET_KEY=<64 hex chars>
```

Generate each secret independently:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Build and start (migrations run automatically on first boot). Tag the working
image before every later upgrade so rollback has a known-good target:

```bash
docker compose -f docker-compose.staging.yml --env-file .env.staging build
docker tag youpi-pg:staging youpi-pg:staging-initial
docker compose -f docker-compose.staging.yml --env-file .env.staging up -d
docker compose -f docker-compose.staging.yml --env-file .env.staging ps
```

All three containers must report `healthy`:

```bash
docker compose -f docker-compose.staging.yml --env-file .env.staging ps --format 'table {{.Name}}\t{{.Status}}'
```

Check the loopback-only bindings on the VPS:

```bash
ss -lntp | grep -E ':(6001|6100|7000)\b'   # must show 127.0.0.1, never 0.0.0.0
```

---

## 4. HTTPS with the existing host Nginx

```bash
sudo cp deploy/nginx/youpi-staging.conf.example /etc/nginx/sites-available/youpi-staging
sudo sed -i 's/staging\.example\.com/your-real-domain/g' /etc/nginx/sites-available/youpi-staging
sudo ln -s /etc/nginx/sites-available/youpi-staging /etc/nginx/sites-enabled/youpi-staging
sudo mkdir -p /var/www/html
sudo nginx -t && sudo systemctl reload nginx
```

The sample starts on port 80 so certbot can answer the ACME challenge, then
upgrades both server blocks to HTTPS in place:

```bash
sudo certbot --nginx -d pay.your-real-domain -d pay-api.your-real-domain
sudo nginx -t && sudo systemctl reload nginx
```

If you already have certificates, add `listen 443 ssl;` plus the
`ssl_certificate`/`ssl_certificate_key` lines to each block instead of running
certbot, and keep every `proxy_set_header` line unchanged.

The vhost exposes only:

- `pay.<domain>` → `/checkout/*`, `/youpi.js`, `/sdk/*`, `/icons/*`, `/api/*` (admin blocked)
- `pay-api.<domain>` → `/health`, `/api/v1/health`, `/api/v1/payments`, `/api/v1/checkout/*`, `/api/v1/pollers/*`, `/api/v1/observers/*`
- Everything else, including `/api/v1/admin/*` and the developer
  `/api/v1/checkout/:id/simulate-observation` injector, returns 404.

Verify from outside:

```bash
curl -fsS https://pay.<domain>/health
curl -fsS https://pay-api.<domain>/health
curl -fsS -o /dev/null -w '%{http_code}\n' https://pay.<domain>/youpi.js      # 200
curl -s -o /dev/null -w '%{http_code}\n' https://pay-api.<domain>/api/v1/admin/payments  # 404 (Nginx)
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://pay.<domain>/api/v1/pollers/android/events  # 404 (Nginx)
curl -s -o /dev/null -w '%{http_code}\n' http://<vps-ip>:6100/health          # connection refused
```

---

## 5. Admin access (private) and device pairing

Open an SSH tunnel from your laptop:

```bash
ssh -N -L 6001:127.0.0.1:6001 <user>@<vps>
```

Then open `http://127.0.0.1:6001` and:

1. Set the merchant **receiving VPA** and payee name to the real account that will
   receive the ₹10 (UPI settings / receiving account tab). Save.
2. Open **Observers & Pairing → Pair Android Device**.
3. Confirm the QR payload `serverUrl` is `https://pay-api.<domain>` (derived from
   `YOUPI_MODE=production`, `CLOUDFLARE_DOMAIN`, `DEPLOYMENT_PREFIX`).
4. Install the observer APK on the merchant phone (download it from
   `http://127.0.0.1:6001/youpi-sms-gateway.apk` while the tunnel is open), grant
   Notification Listener access, exempt it from battery optimization, then scan
   the QR (or enter the enrollment token + gateway URL manually).

The pairing token is single-use and expires in 10 minutes. Each observation is
signed with the device key (`HMAC-SHA256(body + ":" + timestamp)`) and replayed
requests are rejected. The merchant API key is attached server-side by the admin
proxy only for allowlisted pairing calls from the trusted compose gateway.

Verify the device appears under **Observers & Pairing** and sends heartbeats:

```bash
docker compose -f docker-compose.staging.yml --env-file .env.staging logs -f payment-api
```

---

## 6. Create the ₹10 payment

On the VPS (or your laptop against the public API):

```bash
set -a; . ./.env.staging; set +a
ORDER="STAGING-10-$(date +%s)"

curl -sS -X POST https://pay-api.<domain>/api/v1/payments \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $MERCHANT_API_KEY" \
  -H "Idempotency-Key: $ORDER" \
  -d "{\"orderId\":\"$ORDER\",\"amount\":10.00,\"currency\":\"INR\",\"customer\":{\"name\":\"Staging Test\",\"email\":\"staging@example.com\",\"phone\":\"9876543210\"}}" \
  | tee /tmp/youpi-payment.json
```

The response contains `paymentId`, `checkoutUrl`, and `checkoutToken`. UPI sessions
start as `INITIATED`; the 5-minute slot/timer starts only after customer sign-in.

Open `checkoutUrl` in a browser:

1. Sign in with a mobile number. **Customer OTP delivery uses WhatsApp/Berry, which
   is intentionally not running in this stack.** The existing server behavior prints
   the OTP to the payment-api log; retrieve it with:
   ```bash
   docker compose -f docker-compose.staging.yml --env-file .env.staging logs payment-api | grep "OTP generated" | tail -1
   ```
   This is a staging-only operational step, not a change to verification or payment
   security. If a delivered OTP is required, wire the WhatsApp/Berry service or an
   SMS/email OTP channel before the next test.
2. After sign-in the checkout shows the live UPI QR for the configured VPA.
3. Pay **₹10.00** from Paytm to that VPA. Keep the Paytm success screen with the UTR.

---

## 6a. Staging Payment Test Console (no OTP, no merchant credentials)

The private merchant-admin app now ships an opt-in test console that creates a
real `PENDING`/`ACTIVE` payment through the same merchant/payment API and returns a
scoped, unguessable guest checkout link. It is **disabled by default** and is never
proxied by Nginx.

Enable it only on staging, in `.env.staging`:

```dotenv
YOUPI_TEST_CONSOLE_ENABLED=1
YOUPI_TEST_CONSOLE_TOKEN=<at least 24 random chars, NOT the merchant key>
BASE_CHECKOUT_URL=https://pay.169.58.29.37.sslip.io
```

Generate the token with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
then recreate the admin container:

```bash
docker compose -f docker-compose.staging.yml --env-file .env.staging up -d --force-recreate merchant-admin
ssh -N -L 6001:127.0.0.1:6001 <user>@<vps>
```

Open `http://127.0.0.1:6001/test-console`, unlock with `YOUPI_TEST_CONSOLE_TOKEN`,
enter an amount between ₹1 and ₹100 (default ₹10) and press **Generate Payment Link**.

- The merchant API key is attached server-side only; it never reaches the browser.
- The link is `https://pay.169.58.29.37.sslip.io/checkout/<id>?t=<scoped-token>`.
- Share it with the friend. No merchant login and no WhatsApp OTP are required for
  that session, because it is explicitly marked `metadata.guestCheckout`.
- The console shows `AWAITING_PAYMENT` → `PAYMENT_DETECTED` when the signed Android
  SMS observation is attributed, and `SUCCESS` only after bank confirmation.
- It also shows observation → matched → persisted → visible timings. These come from
  `payment_observation_latency` and are telemetry only.

Nginx coverage for the generated link (already present in the staging template):

| Generated route | Nginx location |
| :--- | :--- |
| `/checkout/<id>?t=…` | `location ^~ /checkout/` on `pay.<domain>` |
| `/checkout/<id>/qr.svg?t=…` | same `/checkout/` block |
| `/api/v1/checkout/<id>/state?t=…` | `location ^~ /api/` on `pay.<domain>` |
| `/api/v1/checkout/<id>/stream?t=…` (SSE) | same `/api/` block, `proxy_buffering off` |

The console page itself is served from `merchant-admin:6001` over the SSH tunnel.
There is no public route for it, and `/api/v1/admin/*`, `/api/v1/pollers/*` and
`/api/v1/observers/*` remain `404` on the public checkout host.

Run the complete synthetic flow (console create → guest checkout → signed Android
SMS → `PAYMENT_DETECTED` → authoritative bank confirmation) against a temporary
real SQLite database, including latency percentiles:

```bash
node scripts/test-console-e2e.mjs --iterations=20
```

The script asserts that SMS alone never reaches `SUCCESS`, that one bank reference
is reserved exactly once, and prints p50/p95/p99 for observation → ingest, console
SSE event and console-visible status.

---

## 7. Observe and confirm

Watch the API and observer logs:

```bash
docker compose -f docker-compose.staging.yml --env-file .env.staging logs -f payment-api
```

Poll the checkout state (token comes from the create response):

```bash
TOKEN=$(node -e "console.log(require('/tmp/youpi-payment.json').checkoutToken)")
PAYMENT_ID=$(node -e "console.log(require('/tmp/youpi-payment.json').paymentId)")

curl -sS "https://pay.<domain>/api/v1/checkout/$PAYMENT_ID/state?t=$TOKEN" | tee /tmp/youpi-state.json

# Merchant-side status polling on the API host (credential scoped)
curl -sS -H "X-API-Key: $MERCHANT_API_KEY" \
  "https://pay-api.<domain>/api/v1/payments/$PAYMENT_ID"
```

Expected progression:

| Stage | Status | Meaning |
| :--- | :--- | :--- |
| QR displayed | `ACTIVE` | slot held, timer running |
| notification received | `ACTIVE`/`PROCESSING`, `paymentDetected: true` | observation evidence only (`PAYMENT_DETECTED`) |
| authoritative bank/acquirer confirmation | `SUCCESS` + `BANK_CONFIRMED` | the only settlement path |
| one SMS/email alone | stays `ACTIVE`/`REPORTED` | never settlement; waits for bank evidence or manual review |
| mismatch / late credit | `FAILED` or reconciliation case | not settled; review evidence |

`SUCCESS` in the browser/checkout is **not** proof for fulfilment. Confirm
independently:

1. The Paytm transaction details UTR matches `bankReferenceNumber`/`utr` in the log
   and the state payload.
2. The ₹10.00 credit appears in the merchant bank statement / Paytm passbook with
   that UTR.
3. If a merchant webhook is configured, the received payload has
   `event: "SUCCESS"` and a valid `X-Gateway-Signature` HMAC over the raw body.

Only after all three should the order be treated as paid. A notification alone must
never be turned into `BANK_CONFIRMED` or `SUCCESS`.

Useful private checks (from the VPS or SSH tunnel):

```bash
curl -sS -H "X-Admin-Key: $ADMIN_API_KEY" -H "X-Forwarded-Proto: https" \
  "http://127.0.0.1:6100/api/v1/admin/payments?limit=5" | head -c 2000

curl -sS -H "X-Admin-Key: $ADMIN_API_KEY" -H "X-Forwarded-Proto: https" \
  http://127.0.0.1:6100/api/v1/admin/reconciliation-cases
```

---

## 8. Persistence, graceful shutdown, restart recovery

```bash
# Graceful stop/start (SIGTERM is forwarded; SQLite closes cleanly)
docker compose -f docker-compose.staging.yml --env-file .env.staging restart payment-api

# Hard restart recovery
docker compose -f docker-compose.staging.yml --env-file .env.staging kill -s SIGKILL payment-api
docker compose -f docker-compose.staging.yml --env-file .env.staging up -d payment-api

# Confirm the same database file survived (row count must be non-zero and stable)
docker compose -f docker-compose.staging.yml --env-file .env.staging exec payment-api \
  node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/youpi.sqlite');console.log(d.prepare('select count(*) c from payment_sessions').get())"

# Confirm the payment is still readable after restart
curl -sS "https://pay.<domain>/api/v1/checkout/$PAYMENT_ID/state?t=$TOKEN"
```

Restart policy `unless-stopped` brings containers back after a reboot / crash.

---

## 9. Logs, backups, rollback

```bash
# Logs
docker compose -f docker-compose.staging.yml --env-file .env.staging logs -f --tail=200 payment-api
docker compose -f docker-compose.staging.yml --env-file .env.staging logs -f --tail=200 checkout-portal merchant-admin

# Backup SQLite (while running; WAL is included by the SQLite backup-safe copy below)
docker compose -f docker-compose.staging.yml --env-file .env.staging exec -T payment-api \
  node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/youpi.sqlite');d.exec(\"VACUUM INTO '/data/backup-staging.sqlite'\");console.log('backup written')"
docker compose -f docker-compose.staging.yml --env-file .env.staging cp \
  payment-api:/data/backup-staging.sqlite ./youpi-staging-backup.sqlite

# Stop without deleting the database
docker compose -f docker-compose.staging.yml --env-file .env.staging down

# Before upgrading, preserve the current image:
docker tag youpi-pg:staging youpi-pg:staging-previous

# Rollback application code (volume/data preserved)
docker tag youpi-pg:staging youpi-pg:staging-broken
docker tag youpi-pg:staging-previous youpi-pg:staging
docker compose -f docker-compose.staging.yml --env-file .env.staging up -d --force-recreate
```

Never run `down -v` unless you explicitly intend to delete the SQLite volume.
`ALLOW_DESTRUCTIVE_MIGRATION=true` is not a rollback mechanism.

---

## 9a. Mobile / responsive verification

The merchant dashboard, test console and guest checkout are audited in a real
headless Chrome at **1440 (desktop), 768 (tablet) and 390 (phone)** px. No
Playwright/Puppeteer dependency is required — the script drives the locally
installed Chrome over the DevTools Protocol.

```bash
# CHROME_PATH=<path to chrome> if it is not in a standard location
npm run audit:layout
# screenshots + report.json -> artifacts/mobile-audit/
```

The audit fails when any current page has an element outside the viewport or a
phone-width inline grid whose content overflows its card. It also renders the
`HEAD` version of each page for before/after screenshots; those baseline issues
are printed for comparison and never fail the run.

`npm test` covers the same contracts statically
(`apps/merchant-admin/src/__tests__/responsive-ui.test.js`), so CI without a
browser still catches a removed breakpoint, a disabled zoom lock or an
unwrapped data table.

---

## 10. Known staging constraints

- **OTP delivery**: WhatsApp/Berry is disabled. Use the test console (§6a) for a
  scoped guest link; the older manual flow reads the customer sign-in OTP from the
  server log. Do not expose those logs publicly.
- **Test console**: opt-in via `YOUPI_TEST_CONSOLE_ENABLED`; keep it off in
  production and never proxy port 6001.
- **Responsive UI**: verified for the dashboard, test console and checkout. The
  Android observer app is a native surface and is not covered by the browser audit.
- **Gmail/browser observers**: not started. Verification relies on the signed
  Android observer (and any other enabled observer you add later).
- **Admin**: not proxied by Nginx. Use the SSH tunnel.
- **Webhook target**: the seeded demo webhook points at `localhost:5000` (demo store,
  not running). Set the merchant webhook URL/secret in admin before relying on
  merchant fulfilment.
- **Do not** add a force-success endpoint, relax signature/replay checks, or fulfil
  orders from browser events while testing.
