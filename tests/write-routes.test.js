const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

before(h.start);
after(h.stop);

const pad = (n) => String(n).padStart(2, '0');
const inDays = (n) => {
  const d = new Date(Date.now() + n * 86400000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

describe('publishing availability', () => {
  // The rest of the suite seeds slots straight into the database, so without
  // this the route that actually creates them — and assigns the window ids the
  // booking rule depends on — would never run.
  test('a time range is split into slots that share one window', async () => {
    const lecturer = await h.signedIn(h.makeLecturer);
    const res = await h.call('POST', '/api/lecturer/availability', lecturer.token, {
      slotDate: inDays(3), startTime: '09:00', endTime: '11:00',
      slotDurationMinutes: 30, mode: 'online', meetingLink: 'https://meet.example.test/x',
    });
    assert.equal(res.status, 201, res.data?.message);
    assert.equal(res.data.slotsGenerated, 4);

    const [rows] = await h.pool.query(
      'SELECT window_id, start_time FROM availability_slots WHERE lecturer_id = ? ORDER BY start_time',
      [lecturer.id]
    );
    assert.equal(rows.length, 4);
    assert.equal(new Set(rows.map((r) => r.window_id)).size, 1, 'one publish for one day is one window');
    assert.ok(rows.every((r) => r.window_id != null));
  });

  test('a weekly repeat makes a separate window per week', async () => {
    const lecturer = await h.signedIn(h.makeLecturer);
    const res = await h.call('POST', '/api/lecturer/availability', lecturer.token, {
      slotDate: inDays(4), startTime: '09:00', endTime: '10:00',
      slotDurationMinutes: 30, mode: 'in_person', venue: 'Block C', repeatWeeks: 3,
    });
    assert.equal(res.status, 201, res.data?.message);
    assert.equal(res.data.slotsGenerated, 6);

    const [rows] = await h.pool.query('SELECT window_id FROM availability_slots WHERE lecturer_id = ?', [lecturer.id]);
    assert.equal(new Set(rows.map((r) => r.window_id)).size, 3, 'each week is its own window, so students can book again');
  });

  test('overlapping availability is refused', async () => {
    const lecturer = await h.signedIn(h.makeLecturer);
    const body = {
      slotDate: inDays(5), startTime: '09:00', endTime: '11:00',
      slotDurationMinutes: 30, mode: 'online', meetingLink: 'https://meet.example.test/x',
    };
    assert.equal((await h.call('POST', '/api/lecturer/availability', lecturer.token, body)).status, 201);
    const clash = await h.call('POST', '/api/lecturer/availability', lecturer.token, {
      ...body, startTime: '10:00', endTime: '12:00',
    });
    assert.equal(clash.status, 409);
  });

  test('invalid ranges are rejected, not silently accepted', async () => {
    const lecturer = await h.signedIn(h.makeLecturer);
    const base = { slotDate: inDays(6), mode: 'online', meetingLink: 'https://meet.example.test/x' };

    // End before start — this is also what stops a slot crossing midnight,
    // which the single slot_date column could not represent.
    const backwards = await h.call('POST', '/api/lecturer/availability', lecturer.token, {
      ...base, startTime: '11:00', endTime: '09:00', slotDurationMinutes: 30,
    });
    assert.equal(backwards.status, 400);

    const tooLong = await h.call('POST', '/api/lecturer/availability', lecturer.token, {
      ...base, startTime: '09:00', endTime: '09:20', slotDurationMinutes: 60,
    });
    assert.equal(tooLong.status, 400);

    const midnight = await h.call('POST', '/api/lecturer/availability', lecturer.token, {
      ...base, startTime: '23:00', endTime: '01:00', slotDurationMinutes: 30,
    });
    assert.equal(midnight.status, 400, 'a window crossing midnight must be refused');
  });

  test('an unbooked slot can be removed, a booked one cannot', async () => {
    const lecturer = await h.signedIn(h.makeLecturer);
    const student = await h.signedIn(h.makeStudent);
    const { slots } = await h.makeWindow(lecturer.id, [60, 120]);

    assert.equal((await h.call('DELETE', `/api/lecturer/availability/${slots[0].id}`, lecturer.token)).status, 200);

    await h.call('POST', '/api/student/bookings', student.token, { slotId: slots[1].id });
    const blocked = await h.call('DELETE', `/api/lecturer/availability/${slots[1].id}`, lecturer.token);
    assert.equal(blocked.status, 400);
  });
});

describe('courses', () => {
  test('can be added, listed and removed', async () => {
    const lecturer = await h.signedIn(h.makeLecturer);
    const added = await h.call('POST', '/api/lecturer/courses', lecturer.token, {
      courseName: 'Operating Systems', courseCode: 'CS301',
    });
    assert.equal(added.status, 201, added.data?.message);

    const listed = await h.call('GET', '/api/lecturer/courses', lecturer.token);
    assert.equal(listed.data.length, 1);

    assert.equal((await h.call('DELETE', `/api/lecturer/courses/${added.data.id}`, lecturer.token)).status, 200);
    assert.equal((await h.call('GET', '/api/lecturer/courses', lecturer.token)).data.length, 0);
  });

  test("one lecturer cannot delete another's course", async () => {
    const owner = await h.signedIn(h.makeLecturer);
    const other = await h.signedIn(h.makeLecturer);
    const added = await h.call('POST', '/api/lecturer/courses', owner.token, { courseName: 'Networks' });

    assert.equal((await h.call('DELETE', `/api/lecturer/courses/${added.data.id}`, other.token)).status, 404);
    assert.equal((await h.call('GET', '/api/lecturer/courses', owner.token)).data.length, 1);
  });
});

describe('notifications read state', () => {
  test('one and all can be marked read', async () => {
    const student = await h.signedIn(h.makeStudent);
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const [r] = await h.pool.query(
        `INSERT INTO notifications (recipient_id, recipient_role, title, message, type)
         VALUES (?, 'student', ?, 'body', 'general')`,
        [student.id, `Note ${i}`]
      );
      ids.push(r.insertId);
    }

    assert.equal((await h.call('PUT', `/api/notifications/${ids[0]}/read`, student.token)).status, 200);
    let list = await h.call('GET', '/api/notifications', student.token);
    assert.equal(list.data.filter((n) => n.is_read === 1).length, 1);

    assert.equal((await h.call('PUT', '/api/notifications/read-all', student.token)).status, 200);
    list = await h.call('GET', '/api/notifications', student.token);
    assert.ok(list.data.every((n) => n.is_read === 1));
  });
});

describe('admin account management', () => {
  test('a lecturer can be verified', async () => {
    const admin = await h.signedIn(h.makeAdmin);
    const lecturer = await h.makeLecturer();
    await h.pool.query('UPDATE lecturers SET is_verified = 0 WHERE id = ?', [lecturer.id]);

    assert.equal((await h.call('PUT', `/api/admin/lecturers/${lecturer.id}/verify`, admin.token)).status, 200);
    const [[row]] = [(await h.pool.query('SELECT is_verified FROM lecturers WHERE id = ?', [lecturer.id]))[0]];
    assert.equal(row.is_verified, 1);
  });

  test('deleting a user with live bookings needs an explicit confirmation', async () => {
    const admin = await h.signedIn(h.makeAdmin);
    const lecturer = await h.signedIn(h.makeLecturer);
    const student = await h.signedIn(h.makeStudent);
    const { slots } = await h.makeWindow(lecturer.id, [60]);
    await h.call('POST', '/api/student/bookings', student.token, { slotId: slots[0].id });

    const guarded = await h.call('DELETE', `/api/admin/students/${student.id}`, admin.token);
    assert.equal(guarded.status, 409, 'an active booking should stop a silent cascade delete');
    assert.equal(typeof guarded.data.activeBookings, 'number');

    const forced = await h.call('DELETE', `/api/admin/students/${student.id}?force=true`, admin.token);
    assert.equal(forced.status, 200, forced.data?.message);
    const [[gone]] = [(await h.pool.query('SELECT id FROM students WHERE id = ?', [student.id]))[0]];
    assert.equal(gone, undefined);
  });

  test('admins can be added and removed', async () => {
    const admin = await h.signedIn(h.makeAdmin);
    const email = `test.admin.new.${Date.now()}@example.test`;

    const added = await h.call('POST', '/api/admin/admins', admin.token, {
      name: 'Second Admin', email, password: 'Passw0rd!test',
    });
    assert.equal(added.status, 201, added.data?.message);

    const [[row]] = [(await h.pool.query('SELECT id FROM admins WHERE email = ?', [email]))[0]];
    assert.ok(row, 'the admin row should exist');

    assert.equal((await h.call('DELETE', `/api/admin/admins/${row.id}`, admin.token)).status, 200);
  });
});

describe('profile editing', () => {
  test('a student can update their own details', async () => {
    const student = await h.signedIn(h.makeStudent);
    const res = await h.call('PUT', '/api/profile', student.token, {
      firstName: 'Updated', lastName: 'Name', level: '400', programme: h.PROGRAMME,
    });
    assert.equal(res.status, 200, res.data?.message);

    const me = await h.call('GET', '/api/auth/me', student.token);
    assert.equal(me.data.user.first_name, 'Updated');
  });

  test('a lecturer can update theirs', async () => {
    const lecturer = await h.signedIn(h.makeLecturer);
    const res = await h.call('PUT', '/api/profile', lecturer.token, {
      firstName: 'Updated', lastName: 'Lecturer', department: h.DEPARTMENT,
      title: 'Dr.', office: 'Block C', bio: 'Teaches systems.',
    });
    assert.equal(res.status, 200, res.data?.message);

    const me = await h.call('GET', '/api/auth/me', lecturer.token);
    assert.equal(me.data.user.office, 'Block C');
  });
});
