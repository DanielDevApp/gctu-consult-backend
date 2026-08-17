const { pool } = require('../config/db');

/**
 * A booking is only ever hard-deleted once every party who could see it
 * (student, lecturer, admin) has individually cleared it from their own
 * history. Until then, "deleting" a booking just hides it from that one
 * viewer via the hidden_by_* flags — the row still exists so the other
 * parties keep their own copy of the history.
 */
async function purgeIfFullyHidden(bookingId) {
  const [[booking]] = [
    (await pool.query(
      'SELECT hidden_by_student, hidden_by_lecturer, hidden_by_admin FROM bookings WHERE id = ?',
      [bookingId]
    ))[0],
  ];
  if (booking && booking.hidden_by_student && booking.hidden_by_lecturer && booking.hidden_by_admin) {
    await pool.query('DELETE FROM bookings WHERE id = ?', [bookingId]);
  }
}

module.exports = { purgeIfFullyHidden };
