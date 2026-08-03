// Regression test: destroying an ABORTED body must not kill the process.
//
// The socket-leak fix (PR #3) added an unconditional `response.body.destroy()`
// to fetchICYMetadata's finally block. undici's BodyReadable emits an 'error'
// event (RequestAbortedError / UND_ERR_ABORTED) when it is destroyed after its
// request was aborted — and an abort is routine here, because fetchWithTimeout
// aborts every ICY stream that stays silent past the timeout. With no 'error'
// listener on the body, Node treats that as an unhandled 'error' event and
// terminates the process; the surrounding try/catch cannot see it because the
// event is emitted asynchronously.
//
// Live effect on the VPS (2026-08-03): RestartCount 880, 765 crashes in one log
// window. Every crash also 502'd the in-flight requests of unrelated stations,
// pushing their clients onto the Render fallback for 60s at a time.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { fetchICYMetadata, _setIcyFetchForTests } = require('../strategies/index.js');

// Mirrors undici's BodyReadable after an aborted request: destroy() emits
// 'error' asynchronously rather than completing silently.
function makeAbortedBody() {
  const body = new Readable({ read() {} });
  const destroy = body.destroy.bind(body);
  body.destroy = () =>
    destroy(Object.assign(new Error('Request aborted'), { code: 'UND_ERR_ABORTED' }));
  return body;
}

function fakeResponse({ ok = true, status = 200, headers = {}, body }) {
  return { ok, status, statusCode: status, headers, body };
}

test.afterEach(() => _setIcyFetchForTests(null));

test('ICY: destroying an aborted body raises no unhandled error event', async () => {
  const body = makeAbortedBody();
  _setIcyFetchForTests(async () => fakeResponse({ ok: true, headers: {}, body }));

  const uncaught = [];
  const onUncaught = (err) => uncaught.push(err);
  process.on('uncaughtException', onUncaught);
  try {
    await fetchICYMetadata('http://example.test/stream');
    // The 'error' event lands a tick after destroy() — wait for it.
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    process.off('uncaughtException', onUncaught);
  }

  assert.deepEqual(
    uncaught.map((e) => e.message),
    [],
    'destroying an aborted body must not raise an unhandled error event',
  );
  assert.equal(body.destroyed, true, 'the body must still be destroyed (leak fix stays intact)');
});
