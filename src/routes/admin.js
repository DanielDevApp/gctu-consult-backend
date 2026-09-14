const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { pool } = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { notify } = require('../utils/notify');
const {
  purgeIfFullyHidden, canRemoveFromHistory, clearFinishedFromHistory,
} = require('../utils/bookingVisibility');
const { removeSubscriptionsForUser } = require('../utils/push');
const {
  studentFields, lecturerFields, passwordField, randomAvatarColor, findAccountConflict,
} = require('../utils/accounts');
const { logAdminAction } = require('../utils/auditLog');
const { toCsv, sendCsv } = require('../utils/csv');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

function handleValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ message: errors.array()[0].msg });
    return true;
  }
  return false;
}

/** Reads ?page= & ?pageSize= off the query string, clamped to sane bounds. */
function readPagination(req, { defaultPageSize = 20, maxPageSize = 100 } = {}) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(maxPageSize, Math.max(1, parseInt(req.query.pageSize, 10) || defaultPageSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

const todayStamp = () => new Date().toISOString().slice(0, 10);

// Temporary by default: a password an admin has seen, typed and passed on over
// WhatsApp or on a note shouldn't stay live. Opting out takes an explicit false.
const requirePasswordChangeField = body('requirePasswordChange').optional().isBoolean()
  .withMessage('requirePasswordChange must be true or false').toBoolean(true);
const mustChangeFrom = (req) => (req.body.requirePasswordChange === false ? 0 : 1);

/**
 * Lets an admin issue a new password for an existing student or lecturer —
 * for someone who lost their temporary password before first sign-in, or is
 * locked out and can't reach their email for a self-service reset.
 *
 * With the forced change left on (the default), any session already signed in
 * to that account is confined to choosing a new password, which needs *this*
 * password rather than the old one, so an old session can't simply carry on.
 * The owner is always notified: an administrator changing someone's password
 * is exactly the kind of thing that must never happen silently.
 */
function setPasswordHandlers(role) {
  const table = role === 'student' ? 'students' : 'lecturers';
  const label = role === 'student' ? 'Student' : 'Lecturer';
  return [
    [passwordField(), requirePasswordChangeField],
    async (req, res) => {
      if (handleValidation(req, res)) return;
      const mustChange = mustChangeFrom(req);
      try {
        const [[user]] = [(await pool.query(`SELECT id, first_name, last_name FROM ${table} WHERE id = ?`, [req.params.id]))[0]];
        if (!user) return res.status(404).json({ message: `${label} not found.` });

        const passwordHash = await bcrypt.hash(req.body.password, 10);
        await pool.query(
          `UPDATE ${table} SET password_hash = ?, must_change_password = ? WHERE id = ?`,
          [passwordHash, mustChange, user.id]
        );
        await logAdminAction(req.user, `set_${role}_password`, role, user.id, `${user.first_name} ${user.last_name}`);
        await notify(
          user.id,
          role,
          'Password changed by an administrator',
          mustChange
            ? "An administrator set a new password for your account. You'll be asked to choose your own the next time you sign in. If you didn't expect this, contact the admin office."
            : "An administrator set a new password for your account. If you didn't expect this, contact the admin office.",
          'account_security'
        );
        res.json({ message: `New password set for ${user.first_name} ${user.last_name}.`, mustChangePassword: mustChange === 1 });
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Could not set the password.' });
      }
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Overview stats                                                      */
/* ------------------------------------------------------------------ */
router.get('/stats', async (req, res) => {
  try {
    const [[{ totalStudents }]] = await pool.query('SELECT COUNT(*) AS "totalStudents" FROM students');
    const [[{ totalLecturers }]] = await pool.query('SELECT COUNT(*) AS "totalLecturers" FROM lecturers');
    const [[{ pendingVerification }]] = await pool.query(
      'SELECT COUNT(*) AS "pendingVerification" FROM lecturers WHERE is_verified = 0'
    );
    const [[{ totalBookings }]] = await pool.query('SELECT COUNT(*) AS "totalBookings" FROM bookings');
    const [[{ activeBookings }]] = await pool.query(
      `SELECT COUNT(*) AS "activeBookings" FROM bookings WHERE status IN ('pending','confirmed')`
    );
    const [[{ totalSlots }]] = await pool.query('SELECT COUNT(*) AS "totalSlots" FROM availability_slots');

    res.json({
      totalStudents,
      totalLecturers,
      pendingVerification,
      totalBookings,
      activeBookings,
      totalSlots,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not load stats.' });
  }
});

/* ------------------------------------------------------------------ */
/* Analytics — aggregate usage numbers, not per-record management       */
/* ------------------------------------------------------------------ */
router.get('/analytics', async (req, res) => {
  try {
    const [byStatus] = await pool.query(
      `SELECT status, COUNT(*) AS count FROM bookings WHERE hidden_by_admin = 0 GROUP BY status`
    );

    const [topLecturers] = await pool.query(
      `SELECT l.id, l.first_name, l.last_name, l.department, COUNT(*) AS "bookingCount"
       FROM bookings b JOIN lecturers l ON l.id = b.lecturer_id
       WHERE b.hidden_by_admin = 0
       GROUP BY l.id ORDER BY "bookingCount" DESC LIMIT 5`
    );

    const [byDepartment] = await pool.query(
      `SELECT l.department, COUNT(*) AS count
       FROM bookings b JOIN lecturers l ON l.id = b.lecturer_id
       WHERE b.hidden_by_admin = 0
       GROUP BY l.department ORDER BY count DESC LIMIT 8`
    );

    const [[{ completedCount, noShowCount }]] = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'completed') AS "completedCount",
         COUNT(*) FILTER (WHERE status = 'no_show') AS "noShowCount"
       FROM bookings WHERE status IN ('completed', 'no_show')`
    );

    // Estimate only — updated_at moves on any change to the row, not just
    // the confirm transition, but for bookings that went straight
    // pending -> confirmed with nothing else touching them it's a fair
    // proxy for "how long did the lecturer take to respond".
    const [[{ avgConfirmMinutes }]] = await pool.query(
      `SELECT ROUND(AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 60)) AS "avgConfirmMinutes"
       FROM bookings WHERE status IN ('confirmed', 'completed', 'no_show')`
    );

    const [[{ totalRatings, avgRating }]] = await pool.query(
      `SELECT COUNT(*) AS "totalRatings", ROUND(AVG(rating), 2) AS "avgRating" FROM booking_ratings`
    );

    res.json({
      byStatus,
      topLecturers,
      byDepartment,
      noShowRate: completedCount + noShowCount > 0 ? Math.round((noShowCount / (completedCount + noShowCount)) * 1000) / 10 : null,
      avgConfirmMinutes,
      totalRatings,
      avgRating,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not load analytics.' });
  }
});

/* ------------------------------------------------------------------ */
/* Lecturers management                                                */
/* ------------------------------------------------------------------ */
router.get('/lecturers', async (req, res) => {
  const { search = '' } = req.query;
  const { page, pageSize, offset } = readPagination(req);
  try {
    const where = search ? `WHERE (first_name ILIKE ? OR last_name ILIKE ? OR department ILIKE ? OR staff_id ILIKE ?)` : '';
    const params = search ? [`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`] : [];

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM lecturers ${where}`, params);
    const [rows] = await pool.query(
      `SELECT id, first_name, last_name, staff_id, department, title, email, is_verified, is_active, must_change_password, created_at
       FROM lecturers ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );
    res.json({ rows, total, page, pageSize });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not load lecturers.' });
  }
});

router.get('/lecturers/export', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT first_name, last_name, staff_id, department, title, email, is_verified, is_active, created_at
       FROM lecturers ORDER BY created_at DESC`
    );
    const csv = toCsv(rows, [
      { key: 'first_name', header: 'First name' },
      { key: 'last_name', header: 'Last name' },
      { key: 'staff_id', header: 'Staff ID' },
      { key: 'department', header: 'Department' },
      { key: 'title', header: 'Title' },
      { key: 'email', header: 'Email' },
      { key: 'is_verified', header: 'Verified' },
      { key: 'is_active', header: 'Active' },
      { key: 'created_at', header: 'Joined' },
    ]);
    await logAdminAction(req.user, 'export_lecturers', 'lecturer', null, `${rows.length} rows`);
    sendCsv(res, `lecturers-${todayStamp()}.csv`, csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not export lecturers.' });
  }
});

/* Create a lecturer account on their behalf. The admin is vouching for the
   person, so the account skips email verification and is verified for
   students to find straight away — there's nothing left for anyone to approve. */
router.post('/lecturers', [...lecturerFields, requirePasswordChangeField], async (req, res) => {
  if (handleValidation(req, res)) return;
  const { title, firstName, lastName, staffId, department, email, password } = req.body;
  const mustChange = mustChangeFrom(req);
  try {
    const conflict = await findAccountConflict('lecturer', { email, schoolId: staffId });
    if (conflict) return res.status(409).json({ message: conflict });

    const passwordHash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      `INSERT INTO lecturers
         (first_name, last_name, staff_id, department, title, email, password_hash, avatar_color,
          email_verified, is_verified, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)`,
      [firstName, lastName, staffId, department, title || null, email, passwordHash, randomAvatarColor(), mustChange]
    );
    await logAdminAction(req.user, 'create_lecturer', 'lecturer', result.insertId, `${firstName} ${lastName} (${staffId})`);
    res.status(201).json({
      message: 'Lecturer account created.',
      id: result.insertId,
      login: { role: 'lecturer', identifier: staffId, email, mustChangePassword: mustChange === 1 },
    });
  } catch (err) {
    // Two admins adding the same person at the same moment can both pass the
    // conflict check above; the unique constraint is the backstop.
    if (err.code === '23505') return res.status(409).json({ message: 'An account with this email or staff ID already exists.' });
    console.error(err);
    res.status(500).json({ message: 'Could not create the lecturer account.' });
  }
});

router.put('/lecturers/:id/password', ...setPasswordHandlers('lecturer'));

router.put('/lecturers/:id/verify', async (req, res) => {
  try {
    const [[lecturer]] = [(await pool.query('SELECT first_name, last_name FROM lecturers WHERE id = ?', [req.params.id]))[0]];
    await pool.query('UPDATE lecturers SET is_verified = 1 WHERE id = ?', [req.params.id]);
    await notify(req.params.id, 'lecturer', 'Account verified', 'Your lecturer account has been verified by the admin. You are now visible to students.', 'account_verified');
    await logAdminAction(req.user, 'verify_lecturer', 'lecturer', Number(req.params.id), lecturer ? `${lecturer.first_name} ${lecturer.last_name}` : null);
    res.json({ message: 'Lecturer verified.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not verify lecturer.' });
  }
});

router.put('/lecturers/:id/toggle-active', async (req, res) => {
  try {
    const [[lecturer]] = [(await pool.query('SELECT first_name, last_name, is_active FROM lecturers WHERE id = ?', [req.params.id]))[0]];
    if (!lecturer) return res.status(404).json({ message: 'Lecturer not found.' });

    // `1 - is_active`, not `NOT is_active`: these flags are SMALLINT 0/1, not
    // booleans, and Postgres rejects NOT on a non-boolean ("argument of NOT
    // must be type boolean"). MySQL accepted it on a TINYINT, so this came
    // across in the Postgres migration and silently broke the button.
    await pool.query('UPDATE lecturers SET is_active = 1 - is_active WHERE id = ?', [req.params.id]);
    const willBeActive = !lecturer.is_active;
    await logAdminAction(
      req.user,
      willBeActive ? 'activate_lecturer' : 'deactivate_lecturer',
      'lecturer',
      Number(req.params.id),
      `${lecturer.first_name} ${lecturer.last_name}`
    );
    res.json({
      message: `Lecturer ${willBeActive ? 'reactivated' : 'deactivated'}.`,
      isActive: willBeActive ? 1 : 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not update lecturer status.' });
  }
});

router.delete('/lecturers/:id', async (req, res) => {
  try {
    const [[lecturer]] = [(await pool.query('SELECT first_name, last_name FROM lecturers WHERE id = ?', [req.params.id]))[0]];
    if (!lecturer) return res.status(404).json({ message: 'Lecturer not found.' });

    const [[{ activeCount }]] = await pool.query(
      `SELECT COUNT(*) AS "activeCount" FROM bookings WHERE lecturer_id = ? AND status IN ('pending', 'confirmed')`,
      [req.params.id]
    );

    // Deleting the lecturer row cascades and hard-deletes those bookings —
    // require the admin to explicitly confirm that first, instead of it
    // silently disappearing from the affected students' history.
    if (activeCount > 0 && req.query.force !== 'true') {
      return res.status(409).json({
        message: `${lecturer.first_name} ${lecturer.last_name} has ${activeCount} active booking${activeCount === 1 ? '' : 's'} (pending or confirmed). Deleting this account will cancel ${activeCount === 1 ? 'it' : 'them'} and remove ${activeCount === 1 ? 'it' : 'them'} from the affected student${activeCount === 1 ? "'s" : 's\''} history. Delete anyway?`,
        activeBookings: activeCount,
      });
    }

    if (activeCount > 0) {
      const [affected] = await pool.query(
        `SELECT DISTINCT b.student_id, s.slot_date, s.start_time
         FROM bookings b JOIN availability_slots s ON s.id = b.slot_id
         WHERE b.lecturer_id = ? AND b.status IN ('pending', 'confirmed')`,
        [req.params.id]
      );
      for (const row of affected) {
        await notify(
          row.student_id,
          'student',
          'Consultation cancelled',
          `Your consultation with ${lecturer.first_name} ${lecturer.last_name} on ${row.slot_date} at ${row.start_time} was cancelled because the lecturer's account was removed.`,
          'booking_cancelled'
        );
      }
    }

    await pool.query('DELETE FROM lecturers WHERE id = ?', [req.params.id]);
    // Push subscriptions have no foreign key back to the account (one table
    // serves all three roles), so they don't cascade — clear them explicitly,
    // or the deleted user's devices linger as orphan rows.
    await removeSubscriptionsForUser(req.params.id, 'lecturer');
    await logAdminAction(req.user, 'delete_lecturer', 'lecturer', Number(req.params.id), `${lecturer.first_name} ${lecturer.last_name}`);
    res.json({ message: 'Lecturer removed.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not remove lecturer.' });
  }
});

/* ------------------------------------------------------------------ */
/* Students management                                                 */
/* ------------------------------------------------------------------ */
router.get('/students', async (req, res) => {
  const { search = '' } = req.query;
  const { page, pageSize, offset } = readPagination(req);
  try {
    const where = search ? `WHERE (first_name ILIKE ? OR last_name ILIKE ? OR student_id ILIKE ? OR programme ILIKE ?)` : '';
    const params = search ? [`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`] : [];

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM students ${where}`, params);
    const [rows] = await pool.query(
      `SELECT id, first_name, last_name, student_id, level, programme, email, is_active, must_change_password, created_at
       FROM students ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );
    res.json({ rows, total, page, pageSize });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not load students.' });
  }
});

router.get('/students/export', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT first_name, last_name, student_id, level, programme, email, is_active, created_at
       FROM students ORDER BY created_at DESC`
    );
    const csv = toCsv(rows, [
      { key: 'first_name', header: 'First name' },
      { key: 'last_name', header: 'Last name' },
      { key: 'student_id', header: 'Student ID' },
      { key: 'level', header: 'Level' },
      { key: 'programme', header: 'Programme' },
      { key: 'email', header: 'Email' },
      { key: 'is_active', header: 'Active' },
      { key: 'created_at', header: 'Joined' },
    ]);
    await logAdminAction(req.user, 'export_students', 'student', null, `${rows.length} rows`);
    sendCsv(res, `students-${todayStamp()}.csv`, csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not export students.' });
  }
});

/* Create a student account on their behalf. The admin is vouching for the
   address, so there's no email-verification step — the student can sign in
   straight away with the details the admin hands them. */
router.post('/students', [...studentFields, requirePasswordChangeField], async (req, res) => {
  if (handleValidation(req, res)) return;
  const { firstName, lastName, studentId, level, programme, email, password } = req.body;
  const mustChange = mustChangeFrom(req);
  try {
    const conflict = await findAccountConflict('student', { email, schoolId: studentId });
    if (conflict) return res.status(409).json({ message: conflict });

    const passwordHash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      `INSERT INTO students
         (first_name, last_name, student_id, level, programme, email, password_hash, avatar_color,
          email_verified, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [firstName, lastName, studentId, level, programme, email, passwordHash, randomAvatarColor(), mustChange]
    );
    await logAdminAction(req.user, 'create_student', 'student', result.insertId, `${firstName} ${lastName} (${studentId})`);
    res.status(201).json({
      message: 'Student account created.',
      id: result.insertId,
      login: { role: 'student', identifier: studentId, email, mustChangePassword: mustChange === 1 },
    });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: 'An account with this email or student ID already exists.' });
    console.error(err);
    res.status(500).json({ message: 'Could not create the student account.' });
  }
});

router.put('/students/:id/password', ...setPasswordHandlers('student'));

router.put('/students/:id/toggle-active', async (req, res) => {
  try {
    const [[student]] = [(await pool.query('SELECT first_name, last_name, is_active FROM students WHERE id = ?', [req.params.id]))[0]];
    if (!student) return res.status(404).json({ message: 'Student not found.' });

    // See the lecturer route above: SMALLINT 0/1, so `NOT` is a type error in
    // Postgres even though MySQL allowed it on a TINYINT.
    await pool.query('UPDATE students SET is_active = 1 - is_active WHERE id = ?', [req.params.id]);
    const willBeActive = !student.is_active;
    await logAdminAction(
      req.user,
      willBeActive ? 'activate_student' : 'deactivate_student',
      'student',
      Number(req.params.id),
      `${student.first_name} ${student.last_name}`
    );
    res.json({
      message: `Student ${willBeActive ? 'reactivated' : 'deactivated'}.`,
      isActive: willBeActive ? 1 : 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not update student status.' });
  }
});

router.delete('/students/:id', async (req, res) => {
  try {
    const [[student]] = [(await pool.query('SELECT first_name, last_name FROM students WHERE id = ?', [req.params.id]))[0]];
    if (!student) return res.status(404).json({ message: 'Student not found.' });

    const [[{ activeCount }]] = await pool.query(
      `SELECT COUNT(*) AS "activeCount" FROM bookings WHERE student_id = ? AND status IN ('pending', 'confirmed')`,
      [req.params.id]
    );

    if (activeCount > 0 && req.query.force !== 'true') {
      return res.status(409).json({
        message: `${student.first_name} ${student.last_name} has ${activeCount} active booking${activeCount === 1 ? '' : 's'} (pending or confirmed). Deleting this account will cancel ${activeCount === 1 ? 'it' : 'them'} and remove ${activeCount === 1 ? 'it' : 'them'} from the affected lecturer${activeCount === 1 ? "'s" : 's\''} history. Delete anyway?`,
        activeBookings: activeCount,
      });
    }

    if (activeCount > 0) {
      const [affected] = await pool.query(
        `SELECT DISTINCT b.lecturer_id, s.slot_date, s.start_time
         FROM bookings b JOIN availability_slots s ON s.id = b.slot_id
         WHERE b.student_id = ? AND b.status IN ('pending', 'confirmed')`,
        [req.params.id]
      );
      for (const row of affected) {
        await notify(
          row.lecturer_id,
          'lecturer',
          'Consultation cancelled',
          `Your consultation with ${student.first_name} ${student.last_name} on ${row.slot_date} at ${row.start_time} was cancelled because the student's account was removed.`,
          'booking_cancelled'
        );
      }
    }

    await pool.query('DELETE FROM students WHERE id = ?', [req.params.id]);
    await removeSubscriptionsForUser(req.params.id, 'student');
    await logAdminAction(req.user, 'delete_student', 'student', Number(req.params.id), `${student.first_name} ${student.last_name}`);
    res.json({ message: 'Student removed.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not remove student.' });
  }
});

/* ------------------------------------------------------------------ */
/* Bookings overview                                                   */
/* ------------------------------------------------------------------ */
const BOOKING_STATUSES = ['pending', 'confirmed', 'cancelled', 'completed', 'declined', 'expired', 'no_show'];

/** Builds the shared WHERE clause + params for the admin bookings list,
 *  reused by both the paginated view and the CSV export so the export
 *  always matches whatever filters are currently on screen. */
function bookingFilters(req) {
  const { status, from, to, search } = req.query;
  const clauses = ['b.hidden_by_admin = 0'];
  const params = [];

  if (status && BOOKING_STATUSES.includes(status)) {
    clauses.push('b.status = ?');
    params.push(status);
  }
  if (from) {
    clauses.push('s.slot_date >= ?');
    params.push(from);
  }
  if (to) {
    clauses.push('s.slot_date <= ?');
    params.push(to);
  }
  if (search) {
    clauses.push(
      `(st.first_name ILIKE ? OR st.last_name ILIKE ? OR st.student_id ILIKE ?
        OR l.first_name ILIKE ? OR l.last_name ILIKE ? OR l.department ILIKE ?)`
    );
    params.push(...Array(6).fill(`%${search}%`));
  }
  return { where: clauses.join(' AND '), params };
}

router.get('/bookings', async (req, res) => {
  const { page, pageSize, offset } = readPagination(req, { defaultPageSize: 20, maxPageSize: 100 });
  try {
    const { where, params } = bookingFilters(req);
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM bookings b
       JOIN availability_slots s ON s.id = b.slot_id
       JOIN students st ON st.id = b.student_id
       JOIN lecturers l ON l.id = b.lecturer_id
       WHERE ${where}`,
      params
    );
    const [rows] = await pool.query(
      `SELECT b.*, s.slot_date, s.start_time, s.end_time, s.mode,
              st.first_name AS student_first_name, st.last_name AS student_last_name, st.student_id,
              l.first_name AS lecturer_first_name, l.last_name AS lecturer_last_name, l.department
       FROM bookings b
       JOIN availability_slots s ON s.id = b.slot_id
       JOIN students st ON st.id = b.student_id
       JOIN lecturers l ON l.id = b.lecturer_id
       WHERE ${where}
       ORDER BY b.created_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );
    res.json({ rows, total, page, pageSize });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not load bookings.' });
  }
});

router.get('/bookings/export', async (req, res) => {
  try {
    // Same filters as the on-screen table, so exporting "Confirmed bookings
    // in March" doesn't quietly dump the whole table instead.
    const { where, params } = bookingFilters(req);
    const [rows] = await pool.query(
      `SELECT st.first_name AS student_first_name, st.last_name AS student_last_name, st.student_id,
              l.first_name AS lecturer_first_name, l.last_name AS lecturer_last_name, l.department,
              s.slot_date, s.start_time, s.end_time, s.mode, b.status, b.created_at
       FROM bookings b
       JOIN availability_slots s ON s.id = b.slot_id
       JOIN students st ON st.id = b.student_id
       JOIN lecturers l ON l.id = b.lecturer_id
       WHERE ${where}
       ORDER BY b.created_at DESC`,
      params
    );
    const csv = toCsv(rows, [
      { key: 'student_first_name', header: 'Student first name' },
      { key: 'student_last_name', header: 'Student last name' },
      { key: 'student_id', header: 'Student ID' },
      { key: 'lecturer_first_name', header: 'Lecturer first name' },
      { key: 'lecturer_last_name', header: 'Lecturer last name' },
      { key: 'department', header: 'Department' },
      { key: 'slot_date', header: 'Date' },
      { key: 'start_time', header: 'Start time' },
      { key: 'end_time', header: 'End time' },
      { key: 'mode', header: 'Mode' },
      { key: 'status', header: 'Status' },
      { key: 'created_at', header: 'Booked at' },
    ]);
    await logAdminAction(req.user, 'export_bookings', 'booking', null, `${rows.length} rows`);
    sendCsv(res, `bookings-${todayStamp()}.csv`, csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not export bookings.' });
  }
});

/* Clear every finished booking out of the admin's view at once. Live ones are
   left in place and reported back, so an in-flight consultation can't drop out
   of the view that exists for oversight. Declared before /bookings/:id so the
   collection stays an unambiguous target. */
router.delete('/bookings', async (req, res) => {
  try {
    const { cleared, kept } = await clearFinishedFromHistory('admin', req.user.id);
    await logAdminAction(req.user, 'clear_bookings_from_view', 'booking', null, `${cleared} cleared`);
    res.json({
      cleared,
      kept,
      message: cleared
        ? `Cleared ${cleared} finished booking${cleared === 1 ? '' : 's'} from the list.${kept ? ` ${kept} active booking${kept === 1 ? '' : 's'} kept.` : ''}`
        : (kept
            ? `Nothing to clear — all ${kept} remaining booking${kept === 1 ? ' is' : 's are'} still active.`
            : 'The bookings list is already empty.'),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not clear the bookings list.' });
  }
});

/* Remove a finished booking from the admin's own view. Admin isn't a party to
   the booking, so no ownership check — just visibility. Live bookings stay
   put for the same reason they do for the student and lecturer: an in-flight
   consultation shouldn't be able to drop out of anyone's view, least of all
   the one that exists for oversight. */
router.delete('/bookings/:id', async (req, res) => {
  try {
    const [[booking]] = [(await pool.query('SELECT id, status FROM bookings WHERE id = ?', [req.params.id]))[0]];
    if (!booking) return res.status(404).json({ message: 'Booking not found.' });
    if (!canRemoveFromHistory(booking.status)) {
      return res.status(409).json({
        message: `This booking is still ${booking.status} — only finished bookings (completed, no-show, cancelled, declined or expired) can be cleared from the list.`,
      });
    }

    await pool.query('UPDATE bookings SET hidden_by_admin = 1 WHERE id = ?', [req.params.id]);
    await purgeIfFullyHidden(req.params.id);
    await logAdminAction(req.user, 'remove_booking_from_view', 'booking', Number(req.params.id), null);

    res.json({ message: 'Booking removed from your history.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not remove booking.' });
  }
});

/* ------------------------------------------------------------------ */
/* Audit log                                                           */
/* ------------------------------------------------------------------ */
router.get('/audit-log', async (req, res) => {
  const { page, pageSize, offset } = readPagination(req, { defaultPageSize: 25, maxPageSize: 100 });
  try {
    const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM admin_audit_log');
    const [rows] = await pool.query(
      `SELECT id, admin_name, action, target_type, target_id, details, created_at
       FROM admin_audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [pageSize, offset]
    );
    res.json({ rows, total, page, pageSize });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not load audit log.' });
  }
});

/* ------------------------------------------------------------------ */
/* Admin management (add/remove admins, self password change)          */
/* ------------------------------------------------------------------ */
router.get('/admins', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, name, email, is_super_admin, created_at FROM admins ORDER BY created_at ASC'
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not load admins.' });
  }
});

router.post(
  '/admins',
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().withMessage('A valid email is required').normalizeEmail(),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  ],
  async (req, res) => {
    if (handleValidation(req, res)) return;
    const { name, email, password } = req.body;
    try {
      const [existing] = await pool.query('SELECT id FROM admins WHERE email = ?', [email]);
      if (existing.length) {
        return res.status(409).json({ message: 'An admin with this email already exists.' });
      }
      const passwordHash = await bcrypt.hash(password, 10);
      const [result] = await pool.query(
        'INSERT INTO admins (name, email, password_hash) VALUES (?, ?, ?)',
        [name, email, passwordHash]
      );
      await logAdminAction(req.user, 'add_admin', 'admin', result.insertId, `${name} <${email}>`);
      res.status(201).json({ message: 'Admin added.', id: result.insertId });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Could not add admin.' });
    }
  }
);

router.delete('/admins/:id', async (req, res) => {
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ message: 'You cannot delete your own admin account while logged in.' });
  }
  try {
    const [[target]] = [(await pool.query('SELECT * FROM admins WHERE id = ?', [req.params.id]))[0]];
    if (target && target.is_super_admin) {
      return res.status(403).json({ message: 'The super admin account cannot be deleted.' });
    }
    await pool.query('DELETE FROM admins WHERE id = ?', [req.params.id]);
    await removeSubscriptionsForUser(req.params.id, 'admin');
    await logAdminAction(req.user, 'delete_admin', 'admin', Number(req.params.id), target ? `${target.name} <${target.email}>` : null);
    res.json({ message: 'Admin removed.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not remove admin.' });
  }
});

module.exports = router;
