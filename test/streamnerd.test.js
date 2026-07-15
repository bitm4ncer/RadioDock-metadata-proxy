const test = require('node:test');
const assert = require('node:assert/strict');
const src = require('fs').readFileSync('strategies/index.js', 'utf8');
eval(src.match(/function deriveAirtimeProEndpointFromStream[\s\S]*?\n\}/)[0]);

test('streamnerd: direct station subdomain (Relate Radio)', () => {
  // relateradio.streamnerd.nl/api/live-info-v2 answers with Airtime data, but
  // the stream URL carries no path segment, so the path-based derivation missed.
  assert.equal(
    deriveAirtimeProEndpointFromStream('https://relateradio.streamnerd.nl/'),
    'https://relateradio.streamnerd.nl/api/live-info-v2',
  );
});
test('streamnerd: origin/play hosts still derive from the path segment', () => {
  assert.equal(
    deriveAirtimeProEndpointFromStream('https://origin.streamnerd.nl/operator/mount/icecast.audio'),
    'https://operator.streamnerd.nl/api/live-info-v2',
  );
});
test('out.airtime.pro unchanged', () => {
  assert.equal(
    deriveAirtimeProEndpointFromStream('https://radio80k.out.airtime.pro:8000/radio80k_a'),
    'https://radio80k.airtime.pro/api/live-info-v2',
  );
});
