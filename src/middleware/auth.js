const { verifyToken } = require('../utils/token');
const { pool } = require('../config/db');

const ACCOUNT_TABLE = { student: 'students', lecturer: 'lecturers', admin: 'admins' };

/**
 * Authenticates a request, then confirms the account behind the token is
 * still usable.
 *
 * The database check is the point. A JWT is a snapshot of who the user was
 * when they signed in, and this app issues them with a 7-day lifetime — so
 * verifying the signature alone meant an admin could deactivate a student or
 * delete a lecturer and that person would keep full access for the rest of
 * the week. The admin dashboard's "deactivate" button was effectively
 * decorative for anyone already logged in.
 *
 * One indexed primary-key lookup per request is a cheap price for the
 * deactivate button doing what it says.
 */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: 'Not authenticated. Please log in.' });
  }

  let decoded;
  try {
    decoded = verifyToken(token);
  } catch (err) {
    return res.status(401).json({ message: 'Session expired. Please log in again.' });
  }

  const table = ACCOUNT_TABLE[decoded.role];
  if (!table) {
    return res.status(401).json({ message: 'Session expired. Please log in again.' });
  }

  try {
    // Admins have neither is_active nor email_verified, so only students and
    // lecturers get those columns selected.
    const columns = decoded.role === 'admin' ? 'id' : 'id, is_active, email_verified';
    const [[account]] = [
      (await pool.query(`SELECT ${columns} FROM ${table} WHERE id = ?`, [decoded.id]))[0],
    ];

    // Deleted out from under a live session.
    if (!account) {
      return res.status(401).json({ message: 'This account no longer exists. Please log in again.' });
    }
    if (decoded.role !== 'admin') {
      if (account.is_active === 0) {
        return res.status(403).json({
          message: 'This account has been deactivated. Please contact the administrator.',
          code: 'ACCOUNT_DEACTIVATED',
        });
      }
      if (account.email_verified === 0) {
        return res.status(403).json({
          message: 'Please verify your email address before continuing.',
          code: 'EMAIL_NOT_VERIFIED',
        });
      }
    }

    req.user = decoded; // { id, role, email, firstName, lastName }
    next();
  } catch (err) {
    // A database problem is not an authentication failure — saying "log in
    // again" here would send users round a login loop that cannot succeed.
    console.error('Auth account check failed:', err.message);
    return res.status(503).json({ message: 'Service temporarily unavailable. Please try again in a moment.' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'You do not have permission to do that.' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
