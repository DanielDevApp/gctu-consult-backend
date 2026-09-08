// Must be set before src/app is required — it decides whether request logging
// and the global rate limiter are active.
process.env.NODE_ENV = 'test';

require('dotenv').config();
const bcrypt = require('bcryptjs');

/**
 * Refuse to run against anything that isn't a local database.
 *
 * These tests create and delete users, slots and bookings. Pointed at the
 * production Neon instance they would happily churn through real data, and
 * the only thing standing between the two is an environment variable. This
 * checks before anything is imported, and can only be overridden deliberately.
 */
function assertLocalDatabase() {
  if (process.env.ALLOW_REMOTE_TEST_DB === '1') return;

  const url = process.env.DATABASE_URL;
  const host = url ? new URL(url).hostname : (process.env.DB_HOST || 'localhost');
  const isLocal = ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(host);

  if (!isLocal) {
    console.error('\n  Refusing to run tests against a non-local database.');
    console.error(`  Host resolved to: ${host}`);
    console.error('  These tests create and delete data. Point DB_HOST/DATABASE_URL at a local');
    console.error('  Postgres, or set ALLOW_REMOTE_TEST_DB=1 if you really mean it.\n');
    process.exit(1);
  }
}
assertLocalDatabase();

const app = require('../src/app');
const { pool, ensureSchema } = require('../src/config/db');

let server;
let baseUrl;
const created = { students: [], lecturers: [], admins: [] };

/** Boots the real app on an ephemeral port and applies the schema once. */
async function start() {
  if (server) return baseUrl;
  await ensureSchema();
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return baseUrl;
}

/** Removes every row this run created, then closes the server. */
async function stop() {
  for (const id of created.students) await pool.query('DELETE FROM students WHERE id = ?', [id]);
  for (const id of created.lecturers) await pool.query('DELETE FROM lecturers WHERE id = ?', [id]);
  for (const id of created.admins) await pool.query('DELETE FROM admins WHERE id = ?', [id]);
  created.students.length = created.lecturers.length = created.admins.length = 0;
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
}

/** Thin JSON client over the running app. Returns { status, data, headers }. */
async function call(method, path, token, body, extraHeaders = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data, headers: res.headers };
}

const PASSWORD = 'Passw0rd!test';
let seq = 0;
const unique = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.floor(Math.random() * 1e4)}`;

async function hash() {
  return bcrypt.hash(PASSWORD, 4); // low cost: these are throwaway accounts
}

async function makeStudent({ active = 1, verified = 1 } = {}) {
  const u = unique();
  const email = `test.student.${u}@example.test`;
  const [r] = await pool.query(
    `INSERT INTO students (first_name, last_name, student_id, level, programme, email, password_hash, email_verified, is_active)
     VALUES ('Test','Student',?,'300','BSc Computer Science',?,?,?,?)`,
    [`S${u}`.slice(0, 20), email, await hash(), verified, active]
  );
  created.students.push(r.insertId);
  return { id: r.insertId, email, role: 'student' };
}

async function makeLecturer({ active = 1, verified = 1 } = {}) {
  const u = unique();
  const email = `test.lecturer.${u}@example.test`;
  const [r] = await pool.query(
    `INSERT INTO lecturers (first_name, last_name, staff_id, department, email, password_hash, email_verified, is_verified, is_active)
     VALUES ('Test','Lecturer',?,'Computer Science',?,?,?,1,?)`,
    [`L${u}`.slice(0, 20), email, await hash(), verified, active]
  );
  created.lecturers.push(r.insertId);
  return { id: r.insertId, email, role: 'lecturer' };
}

async function makeAdmin() {
  const u = unique();
  const email = `test.admin.${u}@example.test`;
  const [r] = await pool.query(
    `INSERT INTO admins (name, email, password_hash, is_super_admin) VALUES ('Test Admin',?,?,1)`,
    [email, await hash()]
  );
  created.admins.push(r.insertId);
  return { id: r.insertId, email, role: 'admin' };
}

/** Logs a seeded account in and returns its token. */
async function login(user) {
  const res = await call('POST', '/api/auth/login', null, {
    role: user.role,
    identifier: user.email,
    password: PASSWORD,
  });
  if (!res.data?.token) throw new Error(`login failed for ${user.email}: ${JSON.stringify(res.data)}`);
  return res.data.token;
}

/** Seeds an account and returns it with a live token attached. */
async function signedIn(factory, opts) {
  const user = await factory(opts);
  return { ...user, token: await login(user) };
}

const pad = (n) => String(n).padStart(2, '0');
const asDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const asTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/**
 * A slot is stored as one `slot_date` plus a start and end time, so a window
 * crossing midnight is unrepresentable: the end time would be numerically
 * *earlier* than the start on the same date, and every "has this passed yet?"
 * comparison would read it as long gone. The availability API refuses to
 * create one (it requires end > start), so tests must not fabricate one
 * either — this pulls a straddling slot back to sit inside the same day.
 */
function keepWithinOneDay(start, durationMinutes) {
  let end = new Date(start.getTime() + durationMinutes * 60000);
  if (asDate(end) !== asDate(start)) {
    const dayEnd = new Date(`${asDate(start)}T23:59:00`);
    const overflow = end.getTime() - dayEnd.getTime();
    start = new Date(start.getTime() - overflow);
    end = new Date(start.getTime() + durationMinutes * 60000);
  }
  return { start, end };
}

/**
 * Creates an availability window directly in the database, so a test can place
 * slots in the past — something the API deliberately refuses to do.
 * `offsets` are minutes relative to now for each slot's start.
 */
async function makeWindow(lecturerId, offsets, { durationMinutes = 30, status = 'open' } = {}) {
  const [[{ w }]] = [(await pool.query(`SELECT nextval('availability_window_seq') AS w`))[0]];
  const slots = [];
  for (const offset of offsets) {
    const { start, end } = keepWithinOneDay(new Date(Date.now() + offset * 60000), durationMinutes);
    const [r] = await pool.query(
      `INSERT INTO availability_slots
         (lecturer_id, window_id, slot_date, start_time, end_time, duration_minutes, mode, meeting_link, status)
       VALUES (?, ?, ?, ?, ?, ?, 'online', 'https://meet.example.test/x', ?)`,
      [lecturerId, w, asDate(start), asTime(start), asTime(end), durationMinutes, status]
    );
    slots.push({ id: r.insertId, windowId: w, start, end });
  }
  return { windowId: w, slots };
}

/** Moves an existing slot to a new time relative to now, in minutes. */
async function moveSlot(slotId, startOffsetMin, endOffsetMin) {
  const { start, end } = keepWithinOneDay(
    new Date(Date.now() + startOffsetMin * 60000),
    endOffsetMin - startOffsetMin
  );
  await pool.query(
    'UPDATE availability_slots SET slot_date = ?, start_time = ?, end_time = ? WHERE id = ?',
    [asDate(start), asTime(start), asTime(end), slotId]
  );
}

async function bookingStatus(id) {
  const [[row]] = [(await pool.query('SELECT status, attendance_missed FROM bookings WHERE id = ?', [id]))[0]];
  return row;
}

module.exports = {
  start, stop, call, login, signedIn,
  makeStudent, makeLecturer, makeAdmin,
  makeWindow, moveSlot, bookingStatus,
  pool, PASSWORD,
};
