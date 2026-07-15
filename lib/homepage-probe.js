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
  const ordered = [...positives, ...unknown];
  if (!ordered.length) return null;

  async function probe(endpoint) {
    const probePath = (() => { try { return new URL(endpoint).pathname; } catch (_) { return endpoint; } })();
    try {
      const res = await fetchImpl(endpoint, { signal });
      if (!res.ok) {
        probeCache.markNegative(host, probePath);
        return null;
      }

      let data;
      try {
        data = await res.json();
      } catch (_) {
        // 2xx but not JSON — the path exists, it just isn't for us. Neutral:
        // don't poison the cache.
        return null;
      }

      const display = parseFn(data);
      // A 2xx with nothing useful is neutral too — the endpoint may simply be
      // between tracks.
      if (!display || !isValidMetadata({ display })) return null;
      // The likeliest wrong answer on a station's own site is its own name.
      if (isStationEcho(display, { stationName })) return null;

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
      return null;
    }
  }

  // Probe in ONE round rather than one-after-another. Sequentially, twelve
  // paths at up to 3s each can burn the whole Phase-B budget before Stage 3
  // ever runs — which is exactly what happened to WWOZ on a cold cache in
  // production (10s, no result), while a warm cache skipped the known-bad paths
  // and resolved the same station in 2.4s. The first request for a station is
  // the one that matters, so it must not be the slow one.
  //
  // Politeness: this is a dozen small GETs, once per host — probe-cache
  // remembers the misses, so it does not repeat.
  const results = await Promise.all(ordered.map((e) => (signal?.aborted ? null : probe(e))));
  // Keep list order so the most likely path still wins over a later one.
  return results.find(Boolean) ?? null;
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

/**
 * Phase B in full: Stage 1 (known paths on the homepage origin) → Stage 3 (the
 * on-air block the station renders). Most-precise first, returns the first hit.
 *
 * Stage 4 (probing endpoints the page references) was built and removed: across
 * the community list and a 200-station sample it produced zero real
 * resolutions, while carrying the highest false-positive risk of any stage.
 * chunt.org's discovered "/fm/channels/1/now-playing" turned out to be a
 * client-side route that 404s. The spec's drop clause exists for exactly this.
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

  return fetchHomepageOnAir(homepage, { signal, stationName, fetchImpl, html });
}

module.exports = {
  resolveHomepage,
  fetchHomepageApi,
  fetchHomepageOnAir,
  fetchHtml,
  HOMEPAGE_PATHS,
};
