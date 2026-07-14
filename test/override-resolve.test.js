const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePath, resolveJsonGeneric } = require('../strategies/index.js');

test('resolvePath: nested keys, numeric index, and array scan', () => {
  assert.equal(resolvePath({ a: { b: 'x' } }, 'a.b'), 'x');
  assert.equal(resolvePath({ results: [{ artist: 'A' }] }, 'results.0.artist'), 'A');
  assert.equal(resolvePath({ results: [{ artist: 'A' }] }, 'results.artist'), 'A', 'scans array for first match');
  assert.equal(resolvePath({}, 'a.b'), undefined);
  assert.equal(resolvePath(null, 'a'), undefined);
});

test('resolveJsonGeneric: artist + title combine', () => {
  const r = resolveJsonGeneric({ np: { song: { artist: 'Nina Simone', title: 'Feeling Good' } } },
    { artist: 'np.song.artist', title: 'np.song.title' });
  assert.equal(r.display, 'Nina Simone - Feeling Good');
  assert.equal(r.artist, 'Nina Simone');
});

test('resolveJsonGeneric: title only', () => {
  assert.equal(resolveJsonGeneric({ t: 'Just A Title' }, { title: 't' }).display, 'Just A Title');
});

test('resolveJsonGeneric: placeholder rejected', () => {
  assert.equal(resolveJsonGeneric({ t: 'offline' }, { title: 't' }), null);
});

test('resolveJsonGeneric: nothing matched → null', () => {
  assert.equal(resolveJsonGeneric({}, { title: 'x.y' }), null);
});
