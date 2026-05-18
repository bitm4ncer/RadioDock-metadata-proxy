const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  cleanNowPlaying,
  parseArtistTitle,
  parseStationMetadata,
  isValidMetadata,
  isPlaceholder,
  decodeIcyBytes,
  findCurrentHKCRShow,
} = require('../strategies/index.js');

test('cleanNowPlaying: empty / non-string returns empty string', () => {
  assert.equal(cleanNowPlaying(null), '');
  assert.equal(cleanNowPlaying(undefined), '');
  assert.equal(cleanNowPlaying(''), '');
});

test('cleanNowPlaying: decodes common HTML entities', () => {
  assert.equal(cleanNowPlaying('Sam &amp; Dave'), 'Sam & Dave');
  assert.equal(cleanNowPlaying('it&#039;s'), "it's");
  assert.equal(cleanNowPlaying('it&apos;s'), "it's");
  assert.equal(cleanNowPlaying('a&nbsp;b'), 'a b');
});

test('cleanNowPlaying: strips leading dashes of any flavour', () => {
  assert.equal(cleanNowPlaying('- Real Title'), 'Real Title');
  assert.equal(cleanNowPlaying('– Real Title'), 'Real Title');
  assert.equal(cleanNowPlaying('— Real Title'), 'Real Title');
});

test('cleanNowPlaying: normalises en/em-dash separator to ASCII', () => {
  assert.equal(cleanNowPlaying('Aphex Twin – Windowlicker'), 'Aphex Twin - Windowlicker');
  assert.equal(cleanNowPlaying('Aphex Twin — Windowlicker'), 'Aphex Twin - Windowlicker');
});

test('cleanNowPlaying: does not touch dashes used as proper punctuation (no surrounding spaces)', () => {
  assert.equal(cleanNowPlaying('Café–Society'), 'Café–Society');
});

test('cleanNowPlaying: collapses repeated whitespace', () => {
  assert.equal(cleanNowPlaying('Artist   -   Title'), 'Artist - Title');
});

test('cleanNowPlaying: strips zero-width characters', () => {
  assert.equal(cleanNowPlaying('A​B'), 'AB'); // ZWSP
  assert.equal(cleanNowPlaying('A﻿B'), 'AB'); // BOM
});

test('cleanNowPlaying: NFC-normalises decomposed sequences', () => {
  const decomposed = 'Beyoncé'; // e + combining acute
  const composed  = 'Beyoncé';
  assert.equal(cleanNowPlaying(decomposed), composed);
  assert.equal(cleanNowPlaying(decomposed).length, composed.length);
});

test('parseArtistTitle: splits on " - "', () => {
  assert.equal(parseArtistTitle('Coldplay - Yellow'), 'Coldplay - Yellow');
});

test('parseArtistTitle: uses explicit artist+title over text', () => {
  assert.equal(parseArtistTitle('', 'Coldplay', 'Yellow'), 'Coldplay - Yellow');
});

test('parseArtistTitle: deduplicates when artist === title', () => {
  assert.equal(parseArtistTitle('', 'Same', 'Same'), 'Same');
});

test('parseArtistTitle: returns null on no input', () => {
  assert.equal(parseArtistTitle(''), null);
});

test('isValidMetadata: filters exact-match junk', () => {
  for (const s of ['Live', 'Stream', 'Radio', 'Unknown', 'Airtime!', 'live stream', 'Untitled']) {
    assert.equal(isValidMetadata({ display: s }), false, `expected ${s} to be filtered`);
  }
});

test('isValidMetadata: keeps legitimate titles containing junk words', () => {
  for (const s of ['Coldplay Live', 'Live FM', 'Radiohead - Stream', 'Live at Wembley', 'The Unknowns']) {
    assert.equal(isValidMetadata({ display: s }), true, `expected ${s} to be valid`);
  }
});

test('isValidMetadata: rejects placeholders', () => {
  for (const s of [
    'Now Playing info goes here',
    'Stream Offline',
    'AzuraCast',
    'Liquidsoap',
    'Welcome to Radio Foo',
    'Artist - Title', // literal placeholder
  ]) {
    assert.equal(isValidMetadata({ display: s }), false, `expected ${s} to be filtered as placeholder`);
  }
});

test('isValidMetadata: rejects too-short or missing display', () => {
  assert.equal(isValidMetadata({}), false);
  assert.equal(isValidMetadata({ display: '' }), false);
  assert.equal(isValidMetadata({ display: 'AB' }), false);
  assert.equal(isValidMetadata(null), false);
});

test('isPlaceholder: case insensitive', () => {
  assert.equal(isPlaceholder('NOW PLAYING INFO GOES HERE'), true);
  assert.equal(isPlaceholder('Now playing info goes here'), true);
  assert.equal(isPlaceholder('Welcome to Mojo FM'), true);
  assert.equal(isPlaceholder('Coldplay - Yellow'), false);
});

test('parseStationMetadata: handles nowplaying object', () => {
  const r = parseStationMetadata({ nowplaying: { artist: 'A', title: 'T' } });
  assert.equal(r, 'A - T');
});

test('parseStationMetadata: handles plain song field', () => {
  const r = parseStationMetadata({ song: 'A - T' });
  assert.equal(r, 'A - T');
});

test('parseStationMetadata: returns null on unstructured payload', () => {
  assert.equal(parseStationMetadata({ irrelevant: 1 }), null);
  assert.equal(parseStationMetadata(null), null);
});

test('decodeIcyBytes: UTF-8 happy path', () => {
  const bytes = Buffer.from('Beyoncé', 'utf8');
  assert.equal(decodeIcyBytes(bytes), 'Beyoncé');
});

test('decodeIcyBytes: strips NUL padding', () => {
  const bytes = Buffer.concat([Buffer.from('Hello', 'utf8'), Buffer.from([0, 0, 0])]);
  assert.equal(decodeIcyBytes(bytes), 'Hello');
});

test('decodeIcyBytes: falls back to latin1 when utf8 produces U+FFFD', () => {
  // "Beyoncé" encoded as latin1 — invalid UTF-8 byte 0xe9 alone produces
  // a replacement char on utf8 decode. The fallback must recover it.
  const bytes = Buffer.from('Beyonc\xe9', 'latin1');
  const out = decodeIcyBytes(bytes);
  assert.equal(out.includes('�'), false, 'must not contain replacement char');
  assert.equal(out, 'Beyoncé');
});

// --- HKCR schedule matching (Asia/Hong_Kong, UTC+8) ---
// HKCR shows are stored as { date: "YYYY-MM-DD", startTime: "HH:MM",
// endTime: "HH:MM", title, ... } in HK local time. findCurrentHKCRShow
// must pick the entry whose [start, end) window contains `now`.

// 21:30 HK on 2026-05-18 = 13:30 UTC
const HK_2030_NOW = new Date(Date.UTC(2026, 4, 18, 13, 30));

test('findCurrentHKCRShow: picks the show whose HK window contains now', () => {
  const shows = [
    { title: 'bluebubble with nefo', date: '2026-05-18', startTime: '21:00', endTime: '22:00' },
    { title: 'next show', date: '2026-05-18', startTime: '22:00', endTime: '23:00' },
  ];
  const hit = findCurrentHKCRShow(shows, HK_2030_NOW);
  assert.equal(hit?.title, 'bluebubble with nefo');
});

test('findCurrentHKCRShow: returns null when no show is airing', () => {
  const shows = [
    { title: 'earlier', date: '2026-05-18', startTime: '10:00', endTime: '11:00' },
    { title: 'later', date: '2026-05-19', startTime: '21:00', endTime: '22:00' },
  ];
  assert.equal(findCurrentHKCRShow(shows, HK_2030_NOW), null);
});

test('findCurrentHKCRShow: skips cancelled shows', () => {
  const shows = [
    {
      title: 'bluebubble with nefo',
      date: '2026-05-18', startTime: '21:00', endTime: '22:00',
      cancelledAt: '2026-05-17T10:00:00Z',
    },
  ];
  assert.equal(findCurrentHKCRShow(shows, HK_2030_NOW), null);
});

test('findCurrentHKCRShow: handles midnight-crossing windows', () => {
  // Show 23:00 → 01:00 (HK), now = 00:30 HK on 2026-05-19 = 16:30 UTC on 2026-05-18.
  const shows = [
    { title: 'late night', date: '2026-05-18', startTime: '23:00', endTime: '01:00' },
  ];
  const nowAtMidnightPlus30 = new Date(Date.UTC(2026, 4, 18, 16, 30));
  const hit = findCurrentHKCRShow(shows, nowAtMidnightPlus30);
  assert.equal(hit?.title, 'late night');
});

test('findCurrentHKCRShow: end boundary is exclusive', () => {
  // Show 21:00→22:00 HK. now = exactly 22:00 HK = 14:00 UTC.
  const shows = [
    { title: 'edge', date: '2026-05-18', startTime: '21:00', endTime: '22:00' },
  ];
  const atEnd = new Date(Date.UTC(2026, 4, 18, 14, 0));
  assert.equal(findCurrentHKCRShow(shows, atEnd), null);
});

test('findCurrentHKCRShow: malformed entries are skipped, not thrown', () => {
  const shows = [
    null,
    {},
    { title: '', date: '2026-05-18', startTime: '21:00', endTime: '22:00' },
    { title: 'ok', date: 'bogus', startTime: 'x:y', endTime: 'z' },
    { title: 'bluebubble with nefo', date: '2026-05-18', startTime: '21:00', endTime: '22:00' },
  ];
  assert.equal(findCurrentHKCRShow(shows, HK_2030_NOW)?.title, 'bluebubble with nefo');
});

test('findCurrentHKCRShow: non-array input returns null', () => {
  assert.equal(findCurrentHKCRShow(null), null);
  assert.equal(findCurrentHKCRShow(undefined), null);
  assert.equal(findCurrentHKCRShow({}), null);
});
