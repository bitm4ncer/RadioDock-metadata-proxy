const test = require('node:test');
const assert = require('node:assert/strict');
const { isPlaceholder, isValidMetadata } = require('../lib/normalize.js');

// Regression: Kiosk Radio (Airtime Pro) showed "Airtime - offline" as now-playing.
// Airtime emits that as the ICY StreamTitle when a live source is broadcasting and
// the scheduled playout is offline. ICY carries confidence 0.95, so unless this
// string is caught by the central placeholder gate it beats the Airtime-Pro
// strategy's real show name (e.g. "AliA") in selectBestResult.
test('"Airtime - offline" is a placeholder', () => {
  assert.equal(isPlaceholder('Airtime - offline'), true);
  assert.equal(isPlaceholder('AIRTIME - OFFLINE'), true);
  assert.equal(isValidMetadata({ display: 'Airtime - offline' }), false);
});

test('the existing LibreTime offline sentinel still rejects', () => {
  assert.equal(isPlaceholder('LibreTime - offline'), true);
});

test('a real Airtime show name is not filtered', () => {
  assert.equal(isPlaceholder('AliA'), false);
  assert.equal(isValidMetadata({ display: 'AliA' }), true);
});
