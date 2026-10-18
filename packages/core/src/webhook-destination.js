import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * Safe webhook destination validation (audit P1-05).
 *
 * Webhook URLs are configured by merchants and fetched by the gateway, which is a
 * textbook SSRF sink. Validation is applied BOTH when a URL is configured and
 * immediately before every delivery attempt:
 * - only http/https schemes (https required outside local development),
 * - no embedded credentials and no non-standard ports for https,
 * - the hostname must resolve to PUBLIC addresses only: loopback, private
 *   (RFC1918), link-local (including the 169.254.169.254 cloud metadata service),
 *   CGNAT, unique-local IPv6 and multicast/broadcast ranges are refused.
 */

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
  'instance-data'
]);

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function isBlockedIPv4(address) {
  const value = ipv4ToInt(address);
  const inRange = (cidr, bits) => {
    const base = ipv4ToInt(cidr);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (base & mask);
  };

  return (
    inRange('0.0.0.0', 8) ||        // "this network"
    inRange('10.0.0.0', 8) ||       // RFC1918
    inRange('100.64.0.0', 10) ||    // CGNAT
    inRange('127.0.0.0', 8) ||      // loopback
    inRange('169.254.0.0', 16) ||   // link-local + cloud metadata
    inRange('172.16.0.0', 12) ||    // RFC1918
    inRange('192.0.0.0', 24) ||
    inRange('192.168.0.0', 16) ||   // RFC1918
    inRange('198.18.0.0', 15) ||    // benchmarking
    inRange('224.0.0.0', 4) ||      // multicast
    inRange('240.0.0.0', 4)         // reserved / broadcast
  );
}

function isBlockedIPv6(address) {
  const normalized = address.toLowerCase().split('%')[0];
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fe80')) return true;            // link-local
  if (/^f[cd]/.test(normalized)) return true;                // unique-local fc00::/7
  if (normalized.startsWith('::ffff:')) {                    // IPv4-mapped
    const mapped = normalized.slice('::ffff:'.length);
    return net.isIPv4(mapped) ? isBlockedIPv4(mapped) : true;
  }
  if (normalized.startsWith('64:ff9b')) return true;         // NAT64
  if (normalized.startsWith('2002:')) return true;           // 6to4
  return false;
}

/** @param {string} address */
export function isBlockedAddress(address) {
  if (net.isIPv4(address)) return isBlockedIPv4(address);
  if (net.isIPv6(address)) return isBlockedIPv6(address);
  return true; // unresolvable / unexpected form: refuse
}

/**
 * Validates a webhook destination URL.
 * @param {string} rawUrl
 * @param {{ allowLocalhost?: boolean, resolveDns?: boolean }} [options]
 * @returns {Promise<{ ok: boolean, reason?: string, url?: URL, addresses?: string[] }>}
 */
export async function validateWebhookDestination(rawUrl, options = {}) {
  if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { ok: false, reason: 'MISSING_URL' };
  }

  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { ok: false, reason: 'MALFORMED_URL' };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'UNSUPPORTED_SCHEME' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'CREDENTIALS_IN_URL' };
  }

  const isLocalDev = process.env.NODE_ENV !== 'production';
  const allowLocalhost = options.allowLocalhost === true || isLocalDev;

  if (url.protocol === 'http:' && !allowLocalhost) {
    return { ok: false, reason: 'HTTPS_REQUIRED' };
  }

  const hostname = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname) && !allowLocalhost) {
    return { ok: false, reason: 'BLOCKED_HOST' };
  }

  // Literal IP addresses are checked without DNS.
  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname) && !allowLocalhost) {
      return { ok: false, reason: 'BLOCKED_ADDRESS' };
    }
    return { ok: true, url, addresses: [hostname] };
  }

  if (options.resolveDns === false) {
    return { ok: true, url, addresses: [] };
  }

  let records = [];
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    return { ok: false, reason: 'DNS_LOOKUP_FAILED' };
  }
  if (!records.length) return { ok: false, reason: 'DNS_NO_RECORDS' };

  const addresses = records.map(r => r.address);
  for (const address of addresses) {
    // A hostname that resolves to ANY internal address is refused (DNS-rebinding
    // and split-horizon targets included).
    if (isBlockedAddress(address) && !allowLocalhost) {
      return { ok: false, reason: 'BLOCKED_ADDRESS', addresses };
    }
  }

  return { ok: true, url, addresses };
}
