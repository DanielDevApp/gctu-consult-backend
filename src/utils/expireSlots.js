const { pool } = require('../config/db');
const { notify } = require('./notify');

/** True once a slot's date+end_time is behind the server clock. Shared by
 *  every route that needs to reject or clean up a slot whose window has
 *  already closed (booking creation, cancel, reschedule, decline). */
function hasSlotPassed(slot) {
  return new Date(`${slot.slot_date}T${slot.end_time}`) <= new Date();
}

/** What an availability slot should become once its booking is released
 *  (cancelled, declined, or moved elsewhere via reschedule). A slot whose
 *  time window is still ahead of us goes back to 'open' so someone else can
 *  book it; one whose time has already passed goes to 'expired' instead —
 *  reopening a slot that's already in the past would just leave a dead,
 *  unbookable "open" slot sitting around until the next sweep quietly
 *  expires it anyway. */
function releaseSlotStatus(slot) {
  return hasSlotPassed(slot) ? 'expired' : 'open';
}

/**
 * A booking left 'pending' — the lecturer never confirmed or declined it —
 * whose slot's time has now passed can't go anywhere: the consultation
 * time is gone, so there's nothing left for the lecturer to confirm. This
 * closes those out as 'expired' (distinct from 'declined', since the
 * lecturer never actually rejected it — the clock just ran out), frees the
 * slot the same way, and lets both sides know so the student can book a
 * new time instead of a stale request sitting there forever.
 */
async function expirePendingBookings() {
  try {
    const [rows] = await pool.query(
      `SELECT b.id, b.slot_id, b.student_id, b.lecturer_id, s.slot_date, s.start_time
       FROM bookings b
       JOIN availability_slots s ON s.id = b.slot_id
       WHERE b.status = 'pending'
         AND (s.slot_date < CURRENT_DATE OR (s.slot_date = CURRENT_DATE AND s.end_time <= LOCALTIME))`
    );

    for (const row of rows) {
      // Guard the UPDATE with status = 'pending' so a concurrent sweep (the
      // 60s server timer vs. an inline route-level call) can't process the
      // same booking twice and send duplicate notifications.
      const [result] = await pool.query(
        `UPDATE bookings SET status = 'expired' WHERE id = ? AND status = 'pending'`,
        [row.id]
      );
      if (result.affectedRows === 0) continue;

      await pool.query(`UPDATE availability_slots SET status = 'expired' WHERE id = ?`, [row.slot_id]);

      const when = `${row.slot_date} at ${row.start_time}`;
      await notify(
        row.student_id,
        'student',
        'Booking request expired',
        `Your consultation request for ${when} expired because the lecturer didn't respond before the slot's time passed. Please book another slot.`,
        'booking_expired'
      );
      await notify(
        row.lecturer_id,
        'lecturer',
        'Pending request expired',
        `A consultation request for ${when} expired because it wasn't confirmed or declined before the slot's time passed.`,
        'booking_expired'
      );
    }
  } catch (err) {
    console.error('Failed to expire past-due pending bookings:', err.message);
  }
}

/**
 * Flip any 'open' availability slot whose time window has already passed
 * into 'expired', so it stops being offered to students (or shown as live
 * on the lecturer's dashboard) the moment its end time is behind us.
 *
 * Compares against the DB server's own clock (CURRENT_DATE/LOCALTIME)
 * rather than Node's, so it stays consistent with the date filters every
 * other query in this app already uses (`slot_date >= CURRENT_DATE`).
 */
async function expirePastSlots() {
  // Pending bookings first — this also flips their (currently 'booked')
  // slot to 'expired', so by the time the plain 'open' sweep below runs
  // there's nothing left for it to double-handle.
  await expirePendingBookings();

  try {
    await pool.query(
      `UPDATE availability_slots
       SET status = 'expired'
       WHERE status = 'open'
         AND (slot_date < CURRENT_DATE OR (slot_date = CURRENT_DATE AND end_time <= LOCALTIME))`
    );
  } catch (err) {
    console.error('Failed to expire past availability slots:', err.message);
  }
}

module.exports = { expirePastSlots, hasSlotPassed, releaseSlotStatus };
