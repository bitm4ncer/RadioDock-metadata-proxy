const test = require('node:test');
const assert = require('node:assert/strict');
const { makeOverrideMap } = require('../lib/override-map.js');

const okFetch = (body) => async () => ({ ok: true, status: 200, json: async () => body });
const failFetch = async () => { throw new Error('down'); };
const notFound = async () => ({ ok: false, status: 404, json: async () => ({}) });

test('lookup by stationId (authoritative) then host', async () => {
  const map = {
    stations: { 'uuid-1': { strategy: 'airtime-v1', endpoint: 'https://k/np' } },
    byHost: { 'a.example': { strategy: 'json-generic', endpoint: 'https://a/np' } },
  };
  const om = makeOverrideMap({ url: 'x', fetchImpl: okFetch(map) });
  await om.refresh();
  assert.equal(om.lookup({ stationId: 'uuid-1' }).strategy, 'airtime-v1');
  assert.equal(om.lookup({ streamUrl: 'http://a.example:8000/stream' }).strategy, 'json-generic');
  assert.equal(om.lookup({ stationId: 'nope', streamUrl: 'http://b.example/s' }), null);
});

test('graceful on fetch throw — keeps empty last-known, never throws', async () => {
  const om = makeOverrideMap({ url: 'x', fetchImpl: failFetch });
  await om.refresh();
  assert.deepEqual(om.get(), { stations: {}, byHost: {} });
  assert.equal(om.lookup({ stationId: 'anything' }), null);
});

test('graceful on 404 — empty map', async () => {
  const om = makeOverrideMap({ url: 'x', fetchImpl: notFound });
  await om.refresh();
  assert.deepEqual(om.get(), { stations: {}, byHost: {} });
});

test('keeps last-known on a later failure', async () => {
  const good = { stations: { u: { strategy: 'kexp' } }, byHost: {} };
  let mode = okFetch(good);
  const om = makeOverrideMap({ url: 'x', fetchImpl: (...a) => mode(...a) });
  await om.refresh();
  assert.equal(om.lookup({ stationId: 'u' }).strategy, 'kexp');
  mode = failFetch;
  await om.refresh();
  assert.equal(om.lookup({ stationId: 'u' }).strategy, 'kexp', 'last-known survives a failed refresh');
});
