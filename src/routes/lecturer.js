const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool } = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { notify } = require('../utils/notify');
const { purgeIfFullyHidden } = require('../utils/bookingVisibility');
const { expirePastSlots, releaseSlotStatus } = require('../utils/expireSlots');
const { notifyWaitlist } = require('../utils/waitlist');

const router = express.Router();
router.use(requireAuth, requireRole('lecturer'));

function handleValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ message: errors.array()[0].msg });
    return true;
  }
  return false;
}

/** Add `minutes` to a "HH:MM" string and return a new "HH:MM" string. */
function addMinutes(timeStr, minutes) {
  const [h, m] = timeStr.split(':').map(Number);
  const total = h * 60 + m + minutes;
  const hh = String(Math.floor(total / 60) % 24).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Add `days` to a "YYYY-MM-DD" string and return a new "YYYY-MM-DD" string.
 *  Does the math in UTC so it's immune to the server's local timezone / DST. */
function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/* ------------------------------------------------------------------ */
/* Dashboard summary                                                   */
/* ------------------------------------------------------------------ */
router.get('/summary', async (req, res) => {
  const lecturerId = req.user.id;
  try {
    await expirePastSlots();
    const [[{ openSlots }]] = await pool.query(
      `SELECT COUNT(*) AS "openSlots" FROM availability_slots WHERE lecturer_id = ? AND status = 'open'`,
      [lecturerId]
    );
    const [[{ pendingBookings }]] = await pool.query(
      `SELECT COUNT(*) AS "pendingBookings" FROM bookings WHERE lecturer_id = ? AND status = 'pending'`,
      [lecturerId]
    );
    const [[{ upcomingConfirmed }]] = await pool.query(
      `SELECT COUNT(*) AS "upcomingConfirmed" FROM bookings b
       JOIN availability_slots s ON s.id = b.slot_id
       WHERE b.lecturer_id = ? AND b.status = 'confirmed' AND s.slot_date >= CURRENT_DATE`,
      [lecturerId]
    );
    const [[{ totalStudents }]] = await pool.query(
      `SELECT COUNT(DISTINCT student_id) AS "totalStudents" FROM bookings WHERE lecturer_id = ?`,
      [lecturerId]
    );
    const [[{ avgRating, ratingCount }]] = await pool.query(
      `SELECT ROUND(AVG(rating), 1) AS "avgRating", COUNT(*) AS "ratingCount" FROM booking_ratings WHERE lecturer_id = ?`,
      [lecturerId]
    );
    res.json({ openSlots, pendingBookings, upcomingConfirmed, totalStudents, avgRating, ratingCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not load dashboard summary.' });
  }
});

/* ------------------------------------------------------------------ */
/* Availability: create                                                */
/* ------------------------------------------------------------------ */
router.post(
  '/availability',
  [
    body('slotDate').notEmpty().withMessage('Date is required'),
    body('startTime').notEmpty().withMessage('Start time is required'),
    body('endTime').notEmpty().withMessage('End time is required'),
    body('mode').isIn(['online', 'in_person']).withMessage('Mode must be online or in_person'),
    body('slotDurationMinutes')
      .isInt({ min: 5 })
      .withMessage('Slot duration must be at least 5 minutes'),
    body('repeatWeeks')
      .optional({ nullable: true })
      .isInt({ min: 1, max: 12 })
      .withMessage('Repeat must be between 1 and 12 weeks'),
  ],
  async (req, res) => {
    if (handleValidation(req, res)) return;
    const { slotDate, startTime, endTime, mode, venue, meetingLink, notes } = req.body;
    const slotDurationMinutes = Number(req.body.slotDurationMinutes);
    // 1 = just the chosen date, no repeat. Anything higher repeats weekly
    // on the same weekday for that many total occurrences.
    const repeatWeeks = req.body.repeatWeeks ? Number(req.body.repeatWeeks) : 1;

    if (mode === 'in_person' && !venue) {
      return res.status(400).json({ message: 'Venue is required for in-person consultations.' });
    }
    if (mode === 'online' && !meetingLink) {
      return res.status(400).json({ message: 'A meeting link is required for online consultations.' });
    }

    const start = new Date(`1970-01-01T${startTime}`);
    const end = new Date(`1970-01-01T${endTime}`);
    const windowMinutes = Math.round((end - start) / 60000);
    if (windowMinutes <= 0) {
      return res.status(400).json({ message: 'End time must be after start time.' });
    }

    // Split the start–end window into back-to-back bookable slots of
    // `slotDurationMinutes` each, so students see every individual opening
    // instead of one big block they'd have to book in full.
    const slotsPerDay = Math.floor(windowMinutes / slotDurationMinutes);
    if (slotsPerDay < 1) {
      return res.status(400).json({
        message: `Slot duration (${slotDurationMinutes} min) is longer than the selected time range (${windowMinutes} min).`,
      });
    }

    // "Repeat weekly" just means: generate the exact same day's worth of
    // slots again on the same weekday, `repeatWeeks` total times.
    const occurrenceDates = Array.from({ length: repeatWeeks }, (_, w) => addDays(slotDate, w * 7));

    try {
      // Reject the whole request if any occurrence date already has active
      // availability that overlaps this window — otherwise a lecturer could
      // end up with two bookable slot rows covering the same time, and get
      // double-booked if students take both.
      const [[conflict]] = [
        (await pool.query(
          `SELECT slot_date, start_time, end_time FROM availability_slots
           WHERE lecturer_id = ? AND status IN ('open', 'booked')
             AND slot_date IN (${occurrenceDates.map(() => '?').join(', ')})
             AND start_time < ? AND end_time > ?
           ORDER BY slot_date ASC, start_time ASC
           LIMIT 1`,
          [req.user.id, ...occurrenceDates, endTime, startTime]
        ))[0],
      ];
      if (conflict) {
        return res.status(409).json({
          message: `You already have availability from ${conflict.start_time} to ${conflict.end_time} on ${conflict.slot_date} that overlaps this request. Choose a different time, or remove the existing slot first.`,
        });
      }

      const rows = [];
      const values = [];
      for (const date of occurrenceDates) {
        for (let i = 0; i < slotsPerDay; i++) {
          const slotStart = addMinutes(startTime, i * slotDurationMinutes);
          const slotEnd = addMinutes(startTime, (i + 1) * slotDurationMinutes);
          rows.push('(?, ?, ?, ?, ?, ?, ?, ?, ?)');
          values.push(
            req.user.id,
            date,
            slotStart,
            slotEnd,
            slotDurationMinutes,
            mode,
            mode === 'in_person' ? venue : null,
            mode === 'online' ? meetingLink : null,
            notes || null
          );
        }
      }

      await pool.query(
        `INSERT INTO availability_slots
          (lecturer_id, slot_date, start_time, end_time, duration_minutes, mode, venue, meeting_link, notes)
         VALUES ${rows.join(', ')}`,
        values
      );
      notifyWaitlist(req.user.id);

      const slotsGenerated = rows.length;
      const message = repeatWeeks > 1
        ? `${slotsGenerated} availability slots created — ${slotsPerDay} per week, repeating weekly for ${repeatWeeks} weeks.`
        : `${slotsGenerated} availability slot${slotsGenerated === 1 ? '' : 's'} of ${slotDurationMinutes} min each created.`;

      res.status(201).json({
        message,
        slotsGenerated,
        slotDurationMinutes,
        weeksGenerated: repeatWeeks,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Could not create availability slot.' });
    }
  }
);

/* Availability: list own slots (completed ones are cleared off this list —
   the finished consultation still lives in the Bookings tab as history —
   and so are expired ones: an unbooked slot whose time has passed is just
   dead weight, same treatment as 'completed') */
router.get('/availability', async (req, res) => {
  try {
    await expirePastSlots();
    const [rows] = await pool.query(
      `SELECT * FROM availability_slots WHERE lecturer_id = ? AND status NOT IN ('completed', 'expired') ORDER BY slot_date ASC, start_time ASC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not load availability.' });
  }
});

/* Availability: delete (only if not booked) */
router.delete('/availability/:id', async (req, res) => {
  try {
    const [[slot]] = [
      (await pool.query('SELECT * FROM availability_slots WHERE id = ? AND lecturer_id = ?', [
        req.params.id,
        req.user.id,
      ]))[0],
    ];
    if (!slot) return res.status(404).json({ message: 'Slot not found.' });
    if (slot.status === 'booked') {
      return res.status(400).json({ message: 'Cannot delete a slot that already has a booking. Cancel the booking first.' });
    }
    await pool.query('DELETE FROM availability_slots WHERE id = ?', [req.params.id]);
    res.json({ message: 'Slot removed.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not delete slot.' });
  }
});

/* ------------------------------------------------------------------ */
/* Bookings: list bookings made against this lecturer                  */
/* ------------------------------------------------------------------ */
router.get('/bookings', async (req, res) => {
  try {
    await expirePastSlots();
    const [rows] = await pool.query(
      `SELECT b.*, s.slot_date, s.start_time, s.end_time, s.mode, s.venue, s.meeting_link, s.notes,
              st.first_name AS student_first_name, st.last_name AS student_last_name,
              st.student_id, st.programme, st.email AS student_email, st.avatar_url AS student_avatar_url
       FROM bookings b
       JOIN availability_slots s ON s.id = b.slot_id
       JOIN students st ON st.id = b.student_id
       WHERE b.lecturer_id = ? AND b.hidden_by_lecturer = 0
       ORDER BY s.slot_date DESC, s.start_time DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not load bookings.' });
  }
});

/* Bookings: remove from lecturer's own history (any status) */
router.delete('/bookings/:id', async (req, res) => {
  try {
    const [[booking]] = [
      (await pool.query('SELECT * FROM bookings WHERE id = ? AND lecturer_id = ?', [
        req.params.id,
        req.user.id,
      ]))[0],
    ];
    if (!booking) return res.status(404).json({ message: 'Booking not found.' });

    await pool.query('UPDATE bookings SET hidden_by_lecturer = 1 WHERE id = ?', [req.params.id]);
    await purgeIfFullyHidden(req.params.id);

    res.json({ message: 'Booking removed from your history.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not remove booking.' });
  }
});

/* Bookings: respond (confirm / decline / complete / no_show) */
router.put('/bookings/:id', async (req, res) => {
  const { status } = req.body; // confirmed | declined | completed | no_show
  if (!['confirmed', 'declined', 'completed', 'no_show'].includes(status)) {
    return res.status(400).json({ message: 'Invalid status.' });
  }
  try {
    const [[booking]] = [
      (await pool.query('SELECT * FROM bookings WHERE id = ? AND lecturer_id = ?', [
        req.params.id,
        req.user.id,
      ]))[0],
    ];
    if (!booking) return res.status(404).json({ message: 'Booking not found.' });

    if (['confirmed', 'declined'].includes(status) && booking.status !== 'pending') {
      return res.status(409).json({
        message: booking.status === 'expired'
          ? 'This request already expired because it wasn\'t answered in time — the student will need to book another slot.'
          : `This booking is already ${booking.status} and can no longer be responded to.`,
      });
    }
    if (['completed', 'no_show'].includes(status) && booking.status !== 'confirmed') {
      return res.status(409).json({ message: `Only a confirmed booking can be marked ${status === 'completed' ? 'complete' : 'no-show'} (this one is ${booking.status}).` });
    }

    await pool.query('UPDATE bookings SET status = ? WHERE id = ?', [status, req.params.id]);

    if (status === 'declined') {
      const [[slot]] = [
        (await pool.query('SELECT * FROM availability_slots WHERE id = ?', [booking.slot_id]))[0],
      ];
      if (slot) {
        const newStatus = releaseSlotStatus(slot);
        await pool.query(`UPDATE availability_slots SET status = ? WHERE id = ?`, [newStatus, booking.slot_id]);
        if (newStatus === 'open') notifyWaitlist(req.user.id);
      }
    } else if (status === 'completed' || status === 'no_show') {
      // Either way the consultation's time has passed — drop the slot off
      // the lecturer's active availability list instead of leaving it
      // sitting there as "booked". The distinction between the two only
      // matters on the booking itself.
      await pool.query(`UPDATE availability_slots SET status = 'completed' WHERE id = ?`, [booking.slot_id]);
    }

    const label = { confirmed: 'confirmed', declined: 'declined', completed: 'marked complete', no_show: 'marked as a no-show' }[status];
    await notify(
      booking.student_id,
      'student',
      'Booking update',
      status === 'no_show'
        ? 'Your lecturer marked this confirmed consultation as a no-show.'
        : `Your consultation booking has been ${label} by the lecturer.`,
      `booking_${status}`
    );

    res.json({ message: `Booking ${label}.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not update booking.' });
  }
});

/* Bookings: lecturer-initiated cancellation of an already-confirmed booking
   — the mirror of the student's own cancel. Pending requests already have
   Decline for this; this covers the case where the lecturer agreed to a
   time and then can't make it anymore (emergency, conflict, etc.). */
router.put(
  '/bookings/:id/cancel',
  [body('reason').optional({ nullable: true }).isLength({ max: 500 }).withMessage('Reason is too long')],
  async (req, res) => {
    if (handleValidation(req, res)) return;
    const { reason } = req.body;
    try {
      const [[booking]] = [
        (await pool.query('SELECT * FROM bookings WHERE id = ? AND lecturer_id = ?', [
          req.params.id,
          req.user.id,
        ]))[0],
      ];
      if (!booking) return res.status(404).json({ message: 'Booking not found.' });
      if (booking.status !== 'confirmed') {
        return res.status(409).json({ message: `Only a confirmed booking can be cancelled this way (this one is ${booking.status}).` });
      }

      await pool.query(
        `UPDATE bookings SET status = 'cancelled', cancelled_by = 'lecturer', cancel_reason = ? WHERE id = ?`,
        [reason || null, req.params.id]
      );

      const [[slot]] = [
        (await pool.query('SELECT * FROM availability_slots WHERE id = ?', [booking.slot_id]))[0],
      ];
      if (slot) {
        const newStatus = releaseSlotStatus(slot);
        await pool.query(`UPDATE availability_slots SET status = ? WHERE id = ?`, [newStatus, booking.slot_id]);
        if (newStatus === 'open') notifyWaitlist(req.user.id);
      }

      await notify(
        booking.student_id,
        'student',
        'Booking cancelled by lecturer',
        reason
          ? `The lecturer had to cancel your confirmed consultation. Reason: "${reason}"`
          : 'The lecturer had to cancel your confirmed consultation.',
        'booking_cancelled'
      );

      res.json({ message: 'Booking cancelled and the student notified.' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Could not cancel booking.' });
    }
  }
);

/* ------------------------------------------------------------------ */
/* Courses taught — shown on this lecturer's profile to students        */
/* ------------------------------------------------------------------ */
router.get('/courses', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM lecturer_courses WHERE lecturer_id = ? ORDER BY created_at ASC',
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not load courses.' });
  }
});

router.post(
  '/courses',
  [
    body('courseName').trim().notEmpty().withMessage('Course name is required')
      .isLength({ max: 150 }).withMessage('Course name is too long'),
    body('courseCode').optional({ nullable: true }).trim().isLength({ max: 20 }).withMessage('Course code is too long'),
  ],
  async (req, res) => {
    if (handleValidation(req, res)) return;
    const { courseName, courseCode } = req.body;
    try {
      // A generous but real cap — stops a runaway client/script from
      // spamming thousands of rows onto one lecturer's profile.
      const [[{ count }]] = await pool.query(
        'SELECT COUNT(*) AS count FROM lecturer_courses WHERE lecturer_id = ?',
        [req.user.id]
      );
      if (count >= 50) {
        return res.status(400).json({ message: 'You can list up to 50 courses. Remove one before adding another.' });
      }

      const [result] = await pool.query(
        'INSERT INTO lecturer_courses (lecturer_id, course_code, course_name) VALUES (?, ?, ?)',
        [req.user.id, courseCode || null, courseName]
      );
      res.status(201).json({ id: result.insertId, lecturer_id: req.user.id, course_code: courseCode || null, course_name: courseName });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Could not add course.' });
    }
  }
);

router.delete('/courses/:id', async (req, res) => {
  try {
    const [[course]] = [
      (await pool.query('SELECT * FROM lecturer_courses WHERE id = ? AND lecturer_id = ?', [
        req.params.id,
        req.user.id,
      ]))[0],
    ];
    if (!course) return res.status(404).json({ message: 'Course not found.' });

    await pool.query('DELETE FROM lecturer_courses WHERE id = ?', [req.params.id]);
    res.json({ message: 'Course removed.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not remove course.' });
  }
});

module.exports = router;
