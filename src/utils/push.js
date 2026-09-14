const webpush = require('web-push');
const { pool } = require('../config/db');
const { primaryClientUrl } = require('../config/clientUrls');

/**
 * Web Push delivery — the "tell me even when the app is closed" channel, sent
 * alongside the in-app bell and the email for every notification.
 *
 * Switched off unless VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are both set, so
 * an environment without keys simply skips this channel instead of failing.
 * Config is read at call time rather than on require, so tests can toggle it.
 */

/**
 * The push services a browser can legitimately hand us an endpoint for.
 *
 * The server makes a POST request to whatever endpoint a subscription names.
 * Accepting any URL would let a signed-in user register something like
 * http://169.254.169.254/ (a cloud metadata service) and have the backend
 * request internal addresses on their behalf — server-side request forgery.
 */
const PUSH_SERVICE_HOSTS = [
  'fcm.googleapis.com', // Chrome, Android, Opera, Samsung Internet
  'android.googleapis.com', // older Chrome subscriptions
  'push.services.mozilla.com', // Firefox (updates.push.services.mozilla.com)
  'notify.windows.com', // Edge (wns2-*.notify.windows.com)
  'push.apple.com', // Safari, and iPhone/iPad Home Screen apps (web.push.apple.com)
];

function isAllowedPushEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function vapidConfig() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  // Push services require a contact as an https: or mailto: URL. The public
  // site is a sensible default in production; locally the frontend is plain
  // http, which web-push rejects, so fall back to a placeholder mailbox.
  const subject = process.env.VAPID_SUBJECT
    || (primaryClientUrl.startsWith('https://') ? primaryClientUrl : 'mailto:notifications@gctu-consult.invalid');
  return { subject, publicKey, privateKey };
}

const isPushConfigured = () => vapidConfig() !== null;
const getPublicKey = () => vapidConfig()?.publicKey || null;

/** Pushes captured instead of sent while NODE_ENV === 'test'. */
const sentPushes = [];

function defaultSender(subscription, body, options) {
  // Never reach a real push service from the test suite — same reasoning as
  // the mailer: real network traffic, a slow suite, and a misconfigured run
  // away from buzzing somebody's actual phone.
  if (process.env.NODE_ENV === 'test') {
    sentPushes.push({ endpoint: subscription.endpoint, payload: JSON.parse(body) });
    return Promise.resolve({ statusCode: 201 });
  }
  return webpush.sendNotification(subscription, body, options);
}

let sender = defaultSender;

/** Test hook: swap the transport, e.g. to simulate an expired subscription. */
function setPushSender(fn) {
  sender = fn || defaultSender;
}

/**
 * Sends a payload to every device this user has turned push on for.
 *
 * Never throws: push is a best-effort extra channel, and a failure here must
 * not undo or delay whatever triggered the notification.
 *
 * A 404 or 410 from the push service means the browser has discarded that
 * subscription for good — permission revoked, site data cleared, app removed —
 * so the row is deleted. Otherwise every future notification would keep
 * retrying a dead endpoint forever. Anything else (a 5xx, a timeout) is
 * treated as transient and the subscription is kept.
 */
async function sendPushToUser(userId, role, payload) {
  const vapid = vapidConfig();
  if (!vapid) return { sent: 0, removed: 0 };

  try {
    const [subscriptions] = await pool.query(
      'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ? AND user_role = ?',
      [userId, role]
    );
    if (!subscriptions.length) return { sent: 0, removed: 0 };

    const body = JSON.stringify(payload);
    const options = {
      vapidDetails: vapid,
      // A booking update that arrives a day late isn't worth waking a phone
      // for; let the push service drop it rather than deliver it stale.
      TTL: 24 * 60 * 60,
      urgency: 'high',
    };

    const results = await Promise.allSettled(
      subscriptions.map((s) => sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, options))
    );

    let sent = 0;
    let removed = 0;
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        sent++;
        continue;
      }
      const status = result.reason?.statusCode;
      if (status === 404 || status === 410) {
        await pool.query('DELETE FROM push_subscriptions WHERE id = ?', [subscriptions[i].id]);
        removed++;
      } else {
        console.error(
          `Push to subscription ${subscriptions[i].id} failed (${status || 'no status'}):`,
          result.reason?.body || result.reason?.message
        );
      }
    }
    return { sent, removed };
  } catch (err) {
    console.error('Push delivery failed:', err.message);
    return { sent: 0, removed: 0 };
  }
}

/** Clears every device registered to an account — used when the account is deleted. */
async function removeSubscriptionsForUser(userId, role) {
  await pool.query('DELETE FROM push_subscriptions WHERE user_id = ? AND user_role = ?', [userId, role]);
}

module.exports = {
  isPushConfigured,
  getPublicKey,
  isAllowedPushEndpoint,
  sendPushToUser,
  removeSubscriptionsForUser,
  setPushSender,
  sentPushes,
};
