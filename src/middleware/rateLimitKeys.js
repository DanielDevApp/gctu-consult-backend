const { verifyToken } = require('../utils/token');

/**
 * How a request is bucketed for rate limiting.
 *
 * Keying purely on IP is wrong for this app's actual audience: a university
 * campus puts hundreds of students behind one public address, so a single
 * busy user would throttle everyone sharing the network. Whenever the caller
 * presents a valid token we bucket by the account instead, which is both
 * fairer and a truer measure of "one user hammering the API".
 *
 * Unauthenticated requests still fall back to IP, since there's nothing else
 * to go on.
 */
function userOrIpKey(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      const { id, role } = verifyToken(token);
      if (id && role) return `user:${role}:${id}`;
    } catch {
      // Invalid/expired token — fall through and bucket by IP, so someone
      // replaying junk tokens can't dodge the limiter entirely.
    }
  }
  return `ip:${ipKey(req)}`;
}

/**
 * A stable client identifier from the request address. IPv6 is truncated to
 * its /64 prefix because a single subscriber is routinely handed a whole /64
 * — limiting on the full address would let one client rotate through
 * effectively unlimited keys.
 */
function ipKey(req) {
  const raw = (req.ip || req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
  if (!raw.includes(':')) return raw; // IPv4
  return raw.split(':').slice(0, 4).join(':') + '::/64';
}

/**
 * Buckets an unauthenticated request per IP *and* per whichever account it
 * names, so throttling an attack on one account never locks every other
 * student on the same campus network out of the same flow. Used by the login,
 * password-reset, verification and resend limiters — all of which are
 * otherwise IP-only, which on a shared network means a handful of attempts
 * for the entire campus per window.
 */
function bodyScopedKey(field) {
  return (req) => `${field}:${ipKey(req)}:${String(req.body?.[field] || '').trim().toLowerCase()}`;
}

const loginKey = bodyScopedKey('identifier');

module.exports = { userOrIpKey, ipKey, loginKey, bodyScopedKey };
