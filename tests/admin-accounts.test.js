const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Accounts made through the API aren't tracked by the helpers, so they share
// an email pattern that cleanup can find.
const EMAIL_LIKE = 'test.admincreated.%@example.test';

before(h.start);
after(async () => {
  for (const [table, role] of [['students', 'student'], ['lecturers', 'lecturer']]) {
    await h.pool.query(
      `DELETE FROM notifications WHERE recipient_role = ? AND recipient_id IN (SELECT id FROM ${table} WHERE email LIKE ?)`,
      [role, EMAIL_LIKE]
    );
    await h.pool.query(`DELETE FROM ${table} WHERE email LIKE ?`, [EMAIL_LIKE]);
  }
  await h.stop();
});

let seq = 0;
const uid = () => `${Date.now()}${seq++}`;
const TEMP = 'TempPass#2026';

function studentBody(overrides = {}) {
  const u = uid();
  return {
    firstName: 'Ama', lastName: 'Owusu', studentId: u.slice(-10), level: '200', programme: h.PROGRAMME,
    email: `test.admincreated.s${u}@example.test`, password: TEMP, ...overrides,
  };
}

function lecturerBody(overrides = {}) {
  const u = uid();
  return {
    title: 'Dr.', firstName: 'Kofi', lastName: `Mensah${u.slice(-6)}`, staffId: `ST${u.slice(-8)}`,
    department: h.DEPARTMENT, email: `test.admincreated.l${u}@example.test`, password: TEMP, ...overrides,
  };
}

const loginAs = (role, identifier, password) =>
  h.call('POST', '/api/auth/login', null, { role, identifier, password });

describe('admin creates a student', () => {
  test('the student can sign in straight away, with no email verification step', async () => {
    const admin = await h.signedIn(h.makeAdmin);
    const body = studentBody();

    const created = await h.call('POST', '/api/admin/students', admin.token, body);
    assert.equal(created.status, 201, created.data?.message);
    assert.deepEqual(created.data.login, {
      role: 'student', identifier: body.studentId, email: body.email, mustChangePassword: true,
    });
    assert.equal(created.data.password, undefined, 'the password must never be echoed back');

    const byId = await loginAs('student', body.studentId, TEMP);
    assert.equal(byId.status, 200, byId.data?.message);
    assert.equal(byId.data.user.must_change_password, 1);
    assert.equal(byId.data.user.password_hash, undefined);

    assert.equal((await loginAs('student', body.email, TEMP)).status, 200, 'email works as the login too');
  });

  test('until they choose their own password, only the password change is allowed', async () => {
    const admin = await h.signedIn(h.makeAdmin);
    const body = studentBody();
    await h.call('POST', '/api/admin/students', admin.token, body);
    const { token } = (await loginAs('student', body.studentId, TEMP)).data;

    const blocked = await h.call('GET', '/api/student/summary', token);
    assert.equal(blocked.status, 403, 'the rule is enforced by the API, not just the UI');
    assert.equal(blocked.data.code, 'PASSWORD_CHANGE_REQUIRED');

    const me = await h.call('GET', '/api/auth/me', token);
    assert.equal(me.status, 200);
    assert.equal(me.data.user.must_change_password, 1, '/me must expose the flag so the app can show the screen');
  });

  test('choosing a new password lifts the restriction and retires the temporary one', async () => {
    const admin = await h.signedIn(h.makeAdmin);
    const body = studentBody();
    await h.call('POST', '/api/admin/students', admin.token, body);
    const { token } = (await loginAs('student', body.studentId, TEMP)).data;

    const changed = await h.call('PUT', '/api/profile/password', token, {
      currentPassword: TEMP, newPassword: 'MyOwnPass!77', confirmPassword: 'MyOwnPass!77',
    });
    assert.equal(changed.status, 200, changed.data?.message);

    assert.equal((await h.call('GET', '/api/student/summary', token)).status, 200);
    assert.equal((await h.call('GET', '/api/auth/me', token)).data.user.must_change_password, 0);
    assert.equal((await loginAs('student', body.studentId, TEMP)).status, 401, 'the temporary password stops working');
    assert.equal((await loginAs('student', body.studentId, 'MyOwnPass!77')).status, 200);
  });

  test('the temporary password cannot simply be re-used as the new one', async () => {
    const admin = await h.signedIn(h.makeAdmin);
    const body = studentBody();
    await h.call('POST', '/api/admin/students', admin.token, body);
    const { token } = (await loginAs('student', body.studentId, TEMP)).data;

    const reused = await h.call('PUT', '/api/profile/password', token, { currentPassword: TEMP, newPassword: TEMP });
    assert.equal(reused.status, 400);
    assert.equal((await h.call('GET', '/api/student/summary', token)).status, 403, 'still restricted');
  });

  test('a wrong current password is a 400, not a 401 that would sign them out', async () => {
    const admin = await h.signedIn(h.makeAdmin);
    const body = studentBody();
    await h.call('POST', '/api/admin/students', admin.token, body);
    const { token } = (await loginAs('student', body.studentId, TEMP)).data;

    const wrong = await h.call('PUT', '/api/profile/password', token, { currentPassword: 'not-it', newPassword: 'Whatever!88' });
    assert.equal(wrong.status, 400);
  });

  test('the admin can choose not to force a change', async () => {
    const admin = await h.signedIn(h.makeAdmin);
    const body = studentBody({ requirePasswordChange: false });
    const created = await h.call('POST', '/api/admin/students', admin.token, body);
    assert.equal(created.data.login.mustChangePassword, false);

    const { token } = (await loginAs('student', body.studentId, TEMP)).data;
    assert.equal((await h.call('GET', '/api/student/summary', token)).status, 200);
  });

  test('registration rules apply here too', async () => {
    const admin = await h.signedIn(h.makeAdmin);
    for (const [label, overrides, pattern] of [
      ['a non-numeric index number', { studentId: 'ABC123' }, /numbers only/i],
      ['an 11-digit index number', { studentId: '12345678901' }, /numbers only/i],
      ['an unknown programme', { programme: 'BSc. Made Up Studies' }, /valid programme/i],
      ['a bad email', { email: 'not-an-email' }, /valid GCTU email/i],
      ['a short password', { password: '123' }, /at least 6/i],
      ['a missing first name', { firstName: '' }, /first name is required/i],
    ]) {
      const res = await h.call('POST', '/api/admin/students', admin.token, studentBody(overrides));
      assert.equal(res.status, 400, `${label} should be refused`);
      assert.match(res.data.message, pattern, label);
    }
  });

  test('duplicates are refused, naming which field clashes', async () => {
    const admin = await h.signedIn(h.makeAdmin);
    const first = studentBody();
    await h.call('POST', '/api/admin/students', admin.token, first);

    const sameId = await h.call('POST', '/api/admin/students', admin.token, studentBody({ studentId: first.studentId }));
    assert.equal(sameId.status, 409);
    assert.match(sameId.data.message, /student ID/);

    const sameEmail = await h.call('POST', '/api/admin/students', admin.token, studentBody({ email: first.email }));
    assert.equal(sameEmail.status, 409);
    assert.match(sameEmail.data.message, /email/);
  });

  test('only admins can create accounts', async () => {
    const student = await h.signedIn(h.makeStudent);
    assert.equal((await h.call('POST', '/api/admin/students', student.token, studentBody())).status, 403);
    assert.equal((await h.call('POST', '/api/admin/students', null, studentBody())).status, 401);
  });

  test('is recorded in the audit log', async () => {
    const admin = await h.signedIn(h.makeAdmin);
    const created = await h.call('POST', '/api/admin/students', admin.token, studentBody());
    const [rows] = await h.pool.query(
      `SELECT action FROM admin_audit_log WHERE target_type = 'student' AND target_id = ?`,
      [created.data.id]
    );
    assert.equal(rows[0]?.action, 'create_student');
  });

  test('shows up in the admin list flagged as still on a temporary password', async () => {
    const admin = await h.signedIn(h.makeAdmin);
    const body = studentBody();
    const created = await h.call('POST', '/api/admin/students', admin.token, body);
    const list = await h.call('GET', `/api/admin/students?search=${body.studentId}`, admin.token);
    const row = list.data.rows.find((r) => r.id === created.data.id);
    assert.ok(row, 'the new student should be listed');
    assert.equal(row.must_change_password, 1);
  });
});

describe('admin creates a lecturer', () => {
  test('can sign in straight away and is already visible to students', async () => {
    const admin = await h.signedIn(h.makeAdmin);
    const student = await h.signedIn(h.makeStudent);
    const body = lecturerBody();

    const created = await h.call('POST', '/api/admin/lecturers', admin.token, body);
    assert.equal(created.status, 201, created.data?.message);
    assert.equal(created.data.login.identifier, body.staffId);

    const login = await loginAs('lecturer', body.staffId, TEMP);
    assert.equal(login.status, 200, login.data?.message);
    assert.equal(login.data.user.is_verified, 1, 'an admin-created lecturer needs no separate approval');
    assert.equal(login.data.user.must_change_password, 1);

    const found = await h.call('GET', `/api/student/lecturers?search=${encodeURIComponent(body.lastName)}`, student.token);
    assert.ok(found.data.some((l) => l.id === created.data.id), 'students can find the new lecturer');
  });

  test('staff ID and department are validated', async () => {
    const admin = await h.signedIn(h.makeAdmin);
    const noStaffId = await h.call('POST', '/api/admin/lecturers', admin.token, lecturerBody({ staffId: '' }));
    assert.equal(noStaffId.status, 400);
    const badDept = await h.call('POST', '/api/admin/lecturers', admin.token, lecturerBody({ department: 'Department of Nothing' }));
    assert.equal(badDept.status, 400);
    assert.match(badDept.data.message, /valid department/i);
  });

  test('a clashing staff ID is refused by name', async () => {
    const admin = await h.signedIn(h.makeAdmin);
    const first = lecturerBody();
    await h.call('POST', '/api/admin/lecturers', admin.token, first);
    const clash = await h.call('POST', '/api/admin/lecturers', admin.token, lecturerBody({ staffId: first.staffId }));
    assert.equal(clash.status, 409);
    assert.match(clash.data.message, /staff ID/);
  });
});

describe('admin sets a new password for an existing account', () => {
  test('the new password works, the old one stops, and the owner is told', async () => {
    const admin = await h.signedIn(h.makeAdmin);
    const student = await h.makeStudent();

    const res = await h.call('PUT', `/api/admin/students/${student.id}/password`, admin.token, { password: 'Reset#Pass2026' });
    assert.equal(res.status, 200, res.data?.message);
    assert.equal(res.data.mustChangePassword, true);

    assert.equal((await loginAs('student', student.email, h.PASSWORD)).status, 401, 'old password retired');
    const fresh = await loginAs('student', student.email, 'Reset#Pass2026');
    assert.equal(fresh.status, 200);
    assert.equal(fresh.data.user.must_change_password, 1);

    const [notes] = await h.pool.query(
      `SELECT title FROM notifications WHERE recipient_role = 'student' AND recipient_id = ?`,
      [student.id]
    );
    assert.ok(notes.some((n) => n.title === 'Password changed by an administrator'), 'this must never happen silently');
  });

  test('a session that was already signed in is confined to choosing a new password', async () => {
    const admin = await h.signedIn(h.makeAdmin);
    const student = await h.signedIn(h.makeStudent);
    assert.equal((await h.call('GET', '/api/student/summary', student.token)).status, 200);

    await h.call('PUT', `/api/admin/students/${student.id}/password`, admin.token, { password: 'Reset#Pass2026' });

    const after = await h.call('GET', '/api/student/summary', student.token);
    assert.equal(after.status, 403);
    assert.equal(after.data.code, 'PASSWORD_CHANGE_REQUIRED');
    // And it can't finish the change with the password it used to know.
    const withOld = await h.call('PUT', '/api/profile/password', student.token, {
      currentPassword: h.PASSWORD, newPassword: 'Hijack!Attempt9',
    });
    assert.equal(withOld.status, 400);
  });

  test('works for lecturers and is audit-logged', async () => {
    const admin = await h.signedIn(h.makeAdmin);
    const lecturer = await h.makeLecturer();
    const res = await h.call('PUT', `/api/admin/lecturers/${lecturer.id}/password`, admin.token, {
      password: 'Reset#Pass2026', requirePasswordChange: false,
    });
    assert.equal(res.status, 200, res.data?.message);
    assert.equal(res.data.mustChangePassword, false);

    const [rows] = await h.pool.query(
      `SELECT action FROM admin_audit_log WHERE target_type = 'lecturer' AND target_id = ? ORDER BY id DESC LIMIT 1`,
      [lecturer.id]
    );
    assert.equal(rows[0]?.action, 'set_lecturer_password');
  });

  test('refuses a short password, an unknown account, and non-admins', async () => {
    const admin = await h.signedIn(h.makeAdmin);
    const student = await h.signedIn(h.makeStudent);

    assert.equal((await h.call('PUT', `/api/admin/students/${student.id}/password`, admin.token, { password: '12' })).status, 400);
    assert.equal((await h.call('PUT', '/api/admin/students/999999999/password', admin.token, { password: 'Reset#Pass2026' })).status, 404);
    assert.equal((await h.call('PUT', `/api/admin/students/${student.id}/password`, student.token, { password: 'Reset#Pass2026' })).status, 403);
  });
});
