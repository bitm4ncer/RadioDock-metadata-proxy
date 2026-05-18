const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSingleFlight } = require('../lib/single-flight.js');

test('createSingleFlight: collapses concurrent calls with the same key into one factory invocation', async () => {
  const sf = createSingleFlight();
  let calls = 0;
  const slow = () => new Promise((resolve) => {
    calls++;
    setTimeout(() => resolve('done'), 50);
  });
  const results = await Promise.all([
    sf('k', slow),
    sf('k', slow),
    sf('k', slow),
    sf('k', slow),
  ]);
  assert.equal(calls, 1, 'factory should only fire once for concurrent identical keys');
  assert.deepEqual(results, ['done', 'done', 'done', 'done']);
});

test('createSingleFlight: different keys do not collapse', async () => {
  const sf = createSingleFlight();
  let calls = 0;
  const slow = (val) => () => new Promise((resolve) => {
    calls++;
    setTimeout(() => resolve(val), 20);
  });
  const [a, b, c] = await Promise.all([
    sf('a', slow('a')),
    sf('b', slow('b')),
    sf('c', slow('c')),
  ]);
  assert.equal(calls, 3);
  assert.deepEqual([a, b, c], ['a', 'b', 'c']);
});

test('createSingleFlight: after the in-flight settles, a fresh call re-invokes the factory', async () => {
  const sf = createSingleFlight();
  let calls = 0;
  const fast = () => { calls++; return Promise.resolve(calls); };
  const r1 = await sf('k', fast);
  const r2 = await sf('k', fast);
  assert.equal(r1, 1);
  assert.equal(r2, 2);
});

test('createSingleFlight: rejected in-flight is propagated to all waiters and cleaned up', async () => {
  const sf = createSingleFlight();
  const failing = () => new Promise((_, reject) => setTimeout(() => reject(new Error('boom')), 10));
  const settled = await Promise.allSettled([sf('k', failing), sf('k', failing)]);
  assert.equal(settled[0].status, 'rejected');
  assert.equal(settled[1].status, 'rejected');
  assert.equal(settled[0].reason.message, 'boom');
  // After failure, the key should be released so a new call re-runs.
  let calls = 0;
  const ok = () => { calls++; return Promise.resolve('ok'); };
  const r = await sf('k', ok);
  assert.equal(r, 'ok');
  assert.equal(calls, 1);
});
