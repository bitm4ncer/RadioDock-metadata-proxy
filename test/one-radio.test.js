const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  deriveRadioCultEndpointFromStream,
  parseRadioCultNowPlaying,
  deriveRadioJarEndpointFromStream,
  parseRadioJarNowPlaying,
  findNTSMixtape,
  parseAzuraCastNowPlaying,
} = require('../strategies/index.js');

const {
  findStationMapEntry,
  parseAirtimeV1,
  parseCreekCurrent,
  parseKEXPPlay,
  parseBFFNow,
  parseCKUTShows,
  parseIcecastAllStats,
  parseWNYUCurrent,
} = require('../strategies/station-map.js');

const fixture = (name) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `${name}.json`), 'utf8'));

// --- RadioCult ---

test('deriveRadioCultEndpointFromStream: derives API URL from subdomain slug', () => {
  assert.equal(
    deriveRadioCultEndpointFromStream('https://noods-radio.radiocult.fm/stream?_ic2=1764380384069'),
    'https://api.radiocult.fm/api/station/noods-radio/schedule/live',
  );
  assert.equal(
    deriveRadioCultEndpointFromStream('https://worldwide-fm.radiocult.fm/stream'),
    'https://api.radiocult.fm/api/station/worldwide-fm/schedule/live',
  );
});

test('deriveRadioCultEndpointFromStream: null for non-radiocult URLs', () => {
  assert.equal(deriveRadioCultEndpointFromStream('https://stream.bff.fm/1/mp3.mp3'), null);
  assert.equal(deriveRadioCultEndpointFromStream('https://radiocult.fm/stream'), null);
  assert.equal(deriveRadioCultEndpointFromStream('not a url'), null);
});

test('parseRadioCultNowPlaying: uses file metadata title when no artist', () => {
  const parsed = parseRadioCultNowPlaying(fixture('radiocult-live'));
  assert.equal(parsed.display, 'Through The Years New Age w Mica');
});

test('parseRadioCultNowPlaying: combines artist and title from track metadata', () => {
  const parsed = parseRadioCultNowPlaying(fixture('radiocult-track'));
  assert.equal(parsed.display, 'Soft Power - Doom');
  assert.equal(parsed.artist, 'Soft Power');
  assert.equal(parsed.title, 'Doom');
});

test('parseRadioCultNowPlaying: null when off air', () => {
  assert.equal(parseRadioCultNowPlaying(fixture('radiocult-offair')), null);
});

// --- RadioJar ---

test('deriveRadioJarEndpointFromStream: derives proxy API from stream id', () => {
  assert.equal(
    deriveRadioJarEndpointFromStream('https://stream.radiojar.com/78cxy6wkxtzuv'),
    'https://proxy.radiojar.com/api/stations/78cxy6wkxtzuv/now_playing/',
  );
});

test('deriveRadioJarEndpointFromStream: null for non-radiojar URLs', () => {
  assert.equal(deriveRadioJarEndpointFromStream('https://stream.bff.fm/1/mp3.mp3'), null);
  assert.equal(deriveRadioJarEndpointFromStream('https://stream.radiojar.com/'), null);
});

test('parseRadioJarNowPlaying: combines artist and title', () => {
  const parsed = parseRadioJarNowPlaying(fixture('radiojar'));
  assert.equal(parsed.display, 'radio alhara - [bakisa] 0000');
});

test('parseRadioJarNowPlaying: null on empty payload', () => {
  assert.equal(parseRadioJarNowPlaying({ artist: '', title: '' }), null);
  assert.equal(parseRadioJarNowPlaying(null), null);
});

// --- NTS Mixtapes ---

test('findNTSMixtape: matches mixtape by audio_stream_endpoint', () => {
  const m = findNTSMixtape(fixture('nts-mixtapes'), 'https://stream-mixtape-geo.ntslive.net/mixtape5');
  assert.equal(m.title, '4 To The Floor');
});

test('findNTSMixtape: exact segment match — mixtape does not match mixtape5', () => {
  const m = findNTSMixtape(fixture('nts-mixtapes'), 'https://stream-mixtape-geo.ntslive.net/mixtape');
  assert.equal(m.mixtape_alias, 'slow-focus');
});

test('findNTSMixtape: null when no match', () => {
  assert.equal(findNTSMixtape(fixture('nts-mixtapes'), 'https://stream-mixtape-geo.ntslive.net/mixtape99'), null);
  assert.equal(findNTSMixtape(null, 'https://stream-mixtape-geo.ntslive.net/mixtape5'), null);
});

// --- AzuraCast shared parser ---

test('parseAzuraCastNowPlaying: builds display from song artist/title', () => {
  const parsed = parseAzuraCastNowPlaying(fixture('azuracast-nowplaying'));
  assert.equal(parsed.display, 'CMD094 - Scan');
  assert.equal(parsed.artist, 'CMD094');
  assert.equal(parsed.title, 'Scan');
});

test('parseAzuraCastNowPlaying: null without song data', () => {
  assert.equal(parseAzuraCastNowPlaying({ now_playing: {} }), null);
  assert.equal(parseAzuraCastNowPlaying({}), null);
});

// --- Placeholder filtering (LibreTime emits these when idle) ---

test('isValidMetadata: filters LibreTime offline placeholders', () => {
  const { isValidMetadata } = require('../lib/normalize.js');
  for (const s of ['LibreTime - offline', 'offline', 'LibreTime']) {
    assert.equal(isValidMetadata({ display: s }), false, `expected "${s}" to be filtered`);
  }
});

// --- Station map lookup ---

test('findStationMapEntry: resolves known stream hosts (port ignored)', () => {
  const cases = [
    ['https://stream.kalx.berkeley.edu:8443/kalx-128.mp3', 'creek'],
    ['https://listen.kusf.org/stream', 'creek'],
    ['https://kexp-mp3-128.streamguys1.com/kexp128.mp3', 'kexp'],
    ['https://stream.bff.fm/1/mp3.mp3', 'bff'],
    ['https://delray.ckut.ca:8001/903fm-192-stereo', 'ckut'],
    ['https://transliacija.audiomastering.lt/radiovilnius-mp3', 'icecast-allstats'],
    ['https://radio.kwsx.online/assets/playlists/high/kwsx.m3u', 'azuracast'],
    ['https://radio.syg.ma/audio.mp3', 'airtime-v1'],
    ['https://libretime.radioquantica.com/main.mp3', 'airtime-v1'],
    ['https://stream.skylab-radio.com/live', 'airtime-v1'],
    ['https://radio.veneno.live/stream/main', 'airtime-v1'],
    ['https://sohoradiomusic.doughunt.co.uk:8010/320mp3', 'airtime-v1'],
    ['https://www.wnyu-ice-cast-relay.com/wnyu.mp3', 'wnyu'],
  ];
  for (const [url, kind] of cases) {
    const entry = findStationMapEntry(url);
    assert.ok(entry, `expected entry for ${url}`);
    assert.equal(entry.kind, kind, `expected ${kind} for ${url}`);
    assert.ok(entry.infoUrl, `expected infoUrl for ${url}`);
  }
});

test('findStationMapEntry: null for unknown hosts', () => {
  assert.equal(findStationMapEntry('https://ice2.somafm.com/sf1033-128-mp3'), null);
  assert.equal(findStationMapEntry('not a url'), null);
});

// --- Station map parsers ---

test('parseAirtimeV1: live-info shape — show name prefixes track', () => {
  const parsed = parseAirtimeV1(fixture('airtime-v1-live-info'));
  assert.ok(parsed.display.startsWith('NIGHT MOVES - André 3000 - '));
});

test('parseAirtimeV1: sygma stats shape — tracks.current + shows.current object', () => {
  const parsed = parseAirtimeV1(fixture('airtime-v1-sygma'));
  assert.equal(
    parsed.display,
    'Rotation - serpin - prosthetic sentiments 02 - cerpintxt x Stephan Barrett',
  );
});

test('parseAirtimeV1: show only when no current track', () => {
  const parsed = parseAirtimeV1({ current: null, currentShow: [{ name: 'Night Shift' }] });
  assert.equal(parsed.display, 'Night Shift');
});

test('parseAirtimeV1: null when nothing is on', () => {
  assert.equal(parseAirtimeV1({ current: null, currentShow: [] }), null);
  assert.equal(parseAirtimeV1({}), null);
});

test('parseCreekCurrent: show title + current song', () => {
  const parsed = parseCreekCurrent(fixture('creek-current'));
  assert.equal(parsed.display, 'Moe - Cardiacs - The May');
  assert.equal(parsed.artist, 'Cardiacs');
  assert.equal(parsed.title, 'The May');
});

test('parseCreekCurrent: show only without track', () => {
  const parsed = parseCreekCurrent({ show: { title: 'Moe' }, track: null });
  assert.equal(parsed.display, 'Moe');
});

test('parseCreekCurrent: null on empty payload', () => {
  assert.equal(parseCreekCurrent({}), null);
});

test('parseKEXPPlay: artist - song for trackplay', () => {
  const parsed = parseKEXPPlay(fixture('kexp-play'));
  assert.equal(parsed.display, 'Björk - Isobel');
});

test('parseKEXPPlay: null for airbreak', () => {
  assert.equal(parseKEXPPlay({ results: [{ play_type: 'airbreak', artist: null, song: null }] }), null);
  assert.equal(parseKEXPPlay({ results: [] }), null);
});

test('parseBFFNow: artist - title', () => {
  const parsed = parseBFFNow(fixture('bff-now'));
  assert.equal(parsed.display, 'Bikini Kill - Double Dare Ya');
});

test('parseBFFNow: falls back to program name', () => {
  const parsed = parseBFFNow({ title: '', artist: '', program: 'Schock Treatment' });
  assert.equal(parsed.display, 'Schock Treatment');
});

test('parseCKUTShows: program title with HTML stripped', () => {
  const parsed = parseCKUTShows(fixture('ckut-shows'));
  assert.equal(parsed.display, 'Harbinger Showcase');
});

test('parseCKUTShows: null without program', () => {
  assert.equal(parseCKUTShows({}), null);
});

test('parseIcecastAllStats: picks source matching the stream mount', () => {
  const parsed = parseIcecastAllStats(
    fixture('vilnius-allstats'),
    'https://transliacija.audiomastering.lt/radiovilnius-mp3',
  );
  assert.equal(parsed.display, 'Laikas eina per miestą: Carla dal Forno - Clusters');
});

test('parseIcecastAllStats: null when mount not present', () => {
  assert.equal(
    parseIcecastAllStats(fixture('vilnius-allstats'), 'https://transliacija.audiomastering.lt/nope'),
    null,
  );
});

test('parseWNYUCurrent: playlist title', () => {
  const parsed = parseWNYUCurrent(fixture('wnyu-current'));
  assert.equal(parsed.display, 'The Jukebox Joint');
});

test('parseWNYUCurrent: null without playlist', () => {
  assert.equal(parseWNYUCurrent({}), null);
});
