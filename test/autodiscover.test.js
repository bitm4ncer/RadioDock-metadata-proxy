const test = require('node:test');
const assert = require('node:assert/strict');
const { discoverEndpoints } = require('../lib/homepage-probe.js');

test('finds now-playing-ish API paths in markup and scripts', () => {
  const html = `<script>fetch("/api/v2/onair-now").then(r=>r.json())</script>
                <a href="/api/schedule">x</a>
                <script>const u='/wp-json/radio/v1/current';</script>`;
  const found = discoverEndpoints(html, 'https://s.example');
  assert.ok(found.includes('https://s.example/api/v2/onair-now'), 'onair path');
  assert.ok(found.includes('https://s.example/wp-json/radio/v1/current'), 'wp-json current');
  assert.ok(!found.includes('https://s.example/api/schedule'), 'schedule alone is not a now-playing signal');
  assert.ok(found.length <= 5, 'capped');
});

test('finds the real Chunt FM path', () => {
  // Chunt FM's homepage really does ship this — it is exactly the case a
  // hand-written rule would otherwise be needed for.
  const html = `<div id="app" data-now_playing="1"></div>
                <script>const r = await fetch("/fm/channels/1/now-playing");</script>`;
  const found = discoverEndpoints(html, 'https://chunt.org');
  assert.ok(found.includes('https://chunt.org/fm/channels/1/now-playing'), found.join(','));
});

test('currentColor must never be mistaken for an endpoint', () => {
  // Found live on reprezentradio.org.uk: a naive /current/ match hits every
  // inline SVG on the page and floods the candidate list with junk.
  const html = `<svg><path fill="currentColor" stroke="currentColor"/></svg>
                <svg><circle fill="currentColor"/></svg>`;
  assert.deepEqual(discoverEndpoints(html, 'https://s.example'), []);
});

test('ignores absolute third-party URLs — only the station\'s own origin', () => {
  const html = `<script>fetch("https://evil.example/api/now-playing")</script>`;
  const found = discoverEndpoints(html, 'https://s.example');
  assert.ok(!found.some((u) => u.includes('evil.example')), found.join(','));
});

test('ignores asset paths that merely contain a keyword', () => {
  const html = `<img src="/img/onair-badge.png"><link href="/css/now-playing.css">
                <script src="/js/current.js"></script>`;
  assert.deepEqual(discoverEndpoints(html, 'https://s.example'), []);
});

test('dedupes and survives empty input', () => {
  const html = `<script>fetch("/api/now-playing");fetch("/api/now-playing");</script>`;
  assert.deepEqual(discoverEndpoints(html, 'https://s.example'), ['https://s.example/api/now-playing']);
  assert.deepEqual(discoverEndpoints('', 'https://s.example'), []);
  assert.deepEqual(discoverEndpoints(null, 'https://s.example'), []);
});
