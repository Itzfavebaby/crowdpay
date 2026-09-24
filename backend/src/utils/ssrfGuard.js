'use strict';

const net = require('net');
const dns = require('dns').promises;
const logger = require('../config/logger');

/**
 * SSRF-safe URL validation.
 *
 * Prevents Server-Side Request Forgery (SSRF) by blocking outbound requests to:
 *  - Private IPv4 ranges (RFC 1918, loopback, link-local, carrier-grade NAT)
 *  - Private IPv6 ranges (loopback, unique local, link-local, multicast)
 *  - Cloud metadata endpoints (169.254.169.254)
 *  - Any hostname that resolves to a private/internal IP address
 *
 * Protocol restriction: only HTTPS is allowed in production. HTTP is permitted
 * only for localhost / 127.0.0.1 / ::1 in non-production environments.
 */

// ── IPv4 private / reserved ranges ──────────────────────────────────────────

const IPV4_BLOCKED_RANGES = [
  { prefix: [0], bits: 8 },          // 0.0.0.0/8        — this network
  { prefix: [10], bits: 8 },         // 10.0.0.0/8       — private
  { prefix: [127], bits: 8 },        // 127.0.0.0/8      — loopback
  { prefix: [169, 254], bits: 16 },  // 169.254.0.0/16   — link-local (incl. cloud metadata)
  { prefix: [172, 16], bits: 12 },   // 172.16.0.0/12    — private
  { prefix: [192, 168], bits: 16 },  // 192.168.0.0/16   — private
  { prefix: [100, 64], bits: 10 },   // 100.64.0.0/10    — carrier-grade NAT (RFC 6598)
  { prefix: [198, 18], bits: 16 },   // 198.18.0.0/16    — benchmark testing (RFC 2544)
  { prefix: [198, 19], bits: 16 },   // 198.19.0.0/16    — benchmark testing (RFC 2544)
  { prefix: [224], bits: 4 },        // 224.0.0.0/4      — multicast + reserved
  { prefix: [240], bits: 4 },        // 240.0.0.0/4      — reserved (former Class E)
];

/**
 * Convert an array of 4 octets to an unsigned 32-bit integer.
 * @param {number[]} octets
 * @returns {number}
 */
function ipToUint32(octets) {
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

/**
 * Check whether an IPv4 address falls into any blocked range.
 * Uses proper CIDR bit-masking so ranges like /10, /12, and /4 are handled
 * correctly regardless of octet alignment.
 * @param {string} ip - dotted-decimal IPv4 address
 * @returns {boolean}
 */
function isPrivateIpv4(ip) {
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return true; // malformed — block
  }

  const ipUint = ipToUint32(octets);

  for (const range of IPV4_BLOCKED_RANGES) {
    // Pad the prefix to 4 octets (e.g. [10] → [10, 0, 0, 0])
    const prefixOctets = [
      range.prefix[0] || 0,
      range.prefix[1] || 0,
      range.prefix[2] || 0,
      range.prefix[3] || 0,
    ];
    const networkUint = ipToUint32(prefixOctets);
    // Create subnet mask: e.g. /12 → 0xFFFFF000
    const mask = range.bits === 0 ? 0 : (~0 << (32 - range.bits)) >>> 0;

    if (((ipUint & mask) >>> 0) === networkUint) {
      return true;
    }
  }
  return false;
}

// ── IPv6 private / reserved ranges ──────────────────────────────────────────

const IPV6_BLOCKED_PATTERNS = [
  /^::$/,                  // ::/128   — unspecified
  /^::1$/i,                // ::1      — loopback
  /^f[cd]/i,               // fc00::/7 — unique local (ULA)
  /^fe[89ab]/i,            // fe80::/10— link-local
  /^ff/i,                  // ff00::/8 — multicast
  /^::ffff:0?0?0?0?:/i,   // IPv4-mapped IPv6 (handled via IPv4 check)
];

/**
 * Check whether an IPv6 address falls into any blocked range.
 * @param {string} ip - normalized IPv6 address
 * @returns {boolean}
 */
function isPrivateIpv6(ip) {
  if (typeof ip !== 'string' || !ip) return true;
  const lower = ip.toLowerCase();

  // IPv4-mapped: extract the embedded IPv4 and check it
  const mappedMatch = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(lower);
  if (mappedMatch) {
    return isPrivateIpv4(mappedMatch[1]);
  }

  for (const pattern of IPV6_BLOCKED_PATTERNS) {
    if (pattern.test(lower)) return true;
  }
  return false;
}

// ── Hostname blacklist (well-known cloud metadata endpoints) ────────────────

const BLOCKED_HOSTNAMES = new Set([
  '169.254.169.254',               // AWS EC2 / cloud metadata
  'metadata.google.internal',      // GCP metadata
  'metadata',                       // GCP metadata (short name)
  '169.254.169.253',               // AWS metadata v2 token endpoint
]);

/**
 * Check whether a hostname is explicitly blocked (case-insensitive).
 * @param {string} hostname
 * @returns {boolean}
 */
function isBlockedHostname(hostname) {
  if (typeof hostname !== 'string' || !hostname) return true;
  const lower = hostname.toLowerCase();
  return BLOCKED_HOSTNAMES.has(lower);
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Determine whether a hostname (or raw IP) is considered private / internal.
 * If the hostname is a raw IP it is checked directly; otherwise this returns
 * false — callers must also resolve via DNS to get the actual IP.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
function isPrivateHost(hostname) {
  if (typeof hostname !== 'string' || !hostname) return true;

  // Strip brackets from IPv6 addresses
  let clean = hostname;
  if (clean.startsWith('[') && clean.endsWith(']')) {
    clean = clean.slice(1, -1);
  }

  // Strip zone index (e.g. fe80::1%eth0)
  const zoneIdx = clean.indexOf('%');
  if (zoneIdx !== -1) clean = clean.slice(0, zoneIdx);

  // Check explicit blocklist
  if (isBlockedHostname(clean)) return true;

  const family = net.isIP(clean);
  if (family === 4) return isPrivateIpv4(clean);
  if (family === 6) return isPrivateIpv6(clean);

  return false; // hostname — caller should resolve via DNS
}

/**
 * Resolve a hostname to every A/AAAA record the system resolver returns.
 * Throws if resolution fails entirely (callers treat that as unsafe).
 *
 * @param {string} hostname
 * @returns {Promise<{address: string, family: number}[]>}
 */
async function resolveAllAddresses(hostname) {
  const records = await dns.lookup(hostname, { all: true, family: 0 });
  if (!records || !records.length) {
    throw new Error(`No addresses resolved for hostname: ${hostname}`);
  }
  return records;
}

/**
 * Resolve a hostname and check whether ANY of its A/AAAA records are
 * private/internal. A hostname with mixed public and private answers is
 * treated as unsafe — checking only the first result (as dns.lookup's
 * default single-address mode would) lets a private answer hide behind a
 * public one. Returns true if resolution fails entirely too, as a safe
 * default.
 *
 * @param {string} hostname
 * @returns {Promise<boolean>}
 */
async function resolvesToPrivateIp(hostname) {
  if (typeof hostname !== 'string' || !hostname) return true;

  try {
    const records = await resolveAllAddresses(hostname);
    return records.some((record) => isPrivateHost(record.address));
  } catch {
    // Resolution failure: safest to block
    logger.warn('[ssrfGuard] DNS resolution failed for hostname', { hostname });
    return true;
  }
}

/**
 * Validate that a URL is safe for outbound HTTP requests AND resolve a
 * single pinned address to actually connect to. Combining validation and
 * resolution into one lookup closes the gap where a separate validate-then-
 * connect (or validate-then-resolve-again) pair could observe a different
 * DNS answer at each step (DNS rebinding). The original hostname is still
 * returned for the caller to use as the TLS SNI / Host header — only the
 * connection target is pinned to the resolved address.
 *
 * Returns `{ safe: boolean, reason: string, hostname, pinnedAddress, family }`.
 * `pinnedAddress`/`family` are only present when `safe` is true and the host
 * needed DNS resolution (a raw-IP URL has no separate pinned address to add —
 * the hostname itself already is the connect target).
 *
 * Rules:
 *  - Must be http: or https:
 *  - http: only allowed for localhost / 127.0.0.1 / ::1 in dev
 *  - Hostname must not be a private IP or blocked hostname
 *  - Every resolved A/AAAA record must be public
 *
 * @param {string} urlString
 * @param {object} [options]
 * @param {boolean} [options.allowLocalhostHttp] - allow http://localhost (default: NODE_ENV !== 'production')
 * @returns {Promise<{safe: boolean, reason: string, hostname?: string, pinnedAddress?: string, family?: number}>}
 */
async function resolveSafeConnectTarget(urlString, options = {}) {
  const allowLocalhostHttp = options.allowLocalhostHttp !== undefined
    ? options.allowLocalhostHttp
    : process.env.NODE_ENV !== 'production';

  let u;
  try {
    u = new URL(urlString);
  } catch {
    return { safe: false, reason: 'Invalid URL' };
  }

  // Protocol check
  if (u.protocol === 'https:') {
    // Always safe at the protocol level — hostname/IP checks follow
  } else if (u.protocol === 'http:') {
    const host = u.hostname.toLowerCase();
    if (allowLocalhostHttp && (host === 'localhost' || host === '127.0.0.1' || host === '[::1]')) {
      // Allowed for local dev
    } else {
      return { safe: false, reason: 'HTTP is only allowed for localhost/127.0.0.1 in development' };
    }
  } else {
    return { safe: false, reason: 'Only http: and https: protocols are allowed' };
  }

  const hostname = u.hostname;

  // Determine if this is an explicitly-allowed localhost/loopback HTTP URL
  // (localhost / 127.0.0.1 / ::1). These skip both the private-host and DNS
  // checks because we already know they resolve to loopback addresses and have
  // explicitly opted in via allowLocalhostHttp.
  const isAllowedLocalhostHttp = u.protocol === 'http:' && allowLocalhostHttp &&
    (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1');

  if (isAllowedLocalhostHttp) {
    return { safe: true, reason: '', hostname, pinnedAddress: hostname === 'localhost' ? '127.0.0.1' : hostname };
  }

  // Check if hostname itself is private/blocked (handles raw IPs).
  if (isPrivateHost(hostname)) {
    return { safe: false, reason: `Hostname resolves to a private/internal address: ${hostname}` };
  }

  // Raw IP hostnames have no further resolution — they're already the pin target.
  if (net.isIP(hostname) !== 0) {
    return { safe: true, reason: '', hostname, pinnedAddress: hostname, family: net.isIP(hostname) };
  }

  // Resolve once, validate every answer, and pin the connection to one of
  // the validated addresses — the same lookup backs both checks, so there's
  // no window between "validated" and "connected" for the answer to change.
  let records;
  try {
    records = await resolveAllAddresses(hostname);
  } catch {
    logger.warn('[ssrfGuard] DNS resolution failed for hostname', { hostname });
    return { safe: false, reason: `DNS resolution failed for hostname: ${hostname}` };
  }
  const privateRecord = records.find((record) => isPrivateHost(record.address));
  if (privateRecord) {
    return {
      safe: false,
      reason: `Hostname resolves to a private/internal network: ${hostname} -> ${privateRecord.address}`,
    };
  }

  return { safe: true, reason: '', hostname, pinnedAddress: records[0].address, family: records[0].family };
}

/**
 * Backward-compatible boolean-safety check. Prefer `resolveSafeConnectTarget`
 * for anything that will actually open a connection, since it hands back the
 * pinned address to connect to instead of re-resolving later.
 *
 * @param {string} urlString
 * @param {object} [options]
 * @returns {Promise<{safe: boolean, reason: string}>}
 */
async function isSafeUrl(urlString, options = {}) {
  const { safe, reason } = await resolveSafeConnectTarget(urlString, options);
  return { safe, reason };
}

module.exports = {
  isPrivateIpv4,
  isPrivateIpv6,
  isPrivateHost,
  resolvesToPrivateIp,
  resolveAllAddresses,
  resolveSafeConnectTarget,
  isSafeUrl,
  isBlockedHostname,
  IPV4_BLOCKED_RANGES,
  BLOCKED_HOSTNAMES,
};
