// Stage 3 of the generic coverage engine: read the on-air / timetable block a
// station renders on its OWN homepage.
//
// Generalises what used to be a per-station parser (WWOZ). The rule that keeps
// this safe: never take "the first plausible string on the page" — a candidate
// only counts if it sits behind a positive now-playing signal (JSON-LD
// BroadcastEvent, an on-air/now-playing class, or an explicit label). Anything
// that survives still has to pass the placeholder and station-echo gates,
// because confidently showing a site's own title is worse than showing nothing.

const { cleanNowPlaying, isValidMetadata, isStationEcho } = require('./normalize.js');

const JSONLD_TYPES = new Set(['BroadcastEvent', 'RadioEpisode', 'MusicRecording', 'Episode']);

// Marker classes, matched as WHOLE class tokens. A substring match is not good
// enough: wwoz.org ships `<ul class="nav navbar-nav listen-on-air">` before the
// real `<p class="navbar-text on-air">`, and \bon-air\b happily matches inside
// "listen-on-air" (the hyphen is a word boundary) — so a loose pattern grabs a
// navigation container and returns the whole menu as "now playing".
const MARKER_CLASS_TOKENS = new Set([
  'on-air', 'onair', 'on_air',
  'now-playing', 'nowplaying', 'now_playing',
  'current-show', 'current-track', 'currently-playing',
]);

// Any element carrying a class attribute; tokens are checked properly below.
const CLASS_ELEMENT_RE = /<([a-z]+)[^>]*\bclass="([^"]*)"[^>]*>/gi;

// A now-playing line is short. A long blob means we captured a container, not a
// value — Reprezent returned an entire nav menu that way.
const MAX_DISPLAY_LEN = 120;

// An explicit textual label followed by the value on the same text node.
const TEXT_MARKER_RE = /(?:now\s*playing|on\s*air|streaming\s*now)\s*[:–—-]?\s*([^<\n]{2,140})/i;

// The label itself must not become the value.
const LABEL_PREFIX_RE = /^\s*(?:now\s*playing|on\s*air|streaming\s*now|up\s*next)\s*[:–—-]?\s*/i;

// Words that belong to the page's furniture, not to a track or programme. If a
// candidate still contains one AFTER its own label was stripped, we swept up a
// navigation block rather than a value. Live example from reprezentradio.org.uk:
// "Training On air Off Air LIVE STREAM Reprezent Radio Live Latest MONDAY …" —
// short enough to pass a length cap, still worthless.
const VALUE_NOISE_RE = /\b(?:off[\s-]?air|on[\s-]?air|live\s?stream|up\s?next|listen\s?live|now\s?playing)\b/i;

function stripTags(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function accept(raw, stationName, siteTitle, via) {
  const display = cleanNowPlaying(String(raw ?? '').replace(LABEL_PREFIX_RE, '').trim());
  if (!display) return null;
  // Too long => we grabbed a container, not a value. Showing that is worse than
  // showing nothing, so it is rejected outright rather than truncated.
  if (display.length > MAX_DISPLAY_LEN) return null;
  // Page furniture left inside the value => same problem, but short enough to
  // slip under the length cap.
  if (VALUE_NOISE_RE.test(display)) return null;
  if (!isValidMetadata({ display })) return null;
  if (isStationEcho(display, { stationName, siteTitle })) return null;
  return { display, via };
}

// Content of the first element whose class carries a whole marker token.
function fromClassMarker(html, stationName, siteTitle) {
  CLASS_ELEMENT_RE.lastIndex = 0;
  let m;
  while ((m = CLASS_ELEMENT_RE.exec(html))) {
    const [openTag, tagName, classAttr] = m;
    const tokens = classAttr.split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
    if (!tokens.some((t) => MARKER_CLASS_TOKENS.has(t))) continue;

    // Capture this element's own content: from the end of its opening tag to
    // the first matching close.
    const start = m.index + openTag.length;
    const closeIdx = html.toLowerCase().indexOf(`</${tagName.toLowerCase()}>`, start);
    if (closeIdx === -1) continue;
    const inner = html.slice(start, Math.min(closeIdx, start + 600));
    const r = accept(stripTags(inner), stationName, siteTitle, 'marker');
    if (r) return r;
  }
  return null;
}

function siteTitleOf(html) {
  const m = String(html ?? '').match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  return m ? stripTags(m[1]) : '';
}

function fromJsonLd(html, stationName, siteTitle) {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch (_) { continue; }
    const nodes = Array.isArray(data) ? data : [data];
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const types = [].concat(node['@type'] ?? []);
      if (!types.some((t) => JSONLD_TYPES.has(t))) continue;
      const candidate = node.name
        || node.workPerformed?.name
        || node.broadcastOfEvent?.name
        || node.description;
      const r = accept(candidate, stationName, siteTitle, 'jsonld');
      if (r) return r;
    }
  }
  return null;
}

/**
 * @returns {{display: string, via: 'jsonld'|'marker'}|null}
 */
function extractOnAirFromHtml(html, { stationName = '' } = {}) {
  const s = typeof html === 'string' ? html : '';
  if (!s) return null;
  const siteTitle = siteTitleOf(s);

  const jsonld = fromJsonLd(s, stationName, siteTitle);
  if (jsonld) return jsonld;

  const cls = fromClassMarker(s, stationName, siteTitle);
  if (cls) return cls;

  const txt = stripTags(s).match(TEXT_MARKER_RE);
  if (txt) {
    const r = accept(txt[1], stationName, siteTitle, 'marker');
    if (r) return r;
  }

  return null;
}

module.exports = { extractOnAirFromHtml };
