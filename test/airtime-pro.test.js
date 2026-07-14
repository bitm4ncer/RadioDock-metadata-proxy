const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAirtimeProNowPlaying } = require('../strategies/index.js');

// Regression: Kiosk Radio (Airtime/LibreTime) showed "offline" forever because
// the Airtime-Pro path never ran the placeholder gate the other strategies use.
test('Airtime Pro: offline placeholder yields no metadata', () => {
  const offline = { shows: { current: null }, tracks: { current: { name: 'offline' } } };
  assert.equal(parseAirtimeProNowPlaying(offline) || '', '', 'offline must not surface as now-playing');
});

test('Airtime Pro: "Stream Offline" / LibreTime placeholders rejected', () => {
  assert.equal(parseAirtimeProNowPlaying({ tracks: { current: { name: 'LibreTime - offline' } } }) || '', '');
  assert.equal(parseAirtimeProNowPlaying({ now: 'Stream Offline' }) || '', '');
});

test('Airtime Pro: real track surfaces', () => {
  const data = {
    shows: { current: { name: 'Morning Show' } },
    tracks: { current: { metadata: { artist_name: 'Nina Simone', track_title: 'Feeling Good' } } },
  };
  const np = parseAirtimeProNowPlaying(data);
  assert.match(np, /Nina Simone - Feeling Good/);
});
