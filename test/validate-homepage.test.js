const test = require('node:test');
const assert = require('node:assert/strict');
const { validateMetadataRequest } = require('../server.js');

// `homepage` is client-supplied. It was display-only, so it carried no URL
// safety checks. The generic coverage engine FETCHES it, which makes it an
// SSRF vector unless it is validated exactly like `url`.
const base = { url: 'https://stream.example/live' };

test('homepage: private/loopback rejected', () => {
  assert.equal(validateMetadataRequest({ ...base, homepage: 'http://127.0.0.1/' }).valid, false);
  assert.equal(validateMetadataRequest({ ...base, homepage: 'http://localhost/' }).valid, false);
  assert.equal(validateMetadataRequest({ ...base, homepage: 'http://169.254.169.254/' }).valid, false);
  assert.equal(validateMetadataRequest({ ...base, homepage: 'http://10.0.0.5/' }).valid, false);
  assert.equal(validateMetadataRequest({ ...base, homepage: 'http://192.168.1.1/' }).valid, false);
});

test('homepage: non-http scheme rejected', () => {
  assert.equal(validateMetadataRequest({ ...base, homepage: 'file:///etc/passwd' }).valid, false);
  assert.equal(validateMetadataRequest({ ...base, homepage: 'gopher://evil.example/' }).valid, false);
});

test('homepage: malformed rejected', () => {
  assert.equal(validateMetadataRequest({ ...base, homepage: 'not a url' }).valid, false);
});

test('homepage: public https accepted; absent accepted', () => {
  assert.equal(validateMetadataRequest({ ...base, homepage: 'https://kioskradio.com/' }).valid, true);
  assert.equal(validateMetadataRequest({ ...base }).valid, true);
});

test('existing url validation still holds', () => {
  assert.equal(validateMetadataRequest({ url: 'http://127.0.0.1/s' }).valid, false);
  assert.equal(validateMetadataRequest({}).valid, false);
  assert.equal(validateMetadataRequest({ url: 'https://stream.example/live' }).valid, true);
});
