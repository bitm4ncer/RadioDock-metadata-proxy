const test = require('node:test');
const assert = require('node:assert/strict');
const { parseByKind, parseTheLotSchedule, HTML_KINDS } = require('../strategies/station-map.js');

const SCHEDULE = [
  {
    id: 'restream',
    summary: 'RESTREAM',
    start: '2026-11-09T00:00:00-05:00',
    end: '2026-11-09T10:00:00-05:00',
    reccuring: true,
  },
  {
    id: 'bottom',
    summary: 'Bottom Of The Deck with Druggy Paul',
    start: '2026-11-09T10:00:00-05:00',
    end: '2026-11-09T11:00:00-05:00',
    reccuring: true,
  },
  {
    id: 'past',
    summary: 'Yesterday',
    start: '2026-11-08T10:00:00-05:00',
    end: '2026-11-08T11:00:00-05:00',
    reccuring: false,
  },
];

function page(entries) {
  const payload = `{"schedule":${JSON.stringify(entries)}}`;
  return `<html><body><script>self.__next_f.push([1,${JSON.stringify(payload)}])</script></body></html>`;
}

test('The Lot: the schedule entry containing now is the current programme', () => {
  const html = page(SCHEDULE);
  const r = parseTheLotSchedule(html, Date.parse('2026-11-09T14:30:00Z'));
  assert.equal(r && r.display, 'RESTREAM');
});

test('The Lot: switches to the next programme at the slot boundary', () => {
  const html = page(SCHEDULE);
  const r = parseTheLotSchedule(html, Date.parse('2026-11-09T15:00:00Z'));
  assert.equal(r && r.display, 'Bottom Of The Deck with Druggy Paul');
});

test('The Lot: null outside every scheduled slot', () => {
  assert.equal(parseTheLotSchedule(page(SCHEDULE), Date.parse('2026-11-09T22:00:00Z')), null);
});

test('The Lot: null for missing or malformed RSC payloads', () => {
  assert.equal(parseTheLotSchedule('<html><body>maintenance</body></html>'), null);
  assert.equal(parseTheLotSchedule(page([]), Date.now()), null);
  assert.equal(parseTheLotSchedule(page([{ summary: 'x', start: 'bad', end: 'bad' }]), Date.now()), null);
});

test('thelotradio is registered as an HTML kind (fetched as text, not JSON)', () => {
  assert.ok(HTML_KINDS.has('thelotradio'));
  assert.equal(parseByKind('thelotradio', '<html></html>'), null);
});
