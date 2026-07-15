// LAST RESORT — the smallest tier, deliberately.
//
// Before adding an entry, be sure the generic mechanisms genuinely fail: the
// stream-host strategies (ICY, Icecast, platform APIs) run first, and
// lib/homepage-probe.js then probes the station's own website. A rule is only
// justified when both come back empty AND its data is measurably better.
//
// Every entry below was verified against the live proxy on 2026-07-15, with the
// rule and without it. Each earns its place:
//
//   KALX           creek             without it: only "waiting ..." holding text
//   KEXP           kexp              without it: nothing — API lives on api.kexp.org
//   CKUT           ckut              without it: nothing — unusual .php?json=1 path
//   Radio Vilnius  icecast-allstats  mount-matching across several stations on one
//                                    server: logic, not a path
//   Sygma,         airtime-v1        NOT verified (streams unresolvable at audit
//   Quantica,                        time) — kept rather than deleted blind
//   Veneno
//
// Six entries were deleted in that audit (KUSF, BFF.fm, KWSX, Skylab, Soho,
// WNYU): plain ICY already resolved all of them and their rules never even won
// the confidence race. They were pure maintenance cost.
//
// Adding a station = one entry here + (if the API shape is new) one parser,
// written against a real captured response (see test/fixtures/).

const { cleanNowPlaying, isValidMetadata } = require('../lib/normalize.js');

const STATION_MAP = [
  {
    kind: 'creek',
    station: 'KALX',
    hosts: ['stream.kalx.berkeley.edu'],
    infoUrl: 'https://kalx.studio.creek.org/api/current?x=1&studioId=29',
  },
  {
    kind: 'kexp',
    station: 'KEXP',
    hostPattern: /^kexp[a-z0-9-]*\.streamguys1\.com$/i,
    infoUrl: 'https://api.kexp.org/v2/plays/?format=json&limit=1',
  },
  {
    kind: 'ckut',
    station: 'CKUT',
    hostPattern: /(^|\.)ckut\.ca$/i,
    infoUrl: 'https://ckut.ca/currentliveshows.php?c=1&json=1',
  },
  {
    // The WordPress endpoint returns the Icecast allStats for every mount on
    // audiomastering.lt, so mount-matching also resolves the other stations
    // (raion, svieziosultys, ...) streaming from the same server.
    kind: 'icecast-allstats',
    station: 'Radio Vilnius',
    hosts: ['transliacija.audiomastering.lt'],
    infoUrl: 'https://radiovilnius.live/?rest_route=/radio-vilnius-api/v1/stream-status',
  },
  {
    // LibreTime's stats-icecast.json is the Airtime v1 schedule dump, not an
    // Icecast status document, hence the airtime-v1 parser.
    kind: 'airtime-v1',
    station: 'Radio Sygma',
    hosts: ['radio.syg.ma'],
    infoUrl: 'https://radio.syg.ma/stats-icecast.json',
  },
  {
    kind: 'airtime-v1',
    station: 'Radio Quantica',
    hosts: ['libretime.radioquantica.com'],
    infoUrl: 'https://api.radioquantica.com/api/live-info',
  },
  {
    kind: 'airtime-v1',
    station: 'Veneno',
    // The stream is on veneno.out.airtime.pro while the API is on
    // radio.veneno.live — unrelated hosts, and veneno.live (the homepage) 404s
    // on /api/live-info, so neither derivation nor the homepage tier can find
    // it. Listing only radio.veneno.live meant this entry never matched the
    // stream it exists for.
    hosts: ['veneno.out.airtime.pro', 'radio.veneno.live'],
    infoUrl: 'https://radio.veneno.live/api/live-info',
  },
];

const CACHE_TTL_BY_KIND = {
  creek: 30,
  kexp: 15,
  ckut: 120,
  'icecast-allstats': 15,
  'airtime-v1': 30,
  wwoz: 60,
};

function findStationMapEntry(streamUrl) {
  try {
    const hostname = new URL(streamUrl).hostname.toLowerCase();
    return STATION_MAP.find((e) =>
      (e.hosts && e.hosts.includes(hostname)) ||
      (e.hostPattern && e.hostPattern.test(hostname))
    ) || null;
  } catch (_) {
    return null;
  }
}

function toResult(display, artist = null, title = null) {
  const clean = cleanNowPlaying(display);
  if (!clean || !isValidMetadata({ display: clean })) return null;
  return { display: clean, artist: artist || null, title: title || null };
}

// Mirrors the show-prefixing behaviour of parseAirtimeProNowPlaying (v2) so
// both Airtime generations produce the same display shape.
function combineShowAndTrack(showName, trackComponent) {
  if (showName && trackComponent) {
    const lcShow = showName.toLowerCase();
    const lcTrack = trackComponent.toLowerCase();
    if (!lcTrack.startsWith(lcShow + ' - ') && lcShow !== lcTrack) {
      return `${showName} - ${trackComponent}`;
    }
    return trackComponent;
  }
  return trackComponent || showName || '';
}

// Airtime v1 / LibreTime. Two shapes in the wild:
//   live-info:          { current: {name}, currentShow: [{name}] }
//   stats-icecast.json: { tracks: {current: {name}}, shows: {current: {name}} }
// currentShow/shows.current can be an array or a single object.
function parseAirtimeV1(data) {
  if (!data || typeof data !== 'object') return null;

  const current = data.current ?? data.tracks?.current ?? null;
  let show = data.currentShow ?? data.shows?.current ?? null;
  if (Array.isArray(show)) show = show[0] ?? null;

  const showNameRaw = typeof show?.name === 'string' ? show.name.trim() : '';
  const showName = showNameRaw && !/airtime/i.test(showNameRaw) && !/archive/i.test(showNameRaw)
    ? showNameRaw
    : '';

  const track = typeof current?.name === 'string'
    ? current.name.replace(/^\s*-\s*/, '').trim()
    : '';

  return toResult(combineShowAndTrack(showName, track));
}

// Creek (studio.creek.org) /api/current — used by KALX, KUSF and other
// college stations. `show.title` is the programme, `track.song` the last
// logged spin.
function parseCreekCurrent(data) {
  const showTitle = typeof data?.show?.title === 'string' ? data.show.title.trim() : '';
  const song = data?.track?.song;
  const artist = typeof song?.artist === 'string' ? song.artist.trim() : '';
  const title = typeof song?.title === 'string' ? song.title.trim() : '';

  let trackComponent = '';
  if (artist && title && artist !== title) trackComponent = `${artist} - ${title}`;
  else if (title) trackComponent = title;
  else if (artist) trackComponent = artist;

  return toResult(combineShowAndTrack(showTitle, trackComponent), artist, title);
}

function parseKEXPPlay(data) {
  const play = Array.isArray(data?.results) ? data.results[0] : null;
  if (!play) return null;
  if (play.play_type && play.play_type !== 'trackplay') return null;

  const artist = typeof play.artist === 'string' ? play.artist.trim() : '';
  const song = typeof play.song === 'string' ? play.song.trim() : '';
  if (!artist && !song) return null;

  let display = '';
  if (artist && song && artist !== song) display = `${artist} - ${song}`;
  else display = song || artist;

  return toResult(display, artist, song);
}


function parseCKUTShows(data) {
  const raw = data?.program?.title_html;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return toResult(raw.replace(/<[^>]*>/g, ' '));
}

// Icecast allStats dumps ({allStats: [{listenurl, artist, title, ...}]}) as
// served by radiovilnius.live. The right source is the one whose listenurl
// ends with the stream URL's mount segment.
function parseIcecastAllStats(data, streamUrl) {
  const sources = Array.isArray(data?.allStats) ? data.allStats : null;
  if (!sources) return null;

  let mount;
  try {
    mount = new URL(streamUrl).pathname.split('/').filter(Boolean).pop();
  } catch (_) {
    return null;
  }
  if (!mount) return null;

  const source = sources.find((s) =>
    typeof s?.listenurl === 'string' && s.listenurl.toLowerCase().endsWith('/' + mount.toLowerCase())
  );
  if (!source) return null;

  const artist = typeof source.artist === 'string' ? source.artist.trim() : '';
  const title = typeof source.title === 'string' ? source.title.trim() : '';
  const yp = typeof source.yp_currently_playing === 'string' ? source.yp_currently_playing.trim() : '';

  if (yp) return toResult(yp, artist, title);
  if (artist && title && artist !== title) return toResult(`${artist} - ${title}`, artist, title);
  return toResult(title || artist, artist, title);
}


// WWOZ (wwoz.org) exposes no JSON now-playing API; the on-air programme is
// server-rendered into the page header:
//   <p class="… on-air"> … <span class="song-artist"><a …>PROGRAMME</a></span>
// `data` is the raw HTML string (wwoz is an HTML_KINDS member — fetched as text).
function parseWWOZOnAir(html) {
  const s = typeof html === 'string' ? html : '';
  const m = s.match(/class="[^"]*on-air[^"]*"[\s\S]{0,800}?class="song-artist"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
  if (!m) return null;
  const text = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return toResult(text);
}

// Kinds whose infoUrl returns HTML rather than JSON — fetched via response.text().
const HTML_KINDS = new Set(['wwoz']);

function parseByKind(kind, data, streamUrl) {
  switch (kind) {
    case 'creek': return parseCreekCurrent(data);
    case 'kexp': return parseKEXPPlay(data);
    case 'ckut': return parseCKUTShows(data);
    case 'icecast-allstats': return parseIcecastAllStats(data, streamUrl);
    case 'airtime-v1': return parseAirtimeV1(data);
    case 'wwoz': return parseWWOZOnAir(data);
    // 'azuracast' is dispatched in strategies/index.js — its parser is shared
    // with the derived-endpoint AzuraCast strategy there.
    default: return null;
  }
}

module.exports = {
  STATION_MAP,
  CACHE_TTL_BY_KIND,
  HTML_KINDS,
  findStationMapEntry,
  parseByKind,
  parseWWOZOnAir,
  parseAirtimeV1,
  parseCreekCurrent,
  parseKEXPPlay,
  parseCKUTShows,
  parseIcecastAllStats,
};
