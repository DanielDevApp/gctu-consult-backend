const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool } = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { notify } = require('../utils/notify');
const { purgeIfFullyHidden } = require('../utils/bookingVisibility');
const { expirePastSlots, hasSlotPassed, releaseSlotStatus } = require('../utils/expireSlots');
const { notifyWaitlist } = require('../utils/waitlist');

const router = express.Router();
router.use(requireAuth, requireRole('student'));

function handleValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ message: errors.array()[0].msg });
    return true;
  }
  return false;
}

/* Dashboard summary */
router.get('/summary', async (req, res) => {
  const studentId = req.user.id;
  try {
    await expirePastSlots();
    const [[{ upcoming }]] = await pool.query(
      `SELECT COUNT(*) AS upcoming FROM bookings b JOIN availability_slots s ON s.id = b.slot_id
       WHERE b.student_id = ? AND b.status IN ('pending','confirmed') AND s.slot_date >= CURRENT_DATE`,
      [studentId]
    );
    const [[{ completed }]] = await pool.query(
      `SELECT COUNT(*) AS completed FROM bookings WHERE student_id = ? AND status = 'completed'`,
      [studentId]
    );
    const [[{ lecturersAvailable }]] = await pool.query(
      `SELECT COUNT(DISTINCT lecturer_id) AS "lecturersAvailable" FROM availability_slots
       WHERE status = 'open' AND slot_date >= CURRENT_DATE`
    );
    res.json({ upcoming, completed, lecturersAvailable });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not load dashboard summary.' });
  }
});

/* Browse verified, active lecturers (with optional search/department filter).
   Search also matches against courses the lecturer teaches — a student
   looking for "who teaches Data Structures" shouldn't have to open every
   lecturer's card one by one to find out. DISTINCT because the course join
   can otherwise multiply a lecturer with several matching courses into
   several result rows. */
router.get('/lecturers', async (req, res) => {
  const { search = '', department = '' } = req.query;
  const studentId = req.user.id;
  try {
    await expirePastSlots();
    const params = [studentId];
    let sql = `
      SELECT DISTINCT l.id, l.first_name, l.last_name, l.department, l.title, l.office, l.bio,
             l.avatar_color, l.avatar_url,
             (SELECT COUNT(*) FROM availability_slots s WHERE s.lecturer_id = l.id AND s.status = 'open' AND s.slot_date >= CURRENT_DATE) AS open_slots,
             (SELECT COUNT(*) FROM availability_slots s WHERE s.lecturer_id = l.id AND s.status IN ('open','booked') AND s.slot_date >= CURRENT_DATE) AS total_slots,
             (SELECT ROUND(AVG(rating), 1) FROM booking_ratings r WHERE r.lecturer_id = l.id) AS avg_rating,
             (SELECT COUNT(*) FROM booking_ratings r WHERE r.lecturer_id = l.id) AS rating_count,
             EXISTS(SELECT 1 FROM lecturer_waitlist w WHERE w.lecturer_id = l.id AND w.student_id = ?) AS on_waitlist
      FROM lecturers l
      LEFT JOIN lecturer_courses lc ON lc.lecturer_id = l.id
      WHERE l.is_verified = 1 AND l.is_active = 1
    `;
    if (search) {
      sql += ` AND (l.first_name ILIKE ? OR l.last_name ILIKE ? OR l.department ILIKE ? OR lc.course_name ILIKE ? OR lc.course_code ILIKE ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (department) {
      sql += ` AND LOWER(l.department) = LOWER(?)`;
      params.push(department);
    }
    sql += ` ORDER BY l.first_name ASC`;
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not load lecturers.' });
  }
});

/* List of departments (for filter dropdown) — grouped case-insensitively so
   "Computer Science" and "computer science" collapse into one entry instead
   of listing as two near-duplicate options. Picks whichever exact casing is
   most common as the display label. */
router.get('/departments', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT department, COUNT(*) AS n
       FROM lecturers WHERE is_verified = 1 AND is_active = 1
       GROUP BY department ORDER BY department ASC`
    );
    const byLower = new Map();
    for (const r of rows) {
      const key = r.department.toLowerCase();
      const current = byLower.get(key);
      if (!current || r.n > current.n) byLower.set(key, r);
    }
    const departments = [...byLower.values()].map((r) => r.department).sort((a, b) => a.localeCompare(b));
    res.json(departments);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not load departments.' });
  }
});

/* Single lecturer's availability — includes both open and already-booked
   slots so students can see the full picture (e.g. "1 of 3 booked") instead
   of booked slots just disappearing. Booked slots are returned without any
   identifying info about who booked them; the student can only act on the
   ones still marked 'open'. */
router.get('/lecturers/:id/availability', async (req, res) => {
  try {
    await expirePastSlots();
    const [rows] = await pool.query(
      `SELECT * FROM availability_slots
       WHERE lecturer_id = ? AND status IN ('open', 'booked') AND slot_date >= CURRENT_DATE
       ORDER BY slot_date ASC, start_time ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not load availability.' });
  }
});

/* A lecturer's courses — shown on their profile so a student knows what
   they teach before booking. Scoped to verified/active lecturers only,
   same visibility rule as the lecturer list and availability endpoints. */
router.get('/lecturers/:id/courses', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT lc.id, lc.course_code, lc.course_name
       FROM lecturer_courses lc
       JOIN lecturers l ON l.id = lc.lecturer_id
       WHERE lc.lecturer_id = ? AND l.is_verified = 1 AND l.is_active = 1
       ORDER BY lc.created_at ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not load courses.' });
  }
});

/* ------------------------------------------------------------------ */
/* "Notify me" waitlist — a student asks to hear about the next slot a    */
/* fully-booked lecturer opens up, instead of refreshing the page.        */
/* ------------------------------------------------------------------ */
router.post('/lecturers/:id/waitlist', async (req, res) => {
  try {
    const [[lecturer]] = [
      (await pool.query('SELECT id FROM lecturers WHERE id = ? AND is_verified = 1 AND is_active = 1', [req.params.id]))[0],
    ];
    if (!lecturer) return res.status(404).json({ message: 'Lecturer not found.' });

    await pool.query(
      'INSERT INTO lecturer_waitlist (student_id, lecturer_id) VALUES (?, ?) ON CONFLICT (student_id, lecturer_id) DO NOTHING',
      [req.user.id, req.params.id]
    );
    res.status(201).json({ message: "You'll be notified when a new slot opens up." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not join the waitlist.' });
  }
});

router.delete('/lecturers/:id/waitlist', async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM lecturer_waitlist WHERE student_id = ? AND lecturer_id = ?',
      [req.user.id, req.params.id]
    );
    res.json({ message: 'Removed from the waitlist.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not leave the waitlist.' });
  }
});

/* Book a slot */
router.post(
  '/bookings',
  [body('slotId').isInt().withMessage('A valid slot is required')],
  async (req, res) => {
    if (handleValidation(req, res)) return;
    const { slotId, reason } = req.body;
    const studentId = req.user.id;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [[slot]] = [
        (await conn.query('SELECT * FROM availability_slots WHERE id = ? FOR UPDATE', [slotId]))[0],
      ];
      if (!slot) {
        await conn.rollback();
        return res.status(404).json({ message: 'Slot not found.' });
      }
      if (slot.status !== 'open') {
        await conn.rollback();
        return res.status(409).json({ message: 'This slot has already been booked. Please choose another.' });
      }
      if (hasSlotPassed(slot)) {
        await conn.query(`UPDATE availability_slots SET status = 'expired' WHERE id = ?`, [slot.id]);
        await conn.commit();
        return res.status(409).json({ message: 'This slot\'s time has already passed. Please choose another.' });
      }

      const [result] = await conn.query(
        `INSERT INTO bookings (slot_id, student_id, lecturer_id, reason) VALUES (?, ?, ?, ?)`,
        [slotId, studentId, slot.lecturer_id, reason || null]
      );
      await conn.query(`UPDATE availability_slots SET status = 'booked' WHERE id = ?`, [slotId]);

      await conn.commit();

      await notify(
        slot.lecturer_id,
        'lecturer',
        'New booking request',
        `A student has requested a consultation slot on ${slot.slot_date} at ${slot.start_time}.`,
        'booking_created'
      );

      res.status(201).json({ message: 'Booking request sent! You will be notified once the lecturer responds.', id: result.insertId });
    } catch (err) {
      await conn.rollback();
      console.error(err);
      res.status(500).json({ message: 'Could not complete booking.' });
    } finally {
      conn.release();
    }
  }
);

/* Student's own bookings */
router.get('/bookings', async (req, res) => {
  try {
    await expirePastSlots();
    const [rows] = await pool.query(
      `SELECT b.*, s.slot_date, s.start_time, s.end_time, s.mode, s.venue, s.meeting_link, s.notes,
              l.first_name AS lecturer_first_name, l.last_name AS lecturer_last_name, l.department, l.title,
              l.avatar_url AS lecturer_avatar_url
       FROM bookings b
       JOIN availability_slots s ON s.id = b.slot_id
       JOIN lecturers l ON l.id = b.lecturer_id
       WHERE b.student_id = ? AND b.hidden_by_student = 0
       ORDER BY s.slot_date DESC, s.start_time DESC`,
      [req.user.id]
    );

    // Attach each lecturer's course list so a student can still see what a
    // booking's lecturer teaches after moving past the pre-booking dialog —
    // a second query (rather than a GROUP_CONCAT in the query above) so a
    // comma/pipe in a course name can't corrupt the parsing.
    const lecturerIds = [...new Set(rows.map((b) => b.lecturer_id))];
    if (lecturerIds.length) {
      const [courseRows] = await pool.query(
        `SELECT id, lecturer_id, course_code, course_name FROM lecturer_courses
         WHERE lecturer_id IN (?) ORDER BY created_at ASC`,
        [lecturerIds]
      );
      const byLecturer = {};
      for (const c of courseRows) {
        (byLecturer[c.lecturer_id] ||= []).push({ id: c.id, course_code: c.course_code, course_name: c.course_name });
      }
      for (const b of rows) {
        b.courses = byLecturer[b.lecturer_id] || [];
      }
    }

    // Attach this student's own rating for each booking (if any), so the
    // "rate this consultation" UI knows whether to show a form or the
    // already-submitted rating.
    const bookingIds = rows.map((b) => b.id);
    if (bookingIds.length) {
      const [ratingRows] = await pool.query(
        `SELECT booking_id, rating, comment FROM booking_ratings WHERE booking_id IN (?)`,
        [bookingIds]
      );
      const byBooking = new Map(ratingRows.map((r) => [r.booking_id, { rating: r.rating, comment: r.comment }]));
      for (const b of rows) {
        b.my_rating = byBooking.get(b.id) || null;
      }
    }

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not load bookings.' });
  }
});

/* Remove a booking from the student's own history (any status) */
router.delete('/bookings/:id', async (req, res) => {
  try {
    const [[booking]] = [
      (await pool.query('SELECT * FROM bookings WHERE id = ? AND student_id = ?', [
        req.params.id,
        req.user.id,
      ]))[0],
    ];
    if (!booking) return res.status(404).json({ message: 'Booking not found.' });

    await pool.query('UPDATE bookings SET hidden_by_student = 1 WHERE id = ?', [req.params.id]);
    await purgeIfFullyHidden(req.params.id);

    res.json({ message: 'Booking removed from your history.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not remove booking.' });
  }
});

/* Cancel own booking */
router.put('/bookings/:id/cancel', async (req, res) => {
  try {
    const [[booking]] = [
      (await pool.query('SELECT * FROM bookings WHERE id = ? AND student_id = ?', [
        req.params.id,
        req.user.id,
      ]))[0],
    ];
    if (!booking) return res.status(404).json({ message: 'Booking not found.' });
    if (!['pending', 'confirmed'].includes(booking.status)) {
      return res.status(400).json({ message: 'Only pending or confirmed bookings can be cancelled.' });
    }

    const [[slot]] = [
      (await pool.query('SELECT * FROM availability_slots WHERE id = ?', [booking.slot_id]))[0],
    ];

    await pool.query(`UPDATE bookings SET status = 'cancelled', cancelled_by = 'student' WHERE id = ?`, [
      req.params.id,
    ]);
    // Only reopen the slot if its time hasn't passed yet — cancelling a
    // confirmed booking after its own slot has lapsed shouldn't resurrect
    // it as a bookable "open" slot from the past.
    if (slot) {
      const newStatus = releaseSlotStatus(slot);
      await pool.query(`UPDATE availability_slots SET status = ? WHERE id = ?`, [newStatus, booking.slot_id]);
      if (newStatus === 'open') notifyWaitlist(booking.lecturer_id);
    }

    await notify(
      booking.lecturer_id,
      'lecturer',
      'Booking cancelled',
      `A student has cancelled their consultation booking.`,
      'booking_cancelled'
    );

    res.json({ message: 'Booking cancelled.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not cancel booking.' });
  }
});

/* Reschedule own booking to a different open slot with the same lecturer —
   moves the booking instead of making the student cancel and rebook from
   scratch. Resets status to 'pending' since the lecturer never agreed to
   this particular new time yet. */
router.put(
  '/bookings/:id/reschedule',
  [body('newSlotId').isInt().withMessage('A valid new slot is required')],
  async (req, res) => {
    if (handleValidation(req, res)) return;
    const { newSlotId } = req.body;
    const studentId = req.user.id;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [[booking]] = [
        (await conn.query('SELECT * FROM bookings WHERE id = ? AND student_id = ? FOR UPDATE', [
          req.params.id,
          studentId,
        ]))[0],
      ];
      if (!booking) {
        await conn.rollback();
        return res.status(404).json({ message: 'Booking not found.' });
      }
      if (!['pending', 'confirmed', 'expired'].includes(booking.status)) {
        await conn.rollback();
        return res.status(400).json({ message: 'Only pending, confirmed, or expired bookings can be rescheduled.' });
      }

      const [[oldSlot]] = [
        (await conn.query('SELECT * FROM availability_slots WHERE id = ? FOR UPDATE', [booking.slot_id]))[0],
      ];

      const [[newSlot]] = [
        (await conn.query('SELECT * FROM availability_slots WHERE id = ? FOR UPDATE', [newSlotId]))[0],
      ];
      if (!newSlot) {
        await conn.rollback();
        return res.status(404).json({ message: 'That slot no longer exists.' });
      }
      if (newSlot.lecturer_id !== booking.lecturer_id) {
        await conn.rollback();
        return res.status(400).json({ message: 'You can only reschedule to another slot with the same lecturer.' });
      }
      if (newSlot.id === booking.slot_id) {
        await conn.rollback();
        return res.status(400).json({ message: 'That is already your current slot.' });
      }
      if (newSlot.status !== 'open') {
        await conn.rollback();
        return res.status(409).json({ message: 'That slot has already been booked. Please choose another.' });
      }
      if (hasSlotPassed(newSlot)) {
        await conn.query(`UPDATE availability_slots SET status = 'expired' WHERE id = ?`, [newSlot.id]);
        await conn.commit();
        return res.status(409).json({ message: 'That slot\'s time has already passed. Please choose another.' });
      }

      // Release the old slot — back to 'open' if there's still time left on
      // it, or left/set 'expired' if it's already in the past (e.g. this
      // booking was itself expired). Guard for a slot that's already been
      // deleted by the lecturer out from under this booking.
      let oldSlotReopened = false;
      if (oldSlot) {
        const oldStatus = releaseSlotStatus(oldSlot);
        oldSlotReopened = oldStatus === 'open';
        await conn.query(`UPDATE availability_slots SET status = ? WHERE id = ?`, [oldStatus, booking.slot_id]);
      }
      await conn.query(`UPDATE availability_slots SET status = 'booked' WHERE id = ?`, [newSlot.id]);
      await conn.query(
        // reminder_sent resets too — a reminder already sent for the old
        // time doesn't cover this new one, and the booking isn't even
        // 'confirmed' again yet for the reminder sweep to consider it.
        `UPDATE bookings SET slot_id = ?, status = 'pending', cancelled_by = NULL, reminder_sent = 0 WHERE id = ?`,
        [newSlot.id, booking.id]
      );

      await conn.commit();
      if (oldSlotReopened) notifyWaitlist(booking.lecturer_id);

      await notify(
        booking.lecturer_id,
        'lecturer',
        'Booking rescheduled',
        `A student has moved their consultation to a new time: ${newSlot.slot_date} at ${newSlot.start_time}. Please confirm the new time.`,
        'booking_created'
      );

      res.json({ message: 'Booking rescheduled! The lecturer will need to confirm the new time.' });
    } catch (err) {
      await conn.rollback();
      console.error(err);
      res.status(500).json({ message: 'Could not reschedule booking.' });
    } finally {
      conn.release();
    }
  }
);

/* ------------------------------------------------------------------ */
/* Rating a completed consultation                                     */
/* ------------------------------------------------------------------ */
router.put(
  '/bookings/:id/rating',
  [
    body('rating').isInt({ min: 1, max: 5 }).withMessage('Rating must be between 1 and 5'),
    body('comment').optional({ nullable: true }).trim().isLength({ max: 500 }).withMessage('Comment is too long'),
  ],
  async (req, res) => {
    if (handleValidation(req, res)) return;
    const { rating, comment } = req.body;
    try {
      const [[booking]] = [
        (await pool.query('SELECT * FROM bookings WHERE id = ? AND student_id = ?', [req.params.id, req.user.id]))[0],
      ];
      if (!booking) return res.status(404).json({ message: 'Booking not found.' });
      if (booking.status !== 'completed') {
        return res.status(409).json({ message: 'Only a completed consultation can be rated.' });
      }

      // One rating per booking — a second submission edits the first
      // instead of creating a duplicate row.
      await pool.query(
        `INSERT INTO booking_ratings (booking_id, lecturer_id, student_id, rating, comment)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (booking_id) DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment`,
        [booking.id, booking.lecturer_id, req.user.id, rating, comment || null]
      );

      res.json({ message: 'Thanks for the feedback!' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Could not save your rating.' });
    }
  }
);

module.exports = router;
