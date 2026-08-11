const { test } = require('node:test');
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

// --- slot selection (pure, fixed timestamps) ---

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

// --- ttl (pure, fixed timestamps) ---

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
//
// These drive the real clock (node 18's mock timers cannot fake Date), so the
// documents are built relative to now and the assertions carry a few seconds
// of tolerance.

const MIN = 60_000;
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

function slot(title, startMinFromNow, endMinFromNow) {
  return {
    broadcast_title: title,
    start_timestamp: iso(startMinFromNow * MIN),
    end_timestamp: iso(endMinFromNow * MIN),
    embeds: { details: { name: title } },
  };
}

// `slots` are [title, startMinFromNow, endMinFromNow] triples, `now` first.
function doc(channel1Slots, channel2Slots = [['Low Key', -30, 30]]) {
  const build = (name, list) => {
    const ch = { channel_name: name, now: slot(...list[0]) };
    list.slice(1).forEach((s, i) => { ch[i === 0 ? 'next' : `next${i + 1}`] = slot(...s); });
    return ch;
  };
  return { results: [build('1', channel1Slots), build('2', channel2Slots)] };
}

function withNtsFetch(handler, run) {
  const calls = [];
  _setNtsFetchForTests(async (url) => {
    calls.push(url);
    return handler(url, calls.length);
  });
  return Promise.resolve(run(calls)).finally(() => _setNtsFetchForTests(null));
}

const near = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ~${expected}, got ${actual}`);

test('on-air show costs exactly one edge request, no cache-buster', async () => {
  const edge = doc([['Tropic of Love w/ Mafalda', -30, 40], ['Self Soothe w/ Margeaux', 40, 100]]);
  await withNtsFetch(() => edge, async (calls) => {
    const r = await fetchNTSMetadata(STREAM1, null, {});
    assert.equal(r.display, 'Tropic of Love w/ Mafalda');
    assert.equal(r.source, 'nts');
    assert.equal(r.cacheTtl, 900, '40 min left, clamped to the ceiling');
    assert.deepEqual(calls, ['https://www.nts.live/api/v2/live']);
  });
});

test('cacheTtl tracks the changeover once the show is nearly over', async () => {
  const edge = doc([['Tropic of Love w/ Mafalda', -110, 4], ['Self Soothe w/ Margeaux', 4, 64]]);
  await withNtsFetch(() => edge, async () => {
    const r = await fetchNTSMetadata(STREAM1, null, {});
    near(r.cacheTtl, 240, 2, 'four minutes of show left');
  });
});

test('a stale edge document is served from its own timetable, still one request', async () => {
  // The edge is 20 minutes behind: `now` ended, `next` is the show on air.
  const edge = doc([['Tropic of Love w/ Mafalda', -90, -20], ['Self Soothe w/ Margeaux', -20, 40]]);
  await withNtsFetch(() => edge, async (calls) => {
    const r = await fetchNTSMetadata(STREAM1, null, {});
    assert.equal(r.display, 'Self Soothe w/ Margeaux');
    assert.equal(calls.length, 1, 'no origin hit needed — the answer was in the stale document');
  });
});

test('when the timetable is exhausted it refetches once past the edge cache', async () => {
  const stale = doc([['Long Gone', -180, -120], ['Also Gone', -120, -60]]);
  const fresh = doc([['Sunlight w/ Kelly', -10, 50]]);
  await withNtsFetch((url) => (url.includes('?') ? fresh : stale), async (calls) => {
    const r = await fetchNTSMetadata(STREAM1, null, {});
    assert.equal(r.display, 'Sunlight w/ Kelly');
    assert.equal(calls.length, 2, 'edge attempt, then one busted refetch');
    const bucket = Number(/\?_=(\d+)$/.exec(calls[1])?.[1]);
    // Bucketed to the minute so concurrent listeners share a single origin miss.
    near(bucket, Math.floor(Date.now() / MIN), 1, 'minute bucket');
  });
});

test('gives up cleanly when even the fresh document has nothing on air', async () => {
  const exhausted = doc([['Long Gone', -180, -120], ['Also Gone', -120, -60]]);
  await withNtsFetch(() => exhausted, async (calls) => {
    assert.equal(await fetchNTSMetadata(STREAM1, null, {}), null);
    assert.equal(calls.length, 2);
  });
});

test('/stream2 resolves against channel 2', async () => {
  const edge = doc([['Tropic of Love w/ Mafalda', -30, 40]], [['Sofay & Ribeka', -30, 4]]);
  await withNtsFetch(() => edge, async () => {
    const r = await fetchNTSMetadata(STREAM2, null, {});
    assert.equal(r.display, 'Sofay & Ribeka');
    assert.equal(r.raw.channel, 'NTS 2');
    near(r.cacheTtl, 240, 2, 'ttl comes from channel 2, not channel 1');
  });
});

test('non-NTS urls are not claimed by the strategy', async () => {
  assert.equal(await fetchNTSMetadata('https://stream.bff.fm/1/mp3.mp3', null, {}), null);
});
