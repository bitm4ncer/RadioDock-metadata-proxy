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
const { extractOnAirFromHtml } = require('./html-onair.js');

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
// A homepage can be huge (Reprezent ships 200 KB+). Bound what we read and scan.
const MAX_HTML_BYTES = 400000;

function originOf(homepage) {
  try {
    const u = new URL(homepage);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    return u.origin;
  } catch (_) {
    return null;
  }
}

async function defaultFetch(url, { signal, accept } = {}) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: accept === 'text/html' ? 'text/html,*/*' : 'application/json, */*' },
    });
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

async function fetchHtml(url, { signal, fetchImpl }) {
  const res = await fetchImpl(url, { signal, accept: 'text/html' });
  if (!res.ok) return null;
  const text = await res.text();
  return typeof text === 'string' ? text.slice(0, MAX_HTML_BYTES) : null;
}

/**
 * Stage 3: the on-air / timetable block the station renders on its own homepage.
 * @returns {Promise<{source:'homepage-html',display:string,artist:null,title:null,raw:object,confidence:number,cacheTtl:number}|null>}
 */
async function fetchHomepageOnAir(homepage, { signal, stationName = '', fetchImpl = defaultFetch, html } = {}) {
  const origin = originOf(homepage);
  if (!origin) return null;
  try {
    const page = html ?? await fetchHtml(homepage, { signal, fetchImpl });
    if (!page) return null;
    const hit = extractOnAirFromHtml(page, { stationName });
    if (!hit) return null;
    return {
      source: 'homepage-html',
      display: hit.display,
      artist: null,
      title: null,
      raw: { via: hit.via, homepage },
      confidence: 0.5,
      cacheTtl: 30,
    };
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return null;
    return null;
  }
}

// ---- Stage 4: endpoint autodiscovery --------------------------------------
// Some stations serve now-playing on a path no list will ever contain
// (chunt.org uses /fm/channels/1/now-playing). Rather than hand-writing a rule,
// read the page the station already ships and find the endpoint it calls itself.
//
// This is the loosest mechanism, so it is also the strictest about what counts:
// a candidate must look like a request path, carry a now-playing word, and not
// be an asset. `currentColor` is called out explicitly — it appears in every
// inline SVG (found live on reprezentradio.org.uk) and a naive /current/ match
// buries the real candidates under it.
const NOWPLAYING_WORD_RE = /(now[-_]?playing|on[-_]?air|onair|live[-_]?info|nowplaying|current[-_](?:track|song|show)|(?:^|[/_-])current(?:$|[/_?-]))/i;
const ASSET_RE = /\.(?:png|jpe?g|gif|svg|webp|css|js|mjs|woff2?|ico|map)(?:$|\?)/i;
const MAX_DISCOVERED = 5;

/**
 * @returns {string[]} absolute candidate URLs on `origin`, deduped, capped.
 */
function discoverEndpoints(html, origin) {
  const s = typeof html === 'string' ? html : '';
  if (!s || !origin) return [];

  const out = [];
  const seen = new Set();
  // Quoted, root-relative paths only: an absolute URL would point off-origin
  // (never follow a third party), and a bare word is not a request path.
  const re = /["'](\/[A-Za-z0-9._~\-/]*(?:\?[A-Za-z0-9._~\-/=&%]*)?)["']/g;
  let m;
  while ((m = re.exec(s)) && out.length < MAX_DISCOVERED) {
    const path = m[1];
    if (seen.has(path)) continue;
    seen.add(path);
    if (path.length < 4 || path.length > 180) continue;
    if (ASSET_RE.test(path)) continue;          // /css/now-playing.css is not an API
    if (!NOWPLAYING_WORD_RE.test(path)) continue;
    out.push(`${origin}${path}`);
  }
  return out;
}

/**
 * Stage 4: probe endpoints the homepage itself references.
 * @returns {Promise<{source:'homepage-discovered',display:string,artist:null,title:null,raw:object,confidence:number,cacheTtl:number}|null>}
 */
async function fetchHomepageDiscovered(homepage, { signal, stationName = '', fetchImpl = defaultFetch, html, parse } = {}) {
  const origin = originOf(homepage);
  if (!origin) return null;
  const parseFn = parse || require('../strategies/index.js').parseStationMetadata;

  try {
    const page = html ?? await fetchHtml(homepage, { signal, fetchImpl });
    if (!page) return null;

    for (const endpoint of discoverEndpoints(page, origin)) {
      if (signal?.aborted) return null;
      try {
        const res = await fetchImpl(endpoint, { signal });
        if (!res.ok) continue;
        let data;
        try { data = await res.json(); } catch (_) { continue; }
        const display = parseFn(data);
        if (!display || !isValidMetadata({ display })) continue;
        if (isStationEcho(display, { stationName })) continue;
        return {
          source: 'homepage-discovered',
          display,
          artist: null,
          title: null,
          raw: { data, endpoint },
          confidence: 0.4,
          cacheTtl: 15,
        };
      } catch (error) {
        if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return null;
      }
    }
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Phase B in full: Stage 1 (known paths) → Stage 3 (on-air HTML) → Stage 4
 * (endpoints the page references). Ordered most-precise first and returns the
 * first hit, so the loosest mechanism only ever runs when the stricter ones
 * found nothing. The homepage HTML is fetched at most once and shared by
 * Stages 3 and 4.
 */
async function resolveHomepage(homepage, { signal, stationName = '', fetchImpl = defaultFetch } = {}) {
  const origin = originOf(homepage);
  if (!origin) return null;

  const stage1 = await fetchHomepageApi(homepage, { signal, stationName, fetchImpl });
  if (stage1) return stage1;
  if (signal?.aborted) return null;

  let html = null;
  try {
    html = await fetchHtml(homepage, { signal, fetchImpl });
  } catch (_) {
    return null;
  }
  if (!html) return null;

  const stage3 = await fetchHomepageOnAir(homepage, { signal, stationName, fetchImpl, html });
  if (stage3) return stage3;
  if (signal?.aborted) return null;

  return fetchHomepageDiscovered(homepage, { signal, stationName, fetchImpl, html });
}

module.exports = {
  resolveHomepage,
  fetchHomepageApi,
  fetchHomepageOnAir,
  fetchHomepageDiscovered,
  discoverEndpoints,
  fetchHtml,
  HOMEPAGE_PATHS,
};
