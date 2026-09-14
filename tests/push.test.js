const { test, before, after, afterEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const push = require('../src/utils/push');
const { notify } = require('../src/utils/notify');

before(h.start);
after(h.stop);
afterEach(() => push.setPushSender(null));

let seq = 0;
/** A subscription shaped like a real Chrome one. Nothing is sent to it: the
 *  test-mode transport records the push instead. */
const fakeSubscription = () => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/test-${Date.now()}-${seq++}`,
  keys: {
    p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
    auth: 'tBHItJI5svbpez7KI4CCXg',
  },
});

/** notify() sends push without awaiting it, so poll briefly for the delivery. */
async function pushesTo(endpoint, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hits = push.sentPushes.filter((p) => p.endpoint === endpoint);
    if (hits.length) return hits;
    await new Promise((r) => setTimeout(r, 25));
  }
  return [];
}

async function subscriptionRows(endpoint) {
  const [rows] = await h.pool.query('SELECT user_id, user_role FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
  return rows;
}

describe('push configuration', () => {
  test('the public key is served without signing in', async () => {
    const res = await h.call('GET', '/api/push/public-key');
    assert.equal(res.status, 200);
    assert.equal(res.data.publicKey, process.env.VAPID_PUBLIC_KEY);
  });

  test('with no keys configured, push reports itself as off rather than failing', async () => {
    const saved = { pub: process.env.VAPID_PUBLIC_KEY, priv: process.env.VAPID_PRIVATE_KEY };
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    try {
      const res = await h.call('GET', '/api/push/public-key');
      assert.equal(res.status, 503);
      assert.equal(res.data.code, 'PUSH_NOT_CONFIGURED');
      assert.deepEqual(await push.sendPushToUser(1, 'student', { title: 'x' }), { sent: 0, removed: 0 });
    } finally {
      process.env.VAPID_PUBLIC_KEY = saved.pub;
      process.env.VAPID_PRIVATE_KEY = saved.priv;
    }
  });
});

describe('subscribing a device', () => {
  test('requires signing in', async () => {
    const res = await h.call('POST', '/api/push/subscribe', null, { subscription: fakeSubscription() });
    assert.equal(res.status, 401);
  });

  test('endpoints outside the real push services are refused (SSRF guard)', async () => {
    const student = await h.signedIn(h.makeStudent);
    for (const endpoint of [
      'http://169.254.169.254/latest/meta-data',
      'https://evil.example.com/steal',
      'http://fcm.googleapis.com/fcm/send/plain-http',
      'https://fcm.googleapis.com.evil.example.com/lookalike',
    ]) {
      const res = await h.call('POST', '/api/push/subscribe', student.token, {
        subscription: { ...fakeSubscription(), endpoint },
      });
      assert.equal(res.status, 400, `${endpoint} should be refused`);
      assert.equal((await subscriptionRows(endpoint)).length, 0);
    }
  });

  test('the real push services are accepted', () => {
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
      'https://web.push.apple.com/abc',
    ]) {
      assert.ok(push.isAllowedPushEndpoint(endpoint), endpoint);
    }
  });

  test('the same device moving to another account follows the person signed in', async () => {
    const first = await h.signedIn(h.makeStudent);
    const second = await h.signedIn(h.makeStudent);
    const sub = fakeSubscription();

    await h.call('POST', '/api/push/subscribe', first.token, { subscription: sub });
    await h.call('POST', '/api/push/subscribe', second.token, { subscription: sub });

    const rows = await subscriptionRows(sub.endpoint);
    assert.equal(rows.length, 1, 'one row per device, never a duplicate');
    assert.equal(rows[0].user_id, second.id);

    // The first account must no longer reach that device.
    await notify(first.id, 'student', 'For the first account', 'body');
    assert.equal((await pushesTo(sub.endpoint, 300)).length, 0);
  });

  test("turning it off is scoped to your own devices", async () => {
    const owner = await h.signedIn(h.makeStudent);
    const other = await h.signedIn(h.makeStudent);
    const sub = fakeSubscription();
    await h.call('POST', '/api/push/subscribe', owner.token, { subscription: sub });

    const stranger = await h.call('DELETE', '/api/push/subscribe', other.token, { endpoint: sub.endpoint });
    assert.equal(stranger.status, 404);
    assert.equal((await subscriptionRows(sub.endpoint)).length, 1);

    const mine = await h.call('DELETE', '/api/push/subscribe', owner.token, { endpoint: sub.endpoint });
    assert.equal(mine.status, 200);
    assert.equal((await subscriptionRows(sub.endpoint)).length, 0);
  });
});

describe('notifications reach subscribed devices', () => {
  test('a booking update is pushed to the student, pointing at their bookings', async () => {
    const lecturer = await h.signedIn(h.makeLecturer);
    const student = await h.signedIn(h.makeStudent);
    const studentDevice = fakeSubscription();
    const lecturerDevice = fakeSubscription();
    await h.call('POST', '/api/push/subscribe', student.token, { subscription: studentDevice });
    await h.call('POST', '/api/push/subscribe', lecturer.token, { subscription: lecturerDevice });

    const { slots } = await h.makeWindow(lecturer.id, [120]);
    const booked = await h.call('POST', '/api/student/bookings', student.token, { slotId: slots[0].id });

    // Booking notifies the lecturer — and only the lecturer.
    const toLecturer = await pushesTo(lecturerDevice.endpoint);
    assert.equal(toLecturer.length, 1);
    assert.equal(toLecturer[0].payload.title, 'New booking request');
    assert.equal(toLecturer[0].payload.url, '/lecturer/dashboard?tab=bookings');

    await h.call('PUT', `/api/lecturer/bookings/${booked.data.id}`, lecturer.token, { status: 'confirmed' });

    const toStudent = await pushesTo(studentDevice.endpoint);
    assert.equal(toStudent.length, 1, 'the student must not have received the lecturer\'s alert');
    const { payload } = toStudent[0];
    assert.equal(payload.title, 'Booking update');
    assert.match(payload.body, /confirmed/i);
    assert.equal(payload.url, '/student/dashboard?tab=bookings');
    assert.match(payload.tag, /^notification-\d+$/);
  });

  test('every device on the account gets it', async () => {
    const student = await h.signedIn(h.makeStudent);
    const phone = fakeSubscription();
    const laptop = fakeSubscription();
    await h.call('POST', '/api/push/subscribe', student.token, { subscription: phone });
    await h.call('POST', '/api/push/subscribe', student.token, { subscription: laptop });

    await notify(student.id, 'student', 'Two devices', 'body');
    assert.equal((await pushesTo(phone.endpoint)).length, 1);
    assert.equal((await pushesTo(laptop.endpoint)).length, 1);
  });

  test('a subscription the browser has discarded (410 Gone) is deleted', async () => {
    const student = await h.signedIn(h.makeStudent);
    const sub = fakeSubscription();
    await h.call('POST', '/api/push/subscribe', student.token, { subscription: sub });

    push.setPushSender(() => Promise.reject(Object.assign(new Error('Gone'), { statusCode: 410 })));
    const result = await push.sendPushToUser(student.id, 'student', { title: 'x' });

    assert.deepEqual(result, { sent: 0, removed: 1 });
    assert.equal((await subscriptionRows(sub.endpoint)).length, 0);
  });

  test('a temporary push-service failure keeps the subscription', async () => {
    const student = await h.signedIn(h.makeStudent);
    const sub = fakeSubscription();
    await h.call('POST', '/api/push/subscribe', student.token, { subscription: sub });

    push.setPushSender(() => Promise.reject(Object.assign(new Error('Unavailable'), { statusCode: 503 })));
    const result = await push.sendPushToUser(student.id, 'student', { title: 'x' });

    assert.deepEqual(result, { sent: 0, removed: 0 });
    assert.equal((await subscriptionRows(sub.endpoint)).length, 1);
  });

  test('a push failure never breaks the action that caused it', async () => {
    const lecturer = await h.signedIn(h.makeLecturer);
    const student = await h.signedIn(h.makeStudent);
    await h.call('POST', '/api/push/subscribe', lecturer.token, { subscription: fakeSubscription() });

    push.setPushSender(() => { throw new Error('push service exploded'); });
    const { slots } = await h.makeWindow(lecturer.id, [120]);
    const booked = await h.call('POST', '/api/student/bookings', student.token, { slotId: slots[0].id });
    assert.equal(booked.status, 201, booked.data?.message);
  });
});

describe('test notification', () => {
  test('is sent to the caller\'s devices', async () => {
    const lecturer = await h.signedIn(h.makeLecturer);
    const sub = fakeSubscription();
    await h.call('POST', '/api/push/subscribe', lecturer.token, { subscription: sub });

    const res = await h.call('POST', '/api/push/test', lecturer.token);
    assert.equal(res.status, 200, res.data?.message);
    assert.equal(res.data.sent, 1);
    assert.equal((await pushesTo(sub.endpoint))[0].payload.type, 'push_test');
  });

  test('says so when there is no device to send to', async () => {
    const admin = await h.signedIn(h.makeAdmin);
    const res = await h.call('POST', '/api/push/test', admin.token);
    assert.equal(res.status, 409);
  });
});

describe('account deletion', () => {
  test("clears the deleted user's devices", async () => {
    const admin = await h.signedIn(h.makeAdmin);
    const student = await h.signedIn(h.makeStudent);
    const sub = fakeSubscription();
    await h.call('POST', '/api/push/subscribe', student.token, { subscription: sub });

    const res = await h.call('DELETE', `/api/admin/students/${student.id}`, admin.token);
    assert.equal(res.status, 200, res.data?.message);
    assert.equal((await subscriptionRows(sub.endpoint)).length, 0);
  });
});
