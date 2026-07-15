const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { extractOnAirFromHtml } = require('../lib/html-onair.js');

const html = (n) => readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');

// Generalises the bespoke WWOZ parser: a timetable/on-air block on the
// station's own homepage becomes a generic source, not a per-station rule.

test('WWOZ: on-air programme from the server-rendered header', () => {
  const r = extractOnAirFromHtml(html('wwoz-onair.html'), { stationName: 'WWOZ 90.7 New Orleans, LA' });
  assert.ok(r, 'extracted');
  assert.match(r.display, /New Orleans Music Show/);
  assert.equal(r.via, 'marker');
});

test('JSON-LD BroadcastEvent wins over markers', () => {
  const page = `<html><head><script type="application/ld+json">
    {"@type":"BroadcastEvent","name":"Midnight Jazz Hour"}
  </script></head><body><div class="now-playing">Something Else</div></body></html>`;
  const r = extractOnAirFromHtml(page, { stationName: 'X Radio' });
  assert.equal(r.display, 'Midnight Jazz Hour');
  assert.equal(r.via, 'jsonld');
});

test('marker: NOW PLAYING followed by text', () => {
  const page = `<html><body><p>NOW PLAYING: Aphex Twin - Xtal</p></body></html>`;
  const r = extractOnAirFromHtml(page, { stationName: 'X Radio' });
  assert.equal(r.display, 'Aphex Twin - Xtal');
});

test('marker: class-based now-playing element', () => {
  const page = `<html><body><div class="now-playing">Bonobo - Kerala</div></body></html>`;
  const r = extractOnAirFromHtml(page, { stationName: 'X Radio' });
  assert.equal(r.display, 'Bonobo - Kerala');
});

test('never takes the first plausible string — a page with no signal yields null', () => {
  const page = `<html><head><title>Some Radio</title></head><body>
    <h1>Welcome to Some Radio</h1><p>We play music all day.</p></body></html>`;
  assert.equal(extractOnAirFromHtml(page, { stationName: 'Some Radio' }), null);
});

test('station-echo is rejected even behind a valid marker', () => {
  const page = `<html><body><div class="now-playing">Kiosk Radio</div></body></html>`;
  assert.equal(extractOnAirFromHtml(page, { stationName: 'Kiosk Radio' }), null);
});

test('placeholders behind a marker are rejected', () => {
  const page = `<html><body><div class="now-playing">offline</div></body></html>`;
  assert.equal(extractOnAirFromHtml(page, { stationName: 'X Radio' }), null);
});

test('empty / garbage input never throws', () => {
  assert.equal(extractOnAirFromHtml('', { stationName: 'X' }), null);
  assert.equal(extractOnAirFromHtml(null, { stationName: 'X' }), null);
});

test('a class token must match wholly — "listen-on-air" is not "on-air"', () => {
  // Live on wwoz.org: a nav container carries `listen-on-air` and appears
  // BEFORE the real `on-air` element. \bon-air\b matches inside it (the hyphen
  // is a word boundary), so a loose pattern returns the whole menu.
  const page = `<html><body>
    <ul class="nav navbar-nav listen-on-air"><li>Listen</li><li>Schedule</li></ul>
    <p class="navbar-text on-air"><span>On Air:</span><span>Cole Williams Show</span></p>
  </body></html>`;
  const r = extractOnAirFromHtml(page, { stationName: 'WWOZ' });
  assert.equal(r.display, 'Cole Williams Show');
});

test('a captured container blob is rejected, not truncated', () => {
  // Live on reprezentradio.org.uk this produced:
  // "Training On air Off Air LIVE STREAM Reprezent Radio Live Latest MONDAY…"
  // Long output means we grabbed a container; showing it is worse than nothing.
  const blob = 'Training On air Off Air LIVE STREAM Reprezent Radio Live Latest MONDAY 12:00 Amirah Amour Amirah Amour 6th July 2026 Uk Rap R&B SUNDAY';
  const page = `<html><body><div class="on-air">${blob}</div></body></html>`;
  assert.equal(extractOnAirFromHtml(page, { stationName: 'Reprezent Radio' }), null);
});
