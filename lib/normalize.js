// Shared now-playing text normalisation and junk filtering. Lives outside
// strategies/index.js so strategies/station-map.js can use it without a
// circular require.

// Shared normalization for now playing strings. Goal: produce a single
// canonical form so downstream `display === stationName` and `text.includes(
// " - ")` checks work regardless of which upstream the metadata came from.
function cleanNowPlaying(text) {
  try {
    if (!text) return '';
    let s = String(text).trim();

    // Unicode normalisation. NFC collapses decomposed sequences (é -> é)
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
  'libretime',
  'libretime - offline',
  'offline',
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
  // Holding text a site shows while its own widget is still fetching. Exact
  // matching misses these because of the trailing ellipsis — kalx.berkeley.edu
  // renders "waiting ..." in its now-playing slot, which is not now-playing.
  if (/^(?:waiting|loading|please\s+wait|updating|refreshing|tba|tbd|n\/?a|no\s+data)\b[\s.…-]*$/.test(t)) return true;
  return false;
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

// Boilerplate that carries no information once the station name is removed.
const ECHO_BOILERPLATE = new Set([
  'fm', 'am', 'radio', 'live', 'stream', 'live stream', 'livestream', 'online',
  'now', 'playing', 'on', 'air', 'onair', 'home', 'homepage', 'listen',
  'official', 'website', 'the', 'and', 'welcome',
]);

function echoNormalise(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ') // drop punctuation — "KIOSK RADIO!" === "kiosk radio"
    .replace(/\s+/g, ' ')
    .trim();
}

// True when `display` is really just the station name / page title wearing a hat.
// The generic engine reads unknown JSON and homepage HTML, where the likeliest
// wrong answer is the site's own name — presenting that as "now playing" is
// worse than showing nothing.
//
// The distinction that matters: a display that merely *mentions* the station
// alongside real content ("Tim Reaper @ Kiosk Radio 11.04.2026") is metadata and
// must survive; a display that is the station name *and nothing else of
// substance* ("Kiosk Radio live") is an echo.
function isStationEcho(display, { stationName = '', siteTitle = '' } = {}) {
  const d = echoNormalise(display);
  if (!d) return true;

  for (const ref of [stationName, siteTitle]) {
    const r = echoNormalise(ref);
    if (!r) continue;

    if (d === r) return true;
    // The reference fully contains the display => the display is a fragment of
    // the station's own name, not a programme.
    if (r.includes(d)) return true;

    // The display contains the reference: an echo only if what remains is
    // boilerplate; otherwise it is real content that happens to name the station.
    if (d.includes(r)) {
      const rest = d.replace(r, ' ').replace(/\s+/g, ' ').trim();
      if (!rest) return true;
      const meaningful = rest.split(' ').filter((w) => w && !ECHO_BOILERPLATE.has(w));
      if (meaningful.length === 0) return true;
    }
  }
  return false;
}

module.exports = {
  cleanNowPlaying,
  isPlaceholder,
  isJunkExact,
  isValidMetadata,
  isStationEcho,
};
