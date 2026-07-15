// Stage 1 of the generic coverage engine: probe the station's OWN WEBSITE for
// a now-playing endpoint.
//
// Why this exists: every other generic probe builds its URL from the *stream*
// host. A station whose now-playing lives on its own site (a different host)
// was therefore unreachable generically, and the only fix was a hand-written
// station-map entry. That is why 13 stations are hardcoded — even though most
// of them, Kiosk Radio included, sit on an utterly ordinary path
// (kioskradio.com/api/now-playing). Nothing ever looked.
//
// `homepage` is validated in server.js exactly like `url` (scheme + literal
// private host) and every request goes through the global safe dispatcher, so
// this does not widen the SSRF surface.

const probeCache = require('./probe-cache.js');
const { isValidMetadata, isStationEcho } = require('./normalize.js');

// Ordinary paths radio websites actually serve now-playing on. Ordered roughly
// by how often they hit; probe-cache reorders per host after the first probe.
const HOMEPAGE_PATHS = [
  '/api/now-playing',
  '/api/nowplaying',
  '/api/live-info-v2',
  '/api/live-info',
  '/api/current',
  '/nowplaying.json',
  '/nowplaying',
  '/now-playing',
  '/api/data/onair/now.json',
  '/current.json',
  '/status-json.xsl',
  '/currentsong',
];

const PROBE_TIMEOUT_MS = 3000;

function originOf(homepage) {
  try {
    const u = new URL(homepage);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    return u.origin;
  } catch (_) {
    return null;
  }
}

async function defaultFetch(url, { signal } = {}) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json, */*' } });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Probe the homepage origin for a now-playing endpoint.
 * @returns {Promise<{source:'homepage-api',display:string,artist:null,title:null,raw:object,confidence:number,cacheTtl:number}|null>}
 */
async function fetchHomepageApi(homepage, { signal, stationName = '', fetchImpl = defaultFetch, parse } = {}) {
  const origin = originOf(homepage);
  if (!origin) return null;

  // Injected so the module stays free of a circular require on strategies/.
  const parseFn = parse || require('../strategies/index.js').parseStationMetadata;

  const host = new URL(origin).host;
  const candidates = HOMEPAGE_PATHS.map((p) => `${origin}${p}`);
  const { positives, unknown } = probeCache.orderCandidates(host, candidates);

  for (const endpoint of [...positives, ...unknown]) {
    if (signal?.aborted) return null;
    const probePath = (() => { try { return new URL(endpoint).pathname; } catch (_) { return endpoint; } })();
    try {
      const res = await fetchImpl(endpoint, { signal });
      if (!res.ok) {
        probeCache.markNegative(host, probePath);
        continue;
      }

      let data;
      try {
        data = await res.json();
      } catch (_) {
        // 2xx but not JSON — the path exists, it just isn't for us. Neutral.
        continue;
      }

      const display = parseFn(data);
      // A 2xx with nothing useful is neutral: don't poison the cache, the
      // endpoint may simply be between tracks.
      if (!display || !isValidMetadata({ display })) continue;
      // The likeliest wrong answer on a station's own site is its own name.
      if (isStationEcho(display, { stationName })) continue;

      probeCache.markPositive(host, probePath);
      return {
        source: 'homepage-api',
        display,
        artist: null,
        title: null,
        raw: { data, endpoint },
        confidence: 0.7,
        cacheTtl: 15,
      };
    } catch (error) {
      // A parent abort isn't the host's fault — don't record it against them.
      if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return null;
      probeCache.markNegative(host, probePath);
    }
  }

  return null;
}

module.exports = { fetchHomepageApi, HOMEPAGE_PATHS };
