const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { parseAirtimeV1, parseByKind, HTML_KINDS } = require('../strategies/station-map.js');

const fx = (f) => readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');

// Kiosk Radio override uses the airtime-v1 parser against kioskradio.com's own
// now-playing API. During a live DJ set tracks.current is an empty livestream;
// the meaningful now-playing is shows.current.name.
test('Kiosk (airtime-v1): live DJ resolves to the show name, never "offline"', () => {
  const r = parseAirtimeV1(JSON.parse(fx('kiosk-airtime.json')));
  assert.equal(r && r.display, 'Teenage Menopause w/ Party4ngelxoxo');
});

// WWOZ has no JSON now-playing API; the on-air programme is server-rendered HTML.
test('WWOZ (wwoz kind): extracts the on-air programme from HTML', () => {
  const r = parseByKind('wwoz', fx('wwoz-onair.html'));
  assert.equal(r && r.display, 'New Orleans Music Show with Cole Williams');
});

test('WWOZ: null when no on-air block present', () => {
  assert.equal(parseByKind('wwoz', '<html><body>nothing here</body></html>'), null);
});

test('wwoz is registered as an HTML kind (fetched as text, not JSON)', () => {
  assert.ok(HTML_KINDS.has('wwoz'));
});
