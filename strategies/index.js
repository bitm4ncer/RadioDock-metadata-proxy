/**
 * RadioDock Metadata Strategies - Server Implementation
 * 
 * This file ports all metadata fetching strategies from the extension's metadata-strategies.js
 * and background.js to run server-side on the proxy. This maintains 1:1 behavior compatibility
 * while allowing host_permissions to be restricted to only the proxy and Radio Browser API.
 * 
 * Strategy Types Implemented:
 * 1. NTS Radio API - Live channel metadata from nts.live API
 * 2. NTS Mixtapes - Themed mixtape channels via nts.live mixtapes API
 * 3. Airtime Pro - Generic Airtime Pro stations using live-info-v2 API
 * 4. Cashmere Radio - Specific Airtime Pro instance with custom handling
 * 5. RadioCult - Derived from <slug>.radiocult.fm stream subdomains
 * 6. RadioJar - Derived from stream.radiojar.com stream ids
 * 7. Icecast Status - JSON status endpoints (status-json.xsl, status.json, etc.)
 * 8. ICY Metadata - Stream metadata blocks with Icy-MetaData headers
 * 9. Generic APIs - Common station API patterns and endpoints
 * 10. Radio King - radioking.com specific API endpoints
 * 11. Callshop Radio - Custom JSON status endpoint
 * 12. Station Map - Curated per-station APIs on foreign hosts
 *     (Creek, KEXP, BFF.fm, CKUT, WNYU, Airtime v1/LibreTime, ...)
 *     — see strategies/station-map.js
 * 13. Radio Browser - Fallback using radio-browser.info station data
 * 14. Station Info - Last resort using station name/info
 * 
 * HLS streams (.m3u8) are explicitly excluded and return {ok:false, reason:"hls-client"}
 * so the extension continues to handle HLS ID3 metadata locally with hls.js.
 */

const { request } = require('undici');
const { readBoundedBody } = require('../lib/safe-fetch.js');
const probeCache = require('../lib/probe-cache.js');
const { cleanNowPlaying, isPlaceholder, isValidMetadata } = require('../lib/normalize.js');
const { findStationMapEntry, parseByKind, CACHE_TTL_BY_KIND, HTML_KINDS } = require('./station-map.js');
const { makeOverrideMap } = require('../lib/override-map.js');
const { resolveHomepage } = require('../lib/homepage-probe.js');

// Phase B (homepage tier) entry point, swappable so the two-phase wiring is
// unit-testable without reaching the network.
let homepageTier = resolveHomepage;
function _setHomepageTierForTests(fn) { homepageTier = fn || resolveHomepage; }

// Curated per-station override map, fetched from the PWA-published JSON. Both
// proxy instances consume it; degrades to empty on any failure. start() is
// called from server.js at boot (kept side-effect-free here for tests).
const overrideMap = makeOverrideMap({
  url: process.env.OVERRIDE_MAP_URL || 'https://radiodock.app/public/metadata-overrides.json',
  ttlMs: Number(process.env.OVERRIDE_MAP_TTL_MS) || 300000,
});

// Timeout configuration - reduced for better responsiveness
const DEFAULT_TIMEOUT = 6000;
const FAST_TIMEOUT = 2500;
const MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MB cap on any single upstream body

// cleanNowPlaying / isPlaceholder / isValidMetadata live in lib/normalize.js
// (shared with strategies/station-map.js) and are re-exported below.

// HTTP request utility with timeout. Accepts an optional external `signal`
// in `options` so the caller (fetchMetadata's strategy race) can abort
// losing in-flight requests once a winner is selected, freeing sockets.
async function fetchWithTimeout(url, options = {}, timeout = DEFAULT_TIMEOUT) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  // Forward an external abort onto our internal controller so the request is
  // cancelled even when the timeout hasn't fired yet.
  const externalSignal = options.signal;
  const forwardAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', forwardAbort, { once: true });
  }

  try {
    const { signal: _ignored, ...restOptions } = options; // we set signal explicitly below
    const response = await request(url, {
      ...restOptions,
      signal: controller.signal,
      followRedirects: true,
      maxRedirections: 3,
      headers: {
        'User-Agent': 'RadioDock/1.0',
        'Cache-Control': 'no-store',
        ...options.headers
      }
    });

    clearTimeout(timeoutId);
    if (externalSignal) externalSignal.removeEventListener('abort', forwardAbort);
    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode,
      statusCode: response.statusCode,
      headers: response.headers,
      json: async () => {
        const buf = await readBoundedBody(response.body, MAX_RESPONSE_BYTES);
        return JSON.parse(buf.toString('utf8'));
      },
      text: async () => {
        const buf = await readBoundedBody(response.body, MAX_RESPONSE_BYTES);
        return buf.toString('utf8');
      },
      body: response.body
    };
  } catch (error) {
    clearTimeout(timeoutId);
    if (externalSignal) externalSignal.removeEventListener('abort', forwardAbort);
    throw error;
  }
}



// ICY metadata blocks are not encoding-tagged. The spec leaves charset up to
// the broadcaster, and in practice German/French/Scandinavian stations often
// emit Windows-1252 or ISO-8859-1, which produce U+FFFD replacement chars
// when decoded as UTF-8. Strategy: decode as UTF-8 first; if the result
// contains a replacement character, retry as latin1. Latin1 maps 1:1 to the
// first 256 code points so it never produces replacements — at worst it
// shows the wrong glyph, which is still less broken than `Beyonc\u{FFFD}`.
function decodeIcyBytes(bytes) {
  const buf = bytes instanceof Buffer
    ? bytes
    : Buffer.from(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.length);
  const utf8 = buf.toString('utf8').replace(/\0/g, '');
  if (!utf8.includes('�')) return utf8;
  return buf.toString('latin1').replace(/\0/g, '');
}

// Parse artist and title from various formats
function parseArtistTitle(text, artist = '', title = '') {
  if (!text && !artist && !title) return null;
  
  let finalArtist = artist;
  let finalTitle = title;
  
  // If we have text but no separate artist/title, try to parse from text
  if (text && !artist && !title && text.includes(' - ')) {
    const parts = text.split(' - ');
    finalArtist = parts[0].trim();
    finalTitle = parts.slice(1).join(' - ').trim();
  } else if (text && (!artist || !title)) {
    // Use text as fallback
    finalTitle = text;
  }
  
  // Build final now playing string
  let nowPlaying = '';
  if (finalArtist && finalTitle && finalArtist !== finalTitle) {
    nowPlaying = `${finalArtist} - ${finalTitle}`;
  } else if (finalTitle) {
    nowPlaying = finalTitle;
  } else if (finalArtist) {
    nowPlaying = finalArtist;
  } else if (text) {
    nowPlaying = text;
  }
  
  return nowPlaying ? cleanNowPlaying(nowPlaying) : null;
}

// Common JSON parsing for various station API formats
// Generic now-playing extraction — the mechanism that lets an unknown API work
// without a per-station rule. Walks a priority list of common containers and
// reads artist/title through key aliases. Only strings are ever accepted: the
// previous version did `title = data.song || data.track`, which assigned the
// OBJECT whenever a payload nested its fields and leaked "[object Object]".
const ARTIST_KEYS = ['artist', 'artist_name', 'artistName', 'performer', 'trackArtist'];
const TITLE_KEYS = ['title', 'track_title', 'trackTitle', 'song', 'track', 'songtitle'];
const SHOW_NAME_KEYS = ['name', 'title', 'title_html', 'show', 'program', 'programme'];

// Most specific first; each resolves to an object holding artist/title keys.
const CONTAINER_PATHS = [
  ['now_playing', 'song'],            // AzuraCast
  ['nowplaying', 'song'],
  ['tracks', 'current', 'metadata'],  // Airtime / LibreTime v1
  ['track', 'song'],                  // Creek
  ['icestats', 'source'],             // Icecast status-json
  ['results', 0],                     // KEXP-style result lists
  ['now_playing'],
  ['nowplaying'],
  ['current'],
  ['now'],
  ['live'],
  ['data'],
  ['track'],
  [],                                 // the payload root itself
];

const SHOW_PATHS = [['shows', 'current'], ['program'], ['show'], []];

function asString(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

function pickKey(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const k of keys) {
    const v = asString(obj[k]);
    if (v) return v;
  }
  return '';
}

function resolveContainer(obj, path) {
  let cur = obj;
  for (const seg of path) {
    if (cur == null) return null;
    if (Array.isArray(cur)) cur = typeof seg === 'number' ? cur[seg] : cur[0]?.[seg];
    else cur = cur[seg];
  }
  if (Array.isArray(cur)) cur = cur[0];
  return cur && typeof cur === 'object' ? cur : null;
}

function parseStationMetadata(data) {
  if (!data || typeof data !== 'object') return null;

  // 1. A container that is itself the display string ("Artist - Title").
  for (const key of ['nowplaying', 'now_playing', 'current', 'now']) {
    const text = asString(data[key]);
    if (!text) continue;
    const r = parseArtistTitle(text, '', '');
    if (r && isValidMetadata({ display: r })) return r;
  }

  // 2. Structured artist/title containers.
  for (const path of CONTAINER_PATHS) {
    const c = resolveContainer(data, path);
    if (!c) continue;
    const artist = pickKey(c, ARTIST_KEYS);
    const title = pickKey(c, TITLE_KEYS);
    if (!artist && !title) continue;
    const r = parseArtistTitle('', artist, title);
    if (r && isValidMetadata({ display: r })) return r;
  }

  // 3. No track anywhere — fall back to the programme/show name.
  for (const path of SHOW_PATHS) {
    const c = resolveContainer(data, path);
    const showName = pickKey(c, SHOW_NAME_KEYS);
    if (!showName) continue;
    const r = cleanNowPlaying(showName);
    if (r && isValidMetadata({ display: r })) return r;
  }

  return null;
}

// Simple first-non-null race. Used inside individual strategies that probe
// several equivalent endpoints (e.g. Icecast tries /status-json.xsl,
// /status.json, /stats.json in parallel). Confidence weighting doesn't apply
// here because all endpoints belong to the same source.
function firstNonNullResult(promises) {
  return new Promise((resolve) => {
    let remaining = Array.isArray(promises) ? promises.length : 0;
    let resolved = false;
    if (remaining === 0) return resolve(null);
    promises.forEach((promise) => {
      promise.then((result) => {
        if (!resolved && result && (result.display || result.ok !== false)) {
          resolved = true;
          resolve(result);
        }
      }).catch(() => {}).finally(() => {
        remaining -= 1;
        if (!resolved && remaining === 0) resolve(null);
      });
    });
  });
}

// Pick the best result from a parallel strategy race.
//
// The previous implementation took the *first* non-null result, which meant
// a fast low-confidence strategy (e.g. icy-headers fallback, 0.7) could win
// over a slower but more accurate one (e.g. icy in-stream block, 0.95).
//
// New behaviour:
//   1. As soon as ANY strategy returns a non-null result, start a short
//      "harvest window" (default 600ms).
//   2. While the window is open, collect every other non-null result that
//      arrives.
//   3. When the window closes (or all strategies settle), pick the highest-
//      confidence result and abort the rest via the parent controller.
//
// This keeps latency close to first-hit while giving slightly slower
// high-confidence strategies a chance to overtake.
function selectBestResult(promises, parentCtrl, { harvestMs = 600 } = {}) {
  return new Promise((resolve) => {
    if (!Array.isArray(promises) || promises.length === 0) return resolve(null);
    const harvest = [];
    let resolved = false;
    let remaining = promises.length;
    let harvestTimer = null;

    const finish = () => {
      if (resolved) return;
      resolved = true;
      if (harvestTimer) clearTimeout(harvestTimer);
      try { parentCtrl?.abort(); } catch (_) { /* noop */ }
      if (harvest.length === 0) return resolve(null);
      harvest.sort((a, b) => (b?.confidence ?? 0) - (a?.confidence ?? 0));
      resolve(harvest[0]);
    };

    promises.forEach((promise) => {
      promise.then((result) => {
        if (resolved) return;
        if (result && result.display) {
          harvest.push(result);
          if (harvestTimer === null) {
            harvestTimer = setTimeout(finish, harvestMs);
          }
        }
      }).catch(() => {}).finally(() => {
        if (resolved) return;
        remaining -= 1;
        if (remaining === 0) finish();
      });
    });
  });
}

// Hong Kong Community Radio integration.
// HKCR streams HLS (no in-stream metadata) but exposes the live schedule
// at cms.hkcr.live/schedule/current. Each entry has date/startTime/endTime
// in HK local time (UTC+8, no DST). We pick whichever entry's window
// contains "now"; outside any window the station plays automated fillers
// and we return null so the caller falls back to no display.
const HKCR_HK_OFFSET_MIN = 8 * 60;

function findCurrentHKCRShow(shows, now = new Date()) {
  if (!Array.isArray(shows)) return null;
  const nowMs = now.getTime();
  for (const show of shows) {
    if (!show || show.cancelledAt) continue;
    if (!show.title || !show.date || !show.startTime || !show.endTime) continue;
    const [y, mo, d] = String(show.date).split('-').map(Number);
    const [sH, sM] = String(show.startTime).split(':').map(Number);
    const [eH, eM] = String(show.endTime).split(':').map(Number);
    if (![y, mo, d, sH, sM, eH, eM].every(Number.isFinite)) continue;
    let startUtcMs = Date.UTC(y, mo - 1, d, sH, sM) - HKCR_HK_OFFSET_MIN * 60_000;
    let endUtcMs = Date.UTC(y, mo - 1, d, eH, eM) - HKCR_HK_OFFSET_MIN * 60_000;
    // Defensive: shows that cross midnight (HK time) have endTime <= startTime.
    if (endUtcMs <= startUtcMs) endUtcMs += 24 * 60 * 60_000;
    if (nowMs >= startUtcMs && nowMs < endUtcMs) return show;
  }
  return null;
}

async function fetchHKCRMetadata({ signal } = {}) {
  try {
    const response = await fetchWithTimeout(
      'https://cms.hkcr.live/schedule/current',
      { signal },
      5000
    );
    if (!response.ok) return null;
    const shows = await response.json();
    const current = findCurrentHKCRShow(shows);
    if (!current?.title) return null;
    const display = cleanNowPlaying(current.title);
    if (!display) return null;
    return {
      source: 'hkcr',
      display,
      artist: null,
      title: null,
      raw: current,
      confidence: 0.9,
      // Show boundaries are on the hour; a 60 s refresh catches the rollover
      // quickly without hammering the upstream CMS.
      cacheTtl: 60
    };
  } catch (error) {
    console.error('HKCR API fetch failed:', error);
    return null;
  }
}

// NTS Radio API integration
async function fetchNTSMetadata(streamUrl, stationId, { signal } = {}) {
  try {
    // Only use NTS API for main live channels (stream-relay)
    if (!streamUrl.includes('stream-relay-geo.ntslive.net')) {
      return null;
    }

    const response = await fetchWithTimeout('https://www.nts.live/api/v2/live', { signal }, 5000);
    if (!response.ok) throw new Error(`NTS API error: ${response.status}`);
    
    const data = await response.json();
    const channels = data.results || [];
    
    // Detect channel from stream URL
    let targetChannel = '1'; // default for /stream
    if (streamUrl.includes('/stream2')) {
      targetChannel = '2';
    }
    
    // Find the matching channel
    let channel = channels.find(r => r.channel_name === targetChannel) || channels[0];
    
    if (channel && channel.now) {
      const now = channel.now;
      
      // Use broadcast_title as the main content, it contains the track info
      let nowPlaying = now.broadcast_title || now.title || '';
      
      // If we have artist info from embeds, use that instead
      if (now.embeds?.details?.name) {
        nowPlaying = now.embeds.details.name;
      }
      
      nowPlaying = cleanNowPlaying(nowPlaying);
      
      if (nowPlaying) {
        return {
          source: 'nts',
          display: nowPlaying,
          artist: null,
          title: null,
          raw: { channel: channel.channel_name === '2' ? 'NTS 2' : 'NTS 1', ...now },
          confidence: 0.9,
          cacheTtl: 30
        };
      }
    }
  } catch (error) {
    console.error('NTS API fetch failed:', error);
  }
  return null;
}

// NTS mixtape channels (Poolside, 4 To The Floor, ...) stream from
// stream-mixtape-geo.ntslive.net and carry no in-stream metadata. They are
// static themed channels, so the "now playing" is the mixtape's own title +
// subtitle from the public mixtapes API. Matching is by exact
// audio_stream_endpoint — /mixtape must not match /mixtape5.
function isNTSMixtapeStreamUrl(streamUrl) {
  try {
    return new URL(streamUrl).hostname.toLowerCase() === 'stream-mixtape-geo.ntslive.net';
  } catch (_) {
    return false;
  }
}

function findNTSMixtape(data, streamUrl) {
  const results = data?.results;
  if (!Array.isArray(results)) return null;
  let target;
  try {
    const u = new URL(streamUrl);
    target = (u.origin + u.pathname).replace(/\/+$/, '').toLowerCase();
  } catch (_) {
    return null;
  }
  return results.find((m) =>
    typeof m?.audio_stream_endpoint === 'string' &&
    m.audio_stream_endpoint.replace(/\/+$/, '').toLowerCase() === target
  ) || null;
}

async function fetchNTSMixtapeMetadata(streamUrl, { signal } = {}) {
  try {
    const response = await fetchWithTimeout('https://www.nts.live/api/v2/mixtapes', { signal }, 5000);
    if (!response.ok) return null;
    const data = await response.json();
    const mixtape = findNTSMixtape(data, streamUrl);
    if (!mixtape) return null;
    const title = (mixtape.title || '').trim();
    if (!title) return null;
    const subtitle = (mixtape.subtitle || '').trim().replace(/\.$/, '');
    const display = cleanNowPlaying(subtitle && subtitle !== title ? `${title} - ${subtitle}` : title);
    if (!display || !isValidMetadata({ display })) return null;
    return {
      source: 'nts-mixtape',
      display,
      artist: null,
      title,
      raw: { mixtape_alias: mixtape.mixtape_alias, subtitle: mixtape.subtitle },
      confidence: 0.95,
      // Mixtape descriptions are effectively static — cache long.
      cacheTtl: 3600,
    };
  } catch (error) {
    return null;
  }
}

// RadioCult (radiocult.fm) — platform used by Noods, Oroko, Worldwide FM,
// n10.as, Radio Banda Larga and others. The station slug is the stream
// subdomain and the public API is predictable from it, same pattern as the
// Airtime Pro derivation above.
function deriveRadioCultEndpointFromStream(streamUrl) {
  try {
    const host = new URL(streamUrl).hostname.toLowerCase();
    const m = host.match(/^([^.]+)\.radiocult\.fm$/);
    if (!m || m[1] === 'api' || m[1] === 'www') return null;
    return `https://api.radiocult.fm/api/station/${m[1]}/schedule/live`;
  } catch (_) {
    return null;
  }
}

function parseRadioCultNowPlaying(data) {
  const r = data?.result;
  if (!r || typeof r !== 'object') return null;
  if (r.status === 'offAir') return null;

  const meta = r.metadata && typeof r.metadata === 'object' ? r.metadata : {};
  const artist = typeof meta.artist === 'string' ? meta.artist.trim() : '';
  const title = typeof meta.title === 'string' ? meta.title.trim() : '';

  let display = '';
  if (artist && title && artist !== title) display = `${artist} - ${title}`;
  else if (title) display = title;
  else if (r.content && typeof r.content === 'object' && typeof r.content.title === 'string') {
    display = r.content.title;
  }

  display = cleanNowPlaying(display);
  if (!display || !isValidMetadata({ display })) return null;
  return { display, artist: artist || null, title: title || null };
}

async function fetchRadioCultMetadata(streamUrl, { signal } = {}) {
  try {
    const endpoint = deriveRadioCultEndpointFromStream(streamUrl);
    if (!endpoint) return null;
    const response = await fetchWithTimeout(endpoint, { signal }, 5000);
    if (!response.ok) return null;
    const data = await response.json();
    const parsed = parseRadioCultNowPlaying(data);
    if (!parsed) return null;
    return {
      source: 'radiocult',
      ...parsed,
      raw: { status: data?.result?.status, show: data?.result?.content?.title ?? null },
      confidence: 0.9,
      cacheTtl: 30,
    };
  } catch (error) {
    return null;
  }
}

// RadioJar — stream.radiojar.com/<streamId> exposes now-playing at
// proxy.radiojar.com/api/stations/<streamId>/now_playing/. Used by Radio
// Alhara and many others on the platform.
function deriveRadioJarEndpointFromStream(streamUrl) {
  try {
    const u = new URL(streamUrl);
    if (u.hostname.toLowerCase() !== 'stream.radiojar.com') return null;
    const seg = u.pathname.split('/').filter(Boolean)[0];
    if (!seg) return null;
    return `https://proxy.radiojar.com/api/stations/${seg}/now_playing/`;
  } catch (_) {
    return null;
  }
}

function parseRadioJarNowPlaying(data) {
  if (!data || typeof data !== 'object') return null;
  const artist = typeof data.artist === 'string' ? data.artist.trim() : '';
  const title = typeof data.title === 'string' ? data.title.trim() : '';

  let display = '';
  if (artist && title && artist !== title) display = `${artist} - ${title}`;
  else display = title || artist;

  display = cleanNowPlaying(display);
  if (!display || !isValidMetadata({ display })) return null;
  return { display, artist: artist || null, title: title || null };
}

async function fetchRadioJarMetadata(streamUrl, { signal } = {}) {
  try {
    const endpoint = deriveRadioJarEndpointFromStream(streamUrl);
    if (!endpoint) return null;
    const response = await fetchWithTimeout(endpoint, { signal }, 4000);
    if (!response.ok) return null;
    const data = await response.json();
    const parsed = parseRadioJarNowPlaying(data);
    if (!parsed) return null;
    return {
      source: 'radiojar',
      ...parsed,
      raw: data,
      confidence: 0.85,
      cacheTtl: 15,
    };
  } catch (error) {
    return null;
  }
}

// Curated station-map strategy — stations whose metadata API lives on a
// different host than the stream (see strategies/station-map.js).
async function fetchStationMapMetadata(entry, streamUrl, { signal } = {}) {
  try {
    const response = await fetchWithTimeout(entry.infoUrl, { signal }, 5000);
    if (!response.ok) return null;
    const data = HTML_KINDS.has(entry.kind) ? await response.text() : await response.json();
    const parsed = entry.kind === 'azuracast'
      ? parseAzuraCastNowPlaying(data)
      : parseByKind(entry.kind, data, streamUrl);
    if (!parsed) return null;
    return {
      source: `station-map-${entry.kind}`,
      ...parsed,
      raw: { endpoint: entry.infoUrl, station: entry.station },
      confidence: 0.9,
      cacheTtl: CACHE_TTL_BY_KIND[entry.kind] || 30,
    };
  } catch (error) {
    return null;
  }
}

// StreamTheWorld / Triton Digital — by far the largest platform in the dataset
// (2,634 of 52k stations). Now-playing lives on np.tritondigital.com keyed by
// the mount name, which is the last segment of the stream path — so it derives
// from the URL and needs no per-station rule.
//
// Two shapes cover ~99%:
//   playerservices.streamtheworld.com/api/livestream-redirect/<MOUNT>[.aac]  (1,643)
//   <N>.live.streamtheworld.com/<MOUNT>[.aac]                                 (976)
function deriveStreamTheWorldMount(streamUrl) {
  try {
    if (!streamUrl) return null;
    const u = new URL(streamUrl);
    if (!/(^|\.)streamtheworld\.com$/i.test(u.hostname)) return null;
    const last = u.pathname.split('/').filter(Boolean).pop() || '';
    const mount = last.replace(/\.(aac|mp3|m3u8)$/i, '');
    return mount || null;
  } catch (e) {
    return null;
  }
}

function tritonCdata(xml, key) {
  const needle = 'name="' + key + '"><![CDATA[';
  const i = xml.indexOf(needle);
  if (i === -1) return '';
  const start = i + needle.length;
  const end = xml.indexOf(']]>', start);
  return end === -1 ? '' : xml.slice(start, end).trim();
}

// Triton answers XML with CDATA-wrapped properties. Talk/news mounts return an
// empty <nowplaying-info-list/> — a legitimate "nothing playing", not an error.
function parseTritonNowPlaying(xml) {
  const s = typeof xml === 'string' ? xml : '';
  if (!s) return null;
  const title = cleanNowPlaying(tritonCdata(s, 'cue_title'));
  const artist = cleanNowPlaying(tritonCdata(s, 'track_artist_name'));
  if (!title && !artist) return null;
  const display = parseArtistTitle('', artist, title);
  if (!display || !isValidMetadata({ display })) return null;
  return { artist: artist || null, title: title || null, display };
}

const TRITON_NP_BASE = 'https://np.tritondigital.com/public/nowplaying';

async function fetchTritonForMount(mount, { signal }) {
  const url = TRITON_NP_BASE + '?mountName=' + encodeURIComponent(mount) + '&numberToFetch=1&eventType=track';
  const response = await fetchWithTimeout(url, { signal }, 4000);
  if (!response.ok) return null;
  return parseTritonNowPlaying(await response.text());
}

async function fetchStreamTheWorldMetadata(streamUrl, { signal } = {}) {
  try {
    const mount = deriveStreamTheWorldMount(streamUrl);
    if (!mount) return null;

    // The mount is case-sensitive at Triton and stream URLs do not always carry
    // the canonical case: ACIR11_s01AAC returns nothing where ACIR11_S01AAC
    // returns the track. Try as-is, then upper-case — that lifted the measured
    // sample hit rate from 7/13 to 11/13.
    const candidates = [mount];
    if (mount.toUpperCase() !== mount) candidates.push(mount.toUpperCase());

    for (const cand of candidates) {
      if (signal?.aborted) return null;
      const parsed = await fetchTritonForMount(cand, { signal });
      if (parsed) {
        return {
          source: 'streamtheworld',
          display: parsed.display,
          artist: parsed.artist,
          title: parsed.title,
          raw: { mount: cand },
          confidence: 0.85,
          cacheTtl: 15,
        };
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Airtime Pro integration
function deriveAirtimeProEndpointFromStream(streamUrl) {
  try {
    if (!streamUrl) return null;
    const u = new URL(streamUrl);
    const host = (u.hostname || '').toLowerCase();
    // <station>.out.airtime.pro  ->  <station>.airtime.pro/api/live-info-v2
    const a = host.match(/^([^.]+)\.out\.airtime\.pro$/i);
    if (a) return `https://${a[1]}.airtime.pro/api/live-info-v2`;
    // Airtime Pro on streamnerd.nl. Stream URLs look like
    //   https://origin.streamnerd.nl/<station>/<mount>/icecast.audio
    //   https://play.streamnerd.nl/<station>/<mount>/playlist.m3u8
    // and the Airtime API lives at <station>.streamnerd.nl/api/live-info-v2
    // (verified for Operator Radio: operator.streamnerd.nl/api/live-info-v2).
    if (host === 'origin.streamnerd.nl' || host === 'play.streamnerd.nl') {
      const seg = u.pathname.split('/').filter(Boolean)[0];
      if (seg) return `https://${seg}.streamnerd.nl/api/live-info-v2`;
    }
    // Some stations stream straight off their own streamnerd subdomain, with no
    // path segment to read (Relate Radio: https://relateradio.streamnerd.nl/).
    // The Airtime API then sits on that same host, so derive from the subdomain.
    const sn = host.match(/^([^.]+)\.streamnerd\.nl$/i);
    if (sn) return `https://${sn[1]}.streamnerd.nl/api/live-info-v2`;
    return null;
  } catch (e) {
    return null;
  }
}

function isAirtimeProStreamUrl(streamUrl) {
  return !!deriveAirtimeProEndpointFromStream(streamUrl);
}

function parseAirtimeProNowPlaying(data) {
  // Prefer track-level info from Airtime Pro structure
  const currentTrack = data?.tracks?.current;
  const meta = currentTrack?.metadata;
  const rawArtist = (meta?.artist_name || meta?.artist || '').trim();
  let rawTitle = (meta?.track_title || '').trim();
  if (!rawTitle && typeof currentTrack?.name === 'string') {
    rawTitle = currentTrack.name.replace(/^\s*-\s*/, '').trim();
  }

  // Show name from schedule
  const showNameRaw = (data?.shows?.current?.name || '').trim();
  const showName = showNameRaw && !/airtime/i.test(showNameRaw) && !/archive/i.test(showNameRaw)
    ? showNameRaw
    : '';

  // Build track component first (artist - title if both; else the one available)
  let trackComponent = null;
  if (rawArtist && rawTitle) trackComponent = `${rawArtist} - ${rawTitle}`;
  else if (rawTitle) trackComponent = rawTitle;
  else if (rawArtist) trackComponent = rawArtist;

  let nowPlaying = null;
  if (showName && trackComponent) {
    // Avoid duplicating if track already starts with show name
    const lcShow = showName.toLowerCase();
    const lcTrack = trackComponent.toLowerCase();
    if (!lcTrack.startsWith(lcShow + ' - ') && lcShow !== lcTrack) {
      nowPlaying = `${showName} - ${trackComponent}`;
    } else {
      nowPlaying = trackComponent;
    }
  } else if (trackComponent) {
    nowPlaying = trackComponent;
  } else if (showName) {
    nowPlaying = showName;
  }

  // Last-resort generic keys
  if (!nowPlaying) {
    const np = data?.now || data?.now_playing || data?.nowPlaying;
    if (typeof np === 'string') nowPlaying = np.trim();
    else if (np && (np.title || np.name)) nowPlaying = (np.title || np.name).trim();
  }

  // Apply the same placeholder/junk gate every other strategy uses. Airtime
  // (LibreTime) emits "offline" as a track/show name when a live source is on
  // but no scheduled playout runs — that is not now-playing. Dropping it here
  // lets resolution fall through to ICY stream metadata (Kiosk Radio).
  const cleaned = cleanNowPlaying(nowPlaying);
  return isValidMetadata({ display: cleaned }) ? cleaned : '';
}

async function fetchAirtimeProMetadata(streamUrl, providedEndpoint, { signal } = {}) {
  try {
    const endpoint = providedEndpoint || deriveAirtimeProEndpointFromStream(streamUrl);
    if (!endpoint) return null;

    const response = await fetchWithTimeout(endpoint, { signal }, 5000);
    if (!response.ok) return null;

    const data = await response.json();
    const nowPlaying = parseAirtimeProNowPlaying(data);
    
    if (nowPlaying && nowPlaying.trim().length > 0) {
      return {
        source: 'airtimepro',
        display: nowPlaying.trim(),
        artist: null,
        title: null,
        raw: data,
        confidence: 0.8,
        cacheTtl: 20
      };
    }
    return null;
  } catch (e) {
    console.error('Airtime Pro metadata fetch failed:', e);
    return null;
  }
}

// Cashmere Radio (specific Airtime Pro instance)
async function fetchCashmereMetadata({ signal } = {}) {
  try {
    const endpoint = 'https://cashmereradio.airtime.pro/api/live-info-v2';
    const response = await fetchWithTimeout(endpoint, { signal }, 5000);
    if (!response.ok) throw new Error(`Cashmere API error: ${response.status}`);

    const data = await response.json();
    const nowPlaying = parseAirtimeProNowPlaying(data);

    if (nowPlaying && nowPlaying.trim().length > 0) {
      return {
        source: 'cashmere',
        display: nowPlaying.trim(),
        artist: null,
        title: null,
        raw: data,
        confidence: 0.9,
        cacheTtl: 20
      };
    }

    return null;
  } catch (error) {
    console.error('Cashmere metadata fetch failed:', error);
    return null;
  }
}

// Hong Kong Community Radio (HKCR) broadcasts as an HLS stream
// (stream-test.hkcr.live/hls/main.m3u8) with no useful in-band metadata —
// the actual programming is a hand-curated schedule kept in HKCR's CMS.
//
// The CMS exposes the current week's schedule at
//   GET https://cms.hkcr.live/schedule/current
// returning an array of show objects of shape:
//   { _id, title, description, date: "YYYY-MM-DD", startTime: "HH:MM",
//     endTime: "HH:MM", picture, thumbnail, cancelledAt, status, ... }
// All times are in Hong Kong local time (UTC+8, no DST).
//
// findCurrentHKCRShow() is the pure helper that picks the show whose
// [startTime, endTime) window contains `now`. Exposed for unit tests.

const HK_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// "YYYY-MM-DD" + "HH:MM" in HK local time -> UTC instant (epoch ms).
// HK is UTC+8 with no DST, so the UTC instant is simply 8 hours earlier than
// the wall-clock instant. We use Date.UTC to construct the wall-clock instant
// without involving the host machine's local timezone.
function hkLocalToUtcMs(dateStr, timeStr) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  const tm = /^(\d{2}):(\d{2})$/.exec(timeStr);
  if (!dm || !tm) return NaN;
  const y = +dm[1], mo = +dm[2], d = +dm[3];
  const hh = +tm[1], mm = +tm[2];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mm > 59) return NaN;
  return Date.UTC(y, mo - 1, d, hh, mm) - HK_OFFSET_MS;
}

function findCurrentHKCRShow(shows, now = new Date()) {
  if (!Array.isArray(shows)) return null;
  const t = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(t)) return null;
  for (const show of shows) {
    if (!show || typeof show !== 'object') continue;
    if (show.cancelledAt) continue;
    if (typeof show.title !== 'string' || !show.title.trim()) continue;
    const start = hkLocalToUtcMs(show.date, show.startTime);
    let end = hkLocalToUtcMs(show.date, show.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    // Midnight-crossing window — e.g. 23:00 -> 01:00 — means the end is the
    // next day. Add 24h so the comparison still makes sense.
    if (end <= start) end += DAY_MS;
    if (t >= start && t < end) return show;
  }
  return null;
}

function isHKCRStreamUrl(streamUrl) {
  try {
    const h = new URL(streamUrl).hostname.toLowerCase();
    return h === 'hkcr.live' || h.endsWith('.hkcr.live');
  } catch (_) {
    return false;
  }
}

async function fetchHKCRMetadata({ signal } = {}) {
  try {
    const response = await fetchWithTimeout(
      'https://cms.hkcr.live/schedule/current',
      { signal },
      4000,
    );
    if (!response.ok) return null;
    const shows = await response.json();
    const current = findCurrentHKCRShow(shows, new Date());
    if (!current) return null;
    const title = cleanNowPlaying(current.title);
    if (!title || !isValidMetadata({ display: title })) return null;
    return {
      source: 'hkcr-schedule',
      display: title,
      artist: null,
      title,
      raw: {
        scheduleId: current._id,
        date: current.date,
        startTime: current.startTime,
        endTime: current.endTime,
        thumbnail: current.thumbnail?.url || null,
      },
      confidence: 0.9,
      cacheTtl: 60,
    };
  } catch (_) {
    return null;
  }
}

// ROVR (rovr.live) — London-based curated radio. HLS stream, no in-band
// metadata, but their Strapi CMS exposes the current schedule at
//   GET https://strapi.rovr.live/api/schedules/radio/public?date=<YYYY-MM-DD HH:MM:SS>
// returning { data: [ { startTime, endTime, show: { title, curators: [...] } } ] }
// where data[0] is the show currently on air (per the ROVR app's own client
// code). startTime / endTime are wall-clock strings in London local time.

function pad2(n) { return String(n).padStart(2, '0'); }

// Format a Date as "YYYY-MM-DD HH:MM:SS" in a fixed UTC offset (minutes).
function formatWallclock(d, offsetMinutes = 0) {
  const t = new Date(d.getTime() + offsetMinutes * 60 * 1000);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())} `
       + `${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}:${pad2(t.getUTCSeconds())}`;
}

function isRovrStreamUrl(streamUrl) {
  try {
    const h = new URL(streamUrl).hostname.toLowerCase();
    return h === 'rovr.live' || h.endsWith('.rovr.live');
  } catch (_) {
    return false;
  }
}

async function fetchROVRMetadata({ signal } = {}) {
  try {
    // London is UTC+0 in winter, UTC+1 in BST. Send UTC — Strapi's query
    // appears to match against epoch-equivalent times regardless of the
    // displayed offset. Empirically a UTC query returns the show airing
    // right now.
    const dateParam = formatWallclock(new Date(), 0);
    const url = `https://strapi.rovr.live/api/schedules/radio/public?date=${encodeURIComponent(dateParam)}`;
    const response = await fetchWithTimeout(url, { signal }, 4000);
    if (!response.ok) return null;
    const json = await response.json();
    const slot = Array.isArray(json?.data) ? json.data[0] : null;
    if (!slot || !slot.show) return null;
    const showTitle = (slot.show.title || '').trim();
    if (!showTitle) return null;
    const curatorName = Array.isArray(slot.show.curators) && slot.show.curators[0]?.name
      ? String(slot.show.curators[0].name).trim()
      : '';
    const display = cleanNowPlaying(
      curatorName && curatorName !== showTitle
        ? `${showTitle} - ${curatorName}`
        : showTitle,
    );
    if (!display || !isValidMetadata({ display })) return null;
    return {
      source: 'rovr-schedule',
      display,
      artist: curatorName || null,
      title: showTitle,
      raw: {
        startTime: slot.startTime,
        endTime: slot.endTime,
        showId: slot.show.id,
        radioImage: slot.show.radioImage?.url || null,
      },
      confidence: 0.9,
      cacheTtl: 60,
    };
  } catch (_) {
    return null;
  }
}

// Rinse FM — Craft CMS GraphQL response served at
//   GET https://www.rinse.fm/api/query/v1/schedule/
// returning { episodes: [...] } where each episode has:
//   episodeTime: ISO with Europe/London offset
//   episodeLength: minutes
//   parentShow: [{ title, slug }]
//   channel: [{ slug, streamerMountPoint }]
// Episodes from every channel (uk, fr, kool, ...) are in one response, so
// we filter by matching the request's stream URL against
// channel[0].streamerMountPoint.

function findCurrentRinseEpisode(episodes, streamUrl, now = new Date()) {
  if (!Array.isArray(episodes)) return null;
  const t = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(t)) return null;
  const target = String(streamUrl || '').toLowerCase();
  if (!target) return null;
  for (const ep of episodes) {
    if (!ep || typeof ep !== 'object') continue;
    const mount = ep.channel?.[0]?.streamerMountPoint;
    if (typeof mount !== 'string' || mount.toLowerCase() !== target) continue;
    if (!ep.episodeTime || typeof ep.episodeTime !== 'string') continue;
    const start = Date.parse(ep.episodeTime);
    if (!Number.isFinite(start)) continue;
    const lengthMin = Number(ep.episodeLength);
    if (!Number.isFinite(lengthMin) || lengthMin <= 0) continue;
    const end = start + lengthMin * 60 * 1000;
    if (t >= start && t < end) return ep;
  }
  return null;
}

function isRinseStreamUrl(streamUrl) {
  try {
    const h = new URL(streamUrl).hostname.toLowerCase();
    return h === 'rinse.fm' || h.endsWith('.rinse.fm');
  } catch (_) {
    return false;
  }
}

async function fetchRinseFMMetadata(streamUrl, { signal } = {}) {
  try {
    const response = await fetchWithTimeout(
      'https://www.rinse.fm/api/query/v1/schedule/',
      { signal },
      5000,
    );
    if (!response.ok) return null;
    const json = await response.json();
    const ep = findCurrentRinseEpisode(json?.episodes, streamUrl, new Date());
    if (!ep) return null;
    // Prefer the clean parent-show title ("Suzie Bakos") over the dated
    // episode title ("Suzie Bakos - 19/05/2026 - 13:00").
    const cleanTitle = ep.parentShow?.[0]?.title || ep.title || '';
    const display = cleanNowPlaying(cleanTitle);
    if (!display || !isValidMetadata({ display })) return null;
    return {
      source: 'rinse-schedule',
      display,
      artist: null,
      title: display,
      raw: {
        episodeId: ep.id,
        episodeTime: ep.episodeTime,
        episodeLength: ep.episodeLength,
        channel: ep.channel?.[0]?.slug || null,
        isRebroadcast: !!ep.isRebroadcast,
      },
      confidence: 0.9,
      cacheTtl: 60,
    };
  } catch (_) {
    return null;
  }
}

// Radio.co stations expose a clean public JSON API at
// https://public.radio.co/stations/<id>/status. The station id is the path
// segment in the stream URL, e.g. https://streaming.radio.co/s3699c5e49/listen
// -> station id "s3699c5e49". Detection is conservative: host must end in
// .radio.co or radio.co exactly.
async function fetchRadioCoMetadata(streamUrl, { signal } = {}) {
  try {
    const u = new URL(streamUrl);
    if (!/(^|\.)radio\.co$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/\/(s[a-z0-9]+)\b/i);
    if (!m) return null;
    const stationId = m[1];
    const response = await fetchWithTimeout(
      `https://public.radio.co/stations/${stationId}/status`,
      { signal },
      4000,
    );
    if (!response.ok) return null;
    const data = await response.json();
    const title = (data?.current_track?.title || '').trim();
    if (!title) return null;
    const display = cleanNowPlaying(title);
    if (!display || !isValidMetadata({ display })) return null;
    let artist = null;
    let trackTitle = null;
    if (display.includes(' - ')) {
      const parts = display.split(' - ');
      artist = parts[0].trim();
      trackTitle = parts.slice(1).join(' - ').trim();
    }
    return {
      source: 'radio-co',
      display,
      artist,
      title: trackTitle,
      raw: { current_track: data.current_track, status: data.status },
      confidence: 0.9,
      cacheTtl: 30,
    };
  } catch (e) {
    return null;
  }
}

// Pure parser for the AzuraCast now-playing shape ({now_playing: {song:
// {artist, title, text}}}). Shared between the derived-endpoint strategy
// below and station-map entries whose API lives on a different host (KWSX).
function parseAzuraCastNowPlaying(data) {
  const song = data?.now_playing?.song || data?.now_playing;
  if (!song || typeof song !== 'object') return null;
  const artist = (song.artist || '').trim();
  const trackTitle = (song.title || '').trim();
  const text = (song.text || '').trim();
  let display = '';
  if (artist && trackTitle && artist !== trackTitle) {
    display = `${artist} - ${trackTitle}`;
  } else if (text) {
    display = text;
  } else if (trackTitle) {
    display = trackTitle;
  } else if (artist) {
    display = artist;
  }
  display = cleanNowPlaying(display);
  if (!display || !isValidMetadata({ display })) return null;
  return { display, artist: artist || null, title: trackTitle || null };
}

// AzuraCast exposes /api/nowplaying_static/<shortcode>.json on the host that
// also serves the stream. The shortcode is in the stream path:
//   https://radio.example.com/listen/myradio/radio.mp3 -> "myradio"
// We probe defensively — if the host isn't AzuraCast we get a fast 404.
async function fetchAzuraCastMetadata(streamUrl, { signal } = {}) {
  try {
    const u = new URL(streamUrl);
    const m = u.pathname.match(/^\/listen\/([A-Za-z0-9_-]+)\b/);
    if (!m) return null;
    const shortcode = m[1];
    const endpoints = [
      `${u.protocol}//${u.host}/api/nowplaying_static/${shortcode}.json`,
      `${u.protocol}//${u.host}/api/nowplaying/${shortcode}`,
    ];
    for (const endpoint of endpoints) {
      if (signal?.aborted) return null;
      try {
        const response = await fetchWithTimeout(endpoint, { signal }, 3000);
        if (!response.ok) continue;
        const data = await response.json();
        // Static endpoint returns a single object; non-static returns the
        // same shape but is the canonical source if the static is stale.
        const parsed = parseAzuraCastNowPlaying(data);
        if (!parsed) continue;
        return {
          source: 'azuracast',
          ...parsed,
          raw: { now_playing: data.now_playing, station: data.station },
          confidence: 0.9,
          cacheTtl: 20,
        };
      } catch (e) {
        continue;
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Shoutcast v2 SC_TRANS exposes JSON stats at /stats?json=1.
// Response shape: { songtitle: "Artist - Title", streamtitle, servertitle, ... }
async function fetchShoutcastV2Metadata(streamUrl, { signal } = {}) {
  try {
    const u = new URL(streamUrl);
    const endpoint = `${u.protocol}//${u.host}/stats?json=1`;
    const response = await fetchWithTimeout(endpoint, { signal }, 3000);
    if (!response.ok) return null;
    const data = await response.json();
    const songtitle = (data?.songtitle || '').trim();
    if (!songtitle) return null;
    const display = cleanNowPlaying(songtitle);
    if (!display || !isValidMetadata({ display })) return null;
    let artist = null;
    let trackTitle = null;
    if (display.includes(' - ')) {
      const parts = display.split(' - ');
      artist = parts[0].trim();
      trackTitle = parts.slice(1).join(' - ').trim();
    }
    return {
      source: 'shoutcast-v2',
      display,
      artist,
      title: trackTitle,
      raw: data,
      confidence: 0.85,
      cacheTtl: 15,
    };
  } catch (e) {
    return null;
  }
}

// Icecast status JSON endpoints
async function fetchIcecastMetadata(endpoints, mount, { signal } = {}) {
  try {
    const attempt = async (statusUrl) => {
      try {
        const response = await fetchWithTimeout(statusUrl, { signal }, FAST_TIMEOUT);
        if (!response.ok) return null;

        const data = await response.json();
        let sources = [];

        if (data.icestats?.source) {
          sources = Array.isArray(data.icestats.source) ? data.icestats.source : [data.icestats.source];
        }

        const source = sources.find(s => 
          (s.listenurl && mount && s.listenurl.includes(mount)) ||
          (s.mount && mount && s.mount === mount) ||
          (s.server_name && mount && s.server_name.includes(mount))
        ) || sources[0];

        if (source && (source.title || source.artist || source.song || source.track || source.track_title || source.artist_name)) {
          const title = source.title || source.song || source.track || source.track_title || '';
          const artist = source.artist || source.performer || source.artist_name || '';

          let parsedArtist = artist;
          let parsedTitle = title;
          if (!artist && title.includes(' - ')) {
            const parts = title.split(' - ');
            parsedArtist = parts[0].trim();
            parsedTitle = parts.slice(1).join(' - ').trim();
          }

          let nowPlaying = '';
          if (parsedArtist && parsedTitle && parsedArtist !== parsedTitle) nowPlaying = `${parsedArtist} - ${parsedTitle}`;
          else if (parsedTitle) nowPlaying = parsedTitle;
          else if (parsedArtist) nowPlaying = parsedArtist;

          if (nowPlaying && isValidMetadata({ display: nowPlaying })) {
            {
              return {
                source: 'icecast-status',
                display: nowPlaying,
                artist: parsedArtist || null,
                title: parsedTitle || null,
                raw: { source, endpoint: statusUrl },
                confidence: 0.8,
                cacheTtl: 15
              };
            }
          }
        }
        return null;
      } catch (error) {
        if (error.name === 'AbortError') return null;
        return null;
      }
    };

    const promises = endpoints.map(e => attempt(e));
    return await firstNonNullResult(promises) || null;
  } catch (e) {
    return null;
  }
}

// ICY metadata parsing using the same logic as the working old version (adapted for Node.js)
async function fetchICYMetadata(streamUrl, { signal } = {}) {
  try {

    const response = await fetchWithTimeout(streamUrl, {
      method: 'GET',
      signal,
      headers: {
        'Icy-MetaData': '1',
        'User-Agent': 'RadioDock/1.0'
      }
    }, 8000);
    
    if (!response.ok) {
      throw new Error(`ICY fetch error: ${response.status}`);
    }
    
    const icyMetaInt = parseInt(response.headers['icy-metaint']);
    
    if (!icyMetaInt || !response.body) {
      // Fallback to headers if no metadata blocks
      const icyName = response.headers['icy-name'];
      const icyDescription = response.headers['icy-description'];
      
      
      if (icyName && icyName !== icyDescription && isValidMetadata({ display: icyName })) {
        {
          return {
            source: 'icy-headers',
            display: cleanNowPlaying(icyName),
            artist: null,
            title: null,
            raw: { icyName, icyDescription },
            confidence: 0.7,
            cacheTtl: 30
          };
        }
      }
      throw new Error('No ICY metadata available');
    }
    
    // Read the stream to extract metadata blocks (adapted for Node.js undici)
    let buffer = new Uint8Array();
    let bytesRead = 0;
    let metadataFound = null;
    
    
    try {
      // Use undici body iterator for Node.js
      for await (const chunk of response.body) {
        // Convert chunk to Uint8Array if needed
        const chunkArray = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        
        // Append new data to buffer
        const newBuffer = new Uint8Array(buffer.length + chunkArray.length);
        newBuffer.set(buffer);
        newBuffer.set(chunkArray, buffer.length);
        buffer = newBuffer;
        bytesRead += chunkArray.length;
        
        // Check if we have reached the metadata block
        if (buffer.length >= icyMetaInt + 1) {
          const metadataLength = buffer[icyMetaInt] * 16;
          
          if (metadataLength > 0 && buffer.length >= icyMetaInt + 1 + metadataLength) {
            // Extract metadata block
            const metadataBytes = buffer.slice(icyMetaInt + 1, icyMetaInt + 1 + metadataLength);
            const metadataString = decodeIcyBytes(metadataBytes);

            // Parse StreamTitle from metadata
            const streamTitleMatch = metadataString.match(/StreamTitle='([^']*)'/);
            if (streamTitleMatch && streamTitleMatch[1]) {
              metadataFound = streamTitleMatch[1].trim();
              break; // Found metadata, exit loop
            }
          }
        }
        
        // Stop reading after getting enough data
        if (bytesRead >= icyMetaInt + 255) {
          break;
        }
      }
    } catch (streamError) {
    }
    
    // Filter out generic/unhelpful metadata using the central junk list.
    if (metadataFound && isValidMetadata({ display: metadataFound })) {
      {
        // Try to split artist and title
        let artist = null;
        let title = null;
        
        if (metadataFound.includes(' - ')) {
          const parts = metadataFound.split(' - ');
          artist = parts[0].trim();
          title = parts.slice(1).join(' - ').trim();
        }
        
        return {
          source: 'icy',
          display: cleanNowPlaying(metadataFound),
          artist: artist,
          title: title,
          raw: { StreamTitle: metadataFound },
          confidence: 0.95,
          cacheTtl: 15
        };
      }
    }
    
    return null;
    
  } catch (error) {
    // Only log significant errors, not common network issues
    if (error.name !== 'AbortError' && !error.message.includes('NetworkError')) {
    }
    return null;
  }
}

// Generic metadata fetcher for various station APIs
async function fetchGenericMetadata(streamUrl, station, { signal } = {}) {
  try {
    const urlObj = new URL(streamUrl);

    // Special handling for Callshop Radio
    if (streamUrl.includes('callshopradio.com')) {
      try {
        const response = await fetchWithTimeout('https://icecast.callshopradio.com/status-json.xsl', { signal });
        
        if (response.ok) {
          const data = await response.json();
          let sources = [];
          if (data.icestats?.source) {
            sources = Array.isArray(data.icestats.source) ? data.icestats.source : [data.icestats.source];
          }
          
          const mount = streamUrl.includes('/callshopradio-wien') ? '/callshopradio-wien' : '/callshopradio';
          let source = sources.find(s => s.listenurl?.includes(mount) || s.mount?.includes(mount)) || sources[0];
          
          if (source?.title && source.title.trim()) {
            const nowPlaying = source.title.trim();
            if (isValidMetadata({ display: nowPlaying })) {
              return {
                source: 'callshop-radio',
                display: nowPlaying,
                artist: null,
                title: null,
                raw: source,
                confidence: 0.8,
                cacheTtl: 15
              };
            }
          }
        }
      } catch (e) {
        // Continue to other methods
      }
    }
    
    // Special handling for Radio King streams
    if (streamUrl.includes('radioking.com')) {
      
      const radioIdMatch = streamUrl.match(/radio\/(\d+)/);
      if (radioIdMatch) {
        const radioId = radioIdMatch[1];
        
        const radioKingEndpoints = [
          `https://www.radioking.com/api/radio/${radioId}/track/current`,
          `https://api.radioking.com/widget/radio/${radioId}`,
          `https://www.radioking.com/api/radio/${radioId}`,
          `${urlObj.protocol}//${urlObj.host}/api/radio/${radioId}/track/current`
        ];
        
        
        for (const endpoint of radioKingEndpoints) {
          if (signal?.aborted) return null;
          try {
            const response = await fetchWithTimeout(endpoint, { signal }, 3000);
            
            if (response.ok) {
              const data = await response.json();
              
              const parsed = parseArtistTitle(
                data.title || data.track?.title || data.track?.name || '',
                data.artist || data.track?.artist || '',
                data.title || data.track?.title || data.track?.name || ''
              );
              
              
              if (parsed && isValidMetadata({ display: parsed })) {
                return {
                  source: 'radioking',
                  display: parsed,
                  artist: data.artist || data.track?.artist || null,
                  title: data.title || data.track?.title || data.track?.name || null,
                  raw: data,
                  confidence: 0.8,
                  cacheTtl: 15
                };
              } else {
              }
            } else {
            }
          } catch (e) {
            continue;
          }
        }
        
      } else {
      }
    }
    
    // Try common metadata endpoints based on station URL.
    // Path-negative cache (lib/probe-cache.js) records which of these paths
    // returned 4xx/5xx/timeout per host so a subsequent miss only re-probes
    // the unknown ones, and tries known-good paths first.
    const metadataEndpoints = [
      `${urlObj.protocol}//${urlObj.host}/api/nowplaying`,
      `${urlObj.protocol}//${urlObj.host}/nowplaying`,
      `${urlObj.protocol}//${urlObj.host}/current`,
      `${urlObj.protocol}//${urlObj.host}/metadata`,
      `${urlObj.protocol}//${urlObj.host}/info`,
      `${urlObj.protocol}//${urlObj.host}/playing.json`,
      `${urlObj.protocol}//${urlObj.host}/current.json`,
      `${urlObj.protocol}//${urlObj.host}/api/current`,
      `${urlObj.protocol}//${urlObj.host}/stats`,
      `${urlObj.protocol}//${urlObj.host}/7.html`
    ];

    const { positives, unknown } = probeCache.orderCandidates(urlObj.host, metadataEndpoints);
    const orderedCandidates = [...positives, ...unknown];

    for (const endpoint of orderedCandidates) {
      if (signal?.aborted) return null;
      const probePath = (() => { try { return new URL(endpoint).pathname; } catch (_) { return endpoint; } })();
      try {
        const response = await fetchWithTimeout(endpoint, { signal }, 3000);
        if (!response.ok) {
          probeCache.markNegative(urlObj.host, probePath);
          continue;
        }

        const data = await response.json();
        const parsed = parseStationMetadata(data);

        if (parsed && isValidMetadata({ display: parsed })) {
          probeCache.markPositive(urlObj.host, probePath);
          return {
            source: 'generic-api',
            display: parsed,
            artist: null,
            title: null,
            raw: { data, endpoint },
            confidence: 0.7,
            cacheTtl: 15
          };
        }
        // 2xx but no useful metadata — neutral; don't poison the cache.
      } catch (error) {
        // Parent-abort isn't a host problem — don't mark negative.
        if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return null;
        probeCache.markNegative(urlObj.host, probePath);
        continue;
      }
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

// Radio-Browser API metadata fallback
async function fetchRadioBrowserMetadata(station, { signal } = {}) {
  try {
    if (!station.stationId) return null;

    const response = await fetchWithTimeout(`https://de1.api.radio-browser.info/json/stations/byuuid/${station.stationId}`, { signal });
    if (!response.ok) throw new Error(`Radio-Browser API error: ${response.status}`);
    
    const stations = await response.json();
    const stationInfo = stations[0];
    
    if (stationInfo) {
      // Check for any recently updated info
      const lastChanged = new Date(stationInfo.lastchangetime_iso8601);
      const isRecent = (Date.now() - lastChanged.getTime()) < 3600000; // Within last hour
      
      if (isRecent && stationInfo.lastcheckok === 1) {
        let nowPlaying = null;
        
        // Sometimes stations update their name to include current show/track
        if (stationInfo.name && stationInfo.name.length > 5) {
          nowPlaying = stationInfo.name;
        }
        
        if (nowPlaying && isValidMetadata({ display: nowPlaying })) {
          return {
            source: 'radio-browser',
            display: nowPlaying,
            artist: null,
            title: null,
            raw: stationInfo,
            confidence: 0.5,
            cacheTtl: 60
          };
        }
      }
    }
    
    return null;
  } catch (error) {
    console.error('Radio-Browser metadata fetch failed:', error);
    return null;
  }
}

// Station info fallback
async function fetchStationInfoFallback(station) {
  try {
    if (!station.name || station.name.toLowerCase().includes('untitled') || 
        station.name.toLowerCase().includes('unknown')) {
      return null;
    }
    
    const name = station.name.trim();
    
    // Skip generic station names
    const genericPatterns = [
      /^radio\s+\d+$/i,
      /^fm\s+\d+/i,
      /^station\s+/i,
      /^\d+\.\d+\s*fm$/i
    ];
    
    const isGeneric = genericPatterns.some(pattern => pattern.test(name));
    
    if (!isGeneric && name.length > 5 && isValidMetadata({ display: name })) {
      return {
        source: 'station-info',
        display: name,
        artist: null,
        title: null,
        raw: station,
        confidence: 0.3,
        cacheTtl: 120
      };
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

// Main metadata fetching function
// Resolves "a.b.0.c" against a parsed object. When a segment lands on an array
// and the key is non-numeric, scans for the first element resolving the rest
// (Icecast `source[]`, KEXP `results[]`, …).
function resolvePath(obj, pathStr) {
  if (!pathStr) return undefined;
  const parts = String(pathStr).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length; i++) {
    if (cur == null) return undefined;
    const key = parts[i];
    if (Array.isArray(cur)) {
      if (/^\d+$/.test(key)) {
        cur = cur[Number(key)];
      } else {
        const rest = parts.slice(i).join('.');
        for (const el of cur) {
          const v = resolvePath(el, rest);
          if (v !== undefined && v !== null && v !== '') return v;
        }
        return undefined;
      }
    } else {
      cur = cur[key];
    }
  }
  return cur;
}

function cleanField(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

// Pure: parsed JSON + {artist,title,show} field paths → {display,artist,title}
// or null (after the shared placeholder/junk gate).
function resolveJsonGeneric(data, mapping = {}) {
  const artist = cleanField(resolvePath(data, mapping.artist));
  const title = cleanField(resolvePath(data, mapping.title));
  const show = cleanField(resolvePath(data, mapping.show));
  const display = (artist && title) ? `${artist} - ${title}` : (title || artist || show || '');
  const cleaned = cleanNowPlaying(display);
  if (!cleaned || !isValidMetadata({ display: cleaned })) return null;
  return { display: cleaned, artist: artist || null, title: title || null };
}

// Runs a published override entry. Bespoke kinds reuse the station-map parsers
// (JSON or HTML); json-generic uses the field-path resolver. Curated overrides
// carry high confidence so they win the selection.
async function resolveOverride(entry, streamUrl, { signal } = {}) {
  if (!entry || entry.strategy === 'none') return null;
  if (entry.strategy !== 'json-generic') {
    const r = await fetchStationMapMetadata(
      { kind: entry.strategy, infoUrl: entry.endpoint, station: '(override)' }, streamUrl, { signal });
    if (r) {
      r.source = `override-${entry.strategy}`;
      r.confidence = 0.98;
      if (entry.ttl) r.cacheTtl = entry.ttl;
    }
    return r;
  }
  if (!entry.endpoint) return null;
  const response = await fetchWithTimeout(entry.endpoint, { signal }, 5000);
  if (!response.ok) return null;
  const data = await response.json();
  const parsed = resolveJsonGeneric(data, entry.mapping || {});
  if (!parsed) return null;
  return { source: 'override-json-generic', ...parsed, raw: { endpoint: entry.endpoint }, confidence: 0.98, cacheTtl: entry.ttl || 15 };
}

async function fetchMetadata({ streamUrl, stationId, homepage, country, name }) {
  // Station-specific handlers for stations whose audio is HLS but whose
  // now-playing data is exposed via a separate API. Must run BEFORE the
  // generic .m3u8 bail below — otherwise these never reach their strategy.
  // Schedule-aware short-circuits for stations whose audio is HLS but whose
  // now-playing data is exposed via a separate scheduling API. Each handler
  // gets a fresh AbortController so a hung upstream doesn't bleed into
  // unrelated paths.
  const scheduleHandlers = [
    { match: (u) => isHKCRStreamUrl(u),  run: (u, sig) => fetchHKCRMetadata({ signal: sig }) },
    { match: (u) => isRovrStreamUrl(u),  run: (u, sig) => fetchROVRMetadata({ signal: sig }) },
    { match: (u) => isRinseStreamUrl(u), run: (u, sig) => fetchRinseFMMetadata(u, { signal: sig }) },
  ];
  const matchedHandler = scheduleHandlers.find((h) => h.match(streamUrl));
  if (matchedHandler) {
    const parentCtrl = new AbortController();
    const result = await Promise.race([
      matchedHandler.run(streamUrl, parentCtrl.signal),
      new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
    ]).catch(() => null);
    try { parentCtrl.abort(); } catch (_) {}
    if (result?.display) {
      return {
        source: result.source,
        display: result.display,
        artist: result.artist,
        title: result.title,
        raw: result.raw,
        cacheTtl: result.cacheTtl || 60
      };
    }
    return { ok: false, reason: 'no-metadata' };
  }

  // Curated per-station override (published metadata-overrides.json). Resolved
  // BEFORE the HLS bail so an override endpoint can serve HLS-audio stations,
  // and before the probe chain so a curated config always wins. `none`
  // deliberately suppresses garbage metadata; `exclusive` skips the probe
  // chain entirely on a miss.
  const overrideEntry = overrideMap.lookup({ stationId, streamUrl });
  if (overrideEntry && overrideEntry.strategy === 'none') {
    return { ok: false, reason: 'suppressed' };
  }
  if (overrideEntry) {
    const ovCtrl = new AbortController();
    const only = await Promise.race([
      resolveOverride(overrideEntry, streamUrl, { signal: ovCtrl.signal }),
      new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
    ]).catch(() => null);
    try { ovCtrl.abort(); } catch (_) {}
    if (only?.display) {
      return {
        source: only.source,
        display: only.display,
        artist: only.artist,
        title: only.title,
        raw: only.raw,
        cacheTtl: only.cacheTtl || 15,
      };
    }
    if (overrideEntry.exclusive) {
      return { ok: false, reason: 'no-metadata' };
    }
    // non-exclusive miss → fall through to the normal probe chain
  }

  // HLS streams without a station-specific strategy — let the client handle
  // (hls.js parses ID3 timed metadata locally for stations that ship it).
  if (streamUrl.includes('.m3u8')) {
    return {
      ok: false,
      reason: 'hls-client'
    };
  }

  const station = { stationId, url: streamUrl, homepage, country, name };
  const strategies = [];

  // Parent controller — selectBestResult aborts() this once it picks a
  // winner, which cancels every losing in-flight upstream request so we
  // don't leak sockets or read bodies we'll never use.
  const parentCtrl = new AbortController();
  const opts = { signal: parentCtrl.signal };

  try {
    // German public broadcasters (WDR, ARD)
    if (streamUrl.includes('wdr') || streamUrl.includes('rndfnk.com') ||
        streamUrl.includes('1live') || streamUrl.includes('wdr2') ||
        streamUrl.includes('wdr3') || streamUrl.includes('wdr4') || streamUrl.includes('wdr5')) {
      strategies.push(() => fetchWDRMetadata(streamUrl, station, opts));
    }

    if (streamUrl.includes('stream-relay-geo.ntslive.net')) {
      strategies.push(() => fetchNTSMetadata(streamUrl, stationId, opts));
    }

    if (isNTSMixtapeStreamUrl(streamUrl)) {
      strategies.push(() => fetchNTSMixtapeMetadata(streamUrl, opts));
    }

    // StreamTheWorld/Triton — the largest platform in the dataset; the mount
    // derives straight from the stream URL.
    if (deriveStreamTheWorldMount(streamUrl)) {
      strategies.push(() => fetchStreamTheWorldMetadata(streamUrl, opts));
    }

    if (deriveRadioCultEndpointFromStream(streamUrl)) {
      strategies.push(() => fetchRadioCultMetadata(streamUrl, opts));
    }

    if (deriveRadioJarEndpointFromStream(streamUrl)) {
      strategies.push(() => fetchRadioJarMetadata(streamUrl, opts));
    }

    // Curated map for stations whose metadata API lives on a different host
    // than the stream — the generic probe below can never find these.
    const stationMapEntry = findStationMapEntry(streamUrl);
    if (stationMapEntry) {
      strategies.push(() => fetchStationMapMetadata(stationMapEntry, streamUrl, opts));
    }

    if (streamUrl.includes('cashmereradio.airtime.pro')) {
      strategies.push(() => fetchCashmereMetadata(opts));
    } else if (isAirtimeProStreamUrl(streamUrl)) {
      strategies.push(() => fetchAirtimeProMetadata(streamUrl, undefined, opts));
    }

    const urlObj = new URL(streamUrl);
    const host = urlObj.host;

    // Radio.co — public JSON API for any *.radio.co stream
    if (/(^|\.)radio\.co$/i.test(urlObj.hostname)) {
      strategies.push(() => fetchRadioCoMetadata(streamUrl, opts));
    }

    // AzuraCast — detected via /listen/<shortcode>/ path on the stream host
    if (/^\/listen\/[A-Za-z0-9_-]+\b/.test(urlObj.pathname)) {
      strategies.push(() => fetchAzuraCastMetadata(streamUrl, opts));
    }

    // Shoutcast v2 — cheap to probe, runs in parallel; null-result if not v2
    strategies.push(() => fetchShoutcastV2Metadata(streamUrl, opts));

    // Icecast status endpoints
    const icecastEndpoints = [
      `${urlObj.protocol}//${host}/status-json.xsl`,
      `${urlObj.protocol}//${host}/status.json`,
      `${urlObj.protocol}//${host}/stats.json`,
      `${urlObj.protocol}//${host}/status?json=1`
    ];
    strategies.push(() => fetchIcecastMetadata(icecastEndpoints, urlObj.pathname, opts));

    // ICY metadata — slowest strategy (8s timeout). With the new harvest
    // window (~600ms) plus parent-abort, a faster low-confidence strategy
    // no longer wins permanently; ICY's 0.95 confidence overtakes a
    // 0.7-0.8 result if it lands inside the window.
    strategies.push(() => fetchICYMetadata(streamUrl, opts));

    // Generic API endpoints
    strategies.push(() => fetchGenericMetadata(streamUrl, station, opts));

    // Radio Browser fallback
    if (stationId) {
      strategies.push(() => fetchRadioBrowserMetadata(station, opts));
    }

    // Station info fallback disabled - better to show nothing than redundant station name
    // strategies.push(() => fetchStationInfoFallback(station));

    // Execute strategies concurrently with individual timeouts. The 5s cap
    // is a backstop; selectBestResult will normally finish well before that.
    const promises = strategies.map((strategy) =>
      Promise.race([
        strategy(),
        new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
      ]).catch((err) => {
        // AbortError is expected when selectBestResult aborts losers.
        if (err?.name !== 'AbortError' && err?.code !== 'ABORT_ERR') {
          console.error('Strategy failed:', err.message || err);
        }
        return null;
      })
    );

    const result = await selectBestResult(promises, parentCtrl, { harvestMs: 600 });

    if (result && result.display) {
      return {
        source: result.source,
        display: result.display,
        artist: result.artist,
        title: result.title,
        raw: result.raw,
        cacheTtl: result.cacheTtl || 15
      };
    }

    // ---- Phase B: the homepage tier ------------------------------------
    // Only on a Phase-A miss, so the vast majority of stations (ICY/Icecast/
    // platform APIs) pay no extra request or latency. Flag-gated and OFF by
    // default: it runs on Hetzner (primary) while Render keeps the proven path,
    // so an engine bug can't take out primary and fallback at the same time.
    if (process.env.ENABLE_HOMEPAGE_TIER === '1' && homepage) {
      // Fresh controller: parentCtrl may already be aborted by selectBestResult.
      const hpCtrl = new AbortController();
      try {
        const hp = await Promise.race([
          homepageTier(homepage, { signal: hpCtrl.signal, stationName: station.name || '' }),
          new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
        ]);
        if (hp && hp.display) {
          return {
            source: hp.source,
            display: hp.display,
            artist: hp.artist ?? null,
            title: hp.title ?? null,
            raw: hp.raw,
            cacheTtl: hp.cacheTtl || 15,
          };
        }
      } catch (e) {
        // The tier is best-effort — a failure here must degrade to no-metadata,
        // never leak an error to the client.
      } finally {
        try { hpCtrl.abort(); } catch (_) { /* noop */ }
      }
    }

    return {
      ok: false,
      reason: 'no-metadata'
    };

  } catch (error) {
    console.error('Metadata fetch failed:', error);
    return {
      ok: false,
      reason: 'upstream-error'
    };
  } finally {
    // Belt-and-suspenders: selectBestResult already aborts on its happy
    // path, but if we threw before reaching it (or returned early after
    // an HLS check etc.) we still want to release any handlers waiting on
    // the signal.
    try { parentCtrl.abort(); } catch (_) { /* noop */ }
  }
}

// WDR/ARD German Public Broadcaster metadata
async function fetchWDRMetadata(streamUrl, station, { signal } = {}) {
  try {
    
    // Try to determine the service from the URL
    let service = null;
    if (streamUrl.includes('1live')) {
      service = '1live';
    } else if (streamUrl.includes('wdr2')) {
      service = 'wdr2';
    } else if (streamUrl.includes('wdr3')) {
      service = 'wdr3';
    } else if (streamUrl.includes('wdr4')) {
      service = 'wdr4';
    } else if (streamUrl.includes('wdr5')) {
      service = 'wdr5';
    }
    
    if (!service) {
      return null;
    }
    
    // Try WDR's live API endpoint
    const apiUrl = `https://www1.wdr.de/radio/player/live/livesender-${service}-100.json`;

    const response = await fetchWithTimeout(apiUrl, { signal }, 5000);
    if (!response.ok) {
      return null;
    }
    
    const data = await response.json();
    
    // Parse WDR API response
    if (data && data.liveStreamData && data.liveStreamData.currentBroadcast) {
      const broadcast = data.liveStreamData.currentBroadcast;
      let nowPlaying = '';
      
      if (broadcast.title) {
        nowPlaying = broadcast.title;
        
        // Add subtitle if available
        if (broadcast.subtitle && broadcast.subtitle !== broadcast.title) {
          nowPlaying += ` - ${broadcast.subtitle}`;
        }
      }
      
      if (nowPlaying) {
        return {
          source: 'wdr-api',
          display: cleanNowPlaying(nowPlaying),
          artist: null,
          title: broadcast.title,
          raw: broadcast,
          confidence: 0.9,
          cacheTtl: 60 // Cache for 1 minute
        };
      }
    }
    
    // Fallback: Try to get current track info
    if (data && data.liveStreamData && data.liveStreamData.currentTrack) {
      const track = data.liveStreamData.currentTrack;
      let artist = track.artist || '';
      let title = track.title || '';
      
      if (artist && title) {
        return {
          source: 'wdr-api',
          display: `${artist} - ${title}`,
          artist: artist,
          title: title,
          raw: track,
          confidence: 0.95,
          cacheTtl: 30 // Cache for 30 seconds
        };
      }
    }
    
  } catch (error) {
  }
  
  return null;
}

module.exports = {
  fetchMetadata,
  cleanNowPlaying,
  parseArtistTitle,
  parseStationMetadata,
  isValidMetadata,
  // Exported for tests — not part of the runtime API.
  isPlaceholder,
  decodeIcyBytes,
  selectBestResult,
  firstNonNullResult,
  findCurrentHKCRShow,
  findCurrentRinseEpisode,
  deriveRadioCultEndpointFromStream,
  parseRadioCultNowPlaying,
  deriveStreamTheWorldMount,
  parseTritonNowPlaying,
  deriveRadioJarEndpointFromStream,
  parseRadioJarNowPlaying,
  isNTSMixtapeStreamUrl,
  findNTSMixtape,
  parseAzuraCastNowPlaying,
  parseAirtimeProNowPlaying,
  resolvePath,
  resolveJsonGeneric,
  overrideMap,
  _setHomepageTierForTests,
};