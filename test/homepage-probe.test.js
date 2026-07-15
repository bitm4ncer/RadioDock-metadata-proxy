const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchHomepageApi, HOMEPAGE_PATHS } = require('../lib/homepage-probe.js');
const probeCache = require('../lib/probe-cache.js');

const json = (body) => ({ ok: true, status: 200, json: async () => body });
const notFound = { ok: false, status: 404, json: async () => ({}) };

test('resolves a now-playing endpoint on the homepage origin (the Kiosk case)', async () => {
  probeCache._resetForTests();
  // Kiosk's real endpoint is an utterly ordinary path on its own website —
  // it only ever needed a hardcoded rule because nothing probed the homepage.
  const fetchImpl = async (url) => (url === 'https://kioskradio.com/api/now-playing'
    ? json({ now_playing: { artist: 'Tim Reaper', title: 'Live @ Kiosk' } })
    : notFound);
  const r = await fetchHomepageApi('https://kioskradio.com/', { fetchImpl, stationName: 'Kiosk Radio' });
  assert.ok(r, 'resolved');
  assert.equal(r.display, 'Tim Reaper - Live @ Kiosk');
  assert.equal(r.source, 'homepage-api');
  assert.equal(r.confidence, 0.7);
});

test('null when every path misses', async () => {
  probeCache._resetForTests();
  const r = await fetchHomepageApi('https://nothing.example/', { fetchImpl: async () => notFound, stationName: 'X' });
  assert.equal(r, null);
});

test('rejects a station-name echo', async () => {
  probeCache._resetForTests();
  const fetchImpl = async () => json({ title: 'Kiosk Radio' });
  const r = await fetchHomepageApi('https://kioskradio.com/', { fetchImpl, stationName: 'Kiosk Radio' });
  assert.equal(r, null, 'the station name is not now-playing');
});

test('rejects placeholders', async () => {
  probeCache._resetForTests();
  const fetchImpl = async () => json({ now_playing: { title: 'offline' } });
  assert.equal(await fetchHomepageApi('https://x.example/', { fetchImpl, stationName: 'X' }), null);
});

test('probes the homepage origin, never the given path', async () => {
  probeCache._resetForTests();
  const seen = [];
  const fetchImpl = async (url) => { seen.push(url); return notFound; };
  await fetchHomepageApi('https://x.example/some/deep/page?a=1', { fetchImpl, stationName: 'X' });
  assert.ok(seen.length > 0);
  for (const u of seen) assert.ok(u.startsWith('https://x.example/'), u);
  assert.ok(!seen.some((u) => u.includes('/some/deep')), 'must not append to the given path');
});

test('ignores a non-JSON or unparseable body without throwing', async () => {
  probeCache._resetForTests();
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } });
  assert.equal(await fetchHomepageApi('https://x.example/', { fetchImpl, stationName: 'X' }), null);
});

test('invalid homepage yields null, never a throw', async () => {
  probeCache._resetForTests();
  assert.equal(await fetchHomepageApi('not a url', { fetchImpl: async () => notFound, stationName: 'X' }), null);
  assert.equal(await fetchHomepageApi('', { fetchImpl: async () => notFound, stationName: 'X' }), null);
});

test('cold cache: probes run in one round, not one after another', async () => {
  // Regression, found in production: sequential probing burned the whole
  // Phase-B budget before Stage 3 could run, so WWOZ's FIRST request returned
  // nothing after 10s while a warm cache resolved it in 2.4s. The first request
  // for a station is the one that matters — it must not be the slow one.
  probeCache._resetForTests();
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    return notFound;
  };
  await fetchHomepageApi('https://cold.example/', { fetchImpl, stationName: 'X' });
  assert.ok(maxInFlight > 1, `probes must overlap; max in flight was ${maxInFlight}`);
});

test('the earliest matching path still wins, despite probing concurrently', async () => {
  probeCache._resetForTests();
  const fetchImpl = async (url) => {
    // Both are valid endpoints; /api/now-playing comes first in HOMEPAGE_PATHS.
    if (url.endsWith('/api/now-playing')) return json({ title: 'First Choice', artist: 'A' });
    if (url.endsWith('/currentsong')) return json({ title: 'Later Choice', artist: 'B' });
    return notFound;
  };
  const r = await fetchHomepageApi('https://x.example/', { fetchImpl, stationName: 'X' });
  assert.equal(r.display, 'A - First Choice');
});

test('HOMEPAGE_PATHS covers the paths the special rules needed', () => {
  for (const p of ['/api/now-playing', '/api/nowplaying', '/api/live-info-v2', '/status-json.xsl', '/api/current']) {
    assert.ok(HOMEPAGE_PATHS.includes(p), `${p} missing`);
  }
});
