const test = require('node:test');
const assert = require('node:assert/strict');
const strategies = require('../strategies/index.js');

// Phase A = stream-host strategies (unchanged). Phase B = the homepage tier,
// which must run ONLY on a Phase-A miss, ONLY with a homepage, and ONLY when
// the Hetzner flag is on — Render runs the same code with the flag unset and
// must behave exactly as it does today.

// A stream host that can never resolve, so Phase A misses fast without network.
const DEAD_STREAM = 'https://nothing.invalid/stream';

function stubTier() {
  const calls = [];
  strategies._setHomepageTierForTests(async (homepage, opts) => {
    calls.push({ homepage, opts });
    return { source: 'homepage-api', display: 'Real Artist - Real Song', artist: null, title: null, raw: {}, confidence: 0.7, cacheTtl: 15 };
  });
  return calls;
}

test.afterEach(() => {
  strategies._setHomepageTierForTests(null);
  delete process.env.ENABLE_HOMEPAGE_TIER;
});

test('flag OFF: homepage tier never runs (this is what keeps Render the proven fallback)', async () => {
  const calls = stubTier();
  delete process.env.ENABLE_HOMEPAGE_TIER;
  const r = await strategies.fetchMetadata({ streamUrl: DEAD_STREAM, stationId: 'x', homepage: 'https://station.example/' });
  assert.equal(calls.length, 0, 'tier must not be called with the flag off');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-metadata');
});

test('flag ON + Phase A miss + homepage: tier result is returned', async () => {
  const calls = stubTier();
  process.env.ENABLE_HOMEPAGE_TIER = '1';
  const r = await strategies.fetchMetadata({ streamUrl: DEAD_STREAM, stationId: 'x', homepage: 'https://station.example/' });
  assert.equal(calls.length, 1, 'tier ran once');
  assert.equal(calls[0].homepage, 'https://station.example/');
  assert.equal(r.display, 'Real Artist - Real Song');
  assert.equal(r.source, 'homepage-api');
});

test('flag ON but no homepage: nothing to probe, clean no-metadata', async () => {
  const calls = stubTier();
  process.env.ENABLE_HOMEPAGE_TIER = '1';
  const r = await strategies.fetchMetadata({ streamUrl: DEAD_STREAM, stationId: 'x' });
  assert.equal(calls.length, 0);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-metadata');
});

test('flag ON + tier finds nothing: still a prompt no-metadata, never a hang or placeholder', async () => {
  strategies._setHomepageTierForTests(async () => null);
  process.env.ENABLE_HOMEPAGE_TIER = '1';
  const r = await strategies.fetchMetadata({ streamUrl: DEAD_STREAM, stationId: 'x', homepage: 'https://station.example/' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-metadata');
});

test('flag ON + tier throws: degrades to no-metadata rather than surfacing an error', async () => {
  strategies._setHomepageTierForTests(async () => { throw new Error('boom'); });
  process.env.ENABLE_HOMEPAGE_TIER = '1';
  const r = await strategies.fetchMetadata({ streamUrl: DEAD_STREAM, stationId: 'x', homepage: 'https://station.example/' });
  assert.equal(r.ok, false);
});

test('the station name is passed to the tier so the echo gate can work', async () => {
  const calls = stubTier();
  process.env.ENABLE_HOMEPAGE_TIER = '1';
  await strategies.fetchMetadata({ streamUrl: DEAD_STREAM, stationId: 'x', homepage: 'https://station.example/', name: 'Station Example' });
  assert.equal(calls[0].opts.stationName, 'Station Example');
});
