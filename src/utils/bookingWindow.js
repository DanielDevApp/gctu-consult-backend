/**
 * "One booking per availability window."
 *
 * A lecturer publishes availability as a *window* — "Monday 9:00–11:00, 30
 * minutes each" becomes one window of four bookable slots (a weekly repeat
 * makes a separate window per occurrence date). Without a rule here, one
 * student could take every slot in that window and lock the lecturer's whole
 * consultation period to themselves. So a student may hold at most one
 * booking per window, per lecturer; once that lecturer opens a *different*
 * window, the student can book again.
 *
 * Only bookings that actually consumed the student's turn count: pending and
 * confirmed (still live), completed and no_show (the meeting slot was spent
 * either way — a student who skipped their own consultation doesn't get a
 * second bite at the same window). Cancelled, declined and expired bookings
 * released the slot, so they don't block a re-book.
 */

const { formatSlotTime } = require('./time');

const BLOCKING_STATUSES = ['pending', 'confirmed', 'completed', 'no_show'];

/**
 * Builds the SQL fragment that matches "the same window as `slot`". Slots
 * created before window_id existed are backfilled on boot (see ensureSchema),
 * but a null still degrades sanely to same-lecturer-same-day rather than
 * matching nothing.
 */
function sameWindowClause(slot) {
  return slot.window_id != null
    ? { sql: 's.window_id = ?', param: slot.window_id }
    : { sql: '(s.window_id IS NULL AND s.slot_date = ?)', param: slot.slot_date };
}

/**
 * Serializes concurrent booking attempts by the same student against the same
 * window, so two requests fired at once can't both pass the check below and
 * each insert a booking. Transaction-scoped: released on commit/rollback.
 * Must be called inside a transaction, before findWindowConflict.
 *
 * A null window_id (legacy slot) locks on key 0, which is broader than needed
 * — it serializes that student's legacy-slot bookings as a group. Safe, and
 * nothing hits that path after the boot-time backfill.
 */
async function lockStudentWindow(conn, studentId, slot) {
  await conn.query('SELECT pg_advisory_xact_lock(?, ?)', [studentId, slot.window_id ?? 0]);
}

/**
 * Returns the booking that already occupies this student's turn in `slot`'s
 * window, or null if they're free to book. `excludeBookingId` skips the
 * booking being moved, so a reschedule within its own window isn't blocked
 * by itself.
 */
async function findWindowConflict(db, { studentId, slot, excludeBookingId = null }) {
  const window = sameWindowClause(slot);
  const params = [studentId, slot.lecturer_id, window.param];
  let sql = `
    SELECT b.id, b.status, s.slot_date, s.start_time, s.end_time
    FROM bookings b
    JOIN availability_slots s ON s.id = b.slot_id
    WHERE b.student_id = ? AND b.lecturer_id = ?
      AND b.status IN ('${BLOCKING_STATUSES.join("','")}')
      AND ${window.sql}`;
  if (excludeBookingId != null) {
    sql += ' AND b.id <> ?';
    params.push(excludeBookingId);
  }
  sql += ' ORDER BY s.start_time ASC LIMIT 1';

  const [rows] = await db.query(sql, params);
  return rows[0] || null;
}

/** The message a student sees when they've already used their turn. */
function windowConflictMessage(conflict) {
  const when = `${conflict.slot_date} at ${formatSlotTime(conflict.start_time)}`;
  const held = {
    pending: 'a booking request awaiting this lecturer\'s response',
    confirmed: 'a confirmed booking',
    completed: 'a completed consultation',
    no_show: 'a booking that was marked as a no-show',
  }[conflict.status] || 'a booking';

  return `You already have ${held} with this lecturer in this consultation window (${when}). Only one slot per window can be booked, so other students get a turn — you can book again once this lecturer opens a new availability window.`;
}

/**
 * Marks each slot with whether this student has already used their turn in
 * that slot's window — so the booking dialog can grey those out up front
 * instead of letting the student pick one and get rejected on submit.
 * `excludeBookingId` is the booking being rescheduled, if any.
 */
async function markBlockedWindows(db, slots, studentId, excludeBookingId = null) {
  if (!slots.length) return slots;

  const params = [studentId];
  let sql = `
    SELECT s.window_id, s.slot_date
    FROM bookings b
    JOIN availability_slots s ON s.id = b.slot_id
    WHERE b.student_id = ?
      AND b.status IN ('${BLOCKING_STATUSES.join("','")}')`;
  if (excludeBookingId != null) {
    sql += ' AND b.id <> ?';
    params.push(excludeBookingId);
  }

  const [rows] = await db.query(sql, params);
  const takenWindows = new Set(rows.filter((r) => r.window_id != null).map((r) => r.window_id));
  const takenDates = new Set(rows.filter((r) => r.window_id == null).map((r) => r.slot_date));

  for (const slot of slots) {
    slot.already_booked_in_window = slot.window_id != null
      ? takenWindows.has(slot.window_id)
      : takenDates.has(slot.slot_date);
  }
  return slots;
}

module.exports = {
  BLOCKING_STATUSES,
  lockStudentWindow,
  findWindowConflict,
  windowConflictMessage,
  markBlockedWindows,
};
