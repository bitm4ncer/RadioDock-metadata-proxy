const { test } = require('node:test');
const assert = require('node:assert/strict');

const { findCurrentRinseEpisode } = require('../strategies/index.js');

// Rinse FM episode payloads use ISO timestamps with Europe/London offset.
// findCurrentRinseEpisode picks the episode whose [episodeTime,
// episodeTime + episodeLength*60s) window contains `now` AND whose
// channel[0].streamerMountPoint matches the request's stream URL (case-
// insensitive exact match).

const RINSE_UK_STREAM = 'https://admin.stream.rinse.fm/proxy/rinse_uk/stream';
const KOOL_STREAM     = 'https://admin.stream.rinse.fm/proxy/kool/stream';

function ep({ id = '1', title = 'Show', length = 60, channel = 'uk', mount = RINSE_UK_STREAM, time }) {
  return {
    id, title, episodeTime: time, episodeLength: length,
    parentShow: [{ title: title.split(' - ')[0] }],
    channel: [{ slug: channel, streamerMountPoint: mount }],
  };
}

test('findCurrentRinseEpisode: picks episode whose window contains now (UK channel)', () => {
  const now = new Date('2026-05-18T18:30:00+01:00'); // 17:30 UTC
  const hit = findCurrentRinseEpisode([
    ep({ id: '1', title: 'Suzie Bakos', length: 60, time: '2026-05-18T18:00:00+01:00' }),
    ep({ id: '2', title: 'Next Up',     length: 60, time: '2026-05-18T19:00:00+01:00' }),
  ], RINSE_UK_STREAM, now);
  assert.equal(hit?.id, '1');
});

test('findCurrentRinseEpisode: filters by streamerMountPoint (UK request ignores Kool episodes)', () => {
  const now = new Date('2026-05-18T18:30:00+01:00');
  const hit = findCurrentRinseEpisode([
    ep({ id: 'k', title: 'Kool show', length: 60, channel: 'kool', mount: KOOL_STREAM, time: '2026-05-18T18:00:00+01:00' }),
    ep({ id: 'u', title: 'UK show',   length: 60, time: '2026-05-18T18:00:00+01:00' }),
  ], RINSE_UK_STREAM, now);
  assert.equal(hit?.id, 'u');
});

test('findCurrentRinseEpisode: case-insensitive stream URL match', () => {
  const now = new Date('2026-05-18T18:30:00+01:00');
  const hit = findCurrentRinseEpisode([
    ep({ id: '1', title: 'X', length: 60, mount: 'https://Admin.Stream.RINSE.FM/proxy/rinse_uk/stream', time: '2026-05-18T18:00:00+01:00' }),
  ], RINSE_UK_STREAM, now);
  assert.equal(hit?.id, '1');
});

test('findCurrentRinseEpisode: end boundary is exclusive', () => {
  const startUtc = '2026-05-18T18:00:00+01:00'; // 17:00 UTC
  const atEnd = new Date('2026-05-18T18:00:00Z'); // exactly 1 hour later UTC
  const hit = findCurrentRinseEpisode([
    ep({ id: '1', title: 'X', length: 60, time: startUtc }),
  ], RINSE_UK_STREAM, atEnd);
  assert.equal(hit, null);
});

test('findCurrentRinseEpisode: returns null when no episode is airing', () => {
  const now = new Date('2026-05-18T23:30:00+01:00');
  const hit = findCurrentRinseEpisode([
    ep({ id: '1', title: 'X', length: 60, time: '2026-05-18T18:00:00+01:00' }),
  ], RINSE_UK_STREAM, now);
  assert.equal(hit, null);
});

test('findCurrentRinseEpisode: malformed episodes are skipped, not thrown', () => {
  const now = new Date('2026-05-18T18:30:00+01:00');
  const valid = ep({ id: 'ok', title: 'OK', length: 60, time: '2026-05-18T18:00:00+01:00' });
  const hit = findCurrentRinseEpisode([
    null,
    {},
    { episodeTime: 'not-a-date', episodeLength: 60, channel: [{ streamerMountPoint: RINSE_UK_STREAM }] },
    { episodeTime: '2026-05-18T18:00:00+01:00', episodeLength: 'abc', channel: [{ streamerMountPoint: RINSE_UK_STREAM }] },
    { episodeTime: '2026-05-18T18:00:00+01:00', episodeLength: 60 }, // no channel
    valid,
  ], RINSE_UK_STREAM, now);
  assert.equal(hit?.id, 'ok');
});

test('findCurrentRinseEpisode: non-array input returns null', () => {
  assert.equal(findCurrentRinseEpisode(null, RINSE_UK_STREAM), null);
  assert.equal(findCurrentRinseEpisode({}, RINSE_UK_STREAM), null);
});

test('findCurrentRinseEpisode: missing stream URL returns null', () => {
  const eps = [ep({ id: '1', title: 'X', length: 60, time: '2026-05-18T18:00:00+01:00' })];
  assert.equal(findCurrentRinseEpisode(eps, '', new Date('2026-05-18T18:30:00+01:00')), null);
  assert.equal(findCurrentRinseEpisode(eps, null, new Date('2026-05-18T18:30:00+01:00')), null);
});
