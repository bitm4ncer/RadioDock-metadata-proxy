const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  pickNTSBroadcast,
  ntsCacheTtl,
  fetchNTSMetadata,
  _setNtsFetchForTests,
} = require('../strategies/index.js');

// nts.live/api/v2/live sits behind CloudFront with `Cache-Control: max-age=900`.
// Measured live: `Age: 751` — i.e. the document we are handed can be a quarter
// of an hour behind, so `now` regularly describes a show that already ended.
// The same stale document already carries the current show in `next`/`next2`,
// which is what these tests pin down.

const live = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'nts-live.json'), 'utf8'));
const channel1 = () => live().results[0];
const at = (iso) => Date.parse(iso);

const STREAM1 = 'http://stream-relay-geo.ntslive.net/stream';
const STREAM2 = 'http://stream-relay-geo.ntslive.net/stream2';

// --- slot selection (pure) ---

test('picks `now` while the show is actually on air', () => {
  const slot = pickNTSBroadcast(channel1(), at('2026-08-11T14:30:00+01:00'));
  assert.equal(slot.broadcast_title, 'Tropic of Love w/ Mafalda');
});

test('a stale document resolves to the show that is on air now, not the ended one', () => {
  // 15:20 — `now` ended at 15:00, `next` runs 15:00-16:00.
  const slot = pickNTSBroadcast(channel1(), at('2026-08-11T15:20:00+01:00'));
  assert.equal(slot.broadcast_title, 'Self Soothe w/ Margeaux');
});

test('walks past several ended slots', () => {
  const slot = pickNTSBroadcast(channel1(), at('2026-08-11T16:45:00+01:00'));
  assert.equal(slot.broadcast_title, 'Kültür Hour');
});

test('start boundary is inclusive, end boundary is exclusive', () => {
  assert.equal(pickNTSBroadcast(channel1(), at('2026-08-11T15:00:00+01:00')).broadcast_title, 'Self Soothe w/ Margeaux');
  assert.equal(pickNTSBroadcast(channel1(), at('2026-08-11T14:59:59+01:00')).broadcast_title, 'Tropic of Love w/ Mafalda');
});

test('null once the timetable itself has run out', () => {
  assert.equal(pickNTSBroadcast(channel1(), at('2026-08-11T18:00:00+01:00')), null);
});

test('unparseable timestamps fall back to `now` instead of losing metadata', () => {
  const ch = channel1();
  ch.now.start_timestamp = 'not a date';
  ch.now.end_timestamp = undefined;
  delete ch.next;
  delete ch.next2;
  assert.equal(pickNTSBroadcast(ch, at('2026-08-11T15:20:00+01:00')).broadcast_title, 'Tropic of Love w/ Mafalda');
});

// --- ttl (pure) ---

test('cacheTtl is the remaining runtime so the poll lands on the changeover', () => {
  const slot = channel1().now; // ends 15:00
  assert.equal(ntsCacheTtl(slot, at('2026-08-11T14:58:00+01:00')), 120);
});

test('cacheTtl is clamped to [30, 900]', () => {
  const slot = channel1().now;
  assert.equal(ntsCacheTtl(slot, at('2026-08-11T14:59:55+01:00')), 30, 'floor');
  assert.equal(ntsCacheTtl(slot, at('2026-08-11T13:00:00+01:00')), 900, 'ceiling');
  assert.equal(ntsCacheTtl({}, at('2026-08-11T13:00:00+01:00')), 30, 'no end timestamp');
});

// --- fetch behaviour ---

function withNtsFetch(handler, run) {
  const calls = [];
  _setNtsFetchForTests(async (url) => {
    calls.push(url);
    return handler(url, calls.length);
  });
  return Promise.resolve(run(calls)).finally(() => _setNtsFetchForTests(null));
}

test('on-air show costs exactly one edge request, no cache-buster', async () => {
  mock.timers.enable({ apis: ['Date'], now: at('2026-08-11T14:30:00+01:00') });
  try {
    await withNtsFetch(() => live(), async (calls) => {
      const r = await fetchNTSMetadata(STREAM1, null, {});
      assert.equal(r.display, 'Tropic of Love w/ Mafalda');
      assert.equal(r.source, 'nts');
      assert.equal(r.cacheTtl, 900, 'clamped remaining runtime');
      assert.deepEqual(calls, ['https://www.nts.live/api/v2/live']);
    });
  } finally {
    mock.timers.reset();
  }
});

test('a stale edge document is served from its own timetable, still one request', async () => {
  mock.timers.enable({ apis: ['Date'], now: at('2026-08-11T15:20:00+01:00') });
  try {
    await withNtsFetch(() => live(), async (calls) => {
      const r = await fetchNTSMetadata(STREAM1, null, {});
      assert.equal(r.display, 'Self Soothe w/ Margeaux');
      assert.equal(r.cacheTtl, 900, '40 min left, clamped to the ceiling');
      assert.equal(calls.length, 1, 'no origin hit needed — the answer was in the stale document');
    });
  } finally {
    mock.timers.reset();
  }
});

test('when the timetable is exhausted it refetches once past the edge cache', async () => {
  const now = at('2026-08-11T18:20:00+01:00');
  mock.timers.enable({ apis: ['Date'], now });
  try {
    const fresh = live();
    fresh.results[0].now = {
      broadcast_title: 'Sunlight w/ Kelly',
      start_timestamp: '2026-08-11T18:00:00+01:00',
      end_timestamp: '2026-08-11T19:00:00+01:00',
      embeds: { details: { name: 'Sunlight w/ Kelly' } },
    };
    await withNtsFetch((url) => (url.includes('?') ? fresh : live()), async (calls) => {
      const r = await fetchNTSMetadata(STREAM1, null, {});
      assert.equal(r.display, 'Sunlight w/ Kelly');
      assert.equal(calls.length, 2, 'edge attempt, then one busted refetch');
      // Bucketed to the minute so concurrent listeners share a single origin miss.
      assert.equal(calls[1], `https://www.nts.live/api/v2/live?_=${Math.floor(now / 60000)}`);
    });
  } finally {
    mock.timers.reset();
  }
});

test('gives up cleanly when even the fresh document has nothing on air', async () => {
  mock.timers.enable({ apis: ['Date'], now: at('2026-08-11T18:20:00+01:00') });
  try {
    await withNtsFetch(() => live(), async (calls) => {
      assert.equal(await fetchNTSMetadata(STREAM1, null, {}), null);
      assert.equal(calls.length, 2);
    });
  } finally {
    mock.timers.reset();
  }
});

test('/stream2 resolves against channel 2', async () => {
  mock.timers.enable({ apis: ['Date'], now: at('2026-08-11T14:30:00+01:00') });
  try {
    await withNtsFetch(() => live(), async () => {
      const r = await fetchNTSMetadata(STREAM2, null, {});
      assert.equal(r.display, 'Low Key');
      assert.equal(r.raw.channel, 'NTS 2');
    });
  } finally {
    mock.timers.reset();
  }
});

test('non-NTS urls are not claimed by the strategy', async () => {
  assert.equal(await fetchNTSMetadata('https://stream.bff.fm/1/mp3.mp3', null, {}), null);
});
