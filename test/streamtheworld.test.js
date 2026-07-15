const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { deriveStreamTheWorldMount, parseTritonNowPlaying } = require('../strategies/index.js');

const fixture = (n) => readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');

// StreamTheWorld/Triton is the single biggest platform in the dataset (2,634
// stations of 52k). Its now-playing lives on np.tritondigital.com, keyed by the
// mount name in the stream path — derivable, so no per-station rule is needed.

test('derives the mount from the two dominant URL shapes', () => {
  // 1,643 stations
  assert.equal(
    deriveStreamTheWorldMount('https://playerservices.streamtheworld.com/api/livestream-redirect/XHFAJ_FMAAC.aac'),
    'XHFAJ_FMAAC',
  );
  // 976 stations
  assert.equal(
    deriveStreamTheWorldMount('https://18313.live.streamtheworld.com:443/XEJP_AMAAC.aac'),
    'XEJP_AMAAC',
  );
});

test('handles no extension, .mp3, regional and redirect hosts, double slash', () => {
  assert.equal(deriveStreamTheWorldMount('http://22963.live.streamtheworld.com/AFNP_TKO_SC'), 'AFNP_TKO_SC');
  assert.equal(deriveStreamTheWorldMount('https://playerservices.streamtheworld.com/api/livestream-redirect/KUOW.mp3'), 'KUOW');
  assert.equal(deriveStreamTheWorldMount('https://eu-playerservices.streamtheworld.com/api/livestream-redirect/X.aac'), 'X');
  assert.equal(deriveStreamTheWorldMount('https://player-redirect.streamtheworld.com/api/livestream-redirect/Y.aac'), 'Y');
  assert.equal(deriveStreamTheWorldMount('https://playerservices.streamtheworld.com/api/livestream-redirect//Z.aac'), 'Z');
});

test('null for anything that is not StreamTheWorld', () => {
  assert.equal(deriveStreamTheWorldMount('https://stream.bff.fm/1/mp3.mp3'), null);
  assert.equal(deriveStreamTheWorldMount('not a url'), null);
  assert.equal(deriveStreamTheWorldMount(''), null);
  assert.equal(deriveStreamTheWorldMount(null), null);
});

test('parses artist + title out of the Triton CDATA payload', () => {
  // Captured live from mount XEJP_AMAAC (El Fonógrafo).
  const r = parseTritonNowPlaying(fixture('triton-nowplaying.xml'));
  assert.ok(r, 'parsed');
  assert.equal(r.artist, 'Yuriria A Duo Reyli');
  assert.equal(r.title, 'Que Nos Paso');
  assert.equal(r.display, 'Yuriria A Duo Reyli - Que Nos Paso');
});

test('empty now-playing list yields null (talk/news mounts return this)', () => {
  assert.equal(parseTritonNowPlaying(fixture('triton-empty.xml')), null);
  assert.equal(parseTritonNowPlaying(''), null);
  assert.equal(parseTritonNowPlaying(null), null);
});

test('title without an artist still resolves', () => {
  const xml = '<nowplaying-info-list><nowplaying-info mountName="X" type="track">'
    + '<property name="cue_title"><![CDATA[Some Show]]></property></nowplaying-info></nowplaying-info-list>';
  assert.equal(parseTritonNowPlaying(xml).display, 'Some Show');
});

test('placeholder titles are rejected like everywhere else', () => {
  const xml = '<nowplaying-info-list><nowplaying-info mountName="X" type="track">'
    + '<property name="cue_title"><![CDATA[offline]]></property></nowplaying-info></nowplaying-info-list>';
  assert.equal(parseTritonNowPlaying(xml), null);
});
