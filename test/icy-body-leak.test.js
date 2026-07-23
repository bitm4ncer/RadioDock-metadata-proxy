// Regression test for the proxy's socket / TCP-memory leak.
//
// fetchICYMetadata opens a live (effectively infinite) audio stream to read the
// ICY metadata block. Several exit paths — a non-2xx response, a stream that
// carries no icy-metaint (header-only), and the normal "metadata found" path —
// must ALWAYS destroy the upstream body. If they don't, the socket stays open
// and its receive buffer accumulates in kernel TCP memory; on the 3.7GB VPS
// this drove tcp_memory_allocated to its ceiling ("TCP: out of memory") and the
// proxy heap to a global OOM. See the 2026-07-22 server health audit.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchICYMetadata, _setIcyFetchForTests } = require('../strategies/index.js');

// A fake undici-style body: async-iterable, with a destroy() spy. Breaking the
// for-await over it does NOT auto-destroy (unlike a real undici stream), so the
// test proves the code destroys the body EXPLICITLY on every path.
function makeBody(chunks = []) {
  let destroyed = false;
  return {
    get destroyed() { return destroyed; },
    destroy() { destroyed = true; },
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

function fakeResponse({ ok = true, status = 200, headers = {}, body }) {
  return { ok, status, statusCode: status, headers, body };
}

test.afterEach(() => _setIcyFetchForTests(null));

test('ICY: header-only response (no icy-metaint) destroys the body', async () => {
  const body = makeBody();
  _setIcyFetchForTests(async () =>
    fakeResponse({ ok: true, headers: { 'icy-name': 'Cool Radio' }, body }));

  const result = await fetchICYMetadata('http://example.test/stream');

  assert.equal(result?.source, 'icy-headers');
  assert.equal(body.destroyed, true, 'header-only path must destroy the stream body');
});

test('ICY: non-2xx response destroys the body', async () => {
  const body = makeBody();
  _setIcyFetchForTests(async () =>
    fakeResponse({ ok: false, status: 502, headers: {}, body }));

  const result = await fetchICYMetadata('http://example.test/stream');

  assert.equal(result, null);
  assert.equal(body.destroyed, true, 'error path must destroy the stream body');
});

test('ICY: metadata-found path destroys the body', async () => {
  // Build one chunk: 4 audio bytes, a length byte (2 -> 32 bytes), then the
  // StreamTitle metadata padded to 32 bytes. icy-metaint = 4.
  const meta = Buffer.from("StreamTitle='A - B';");
  const padded = Buffer.alloc(32);
  meta.copy(padded);
  const chunk = Buffer.concat([Buffer.alloc(4), Buffer.from([2]), padded]);

  const body = makeBody([new Uint8Array(chunk)]);
  _setIcyFetchForTests(async () =>
    fakeResponse({ ok: true, headers: { 'icy-metaint': '4' }, body }));

  const result = await fetchICYMetadata('http://example.test/stream');

  assert.equal(result?.source, 'icy');
  assert.equal(result?.display, 'A - B');
  assert.equal(body.destroyed, true, 'metadata-found path must destroy the stream body');
});
