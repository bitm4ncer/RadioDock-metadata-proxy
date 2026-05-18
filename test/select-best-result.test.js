const { test } = require('node:test');
const assert = require('node:assert/strict');

const { selectBestResult, firstNonNullResult } = require('../strategies/index.js');

// Helper: a promise that resolves to `value` after `delay`ms.
const after = (delay, value) => new Promise((resolve) => setTimeout(() => resolve(value), delay));

test('selectBestResult: returns null when all promises resolve null', async () => {
  const ctrl = new AbortController();
  const r = await selectBestResult(
    [after(10, null), after(20, null)],
    ctrl,
    { harvestMs: 50 }
  );
  assert.equal(r, null);
});

test('selectBestResult: returns the only result when only one strategy hits', async () => {
  const ctrl = new AbortController();
  const r = await selectBestResult(
    [
      after(10, null),
      after(15, { display: 'A - B', confidence: 0.7 }),
      after(20, null),
    ],
    ctrl,
    { harvestMs: 50 }
  );
  assert.equal(r.display, 'A - B');
});

test('selectBestResult: higher confidence within harvest window overtakes first hit', async () => {
  const ctrl = new AbortController();
  const r = await selectBestResult(
    [
      after(10, { display: 'low',  confidence: 0.7 }),
      after(20, { display: 'high', confidence: 0.95 }),
    ],
    ctrl,
    { harvestMs: 200 }
  );
  assert.equal(r.display, 'high', 'expected the 0.95-confidence result');
  assert.equal(r.confidence, 0.95);
});

test('selectBestResult: later high-confidence result outside the window does NOT overtake', async () => {
  const ctrl = new AbortController();
  const r = await selectBestResult(
    [
      after(10,   { display: 'low',  confidence: 0.7 }),
      after(500,  { display: 'high', confidence: 0.95 }),
    ],
    ctrl,
    { harvestMs: 100 }
  );
  assert.equal(r.display, 'low', 'the late-arriving high-confidence result must not win');
});

test('selectBestResult: aborts the parent controller once a winner is chosen', async () => {
  const ctrl = new AbortController();
  let aborted = false;
  ctrl.signal.addEventListener('abort', () => { aborted = true; });
  await selectBestResult(
    [
      after(10, { display: 'A', confidence: 0.8 }),
      after(500, null),
    ],
    ctrl,
    { harvestMs: 30 }
  );
  assert.equal(aborted, true);
});

test('selectBestResult: empty input resolves to null', async () => {
  const ctrl = new AbortController();
  const r = await selectBestResult([], ctrl, { harvestMs: 50 });
  assert.equal(r, null);
});

test('selectBestResult: result missing display is ignored', async () => {
  const ctrl = new AbortController();
  const r = await selectBestResult(
    [
      after(10, { confidence: 0.99 }),         // no display -> ignored
      after(20, { display: 'real', confidence: 0.5 }),
    ],
    ctrl,
    { harvestMs: 50 }
  );
  assert.equal(r.display, 'real');
});

test('firstNonNullResult: returns the first non-null result', async () => {
  const r = await firstNonNullResult([after(20, null), after(5, { display: 'first' }), after(100, { display: 'late' })]);
  assert.equal(r.display, 'first');
});

test('firstNonNullResult: returns null when all are null', async () => {
  const r = await firstNonNullResult([after(10, null), after(20, null)]);
  assert.equal(r, null);
});

test('firstNonNullResult: empty input resolves to null', async () => {
  const r = await firstNonNullResult([]);
  assert.equal(r, null);
});
