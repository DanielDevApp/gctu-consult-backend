const { pool } = require('../config/db');
const { notify } = require('./notify');

// How long before a confirmed consultation's start time the reminder fires.
// Configurable so a deployment can tune it without a code change.
const REMINDER_MINUTES_BEFORE = Number(process.env.REMINDER_MINUTES_BEFORE) || 60;

/**
 * Nudges both sides of a confirmed booking shortly before it starts. Runs
 * on a periodic sweep (see server.js) rather than inline on a route, since
 * it's a proactive notification, not something that gates a request's
 * correctness the way slot/booking expiry does.
 *
 * Fires once per booking: the WHERE clause only ever matches bookings still
 * `reminder_sent = 0`, and the UPDATE that flips it is guarded by the same
 * condition, so a slow sweep overlapping the next one can't double-send.
 */
async function sendUpcomingReminders() {
  try {
    const [rows] = await pool.query(
      `SELECT b.id, b.student_id, b.lecturer_id, s.slot_date, s.start_time, s.mode, s.venue, s.meeting_link,
              st.first_name AS student_first_name, st.last_name AS student_last_name,
              l.first_name AS lecturer_first_name, l.last_name AS lecturer_last_name
       FROM bookings b
       JOIN availability_slots s ON s.id = b.slot_id
       JOIN students st ON st.id = b.student_id
       JOIN lecturers l ON l.id = b.lecturer_id
       WHERE b.status = 'confirmed' AND b.reminder_sent = 0
         AND (s.slot_date + s.start_time) > LOCALTIMESTAMP
         AND (s.slot_date + s.start_time) <= LOCALTIMESTAMP + (?::double precision * INTERVAL '1 minute')`,
      [REMINDER_MINUTES_BEFORE]
    );

    for (const row of rows) {
      const [result] = await pool.query(
        `UPDATE bookings SET reminder_sent = 1 WHERE id = ? AND reminder_sent = 0`,
        [row.id]
      );
      if (result.affectedRows === 0) continue;

      const when = `${row.slot_date} at ${row.start_time}`;
      const whereInfo = row.mode === 'online'
        ? (row.meeting_link ? ` The meeting link is on your dashboard.` : '')
        : (row.venue ? ` Location: ${row.venue}.` : '');

      await notify(
        row.student_id,
        'student',
        'Upcoming consultation',
        `Reminder: your consultation with ${row.lecturer_first_name} ${row.lecturer_last_name} is coming up on ${when}.${whereInfo}`,
        'booking_reminder'
      );
      await notify(
        row.lecturer_id,
        'lecturer',
        'Upcoming consultation',
        `Reminder: your consultation with ${row.student_first_name} ${row.student_last_name} is coming up on ${when}.`,
        'booking_reminder'
      );
    }
  } catch (err) {
    console.error('Failed to send upcoming-consultation reminders:', err.message);
  }
}

module.exports = { sendUpcomingReminders };
