const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { userOrIpKey, ipKey, loginKey } = require('../src/middleware/rateLimitKeys');
const { isAllowedOrigin, allowedOrigins, primaryClientUrl } = require('../src/config/clientUrls');

before(h.start);
after(h.stop);

describe('a live session is re-checked against the database', () => {
  test('deactivating an account kills its existing token immediately', async () => {
    const student = await h.signedIn(h.makeStudent);

    // The token works right up until the account is switched off.
    assert.equal((await h.call('GET', '/api/student/summary', student.token)).status, 200);

    await h.pool.query('UPDATE students SET is_active = 0 WHERE id = ?', [student.id]);

    const res = await h.call('GET', '/api/student/summary', student.token);
    assert.equal(res.status, 403, 'a deactivated user must not keep working until their JWT expires');
    assert.equal(res.data.code, 'ACCOUNT_DEACTIVATED');
  });

  test('deleting an account kills its existing token', async () => {
    const lecturer = await h.signedIn(h.makeLecturer);
    assert.equal((await h.call('GET', '/api/lecturer/summary', lecturer.token)).status, 200);

    await h.pool.query('DELETE FROM lecturers WHERE id = ?', [lecturer.id]);

    const res = await h.call('GET', '/api/lecturer/summary', lecturer.token);
    assert.equal(res.status, 401);
  });

  test('un-verifying an email blocks the session', async () => {
    const student = await h.signedIn(h.makeStudent);
    await h.pool.query('UPDATE students SET email_verified = 0 WHERE id = ?', [student.id]);

    const res = await h.call('GET', '/api/student/summary', student.token);
    assert.equal(res.status, 403);
    assert.equal(res.data.code, 'EMAIL_NOT_VERIFIED');
  });

  test('admins are unaffected (they have no is_active column)', async () => {
    const admin = await h.signedIn(h.makeAdmin);
    assert.equal((await h.call('GET', '/api/admin/stats', admin.token)).status, 200);
  });

  test('a garbage token is still rejected', async () => {
    assert.equal((await h.call('GET', '/api/student/summary', 'not-a-real-token')).status, 401);
    assert.equal((await h.call('GET', '/api/student/summary')).status, 401);
  });

  test('a student token cannot reach lecturer routes', async () => {
    const student = await h.signedIn(h.makeStudent);
    assert.equal((await h.call('GET', '/api/lecturer/summary', student.token)).status, 403);
  });
});

describe('rate-limit bucketing', () => {
  const req = (over = {}) => ({ headers: {}, socket: {}, body: {}, ip: '1.2.3.4', ...over });

  test('authenticated requests bucket per account, not per IP', async () => {
    const a = await h.signedIn(h.makeStudent);
    const b = await h.signedIn(h.makeStudent);

    // Same IP, different accounts -> different buckets. This is the whole
    // point: a campus shares one public address.
    const keyA = userOrIpKey(req({ headers: { authorization: `Bearer ${a.token}` } }));
    const keyB = userOrIpKey(req({ headers: { authorization: `Bearer ${b.token}` } }));
    assert.notEqual(keyA, keyB);
    assert.match(keyA, /^user:student:/);
  });

  test('signed-out requests fall back to IP', () => {
    assert.equal(userOrIpKey(req()), 'ip:1.2.3.4');
  });

  test('an invalid token falls back to IP rather than escaping the limiter', () => {
    const key = userOrIpKey(req({ headers: { authorization: 'Bearer garbage' } }));
    assert.equal(key, 'ip:1.2.3.4');
  });

  test('IPv6 is bucketed by /64, so one subscriber cannot rotate addresses', () => {
    const one = ipKey(req({ ip: '2001:db8:1:2:aaaa:bbbb:cccc:dddd' }));
    const two = ipKey(req({ ip: '2001:db8:1:2:1111:2222:3333:4444' }));
    assert.equal(one, two);
  });

  test('login attempts bucket per account, so one target cannot lock out a campus', () => {
    const mine = loginKey(req({ body: { identifier: 'me@example.test' } }));
    const theirs = loginKey(req({ body: { identifier: 'someone.else@example.test' } }));
    assert.notEqual(mine, theirs);
  });

  test('the identifier is case-insensitive, so casing cannot multiply buckets', () => {
    assert.equal(
      loginKey(req({ body: { identifier: 'Me@Example.Test' } })),
      loginKey(req({ body: { identifier: 'me@example.test' } }))
    );
  });
});

describe('allowed frontend origins', () => {
  test('every configured origin is accepted', () => {
    for (const origin of allowedOrigins) assert.ok(isAllowedOrigin(origin), origin);
  });

  test('an unlisted origin is refused', () => {
    assert.equal(isAllowedOrigin('https://not-your-site.example.com'), false);
  });

  test('email links use a single URL, never the whole list', () => {
    assert.ok(!primaryClientUrl.includes(','));
    assert.equal(primaryClientUrl, allowedOrigins[0]);
  });

  test('CORS headers are returned for a listed origin only', async () => {
    const good = await h.call('OPTIONS', '/api/auth/login', null, undefined, {
      Origin: allowedOrigins[0],
      'Access-Control-Request-Method': 'POST',
    });
    assert.equal(good.headers.get('access-control-allow-origin'), allowedOrigins[0]);

    const bad = await h.call('OPTIONS', '/api/auth/login', null, undefined, {
      Origin: 'https://not-your-site.example.com',
      'Access-Control-Request-Method': 'POST',
    });
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
  });
});

describe('health endpoint', () => {
  test('reports database and schema state', async () => {
    const res = await h.call('GET', '/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.data.database, 'ok');
    assert.equal(res.data.schema.ready, true);
    assert.equal(res.data.status, 'ok');
  });
});
