const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { pool } = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { notify } = require('../utils/notify');
const { purgeIfFullyHidden } = require('../utils/bookingVisibility');
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
      `SELECT id, first_name, last_name, staff_id, department, title, email, is_verified, is_active, created_at
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
    await pool.query('UPDATE lecturers SET is_active = NOT is_active WHERE id = ?', [req.params.id]);
    const willBeActive = lecturer ? !lecturer.is_active : null;
    await logAdminAction(
      req.user,
      willBeActive ? 'activate_lecturer' : 'deactivate_lecturer',
      'lecturer',
      Number(req.params.id),
      lecturer ? `${lecturer.first_name} ${lecturer.last_name}` : null
    );
    res.json({ message: 'Lecturer status updated.' });
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
      `SELECT id, first_name, last_name, student_id, level, programme, email, is_active, created_at
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

router.put('/students/:id/toggle-active', async (req, res) => {
  try {
    const [[student]] = [(await pool.query('SELECT first_name, last_name, is_active FROM students WHERE id = ?', [req.params.id]))[0]];
    await pool.query('UPDATE students SET is_active = NOT is_active WHERE id = ?', [req.params.id]);
    const willBeActive = student ? !student.is_active : null;
    await logAdminAction(
      req.user,
      willBeActive ? 'activate_student' : 'deactivate_student',
      'student',
      Number(req.params.id),
      student ? `${student.first_name} ${student.last_name}` : null
    );
    res.json({ message: 'Student status updated.' });
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

/* Remove a booking from the admin's own view (any status). Admin isn't a
   party to the booking, so no ownership check — just visibility. */
router.delete('/bookings/:id', async (req, res) => {
  try {
    const [[booking]] = [(await pool.query('SELECT id FROM bookings WHERE id = ?', [req.params.id]))[0]];
    if (!booking) return res.status(404).json({ message: 'Booking not found.' });

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
    await logAdminAction(req.user, 'delete_admin', 'admin', Number(req.params.id), target ? `${target.name} <${target.email}>` : null);
    res.json({ message: 'Admin removed.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not remove admin.' });
  }
});

module.exports = router;
