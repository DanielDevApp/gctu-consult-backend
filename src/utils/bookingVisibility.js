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

/**
 * A booking can only be cleared from someone's history once it has actually
 * finished — cancelled, declined, expired, completed, or marked a no-show.
 * A live booking (pending or confirmed, including one mid-session or waiting
 * on the lecturer to record attendance) is not deletable by anyone: deleting
 * it would let either side make an in-flight commitment disappear from their
 * own view while the other party still shows up for it. The way out of a live
 * booking is to cancel it, which both sides can see and be notified about.
 */
const REMOVABLE_STATUSES = ['cancelled', 'declined', 'expired', 'completed', 'no_show'];

function canRemoveFromHistory(status) {
  return REMOVABLE_STATUSES.includes(status);
}

/** Why a live booking can't be deleted, phrased for whoever is asking. */
function removalBlockedMessage(status, viewer) {
  if (status === 'pending') {
    return viewer === 'lecturer'
      ? 'This request is still awaiting your response — confirm or decline it first. You can only clear a booking from your history once it has finished.'
      : "This request is still awaiting the lecturer's response. Cancel it if you no longer need it — you can only remove a booking from your history once it has finished.";
  }
  return viewer === 'lecturer'
    ? 'This consultation is still active. Mark it complete or as a no-show once its time has passed (or cancel it) — a live booking can\'t be removed from your history.'
    : 'This consultation is still active. Cancel it if you can no longer attend — a live booking can\'t be removed from your history until it has finished.';
}

module.exports = { purgeIfFullyHidden, REMOVABLE_STATUSES, canRemoveFromHistory, removalBlockedMessage };
