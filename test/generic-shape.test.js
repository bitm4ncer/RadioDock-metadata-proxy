const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { parseStationMetadata } = require('../strategies/index.js');

const fixture = (n) => JSON.parse(readFileSync(path.join(__dirname, 'fixtures', `${n}.json`), 'utf8'));

// The generic extractor must reach the shapes that today only bespoke parsers
// understand — that is what lets the station-map entries be deleted.

test('AzuraCast shape: now_playing.song.{artist,title}', () => {
  assert.equal(parseStationMetadata(fixture('azuracast-nowplaying')), 'CMD094 - Scan');
});

test('KEXP shape: results[0].{artist,song}', () => {
  assert.equal(parseStationMetadata(fixture('kexp-play')), 'Björk - Isobel');
});

test('BFF shape: flat {artist,title}', () => {
  assert.equal(parseStationMetadata(fixture('bff-now')), 'Bikini Kill - Double Dare Ya');
});

test('Creek shape: track.song.{artist,title}', () => {
  assert.equal(parseStationMetadata(fixture('creek-current')), 'Cardiacs - The May');
});

test('Airtime v1 shape: tracks.current.metadata', () => {
  const data = {
    shows: { current: { name: 'Morning Show' } },
    tracks: { current: { metadata: { artist_name: 'Nina Simone', track_title: 'Feeling Good' } } },
  };
  assert.equal(parseStationMetadata(data), 'Nina Simone - Feeling Good');
});

test('Icecast shape: icestats.source.title', () => {
  const data = { icestats: { source: { title: 'Kate Bush - Cloudbusting' } } };
  assert.equal(parseStationMetadata(data), 'Kate Bush - Cloudbusting');
});

test('show-only shape falls back to the programme name (CKUT)', () => {
  assert.equal(parseStationMetadata(fixture('ckut-shows')), 'Harbinger Showcase');
});

test('never returns an object as the display (nested container must not leak)', () => {
  // Regression: `title = data.song || data.track` assigned the OBJECT when the
  // payload nested its fields, producing "[object Object]" downstream.
  const r = parseStationMetadata({ song: { artist: 'A', title: 'B' } });
  assert.ok(r === null || typeof r === 'string', 'display must be a string or null');
  if (r) assert.ok(!r.includes('[object'), r);
});

test('placeholders and junk are rejected', () => {
  assert.equal(parseStationMetadata({ title: 'offline' }), null);
  assert.equal(parseStationMetadata({ now_playing: { title: 'Stream Offline' } }), null);
  assert.equal(parseStationMetadata({}), null);
  assert.equal(parseStationMetadata(null), null);
});
