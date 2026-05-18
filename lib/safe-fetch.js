// SSRF guard for outbound HTTP.
//
// The /v1/metadata endpoint accepts a user-supplied stream URL and fetches it
// server-side. Without this guard, an attacker could point `url` at private
// network resources (127.0.0.1, 10.x, 192.168.x, AWS IMDS 169.254.169.254, …)
// and use the proxy as a network egress.
//
// Strategy:
//  1. Synchronous literal-IP / localhost rejection on the entry-point URL.
//  2. A custom undici lookup() that resolves the hostname AT CONNECT TIME and
//     refuses if any returned address falls into a private range. This blocks
//     DNS rebinding because the resolved IP is the same one undici dials.
//
// We treat anything we cannot positively classify as public as unsafe.

const dns = require('node:dns/promises');
const net = require('node:net');
const { Agent, setGlobalDispatcher } = require('undici');

const PRIVATE_V4_RANGES = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.0\.0\./,
  /^192\.0\.2\./,
  /^192\.168\./,
  /^198\.(1[89])\./,
  /^198\.51\.100\./,
  /^203\.0\.113\./,
  /^22[4-9]\./, /^23\d\./,           // 224.0.0.0/4 multicast
  /^2[4-9]\d\./, /^25[0-5]\./,       // 240.0.0.0/4 reserved (+255.255.255.255 broadcast)
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64.0.0/10
];

const PRIVATE_V6_PREFIXES = [
  '::1',         // loopback
  '::',          // unspecified
  'fc', 'fd',    // unique local
  'fe80',        // link-local
  'ff',          // multicast
];

function isPrivateAddress(addr) {
  if (!addr || typeof addr !== 'string') return true;
  if (net.isIPv4(addr)) return PRIVATE_V4_RANGES.some(r => r.test(addr));
  if (net.isIPv6(addr)) {
    const lower = addr.toLowerCase();
    if (lower.startsWith('::ffff:')) {
      const v4 = lower.slice('::ffff:'.length);
      if (net.isIPv4(v4)) return PRIVATE_V4_RANGES.some(r => r.test(v4));
    }
    return PRIVATE_V6_PREFIXES.some(p => lower === p || lower.startsWith(p + ':'));
  }
  return true;
}

// Cheap synchronous check for the most common SSRF probes: literal IPs and
// localhost-flavoured hostnames. DNS-resolved hostnames go through safeLookup.
function isHostnameLiteralPrivate(host) {
  if (!host) return true;
  const lower = String(host).toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost')) return true;
  if (lower === 'ip6-localhost' || lower === 'ip6-loopback') return true;
  if (net.isIP(lower)) return isPrivateAddress(lower);
  return false;
}

function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const family = (options && options.family) || 0;
  const wantAll = !!(options && options.all);
  dns.lookup(hostname, { all: true, family })
    .then((addrs) => {
      const list = Array.isArray(addrs) ? addrs : [];
      if (list.length === 0) {
        const err = new Error('ENOTFOUND');
        err.code = 'ENOTFOUND';
        return callback(err);
      }
      const bad = list.find(a => isPrivateAddress(a.address));
      if (bad) {
        const err = new Error(`SSRF_BLOCKED ${hostname} -> ${bad.address}`);
        err.code = 'SSRF_BLOCKED';
        return callback(err);
      }
      if (wantAll) {
        callback(null, list);
      } else {
        const pick = list[0];
        callback(null, pick.address, pick.family);
      }
    })
    .catch((err) => callback(err));
}

function installSafeDispatcher({ bodyTimeout, headersTimeout } = {}) {
  const agent = new Agent({
    connect: { lookup: safeLookup },
    bodyTimeout: bodyTimeout ?? 10000,
    headersTimeout: headersTimeout ?? 6000,
  });
  setGlobalDispatcher(agent);
  return agent;
}

// Read an undici response body up to a maximum byte count. Aborts as soon as
// the limit is exceeded. Prevents a malicious or broken upstream from blowing
// up Render's 512 MB dyno with a multi-gigabyte body.
async function readBoundedBody(body, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of body) {
    const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) {
      const err = new Error(`Response body exceeded ${maxBytes} bytes`);
      err.code = 'BODY_TOO_LARGE';
      throw err;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, size);
}

module.exports = {
  installSafeDispatcher,
  isHostnameLiteralPrivate,
  isPrivateAddress,
  safeLookup,
  readBoundedBody,
};
