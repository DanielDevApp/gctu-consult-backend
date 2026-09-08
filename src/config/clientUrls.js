require('dotenv').config();

/**
 * CLIENT_URL accepts a comma-separated list, not just one URL.
 *
 * Moving the frontend to a new domain used to mean instant downtime: CORS
 * allowed exactly one origin, so the moment CLIENT_URL was pointed at the new
 * domain, every user still on the old one could load the page but had every
 * API call blocked by the browser. Accepting a list means both can be live
 * through the switchover, and the old entry is dropped once traffic has moved.
 *
 * Trailing slashes are stripped because a browser's Origin header never has
 * one — "https://example.com/" in the env var would otherwise match nothing
 * and silently block the very origin it was meant to allow.
 */
const RAW = process.env.CLIENT_URL || 'http://localhost:3000';

const allowedOrigins = RAW.split(',')
  .map((url) => url.trim().replace(/\/+$/, ''))
  .filter(Boolean);

/** The canonical public URL — the first entry. Used to build links inside
 *  emails, which need one address rather than a list. */
const primaryClientUrl = allowedOrigins[0] || 'http://localhost:3000';

function isAllowedOrigin(origin) {
  return allowedOrigins.includes(origin.replace(/\/+$/, ''));
}

module.exports = { allowedOrigins, primaryClientUrl, isAllowedOrigin };
