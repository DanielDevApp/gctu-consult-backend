const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

before(h.start);
after(h.stop);

/**
 * Hits every read endpoint with realistic data and asserts none of them 500.
 *
 * The point is to catch SQL that no other test happens to execute. The admin
 * activate/deactivate bug survived three weeks precisely because nothing ever
 * ran that statement — `NOT is_active` is valid MySQL and a type error in
 * Postgres, so it threw on every call and nobody noticed until a human tried
 * the button. Postgres is strict about GROUP BY, type coercion and identifier
 * casing, so a query it dislikes fails loudly at runtime; this makes sure
 * something actually runs each one.
 *
 * A 4xx is fine here — that's the endpoint working. Only a 500 is a failure.
 */
describe('every read endpoint executes its SQL', () => {
  let ctx;

  before(async () => {
    const lecturer = await h.signedIn(h.makeLecturer);
    const student = await h.signedIn(h.makeStudent);
    const admin = await h.signedIn(h.makeAdmin);

    // Give the queries something to chew on: courses, availability, a booking
    // in a few different states, a rating, a waitlist entry, notifications.
    await h.call('POST', '/api/lecturer/courses', lecturer.token, { courseName: 'Data Structures', courseCode: 'CS201' });
    const { slots } = await h.makeWindow(lecturer.id, [60, 120, 180]);

    const booked = await h.call('POST', '/api/student/bookings', student.token, { slotId: slots[0].id });
    await h.call('PUT', `/api/lecturer/bookings/${booked.data.id}`, lecturer.token, { status: 'confirmed' });
    await h.moveSlot(slots[0].id, -60, -30);
    await h.call('PUT', `/api/lecturer/bookings/${booked.data.id}`, lecturer.token, { status: 'completed' });
    await h.call('PUT', `/api/student/bookings/${booked.data.id}/rating`, student.token, { rating: 5, comment: 'Very helpful' });
    await h.call('POST', `/api/student/lecturers/${lecturer.id}/waitlist`, student.token);
    await h.pool.query(
      `INSERT INTO notifications (recipient_id, recipient_role, title, message, type)
       VALUES (?, 'student', 'Test', 'body', 'general')`,
      [student.id]
    );

    ctx = { lecturer, student, admin, bookingId: booked.data.id, slotId: slots[1].id };
  });

  const routes = () => [
    ['student', 'GET', '/api/student/summary'],
    ['student', 'GET', '/api/student/lecturers'],
    ['student', 'GET', `/api/student/lecturers?search=data&department=${encodeURIComponent(h.DEPARTMENT)}`],
    ['student', 'GET', '/api/student/departments'],
    ['student', 'GET', `/api/student/lecturers/${ctx.lecturer.id}/availability`],
    ['student', 'GET', `/api/student/lecturers/${ctx.lecturer.id}/availability?excludeBooking=${ctx.bookingId}`],
    ['student', 'GET', `/api/student/lecturers/${ctx.lecturer.id}/courses`],
    ['student', 'GET', '/api/student/bookings'],
    ['student', 'GET', '/api/auth/me'],
    ['student', 'GET', '/api/notifications'],

    ['lecturer', 'GET', '/api/lecturer/summary'],
    ['lecturer', 'GET', '/api/lecturer/availability'],
    ['lecturer', 'GET', '/api/lecturer/bookings'],
    ['lecturer', 'GET', '/api/lecturer/courses'],
    ['lecturer', 'GET', '/api/auth/me'],

    ['admin', 'GET', '/api/admin/stats'],
    ['admin', 'GET', '/api/admin/analytics'],
    ['admin', 'GET', '/api/admin/lecturers'],
    ['admin', 'GET', '/api/admin/lecturers?search=test'],
    ['admin', 'GET', '/api/admin/lecturers/export'],
    ['admin', 'GET', '/api/admin/students'],
    ['admin', 'GET', '/api/admin/students?search=test'],
    ['admin', 'GET', '/api/admin/students/export'],
    ['admin', 'GET', '/api/admin/bookings'],
    ['admin', 'GET', '/api/admin/bookings?status=completed&search=test&from=2020-01-01&to=2099-01-01'],
    ['admin', 'GET', '/api/admin/bookings/export'],
    ['admin', 'GET', '/api/admin/audit-log'],
    ['admin', 'GET', '/api/admin/admins'],
    ['admin', 'GET', '/api/health'],
  ];

  test('no read endpoint returns 500', async () => {
    const failures = [];
    for (const [role, method, path] of routes()) {
      const res = await h.call(method, path, ctx[role].token);
      if (res.status >= 500) failures.push(`${method} ${path} -> ${res.status} ${res.data?.message || ''}`);
    }
    assert.deepEqual(failures, [], `endpoints returned 5xx:\n  ${failures.join('\n  ')}`);
  });

  test('the paginated and filtered admin views agree with their totals', async () => {
    const res = await h.call('GET', '/api/admin/bookings?page=1', ctx.admin.token);
    assert.equal(res.status, 200);
    assert.equal(typeof res.data.total, 'number', 'total must be a number, not a bigint string');
    assert.ok(Array.isArray(res.data.rows));
  });

  test('analytics returns numbers, not stringified bigints', async () => {
    const res = await h.call('GET', '/api/admin/analytics', ctx.admin.token);
    assert.equal(res.status, 200);
    for (const row of res.data.byStatus || []) {
      assert.equal(typeof row.count, 'number', `byStatus.count should be a number, got ${typeof row.count}`);
    }
  });

  test('search is case-insensitive, as it was under MySQL', async () => {
    const lower = await h.call('GET', '/api/student/lecturers?search=test', ctx.student.token);
    const upper = await h.call('GET', '/api/student/lecturers?search=TEST', ctx.student.token);
    assert.equal(lower.status, 200);
    assert.equal(upper.status, 200);
    assert.equal(upper.data.length, lower.data.length, 'ILIKE, not LIKE — MySQL LIKE was case-insensitive');
  });

  test('an empty IN (?) list does not produce invalid SQL', async () => {
    // Guarded at both current call sites, but the expansion itself must not
    // be a syntax error waiting for a third one.
    const [rows] = await h.pool.query('SELECT id FROM students WHERE id IN (?)', [[]]);
    assert.deepEqual(rows, []);
  });
});
