const test = require('node:test');
const assert = require('node:assert/strict');
const { isStationEcho } = require('../lib/normalize.js');

// The generic engine reads unknown JSON and homepage HTML. Its worst failure is
// not "no metadata" — it is confidently showing the station's own name or the
// page title as if it were now-playing. This gate is what makes Stages 3/4 safe.

test('rejects echoes of the station name', () => {
  assert.equal(isStationEcho('Kiosk Radio', { stationName: 'Kiosk Radio' }), true);
  assert.equal(isStationEcho('  kiosk   radio ', { stationName: 'Kiosk Radio' }), true);
  assert.equal(isStationEcho('KIOSK RADIO!', { stationName: 'Kiosk Radio' }), true);
});

test('rejects echoes of the site title', () => {
  assert.equal(isStationEcho('Homepage | Kiosk Radio', { siteTitle: 'Homepage | Kiosk Radio' }), true);
});

test('rejects the station name plus only boilerplate', () => {
  assert.equal(isStationEcho('WWOZ FM', { stationName: 'WWOZ' }), true);
  assert.equal(isStationEcho('Kiosk Radio live', { stationName: 'Kiosk Radio' }), true);
  assert.equal(isStationEcho('Radio 80000 - live stream', { stationName: 'Radio 80000' }), true);
});

test('rejects a display the reference fully contains', () => {
  // "WWOZ 90.7" is just a fragment of the station name — not a programme.
  assert.equal(isStationEcho('WWOZ 90.7', { stationName: 'WWOZ 90.7 New Orleans, LA' }), true);
});

test('keeps real now-playing that merely mentions the station', () => {
  assert.equal(isStationEcho('Tim Reaper @ Kiosk Radio 11.04.2026', { stationName: 'Kiosk Radio' }), false);
  assert.equal(isStationEcho('Nina Simone - Feeling Good', { stationName: 'Kiosk Radio' }), false);
  assert.equal(isStationEcho('New Orleans Music Show with Cole Williams', { stationName: 'WWOZ 90.7 New Orleans, LA' }), false);
});

test('handles missing references and empty input', () => {
  assert.equal(isStationEcho('Nina Simone - Feeling Good', {}), false);
  assert.equal(isStationEcho('', { stationName: 'X' }), true);
  assert.equal(isStationEcho(null, { stationName: 'X' }), true);
});
