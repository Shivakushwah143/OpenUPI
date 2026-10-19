import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDatabase, MerchantRepository, SupportTicketRepository } from '@youpi/db';
import { TestConsole, readTestConsoleConfig } from './test-console.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In production, reliably ensure environment variables from .env are loaded if not already provided
if (!process.env.BASE_PAYMENT_API_URL && typeof process.loadEnvFile === 'function') {
  try {
    const rootEnv = path.resolve(__dirname, '../../../.env');
    if (fs.existsSync(rootEnv)) {
      process.loadEnvFile(rootEnv);
    }
  } catch {}
}

/**
 * Gateway endpoints the local merchant console may call with the merchant
 * credential attached server-side. Kept deliberately narrow: pairing QR, device
 * list and device unpair only — never payments, refunds or bank confirmations.
 */
export const PAIRING_PROXY_ALLOWLIST = Object.freeze({
  '/api/v1/admin/sms-gateway/pair-qr': ['GET'],
  '/api/v1/admin/sms-gateway/pairing-tokens/revoke': ['POST'],
  '/api/v1/admin/sms-gateway/devices': ['GET']
});

const isLoopbackAddress = address => {
  const addr = String(address || '').replace(/^::ffff:/, '');
  return addr === '127.0.0.1' || addr === '::1';
};

/**
 * Explicitly trusted reverse-proxy/Docker-gateway sources. Attaching the merchant
 * credential is a privileged action, so anything outside loopback must be opted
 * into by the operator. Accepts comma-separated IPv4 addresses and CIDRs.
 */
export function resolveTrustedAdminProxies(env = process.env) {
  return String(env.MERCHANT_ADMIN_TRUSTED_PROXIES || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

function ipv4ToInt(address) {
  const parts = String(address || '').replace(/^::ffff:/, '').split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value * 256) + octet;
  }
  return value >>> 0;
}

function addressMatchesEntry(address, entry) {
  const addr = String(address || '').replace(/^::ffff:/, '');
  if (addr === entry) return true;
  if (!entry.includes('/')) return false;

  const [network, bitsRaw] = entry.split('/');
  const bits = Number(bitsRaw);
  const addrInt = ipv4ToInt(addr);
  const networkInt = ipv4ToInt(network);
  if (addrInt === null || networkInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;

  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (addrInt & mask) === (networkInt & mask);
}

/**
 * Loopback always qualifies (single-host installs). Container deployments add the
 * compose gateway CIDR through MERCHANT_ADMIN_TRUSTED_PROXIES.
 */
export function isTrustedAdminSource(address, env = process.env) {
  if (isLoopbackAddress(address)) return true;
  return resolveTrustedAdminProxies(env).some(entry => addressMatchesEntry(address, entry));
}

/**
 * Decides whether to attach the merchant API key to a proxied gateway request.
 * Requires: loopback (or explicitly trusted proxy) caller, allowlisted
 * path+method, and NO caller-supplied gateway credential (which is forwarded
 * untouched instead).
 * @param {{ socket?: { remoteAddress?: string }, method?: string, headers?: Record<string, any> }} req
 * @param {string} pathname
 * @returns {boolean}
 */
export function shouldAttachPairingCredential(req, pathname) {
  if (!isTrustedAdminSource(req?.socket?.remoteAddress)) return false;

  const headers = req?.headers || {};
  if (headers['x-api-key'] || headers['x-admin-key'] || headers['authorization']) return false;

  const method = String(req?.method || '').toUpperCase();
  const allowedMethods = PAIRING_PROXY_ALLOWLIST[pathname];
  if (allowedMethods && allowedMethods.includes(method)) return true;

  // Device unpair: DELETE /api/v1/admin/sms-gateway/devices/:deviceId
  return method === 'DELETE' && /^\/api\/v1\/admin\/sms-gateway\/devices\/[A-Za-z0-9-]+$/.test(pathname);
}

export class AdminServer {
  /**
   * @param {{
   *   db?: import('@youpi/db').Database,
   *   apiBaseUrl?: string
   * }} options
   */
  constructor(options = {}) {
    this.db = options.db || getDatabase();
    this.apiBaseUrl = options.apiBaseUrl || process.env.BASE_PAYMENT_API_URL || 'http://localhost:6100';
    // Internal container-to-container target; falls back to the historical loopback.
    const internalBase = (options.apiInternalUrl || process.env.PAYMENT_API_INTERNAL_URL || `http://127.0.0.1:${process.env.PAYMENT_API_PORT || 6100}`).replace(/\/+$/, '');
    const parsedInternal = new URL(internalBase);
    this.apiInternalBaseUrl = internalBase;
    this.apiTarget = {
      hostname: parsedInternal.hostname,
      port: Number(parsedInternal.port || (parsedInternal.protocol === 'https:' ? 443 : 80))
    };
    this.merchantRepo = new MerchantRepository(this.db);
    this.ticketRepo = new SupportTicketRepository(this.db);
    this.testConsole = new TestConsole({
      db: this.db,
      merchantRepo: this.merchantRepo,
      apiTarget: this.apiTarget,
      apiInternalBaseUrl: this.apiInternalBaseUrl,
      config: readTestConsoleConfig(options.env || process.env)
    });
    this.htmlTemplatePath = path.join(__dirname, 'views', 'admin.html');
    this.template = fs.readFileSync(this.htmlTemplatePath, 'utf8');
  }

  renderHtml() {
    try {
      this.template = fs.readFileSync(this.htmlTemplatePath, 'utf8');
    } catch {}

    let html = this.template;
    // Always use empty string '' so client fetch calls hit the merchant admin's own /api proxy!
    // This completely eliminates CORS errors, tunnel downtime 530s, and cross-origin failures.
    const clientApiBase = '';
    html = html.replaceAll('{{API_BASE_URL}}', clientApiBase);
    // The legacy static enrollment secret is no longer accepted by the gateway
    // (pairing uses single-use challenges), so it is never rendered into HTML.
    html = html.replaceAll('{{ANDROID_ENROLLMENT_SECRET}}', '');
    // Staging-only test console entry. The placeholder renders to an empty string
    // unless the operator explicitly enabled the console.
    html = html.replaceAll('{{TEST_CONSOLE_NAV}}', this.testConsole.navHtml());
    return html;
  }

  createServer() {
    return http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        });
        res.end();
        return;
      }

      // Health
      if (pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'UP', service: 'merchant-admin' }));
        return;
      }

      // Staging-only Payment Test Console (opt-in; disabled by default). It is
      // handled before the generic /api/ proxy so no console route can ever be
      // forwarded to the gateway without the console's own session check.
      if (pathname === '/test-console' || pathname.startsWith('/api/test-console/')) {
        try {
          const handled = await this.testConsole.handle(req, res, pathname);
          if (handled) return;
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'TEST_CONSOLE_UNAVAILABLE', details: err.message }));
          }
          return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Test Console Disabled');
        return;
      }

      // Admin Tickets API: GET /api/admin/tickets
      if (pathname === '/api/admin/tickets') {
        const merchants = this.merchantRepo.findAll();
        const mId = merchants[0]?.id || '00000000-0000-0000-0000-000000000001';
        const tickets = this.ticketRepo.findTicketsByMerchant(mId);

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify(tickets));
        return;
      }

      // Merged Control Center Supervisor Proxy: /api/services/* and /api/logs/stream -> Control Center on port 8090
      if (pathname.startsWith('/api/services') || pathname === '/api/logs/stream') {
        const ccPort = Number(process.env.CONTROL_CENTER_PORT || 8090);
        const proxyReq = http.request({
          hostname: '127.0.0.1',
          port: ccPort,
          path: req.url,
          method: req.method,
          headers: {
            ...req.headers,
            host: `localhost:${ccPort}`
          }
        }, (proxyRes) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Control center supervisor unavailable', details: err.message }));
          }
        });

        req.on('data', chunk => proxyReq.write(chunk));
        req.on('end', () => proxyReq.end());
        return;
      }

      // Transparent API Proxy: /api/* -> Payment Core REST API
      if (pathname.startsWith('/api/')) {
        const targetPort = this.apiTarget.port;
        const defaultMerchant = this.merchantRepo.getDefault ? this.merchantRepo.getDefault() : (this.merchantRepo.findById('00000000-0000-0000-0000-000000000001') || this.merchantRepo.findAll()[0]);
        const defaultMerchantId = defaultMerchant?.id || '00000000-0000-0000-0000-000000000001';

        const proxyHeaders = {
          ...req.headers,
          'x-merchant-id': req.headers['x-merchant-id'] || defaultMerchantId,
          host: `localhost:${targetPort}`,
          'x-forwarded-host': req.headers.host || '',
          // The console is reached over loopback or an SSH tunnel (never a public
          // plaintext listener). Forward the real scheme when a proxy supplies it,
          // otherwise present the transport as secure to the API's TLS guard.
          'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'https'
        };

        // Pairing QR + device management are the only gateway calls this local
        // console performs server-side. The merchant credential is attached HERE
        // (never sent to the browser, never in a response) and only for loopback
        // callers on an explicit allowlist; everything else stays unauthenticated
        // and is refused by the gateway (fail closed).
        if (shouldAttachPairingCredential(req, pathname) && defaultMerchant?.apiKey) {
          proxyHeaders['x-api-key'] = defaultMerchant.apiKey;
        }

        const proxyReq = http.request({
          hostname: this.apiTarget.hostname,
          port: targetPort,
          path: req.url,
          method: req.method,
          headers: proxyHeaders
        }, (proxyRes) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Gateway API unavailable', details: err.message }));
          }
        });

        req.pipe(proxyReq);
        return;
      }

      // Download Android Companion APK
      if (pathname === '/youpi-sms-gateway.apk' || pathname === '/api/v1/admin/sms-gateway/download-apk') {
        const apkCandidates = [
          path.resolve(__dirname, '../public/youpi-sms-gateway.apk'),
          path.resolve(__dirname, '../../payment-api/public/youpi-sms-gateway.apk'),
          path.resolve(__dirname, '../../android-observer-app/youpi-sms-gateway.apk')
        ];
        let apkPath = null;
        for (const p of apkCandidates) {
          if (fs.existsSync(p)) {
            apkPath = p;
            break;
          }
        }
        if (apkPath) {
          const stat = fs.statSync(apkPath);
          res.writeHead(200, {
            'Content-Type': 'application/vnd.android.package-archive',
            'Content-Disposition': 'attachment; filename="youpi-sms-gateway.apk"',
            'Content-Length': stat.size,
            'Access-Control-Allow-Origin': '*'
          });
          const stream = fs.createReadStream(apkPath);
          stream.pipe(res);
          return;
        }
      }

      // Dashboard View: GET / or GET /admin
      if (pathname === '/' || pathname === '/admin') {
        const html = this.renderHtml();
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache'
        });
        res.end(html);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Admin Route Not Found');
    });
  }
}
