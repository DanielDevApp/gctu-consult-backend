const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

const EMAIL_PATTERN = 'test.register.%@example.test';

before(h.start);
after(async () => {
  // Registered through the API, so the helpers aren't tracking these rows.
  await h.pool.query(
    `DELETE FROM email_verifications WHERE user_role = 'student'
       AND user_id IN (SELECT id FROM students WHERE email LIKE ?)`,
    [EMAIL_PATTERN]
  );
  await h.pool.query('DELETE FROM students WHERE email LIKE ?', [EMAIL_PATTERN]);
  await h.stop();
});

let seq = 0;
function registration(overrides = {}) {
  const u = `${Date.now()}${seq++}`;
  return {
    firstName: 'Test',
    lastName: 'Register',
    level: '300',
    programme: h.PROGRAMME,
    email: `test.register.${u}@example.test`,
    password: 'Passw0rd!test',
    studentId: u.slice(-10),
    ...overrides,
  };
}

const register = (body) => h.call('POST', '/api/auth/register/student', null, body);

describe('student index number on registration', () => {
  test('a 10-digit index number is accepted', async () => {
    const body = registration();
    assert.match(body.studentId, /^\d{10}$/);
    const res = await register(body);
    assert.equal(res.status, 201, res.data?.message);
  });

  test('a shorter index number is still accepted', async () => {
    const body = registration();
    const res = await register({ ...body, studentId: body.studentId.slice(-8) });
    assert.equal(res.status, 201, res.data?.message);
  });

  // The register form strips anything that isn't a digit, but the API is what
  // actually has to hold the line — a direct request skips the form entirely.
  for (const [label, studentId] of [
    ['letters', 'ABC1234567'],
    ['more than 10 digits', '12345678901'],
    ['a space', '12345 6789'],
    ['a hyphen', '1234-56789'],
    ['a decimal point', '12345.6789'],
    ['a negative sign', '-123456789'],
    ['nothing at all', ''],
  ]) {
    test(`an index number with ${label} is rejected`, async () => {
      const res = await register(registration({ studentId }));
      assert.equal(res.status, 400, `"${studentId}" should be refused`);
      assert.match(res.data.message, /numbers only, up to 10 digits/i);
    });
  }
});
