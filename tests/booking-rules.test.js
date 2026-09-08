const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

before(h.start);
after(h.stop);

describe('one booking per availability window', () => {
  test('a second slot in the same window is refused', async () => {
    const lecturer = await h.signedIn(h.makeLecturer);
    const student = await h.signedIn(h.makeStudent);
    const { slots } = await h.makeWindow(lecturer.id, [60, 120]);

    const first = await h.call('POST', '/api/student/bookings', student.token, { slotId: slots[0].id });
    assert.equal(first.status, 201, first.data?.message);

    const second = await h.call('POST', '/api/student/bookings', student.token, { slotId: slots[1].id });
    assert.equal(second.status, 409);
    assert.match(second.data.message, /consultation window/i);
  });

  test('a different window is still bookable', async () => {
    const lecturer = await h.signedIn(h.makeLecturer);
    const student = await h.signedIn(h.makeStudent);
    const a = await h.makeWindow(lecturer.id, [60]);
    const b = await h.makeWindow(lecturer.id, [300]);

    assert.equal((await h.call('POST', '/api/student/bookings', student.token, { slotId: a.slots[0].id })).status, 201);
    assert.equal((await h.call('POST', '/api/student/bookings', student.token, { slotId: b.slots[0].id })).status, 201);
  });

  test('another student can still take the remaining slot', async () => {
    const lecturer = await h.signedIn(h.makeLecturer);
    const one = await h.signedIn(h.makeStudent);
    const two = await h.signedIn(h.makeStudent);
    const { slots } = await h.makeWindow(lecturer.id, [60, 120]);

    assert.equal((await h.call('POST', '/api/student/bookings', one.token, { slotId: slots[0].id })).status, 201);
    assert.equal((await h.call('POST', '/api/student/bookings', two.token, { slotId: slots[1].id })).status, 201);
  });

  test('cancelling frees the window to book again', async () => {
    const lecturer = await h.signedIn(h.makeLecturer);
    const student = await h.signedIn(h.makeStudent);
    const { slots } = await h.makeWindow(lecturer.id, [60, 120]);

    const booked = await h.call('POST', '/api/student/bookings', student.token, { slotId: slots[0].id });
    await h.call('PUT', `/api/student/bookings/${booked.data.id}/cancel`, student.token);

    const again = await h.call('POST', '/api/student/bookings', student.token, { slotId: slots[1].id });
    assert.equal(again.status, 201, again.data?.message);
  });

  test('a completed consultation still uses up the window', async () => {
    const lecturer = await h.signedIn(h.makeLecturer);
    const student = await h.signedIn(h.makeStudent);
    const { slots } = await h.makeWindow(lecturer.id, [60, 120]);

    const booked = await h.call('POST', '/api/student/bookings', student.token, { slotId: slots[0].id });
    await h.call('PUT', `/api/lecturer/bookings/${booked.data.id}`, lecturer.token, { status: 'confirmed' });
    await h.moveSlot(slots[0].id, -60, -30);
    assert.equal((await h.call('PUT', `/api/lecturer/bookings/${booked.data.id}`, lecturer.token, { status: 'completed' })).status, 200);

    const again = await h.call('POST', '/api/student/bookings', student.token, { slotId: slots[1].id });
    assert.equal(again.status, 409);
  });

  test('two simultaneous bookings on one window: exactly one wins', async () => {
    const lecturer = await h.signedIn(h.makeLecturer);
    const student = await h.signedIn(h.makeStudent);
    const { slots } = await h.makeWindow(lecturer.id, [60, 120]);

    const [a, b] = await Promise.all([
      h.call('POST', '/api/student/bookings', student.token, { slotId: slots[0].id }),
      h.call('POST', '/api/student/bookings', student.token, { slotId: slots[1].id }),
    ]);
    const created = [a, b].filter((r) => r.status === 201).length;
    assert.equal(created, 1, `expected 1 success, got ${a.status}/${b.status}`);
  });

  test('reschedule cannot smuggle a second booking into a used window', async () => {
    const lecturer = await h.signedIn(h.makeLecturer);
    const student = await h.signedIn(h.makeStudent);
    const a = await h.makeWindow(lecturer.id, [60, 120]);
    const b = await h.makeWindow(lecturer.id, [300]);

    const inA = await h.call('POST', '/api/student/bookings', student.token, { slotId: a.slots[0].id });
    const inB = await h.call('POST', '/api/student/bookings', student.token, { slotId: b.slots[0].id });

    // Moving B's booking into A — where this student already has one — is refused.
    const blocked = await h.call('PUT', `/api/student/bookings/${inB.data.id}/reschedule`, student.token, { newSlotId: a.slots[1].id });
    assert.equal(blocked.status, 409);

    // Moving within its own window is fine: same booking, new time.
    const allowed = await h.call('PUT', `/api/student/bookings/${inA.data.id}/reschedule`, student.token, { newSlotId: a.slots[1].id });
    assert.equal(allowed.status, 200, allowed.data?.message);
  });
});

describe('attendance can only be recorded after the slot ends', () => {
  async function confirmedBooking() {
    const lecturer = await h.signedIn(h.makeLecturer);
    const student = await h.signedIn(h.makeStudent);
    const { slots } = await h.makeWindow(lecturer.id, [60]);
    const booked = await h.call('POST', '/api/student/bookings', student.token, { slotId: slots[0].id });
    await h.call('PUT', `/api/lecturer/bookings/${booked.data.id}`, lecturer.token, { status: 'confirmed' });
    return { lecturer, student, slot: slots[0], bookingId: booked.data.id };
  }

  test('refused before the consultation starts', async () => {
    const { lecturer, bookingId } = await confirmedBooking();
    for (const status of ['completed', 'no_show']) {
      const res = await h.call('PUT', `/api/lecturer/bookings/${bookingId}`, lecturer.token, { status });
      assert.equal(res.status, 409, `${status} should be refused`);
      assert.match(res.data.message, /once it has ended/i);
    }
  });

  test('refused while the consultation is in session', async () => {
    const { lecturer, slot, bookingId } = await confirmedBooking();
    await h.moveSlot(slot.id, -5, 10);
    const res = await h.call('PUT', `/api/lecturer/bookings/${bookingId}`, lecturer.token, { status: 'completed' });
    assert.equal(res.status, 409);
  });

  test('allowed once it has ended', async () => {
    const { lecturer, slot, bookingId } = await confirmedBooking();
    await h.moveSlot(slot.id, -60, -30);
    const res = await h.call('PUT', `/api/lecturer/bookings/${bookingId}`, lecturer.token, { status: 'completed' });
    assert.equal(res.status, 200, res.data?.message);
    assert.equal((await h.bookingStatus(bookingId)).status, 'completed');
  });

  test('a lecturer cannot cancel after it has ended — they record attendance instead', async () => {
    const { lecturer, slot, bookingId } = await confirmedBooking();
    await h.moveSlot(slot.id, -60, -30);
    const res = await h.call('PUT', `/api/lecturer/bookings/${bookingId}/cancel`, lecturer.token, { reason: 'too late' });
    assert.equal(res.status, 409);
  });

  test('a lecturer CAN still cancel mid-session for an emergency', async () => {
    const { lecturer, slot, bookingId } = await confirmedBooking();
    await h.moveSlot(slot.id, -5, 10);
    const res = await h.call('PUT', `/api/lecturer/bookings/${bookingId}/cancel`, lecturer.token, { reason: 'emergency' });
    assert.equal(res.status, 200, res.data?.message);
  });
});

describe('a student cannot walk out of a session that has started', () => {
  async function startedBooking() {
    const lecturer = await h.signedIn(h.makeLecturer);
    const student = await h.signedIn(h.makeStudent);
    const { slots } = await h.makeWindow(lecturer.id, [60]);
    const booked = await h.call('POST', '/api/student/bookings', student.token, { slotId: slots[0].id });
    await h.call('PUT', `/api/lecturer/bookings/${booked.data.id}`, lecturer.token, { status: 'confirmed' });
    await h.moveSlot(slots[0].id, -5, 10);
    return { lecturer, student, slots, bookingId: booked.data.id };
  }

  test('cancelling is refused once it has started', async () => {
    const { student, bookingId } = await startedBooking();
    const res = await h.call('PUT', `/api/student/bookings/${bookingId}/cancel`, student.token);
    assert.equal(res.status, 409);
    assert.match(res.data.message, /already started/i);
  });

  test('rescheduling away is refused once it has started', async () => {
    const { student, lecturer, bookingId } = await startedBooking();
    const other = await h.makeWindow(lecturer.id, [600]);
    const res = await h.call('PUT', `/api/student/bookings/${bookingId}/reschedule`, student.token, { newSlotId: other.slots[0].id });
    assert.equal(res.status, 409);
  });

  test('cancelling before it starts is still fine', async () => {
    const lecturer = await h.signedIn(h.makeLecturer);
    const student = await h.signedIn(h.makeStudent);
    const { slots } = await h.makeWindow(lecturer.id, [120]);
    const booked = await h.call('POST', '/api/student/bookings', student.token, { slotId: slots[0].id });
    const res = await h.call('PUT', `/api/student/bookings/${booked.data.id}/cancel`, student.token);
    assert.equal(res.status, 200, res.data?.message);
  });
});

describe('live bookings cannot be deleted by anyone', () => {
  test('pending and confirmed are protected from all three roles', async () => {
    const lecturer = await h.signedIn(h.makeLecturer);
    const student = await h.signedIn(h.makeStudent);
    const admin = await h.signedIn(h.makeAdmin);
    const { slots } = await h.makeWindow(lecturer.id, [60]);
    const booked = await h.call('POST', '/api/student/bookings', student.token, { slotId: slots[0].id });
    const id = booked.data.id;

    for (const [role, token, path] of [
      ['student', student.token, `/api/student/bookings/${id}`],
      ['lecturer', lecturer.token, `/api/lecturer/bookings/${id}`],
      ['admin', admin.token, `/api/admin/bookings/${id}`],
    ]) {
      const res = await h.call('DELETE', path, token);
      assert.equal(res.status, 409, `${role} should not delete a pending booking`);
    }

    await h.call('PUT', `/api/lecturer/bookings/${id}`, lecturer.token, { status: 'confirmed' });
    assert.equal((await h.call('DELETE', `/api/student/bookings/${id}`, student.token)).status, 409);
  });

  test('a finished booking can be removed', async () => {
    const lecturer = await h.signedIn(h.makeLecturer);
    const student = await h.signedIn(h.makeStudent);
    const { slots } = await h.makeWindow(lecturer.id, [60]);
    const booked = await h.call('POST', '/api/student/bookings', student.token, { slotId: slots[0].id });
    await h.call('PUT', `/api/student/bookings/${booked.data.id}/cancel`, student.token);

    const res = await h.call('DELETE', `/api/student/bookings/${booked.data.id}`, student.token);
    assert.equal(res.status, 200, res.data?.message);
  });
});
