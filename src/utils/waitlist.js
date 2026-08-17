const { pool } = require('../config/db');
const { notify } = require('./notify');

/**
 * Tells every student on a lecturer's "notify me" waitlist that a new slot
 * just opened up. Called at every place an availability_slots row becomes
 * 'open' — freshly created, or released back open by a decline/cancel/
 * reschedule — so a student doesn't have to keep refreshing a fully-booked
 * lecturer's profile.
 *
 * Fire-and-forget from the caller's perspective (same pattern as `notify`
 * itself): failures are logged, never thrown, so a notification hiccup
 * can't take down the booking/availability action that triggered it.
 */
async function notifyWaitlist(lecturerId) {
  try {
    const [[lecturer]] = [
      (await pool.query('SELECT first_name, last_name FROM lecturers WHERE id = ?', [lecturerId]))[0],
    ];
    if (!lecturer) return;

    const [waiters] = await pool.query(
      'SELECT student_id FROM lecturer_waitlist WHERE lecturer_id = ?',
      [lecturerId]
    );
    if (!waiters.length) return;

    const name = `${lecturer.first_name} ${lecturer.last_name}`;
    for (const w of waiters) {
      await notify(
        w.student_id,
        'student',
        'A slot just opened up',
        `${name} has a new open consultation slot. Book it before it's taken.`,
        'waitlist_slot_open'
      );
    }
  } catch (err) {
    console.error('Failed to notify waitlist:', err.message);
  }
}

module.exports = { notifyWaitlist };
