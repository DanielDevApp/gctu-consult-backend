const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

before(h.start);
after(h.stop);

async function isActive(table, id) {
  const [[row]] = [(await h.pool.query(`SELECT is_active FROM ${table} WHERE id = ?`, [id]))[0]];
  return row.is_active;
}

describe('admin can activate and deactivate accounts', () => {
  // Regression: these routes used `SET is_active = NOT is_active`, which is
  // valid on a MySQL TINYINT but a type error on a Postgres SMALLINT
  // ("argument of NOT must be type boolean"). Every toggle 500'd with "Could
  // not update ... status." from the Postgres migration until it was caught.
  for (const [role, table, factory] of [
    ['student', 'students', h.makeStudent],
    ['lecturer', 'lecturers', h.makeLecturer],
  ]) {
    test(`a ${role} can be deactivated and reactivated`, async () => {
      const admin = await h.signedIn(h.makeAdmin);
      const user = await factory();
      assert.equal(await isActive(table, user.id), 1);

      const off = await h.call('PUT', `/api/admin/${table}/${user.id}/toggle-active`, admin.token);
      assert.equal(off.status, 200, off.data?.message);
      assert.equal(off.data.isActive, 0);
      assert.equal(await isActive(table, user.id), 0, 'must actually be deactivated in the database');

      const on = await h.call('PUT', `/api/admin/${table}/${user.id}/toggle-active`, admin.token);
      assert.equal(on.status, 200, on.data?.message);
      assert.equal(on.data.isActive, 1);
      assert.equal(await isActive(table, user.id), 1);
    });

    test(`toggling a ${role} that doesn't exist is a 404, not a false success`, async () => {
      const admin = await h.signedIn(h.makeAdmin);
      const res = await h.call('PUT', `/api/admin/${table}/999999999/toggle-active`, admin.token);
      assert.equal(res.status, 404);
    });
  }

  test('deactivating is what actually locks the user out', async () => {
    const admin = await h.signedIn(h.makeAdmin);
    const student = await h.signedIn(h.makeStudent);
    assert.equal((await h.call('GET', '/api/student/summary', student.token)).status, 200);

    await h.call('PUT', `/api/admin/students/${student.id}/toggle-active`, admin.token);

    const after = await h.call('GET', '/api/student/summary', student.token);
    assert.equal(after.status, 403);
    assert.equal(after.data.code, 'ACCOUNT_DEACTIVATED');
  });

  test('the action is recorded in the audit log', async () => {
    const admin = await h.signedIn(h.makeAdmin);
    const student = await h.makeStudent();
    await h.call('PUT', `/api/admin/students/${student.id}/toggle-active`, admin.token);

    const [rows] = await h.pool.query(
      `SELECT action FROM admin_audit_log WHERE target_type = 'student' AND target_id = ? ORDER BY id DESC LIMIT 1`,
      [student.id]
    );
    assert.equal(rows[0]?.action, 'deactivate_student');
  });

  test('a non-admin cannot toggle anyone', async () => {
    const student = await h.signedIn(h.makeStudent);
    const victim = await h.makeStudent();
    const res = await h.call('PUT', `/api/admin/students/${victim.id}/toggle-active`, student.token);
    assert.equal(res.status, 403);
    assert.equal(await isActive('students', victim.id), 1);
  });
});
