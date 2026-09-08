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

/** The bulk counterpart of purgeIfFullyHidden — one sweep instead of a
 *  round trip per booking, for the "clear my whole history" path. */
async function purgeAllFullyHidden() {
  await pool.query(
    `DELETE FROM bookings WHERE hidden_by_student = 1 AND hidden_by_lecturer = 1 AND hidden_by_admin = 1`
  );
}

const HIDE_COLUMN = {
  student: 'hidden_by_student',
  lecturer: 'hidden_by_lecturer',
  admin: 'hidden_by_admin',
};

/**
 * Clears every finished booking out of one viewer's history in a single go,
 * so a long-running account doesn't have to delete them one at a time.
 *
 * Deliberately leaves live bookings in place rather than refusing the whole
 * request because of them: "clear all" means "clear everything that's done",
 * and a pending or confirmed consultation is still going to happen. The
 * returned counts let the caller say so plainly instead of the user noticing
 * some rows survived and assuming it half-failed.
 *
 * Admin isn't a party to any booking, so it clears across all of them; the
 * student and lecturer views are scoped to their own.
 */
async function clearFinishedFromHistory(viewer, userId) {
  const column = HIDE_COLUMN[viewer];
  if (!column) throw new Error(`Unknown viewer: ${viewer}`);

  const ownerClause = viewer === 'admin' ? '' : ` AND ${viewer}_id = ?`;
  const params = viewer === 'admin' ? [] : [userId];
  const statuses = REMOVABLE_STATUSES.map((s) => `'${s}'`).join(', ');

  const [result] = await pool.query(
    `UPDATE bookings SET ${column} = 1
     WHERE ${column} = 0${ownerClause} AND status IN (${statuses})`,
    params
  );
  const [[{ kept }]] = [
    (await pool.query(
      `SELECT COUNT(*) AS kept FROM bookings WHERE ${column} = 0${ownerClause}`,
      params
    ))[0],
  ];

  await purgeAllFullyHidden();
  return { cleared: result.affectedRows, kept };
}

/** Wording for the result of a bulk clear, including why anything survived. */
function clearHistoryMessage({ cleared, kept }) {
  if (cleared === 0) {
    return kept > 0
      ? `Nothing to clear — all ${kept} of your bookings are still active. They can be cleared once they've finished.`
      : 'Your booking history is already empty.';
  }
  const base = `Cleared ${cleared} finished booking${cleared === 1 ? '' : 's'} from your history.`;
  return kept > 0
    ? `${base} ${kept} active booking${kept === 1 ? '' : 's'} kept — those can be cleared once they've finished.`
    : base;
}

module.exports = {
  purgeIfFullyHidden,
  purgeAllFullyHidden,
  clearFinishedFromHistory,
  clearHistoryMessage,
  REMOVABLE_STATUSES,
  canRemoveFromHistory,
  removalBlockedMessage,
};
