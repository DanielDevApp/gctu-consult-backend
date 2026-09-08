const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { expirePastSlots, ATTENDANCE_GRACE_HOURS } = require('../src/utils/expireSlots');

before(h.start);
after(h.stop);

async function addNotification(userId, role, title = 'Test note') {
  const [r] = await h.pool.query(
    `INSERT INTO notifications (recipient_id, recipient_role, title, message, type)
     VALUES (?, ?, ?, 'body', 'general')`,
    [userId, role, title]
  );
  return r.insertId;
}

describe('notifications can be cleared', () => {
  test('a single notification can be deleted', async () => {
    const student = await h.signedIn(h.makeStudent);
    const id = await addNotification(student.id, 'student');

    assert.equal((await h.call('DELETE', `/api/notifications/${id}`, student.token)).status, 200);
    const list = await h.call('GET', '/api/notifications', student.token);
    assert.equal(list.data.length, 0);
  });

  test('clear-all removes every one and reports the count', async () => {
    const student = await h.signedIn(h.makeStudent);
    for (let i = 0; i < 4; i++) await addNotification(student.id, 'student', `Note ${i}`);

    const res = await h.call('DELETE', '/api/notifications', student.token);
    assert.equal(res.status, 200);
    assert.equal(res.data.cleared, 4);
    assert.equal((await h.call('GET', '/api/notifications', student.token)).data.length, 0);
  });

  test("one user cannot delete another user's notification", async () => {
    const student = await h.signedIn(h.makeStudent);
    const other = await h.signedIn(h.makeStudent);
    const id = await addNotification(other.id, 'student');

    assert.equal((await h.call('DELETE', `/api/notifications/${id}`, student.token)).status, 404);
    const [[row]] = [(await h.pool.query('SELECT id FROM notifications WHERE id = ?', [id]))[0]];
    assert.ok(row, 'the other user\'s notification must survive');
  });

  test("clear-all is scoped to the caller", async () => {
    const student = await h.signedIn(h.makeStudent);
    const other = await h.signedIn(h.makeStudent);
    await addNotification(student.id, 'student');
    await addNotification(other.id, 'student');

    await h.call('DELETE', '/api/notifications', student.token);
    assert.equal((await h.call('GET', '/api/notifications', other.token)).data.length, 1);
  });
});

describe('booking history can be cleared in bulk', () => {
  /** A student with one booking in each finished state, plus two live ones. */
  async function withMixedHistory() {
    const lecturer = await h.signedIn(h.makeLecturer);
    const student = await h.signedIn(h.makeStudent);
    const finished = ['completed', 'cancelled', 'declined', 'expired', 'no_show'];

    for (const status of finished) {
      const { slots } = await h.makeWindow(lecturer.id, [-600], { status: 'booked' });
      await h.pool.query(
        'INSERT INTO bookings (slot_id, student_id, lecturer_id, status) VALUES (?, ?, ?, ?)',
        [slots[0].id, student.id, lecturer.id, status]
      );
    }
    for (const status of ['pending', 'confirmed']) {
      const { slots } = await h.makeWindow(lecturer.id, [600], { status: 'booked' });
      await h.pool.query(
        'INSERT INTO bookings (slot_id, student_id, lecturer_id, status) VALUES (?, ?, ?, ?)',
        [slots[0].id, student.id, lecturer.id, status]
      );
    }
    return { lecturer, student, finishedCount: finished.length };
  }

  test('clears the finished ones and keeps the live ones', async () => {
    const { student, finishedCount } = await withMixedHistory();
    assert.equal((await h.call('GET', '/api/student/bookings', student.token)).data.length, finishedCount + 2);

    const res = await h.call('DELETE', '/api/student/bookings', student.token);
    assert.equal(res.status, 200);
    assert.equal(res.data.cleared, finishedCount);
    assert.equal(res.data.kept, 2);
    assert.match(res.data.message, /2 active bookings kept/i);

    const left = (await h.call('GET', '/api/student/bookings', student.token)).data;
    assert.equal(left.length, 2);
    assert.ok(left.every((b) => ['pending', 'confirmed'].includes(b.status)));
  });

  test('clearing is per-viewer — the lecturer keeps their own copy', async () => {
    const { lecturer, student, finishedCount } = await withMixedHistory();
    await h.call('DELETE', '/api/student/bookings', student.token);

    const lecturerSees = (await h.call('GET', '/api/lecturer/bookings', lecturer.token)).data;
    assert.equal(lecturerSees.length, finishedCount + 2, 'the lecturer must still see everything');
  });

  test('rows survive until every party has cleared them', async () => {
    const { lecturer, student } = await withMixedHistory();
    const admin = await h.signedIn(h.makeAdmin);

    await h.call('DELETE', '/api/student/bookings', student.token);
    const [[mid]] = [(await h.pool.query('SELECT COUNT(*) AS n FROM bookings WHERE student_id = ?', [student.id]))[0]];
    assert.equal(mid.n, 7, 'nothing is really deleted while others can still see it');

    await h.call('DELETE', '/api/lecturer/bookings', lecturer.token);
    await h.call('DELETE', '/api/admin/bookings', admin.token);

    const [[after]] = [(await h.pool.query('SELECT COUNT(*) AS n FROM bookings WHERE student_id = ?', [student.id]))[0]];
    assert.equal(after.n, 2, 'only the two live bookings should remain');
  });

  test('clearing an empty history says so rather than pretending', async () => {
    const student = await h.signedIn(h.makeStudent);
    const res = await h.call('DELETE', '/api/student/bookings', student.token);
    assert.equal(res.data.cleared, 0);
    assert.match(res.data.message, /already empty/i);
  });
});

describe('unmarked consultations close themselves out', () => {
  async function confirmedEndedHoursAgo(hours) {
    const lecturer = await h.makeLecturer();
    const student = await h.makeStudent();
    const minutes = -hours * 60;
    const { slots } = await h.makeWindow(lecturer.id, [minutes - 30], { status: 'booked' });
    await h.moveSlot(slots[0].id, minutes - 30, minutes);
    const [r] = await h.pool.query(
      "INSERT INTO bookings (slot_id, student_id, lecturer_id, status) VALUES (?, ?, ?, 'confirmed')",
      [slots[0].id, student.id, lecturer.id]
    );
    return { bookingId: r.insertId, slotId: slots[0].id, lecturer, student };
  }

  test('one still inside the grace period stays markable', async () => {
    const { bookingId } = await confirmedEndedHoursAgo(1);
    await expirePastSlots();
    assert.equal((await h.bookingStatus(bookingId)).status, 'confirmed');
  });

  test('one past the grace period is closed and flagged', async () => {
    const { bookingId, slotId } = await confirmedEndedHoursAgo(ATTENDANCE_GRACE_HOURS + 2);
    await expirePastSlots();

    const booking = await h.bookingStatus(bookingId);
    assert.equal(booking.status, 'expired');
    assert.equal(booking.attendance_missed, 1, 'must be distinguishable from a never-answered request');

    const [[slot]] = [(await h.pool.query('SELECT status FROM availability_slots WHERE id = ?', [slotId]))[0]];
    assert.equal(slot.status, 'completed');
  });

  test('a repeat sweep does not notify twice', async () => {
    const { bookingId, student } = await confirmedEndedHoursAgo(ATTENDANCE_GRACE_HOURS + 2);
    await expirePastSlots();
    await expirePastSlots();

    const [rows] = await h.pool.query(
      "SELECT id FROM notifications WHERE recipient_id = ? AND recipient_role = 'student' AND type = 'booking_expired'",
      [student.id]
    );
    assert.equal(rows.length, 1);
    assert.equal((await h.bookingStatus(bookingId)).status, 'expired');
  });
});
