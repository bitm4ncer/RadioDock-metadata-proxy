const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const {
  isHostnameLiteralPrivate,
  isPrivateAddress,
  readBoundedBody,
} = require('../lib/safe-fetch.js');

test('isPrivateAddress: IPv4 private ranges', () => {
  for (const addr of ['127.0.0.1', '10.0.0.1', '192.168.1.5', '172.16.0.1', '172.31.255.255', '169.254.169.254', '0.0.0.0']) {
    assert.equal(isPrivateAddress(addr), true, `${addr} should be private`);
  }
});

test('isPrivateAddress: IPv4 public ranges', () => {
  for (const addr of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '93.184.216.34']) {
    assert.equal(isPrivateAddress(addr), false, `${addr} should be public`);
  }
});

test('isPrivateAddress: IPv6 loopback and link-local', () => {
  for (const addr of ['::1', 'fe80::1', 'fc00::1', 'fd12:3456:789a::1']) {
    assert.equal(isPrivateAddress(addr), true, `${addr} should be private`);
  }
});

test('isPrivateAddress: IPv6 public', () => {
  for (const addr of ['2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPrivateAddress(addr), false, `${addr} should be public`);
  }
});

test('isPrivateAddress: IPv4-mapped IPv6 private', () => {
  assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateAddress('::ffff:10.0.0.1'), true);
});

test('isPrivateAddress: bogus / unknown forms refused', () => {
  assert.equal(isPrivateAddress(''), true);
  assert.equal(isPrivateAddress(null), true);
  assert.equal(isPrivateAddress('not-an-ip'), true);
});

test('isHostnameLiteralPrivate: localhost variants', () => {
  for (const h of ['localhost', 'LOCALHOST', 'foo.localhost', 'ip6-localhost', 'ip6-loopback']) {
    assert.equal(isHostnameLiteralPrivate(h), true, `${h} should be flagged`);
  }
});

test('isHostnameLiteralPrivate: literal private IPs', () => {
  assert.equal(isHostnameLiteralPrivate('127.0.0.1'), true);
  assert.equal(isHostnameLiteralPrivate('10.0.0.5'), true);
  assert.equal(isHostnameLiteralPrivate('169.254.169.254'), true);
});

test('isHostnameLiteralPrivate: real domain names pass through', () => {
  assert.equal(isHostnameLiteralPrivate('stream.rinse.fm'), false);
  assert.equal(isHostnameLiteralPrivate('ice1.somafm.com'), false);
  assert.equal(isHostnameLiteralPrivate('public.radio.co'), false);
});

test('readBoundedBody: returns full body under the limit', async () => {
  const body = Readable.from([Buffer.from('hello '), Buffer.from('world')]);
  const out = await readBoundedBody(body, 1024);
  assert.equal(out.toString(), 'hello world');
});

test('readBoundedBody: throws BODY_TOO_LARGE past the limit', async () => {
  const body = Readable.from([Buffer.alloc(2048, 0x61)]);
  await assert.rejects(
    () => readBoundedBody(body, 1024),
    (err) => err.code === 'BODY_TOO_LARGE'
  );
});

test('readBoundedBody: empty body is allowed', async () => {
  const body = Readable.from([]);
  const out = await readBoundedBody(body, 1024);
  assert.equal(out.length, 0);
});
