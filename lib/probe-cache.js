// Per-host endpoint probe cache.
//
// fetchGenericMetadata() blind-probes 10 common URL patterns (/api/nowplaying,
// /nowplaying, /current, /metadata, /info, /playing.json, /current.json,
// /api/current, /stats, /7.html) on every cache-miss. For a host that
// doesn't expose any of them, that's 10 outbound requests every 15 seconds
// per listener — almost all returning 404. With 50 listeners on such a
// station this is ~33 useless outbound requests per second.
//
// This cache records the result of each probe:
//  - "negative" (24h TTL): endpoint returned 4xx/5xx/timeout. Skip next time.
//  - "positive" (1h TTL):  endpoint returned usable metadata. Try first.
//
// Bounded by an LRU (10k entries) so a wave of one-off hosts can't OOM us.
//
// Keyed on host + pathname. The query string isn't part of the key because
// our probe paths don't carry tokens; if you add a path that does, key the
// full URL instead.

const { LRUCache } = require('lru-cache');

const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const POSITIVE_TTL_MS = 60 * 60 * 1000;      // 1h

const cache = new LRUCache({
  max: 10000,
  ttl: NEGATIVE_TTL_MS, // upper bound; per-entry ttl overrides this
});

function key(host, path) {
  return `${host}|${path}`;
}

function markNegative(host, path) {
  cache.set(key(host, path), 'negative', { ttl: NEGATIVE_TTL_MS });
}

function markPositive(host, path) {
  cache.set(key(host, path), 'positive', { ttl: POSITIVE_TTL_MS });
}

function getStatus(host, path) {
  return cache.get(key(host, path)) || null;
}

// Reorder a list of candidate URLs based on cached probe results.
// Returns { positives, unknown, skipped } so callers can decide how to use
// them. Most callers want [...positives, ...unknown] — try known-good first,
// then unknowns, and skip the negatives entirely.
function orderCandidates(host, candidateUrls) {
  const positives = [];
  const unknown = [];
  const skipped = [];
  for (const url of candidateUrls) {
    let path;
    try { path = new URL(url).pathname; } catch (_) { path = url; }
    const status = getStatus(host, path);
    if (status === 'negative') skipped.push(url);
    else if (status === 'positive') positives.push(url);
    else unknown.push(url);
  }
  return { positives, unknown, skipped };
}

// Test helper — clears all state. Not used in production code paths.
function _resetForTests() {
  cache.clear();
}

module.exports = {
  markNegative,
  markPositive,
  getStatus,
  orderCandidates,
  _resetForTests,
};
