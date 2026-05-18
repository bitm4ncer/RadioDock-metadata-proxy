const { test } = require('node:test');
const assert = require('node:assert/strict');

const probeCache = require('../lib/probe-cache.js');

test('orderCandidates: cold state — everything goes into unknown', () => {
  probeCache._resetForTests();
  const candidates = [
    'http://host1.example/api/nowplaying',
    'http://host1.example/current',
    'http://host1.example/stats',
  ];
  const { positives, unknown, skipped } = probeCache.orderCandidates('host1.example', candidates);
  assert.equal(positives.length, 0);
  assert.equal(unknown.length, 3);
  assert.equal(skipped.length, 0);
});

test('orderCandidates: negative paths are skipped, positive paths hoisted', () => {
  probeCache._resetForTests();
  probeCache.markNegative('host2.example', '/api/nowplaying');
  probeCache.markPositive('host2.example', '/current');
  const candidates = [
    'http://host2.example/api/nowplaying',
    'http://host2.example/current',
    'http://host2.example/stats',
  ];
  const { positives, unknown, skipped } = probeCache.orderCandidates('host2.example', candidates);
  assert.deepEqual(positives, ['http://host2.example/current']);
  assert.deepEqual(unknown, ['http://host2.example/stats']);
  assert.deepEqual(skipped, ['http://host2.example/api/nowplaying']);
});

test('orderCandidates: hosts are isolated', () => {
  probeCache._resetForTests();
  probeCache.markNegative('hostA.example', '/api/nowplaying');
  const r = probeCache.orderCandidates('hostB.example', ['http://hostB.example/api/nowplaying']);
  assert.equal(r.unknown.length, 1, 'hostB should not inherit hostA negatives');
  assert.equal(r.skipped.length, 0);
});

test('getStatus: returns null for unseen, negative/positive after marking', () => {
  probeCache._resetForTests();
  assert.equal(probeCache.getStatus('host3.example', '/x'), null);
  probeCache.markNegative('host3.example', '/x');
  assert.equal(probeCache.getStatus('host3.example', '/x'), 'negative');
  probeCache.markPositive('host3.example', '/y');
  assert.equal(probeCache.getStatus('host3.example', '/y'), 'positive');
});

test('orderCandidates: unparseable URL keyed on the raw string', () => {
  probeCache._resetForTests();
  // We don't expect this in practice, but the impl should not throw.
  const { positives, unknown, skipped } = probeCache.orderCandidates('weird', ['::not-a-url::']);
  assert.equal(positives.length + unknown.length + skipped.length, 1);
});
