const { Pool, types } = require('pg');
require('dotenv').config();

// Return DATE/TIME/TIMESTAMP columns as plain strings instead of parsed JS
// Date objects — matches the mysql2 driver's `dateStrings: true` option this
// app was originally written against. slot_date/created_at/etc. are treated
// as strings everywhere in the codebase (template-literal concatenation
// into "YYYY-MM-DDTHH:MM:SS", `.slice()`, direct JSON serialization) — a
// parsed Date object in their place would silently break all of that.
types.setTypeParser(1082, (v) => v); // DATE
types.setTypeParser(1083, (v) => v); // TIME
types.setTypeParser(1114, (v) => v); // TIMESTAMP WITHOUT TIME ZONE
types.setTypeParser(1184, (v) => v); // TIMESTAMP WITH TIME ZONE

// COUNT(*)/SUM() return BIGINT in Postgres, which pg parses as a JS
// *string* by default (a 64-bit int can't always fit a JS number safely).
// Every count/sum in this app is nowhere near that range, and the whole
// codebase does plain arithmetic/comparisons on these results
// (`count >= 50`, `completedCount + noShowCount`, `total_slots === 0`) —
// left as strings, `"5" + "3"` silently becomes `"53"` instead of `8`.
types.setTypeParser(20, (v) => parseInt(v, 10)); // BIGINT / int8

// Managed Postgres providers (Neon, Render, Supabase, ...) hand out a single
// DATABASE_URL and require SSL; local/XAMPP-style setups use the discrete
// DB_* vars with no SSL. Presence of DATABASE_URL picks the cloud path so
// local dev config doesn't have to change.
const pgPool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'gctu_consult',
    });

/**
 * Converts a mysql2-style "?" positional query into Postgres's "$1, $2, ..."
 * form. A "?" bound to an array — mysql2's auto-expand behavior for
 * `IN (?)` — becomes a comma-separated list of its own placeholders, the
 * same shape mysql2 produces, so `IN (?)` call sites don't need their SQL
 * touched either.
 */
function toPg(sql, params = []) {
  const values = [];
  let i = 0;
  const text = sql.replace(/\?/g, () => {
    // pg throws on a literal `undefined` bind value ("please convert
    // undefined to null"); mysql2 silently treated it as NULL. Match
    // mysql2's leniency here rather than audit ~180 call sites for a
    // param that might end up undefined instead of explicitly null.
    let val = params[i++];
    if (val === undefined) val = null;
    if (Array.isArray(val)) {
      return val.map((v) => { values.push(v === undefined ? null : v); return `$${values.length}`; }).join(', ');
    }
    values.push(val);
    return `$${values.length}`;
  });
  return { text, values };
}

/**
 * mysql2 returns `[rows, fields]` for a SELECT and `[resultHeader]` (with
 * `.insertId` / `.affectedRows`) for INSERT/UPDATE/DELETE — a shape every
 * route in this app destructures against (`const [rows] = await
 * pool.query(...)`, `const [result] = await pool.query(...); result.
 * insertId`). This reproduces that exact shape on top of pg's
 * `{rows, rowCount, command}` so none of those ~180 call sites need to
 * change. An INSERT with no explicit RETURNING gets one silently appended
 * (every table here uses `id` as its primary key) so `.insertId` keeps
 * working.
 */
async function runQuery(executor, sql, params) {
  const { text, values } = toPg(sql, params);
  const isInsert = /^\s*INSERT/i.test(text);
  const hasReturning = /\bRETURNING\b/i.test(text);
  const finalText = isInsert && !hasReturning ? `${text} RETURNING id` : text;

  const result = await executor(finalText, values);

  if (result.command === 'SELECT') {
    return [result.rows, result.fields];
  }
  return [{ insertId: result.rows[0]?.id, affectedRows: result.rowCount }, undefined];
}

const pool = {
  query: (sql, params) => runQuery((t, v) => pgPool.query(t, v), sql, params),

  /** Mirrors mysql2's PoolConnection API (query/beginTransaction/commit/
   *  rollback/release) on top of a single checked-out pg client, so the
   *  transactional routes (booking creation, reschedule) work unchanged. */
  async getConnection() {
    const client = await pgPool.connect();
    return {
      query: (sql, params) => runQuery((t, v) => client.query(t, v), sql, params),
      beginTransaction: () => client.query('BEGIN'),
      commit: () => client.query('COMMIT'),
      rollback: () => client.query('ROLLBACK'),
      release: () => client.release(),
    };
  },
};

async function testConnection() {
  try {
    const conn = await pool.getConnection();
    console.log('✅ PostgreSQL connected:', process.env.DB_NAME || 'gctu_consult');
    conn.release();
  } catch (err) {
    console.error('❌ PostgreSQL connection failed:', err.message);
    console.error('   Check that the PostgreSQL service is running and .env DB_* values are correct.');
  }
}

/**
 * Idempotent schema setup — safe to run on every boot. Fresh-database
 * shape (this app switched from MySQL to Postgres with a clean start, no
 * legacy-install migration path to carry forward). CHECK constraints
 * stand in for MySQL's ENUM columns; a DROP + ADD on every boot is what
 * makes widening one (e.g. adding a new status value) idempotent, since
 * Postgres has no "ALTER ... ENUM IF NOT CONTAINS" equivalent to check
 * against first.
 */
async function ensureSchema() {
  try {
    await pool.query(`
      CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $f$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $f$ LANGUAGE plpgsql
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS students (
        id SERIAL PRIMARY KEY,
        first_name VARCHAR(60) NOT NULL,
        last_name VARCHAR(60) NOT NULL,
        student_id VARCHAR(30) NOT NULL UNIQUE,
        level VARCHAR(10) NOT NULL,
        programme VARCHAR(120) NOT NULL,
        email VARCHAR(120) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        avatar_color VARCHAR(20) DEFAULT NULL,
        avatar_url VARCHAR(255) DEFAULT NULL,
        email_verified SMALLINT NOT NULL DEFAULT 0,
        is_active SMALLINT NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`DROP TRIGGER IF EXISTS trg_students_updated_at ON students`);
    await pool.query(`CREATE TRIGGER trg_students_updated_at BEFORE UPDATE ON students FOR EACH ROW EXECUTE FUNCTION set_updated_at()`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS lecturers (
        id SERIAL PRIMARY KEY,
        first_name VARCHAR(60) NOT NULL,
        last_name VARCHAR(60) NOT NULL,
        staff_id VARCHAR(30) NOT NULL UNIQUE,
        department VARCHAR(120) NOT NULL,
        title VARCHAR(30) DEFAULT NULL,
        office VARCHAR(80) DEFAULT NULL,
        bio VARCHAR(500) DEFAULT NULL,
        email VARCHAR(120) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        avatar_color VARCHAR(20) DEFAULT NULL,
        avatar_url VARCHAR(255) DEFAULT NULL,
        email_verified SMALLINT NOT NULL DEFAULT 0,
        is_verified SMALLINT NOT NULL DEFAULT 0,
        is_active SMALLINT NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`DROP TRIGGER IF EXISTS trg_lecturers_updated_at ON lecturers`);
    await pool.query(`CREATE TRIGGER trg_lecturers_updated_at BEFORE UPDATE ON lecturers FOR EACH ROW EXECUTE FUNCTION set_updated_at()`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS lecturer_courses (
        id SERIAL PRIMARY KEY,
        lecturer_id INT NOT NULL REFERENCES lecturers(id) ON DELETE CASCADE,
        course_code VARCHAR(20) DEFAULT NULL,
        course_name VARCHAR(150) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_course_lecturer ON lecturer_courses(lecturer_id)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        email VARCHAR(120) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        is_super_admin SMALLINT NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`DROP TRIGGER IF EXISTS trg_admins_updated_at ON admins`);
    await pool.query(`CREATE TRIGGER trg_admins_updated_at BEFORE UPDATE ON admins FOR EACH ROW EXECUTE FUNCTION set_updated_at()`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS availability_slots (
        id SERIAL PRIMARY KEY,
        lecturer_id INT NOT NULL REFERENCES lecturers(id) ON DELETE CASCADE,
        slot_date DATE NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        duration_minutes INT NOT NULL,
        mode VARCHAR(20) NOT NULL,
        venue VARCHAR(150) DEFAULT NULL,
        meeting_link VARCHAR(255) DEFAULT NULL,
        notes VARCHAR(255) DEFAULT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'open',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`ALTER TABLE availability_slots DROP CONSTRAINT IF EXISTS availability_slots_mode_check`);
    await pool.query(`ALTER TABLE availability_slots ADD CONSTRAINT availability_slots_mode_check CHECK (mode IN ('online', 'in_person'))`);
    await pool.query(`ALTER TABLE availability_slots DROP CONSTRAINT IF EXISTS availability_slots_status_check`);
    await pool.query(`ALTER TABLE availability_slots ADD CONSTRAINT availability_slots_status_check CHECK (status IN ('open', 'booked', 'cancelled', 'completed', 'expired'))`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_slot_lecturer ON availability_slots(lecturer_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_slot_status ON availability_slots(status)`);
    await pool.query(`DROP TRIGGER IF EXISTS trg_slots_updated_at ON availability_slots`);
    await pool.query(`CREATE TRIGGER trg_slots_updated_at BEFORE UPDATE ON availability_slots FOR EACH ROW EXECUTE FUNCTION set_updated_at()`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS bookings (
        id SERIAL PRIMARY KEY,
        slot_id INT NOT NULL REFERENCES availability_slots(id) ON DELETE CASCADE,
        student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        lecturer_id INT NOT NULL REFERENCES lecturers(id) ON DELETE CASCADE,
        reason VARCHAR(500) DEFAULT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        cancelled_by VARCHAR(20) DEFAULT NULL,
        cancel_reason VARCHAR(500) DEFAULT NULL,
        reminder_sent SMALLINT NOT NULL DEFAULT 0,
        hidden_by_student SMALLINT NOT NULL DEFAULT 0,
        hidden_by_lecturer SMALLINT NOT NULL DEFAULT 0,
        hidden_by_admin SMALLINT NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check`);
    await pool.query(`ALTER TABLE bookings ADD CONSTRAINT bookings_status_check CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed', 'declined', 'expired', 'no_show'))`);
    await pool.query(`ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_cancelled_by_check`);
    await pool.query(`ALTER TABLE bookings ADD CONSTRAINT bookings_cancelled_by_check CHECK (cancelled_by IN ('student', 'lecturer', 'admin'))`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_booking_student ON bookings(student_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_booking_lecturer ON bookings(lecturer_id)`);
    await pool.query(`DROP TRIGGER IF EXISTS trg_bookings_updated_at ON bookings`);
    await pool.query(`CREATE TRIGGER trg_bookings_updated_at BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION set_updated_at()`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS booking_ratings (
        id SERIAL PRIMARY KEY,
        booking_id INT NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
        lecturer_id INT NOT NULL REFERENCES lecturers(id) ON DELETE CASCADE,
        student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        rating SMALLINT NOT NULL,
        comment VARCHAR(500) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`ALTER TABLE booking_ratings DROP CONSTRAINT IF EXISTS booking_ratings_rating_check`);
    await pool.query(`ALTER TABLE booking_ratings ADD CONSTRAINT booking_ratings_rating_check CHECK (rating BETWEEN 1 AND 5)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_rating_lecturer ON booking_ratings(lecturer_id)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS lecturer_waitlist (
        id SERIAL PRIMARY KEY,
        student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        lecturer_id INT NOT NULL REFERENCES lecturers(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (student_id, lecturer_id)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_waitlist_lecturer ON lecturer_waitlist(lecturer_id)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        recipient_id INT NOT NULL,
        recipient_role VARCHAR(20) NOT NULL,
        title VARCHAR(150) NOT NULL,
        message VARCHAR(500) NOT NULL,
        type VARCHAR(40) DEFAULT 'general',
        is_read SMALLINT NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_recipient_role_check`);
    await pool.query(`ALTER TABLE notifications ADD CONSTRAINT notifications_recipient_role_check CHECK (recipient_role IN ('student', 'lecturer', 'admin'))`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_notif_recipient ON notifications(recipient_id, recipient_role)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_notif_unread ON notifications(is_read)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS email_verifications (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL,
        user_role VARCHAR(20) NOT NULL,
        code_hash VARCHAR(255) NOT NULL,
        attempts INT NOT NULL DEFAULT 0,
        expires_at TIMESTAMP NOT NULL,
        used SMALLINT NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`ALTER TABLE email_verifications DROP CONSTRAINT IF EXISTS email_verifications_user_role_check`);
    await pool.query(`ALTER TABLE email_verifications ADD CONSTRAINT email_verifications_user_role_check CHECK (user_role IN ('student', 'lecturer'))`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_verify_user ON email_verifications(user_id, user_role)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL,
        user_role VARCHAR(20) NOT NULL,
        token_hash VARCHAR(255) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        used SMALLINT NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`ALTER TABLE password_resets DROP CONSTRAINT IF EXISTS password_resets_user_role_check`);
    await pool.query(`ALTER TABLE password_resets ADD CONSTRAINT password_resets_user_role_check CHECK (user_role IN ('student', 'lecturer', 'admin'))`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_reset_user ON password_resets(user_id, user_role)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_reset_token ON password_resets(token_hash)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id SERIAL PRIMARY KEY,
        admin_id INT NOT NULL,
        admin_name VARCHAR(120) NOT NULL,
        action VARCHAR(60) NOT NULL,
        target_type VARCHAR(30) NOT NULL,
        target_id INT DEFAULT NULL,
        details VARCHAR(255) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_created ON admin_audit_log(created_at)`);

    console.log('✅ Schema ready (PostgreSQL)');
  } catch (err) {
    console.error('⚠️  Schema setup failed:', err.message);
  }
}

module.exports = { pool, testConnection, ensureSchema };
