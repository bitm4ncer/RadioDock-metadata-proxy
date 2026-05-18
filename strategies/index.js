/**
 * RadioDock Metadata Strategies - Server Implementation
 * 
 * This file ports all metadata fetching strategies from the extension's metadata-strategies.js
 * and background.js to run server-side on the proxy. This maintains 1:1 behavior compatibility
 * while allowing host_permissions to be restricted to only the proxy and Radio Browser API.
 * 
 * Strategy Types Implemented:
 * 1. NTS Radio API - Live channel metadata from nts.live API
 * 2. Airtime Pro - Generic Airtime Pro stations using live-info-v2 API
 * 3. Cashmere Radio - Specific Airtime Pro instance with custom handling
 * 4. Icecast Status - JSON status endpoints (status-json.xsl, status.json, etc.)
 * 5. ICY Metadata - Stream metadata blocks with Icy-MetaData headers
 * 6. Generic APIs - Common station API patterns and endpoints
 * 7. Radio King - radioking.com specific API endpoints
 * 8. Callshop Radio - Custom JSON status endpoint
 * 9. Radio Browser - Fallback using radio-browser.info station data
 * 10. Station Info - Last resort using station name/info
 * 
 * HLS streams (.m3u8) are explicitly excluded and return {ok:false, reason:"hls-client"}
 * so the extension continues to handle HLS ID3 metadata locally with hls.js.
 */

const { request } = require('undici');
const { readBoundedBody } = require('../lib/safe-fetch.js');

// Timeout configuration - reduced for better responsiveness
const DEFAULT_TIMEOUT = 6000;
const FAST_TIMEOUT = 2500;
const MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MB cap on any single upstream body

// Shared normalization for now playing strings. Goal: produce a single
// canonical form so downstream `display === stationName` and `text.includes(
// " - ")` checks work regardless of which upstream the metadata came from.
function cleanNowPlaying(text) {
  try {
    if (!text) return '';
    let s = String(text).trim();

    // Unicode normalisation. NFC collapses decomposed sequences (é -> é)
    // which otherwise break a string-length-based comparison and produce
    // surprising substring matches.
    try { s = s.normalize('NFC'); } catch (e) { /* very old runtime, skip */ }

    // Decode HTML entities (numeric + named, common subset)
    s = s.replace(/&amp;/g, '&')
         .replace(/&lt;/g, '<')
         .replace(/&gt;/g, '>')
         .replace(/&quot;/g, '"')
         .replace(/&apos;/g, "'")
         .replace(/&#039;/g, "'")
         .replace(/&#x27;/g, "'")
         .replace(/&#0*39;/g, "'")
         .replace(/&nbsp;/g, ' ');

    // Strip zero-width characters that some encoders inject (ZWSP, ZWNJ,
    // ZWJ, LRM/RLM, BOM). These would otherwise appear in the UI as
    // invisible-but-present chars and break split-by-' - '.
    s = s.replace(/[​-‏﻿]/g, '');

    // Normalise en-dash / em-dash / minus / non-breaking hyphen to the ASCII
    // hyphen when they're used as a visible artist/title separator. We only
    // touch the " <dash> " pattern (whitespace on both sides); we don't want
    // to mangle a single-word "Café–Society" title that uses an en-dash as a
    // proper punctuation mark.
    s = s.replace(/\s+[‐-―−]\s+/g, ' - ');

    // Collapse repeated whitespace introduced by the above (or by upstream)
    // so "Artist   -   Title" lands as "Artist - Title".
    s = s.replace(/\s{2,}/g, ' ');

    // Remove a leading dash of any flavour, with optional leading spaces.
    s = s.replace(/^\s*[-‐-―−]\s+/, '');

    return s.trim();
  } catch (e) {
    return typeof text === 'string' ? text.trim() : '';
  }
}

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

// Exact-match placeholder strings that various streaming server defaults emit
// when no real track metadata is configured. Centova Cast ships with the
// literal "Now Playing info goes here", AzuraCast falls back to "Stream
// Offline", Liquidsoap to "Default", etc. These never carry useful info and
// would otherwise leak straight into the UI.
const PLACEHOLDER_STRINGS = new Set([
  'now playing info goes here',
  'now playing',
  'now playing info',
  'stream offline',
  'no track information',
  'no info available',
  'no metadata available',
  'azuracast',
  'liquidsoap',
  'default',
  'unspecified description',
  'sam broadcaster',
  'sam broadcaster pro',
  'your dj here',
  'dj name',
  'station name',
  'track title',
  'artist - title',
  'artist name',
  'this is your station',
  'mountpoint',
  'mountpoint /stream',
  'description',
]);

function isPlaceholder(text) {
  const t = String(text || '').toLowerCase().trim();
  if (PLACEHOLDER_STRINGS.has(t)) return true;
  if (/^welcome to\b/.test(t)) return true;
  return false;
}

// ICY metadata blocks are not encoding-tagged. The spec leaves charset up to
// the broadcaster, and in practice German/French/Scandinavian stations often
// emit Windows-1252 or ISO-8859-1, which produce U+FFFD replacement chars
// when decoded as UTF-8. Strategy: decode as UTF-8 first; if the result
// contains a replacement character, retry as latin1. Latin1 maps 1:1 to the
// first 256 code points so it never produces replacements — at worst it
// shows the wrong glyph, which is still less broken than `Beyonc�`.
function decodeIcyBytes(bytes) {
  const buf = bytes instanceof Buffer
    ? bytes
    : Buffer.from(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.length);
  const utf8 = buf.toString('utf8').replace(/\0/g, '');
  if (!utf8.includes('�')) return utf8;
  return buf.toString('latin1').replace(/\0/g, '');
}

// Exact-match junk list. Single source of truth used by isValidMetadata()
// and by the inline branches in fetchICYMetadata() / fetchIcecastMetadata().
// Exact-match only (after lowercase + trim) — a substring check would
// incorrectly drop legitimate titles like "Coldplay Live" or station names
// like "Live FM" that happen to contain a junk word.
const JUNK_EXACT = new Set([
  'unknown', 'untitled', 'live', 'on-air', 'stream', 'radio',
  'broadcasting', 'music', 'live stream', 'internet radio',
  'online radio', 'web radio', 'digital radio', 'airtime!',
  'unspecified', 'no name', 'no info', 'no data',
]);

function isJunkExact(text) {
  return JUNK_EXACT.has(String(text || '').toLowerCase().trim());
}

function isValidMetadata(metadata) {
  if (!metadata || !metadata.display || typeof metadata.display !== 'string') {
    return false;
  }
  const text = metadata.display.toLowerCase().trim();
  if (text.length < 3) return false;
  if (isPlaceholder(text)) return false;
  if (isJunkExact(text)) return false;
  return true;
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
function parseStationMetadata(data) {
  if (!data || typeof data !== 'object') return null;
  
  let artist = '';
  let title = '';
  let nowPlaying = '';
  
  // Try different common API formats
  if (data.nowplaying || data.now_playing) {
    const np = data.nowplaying || data.now_playing;
    if (typeof np === 'string') {
      nowPlaying = np;
    } else if (np && typeof np === 'object') {
      artist = np.artist || np.performer || '';
      title = np.song || np.track || np.title || '';
    }
  } else if (data.current) {
    const current = data.current;
    if (typeof current === 'string') {
      nowPlaying = current;
    } else if (current && typeof current === 'object') {
      title = current.title || current.track || '';
    }
  } else if (data.song || data.track || data.title) {
    artist = data.artist || '';
    title = data.song || data.track || data.title || '';
  }
  
  return parseArtistTitle(nowPlaying, artist, title);
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

// Airtime Pro integration
function deriveAirtimeProEndpointFromStream(streamUrl) {
  try {
    if (!streamUrl) return null;
    const u = new URL(streamUrl);
    const host = u.hostname || '';
    // Expect pattern like: <station>.out.airtime.pro
    const m = host.match(/^([^.]+)\.out\.airtime\.pro$/i);
    if (!m) return null;
    const stationKey = m[1];
    return `https://${stationKey}.airtime.pro/api/live-info-v2`;
  } catch (e) {
    return null;
  }
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

  return cleanNowPlaying(nowPlaying);
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
        const song = data?.now_playing?.song || data?.now_playing;
        if (!song) continue;
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
        if (!display || !isValidMetadata({ display })) continue;
        return {
          source: 'azuracast',
          display,
          artist: artist || null,
          title: trackTitle || null,
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
    
    // Try common metadata endpoints based on station URL
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
    
    for (const endpoint of metadataEndpoints) {
      if (signal?.aborted) return null;
      try {
        const response = await fetchWithTimeout(endpoint, { signal }, 3000);
        if (!response.ok) continue;
        
        const data = await response.json();
        const parsed = parseStationMetadata(data);
        
        if (parsed && isValidMetadata({ display: parsed })) {
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
      } catch (error) {
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
async function fetchMetadata({ streamUrl, stationId, homepage, country }) {
  // Check for HLS streams - these should be handled client-side
  if (streamUrl.includes('.m3u8')) {
    return {
      ok: false,
      reason: 'hls-client'
    };
  }
  
  const station = { stationId, url: streamUrl, homepage, country };
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

    if (streamUrl.includes('cashmereradio.airtime.pro')) {
      strategies.push(() => fetchCashmereMetadata(opts));
    } else if (streamUrl.includes('.out.airtime.pro')) {
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
  isValidMetadata
};