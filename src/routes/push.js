const express = require('express');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const { pool } = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { userOrIpKey } = require('../middleware/rateLimitKeys');
const { notificationUrl } = require('../utils/notify');
const {
  isPushConfigured, getPublicKey, isAllowedPushEndpoint, sendPushToUser,
} = require('../utils/push');

const router = express.Router();

function handleValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ message: errors.array()[0].msg });
    return true;
  }
  return false;
}

const notConfigured = (res) => res.status(503).json({
  message: 'Push notifications are not set up on this server.',
  code: 'PUSH_NOT_CONFIGURED',
});

/* The VAPID public key a browser needs in order to subscribe. Public by design
   — it identifies this server to the push service and can't be used to send
   anything — so no authentication. 503 when push is switched off, so the UI
   can say so rather than offer a switch that can't work. */
router.get('/public-key', (req, res) => {
  const publicKey = getPublicKey();
  if (!publicKey) return notConfigured(res);
  res.json({ publicKey });
});

router.use(requireAuth);

/* Registers this browser for the signed-in account, or re-registers it.

   Keyed on the endpoint: a browser holds exactly one subscription per site, so
   when a different account signs in on the same device it takes the
   subscription over, rather than both people receiving each other's alerts. */
router.post(
  '/subscribe',
  [
    body('subscription.endpoint').isString().isLength({ min: 1, max: 1024 }).withMessage('A valid push subscription is required'),
    body('subscription.keys.p256dh').isString().isLength({ min: 1, max: 255 }).withMessage('A valid push subscription is required'),
    body('subscription.keys.auth').isString().isLength({ min: 1, max: 255 }).withMessage('A valid push subscription is required'),
  ],
  async (req, res) => {
    if (handleValidation(req, res)) return;
    if (!isPushConfigured()) return notConfigured(res);

    const { endpoint, keys } = req.body.subscription;
    if (!isAllowedPushEndpoint(endpoint)) {
      return res.status(400).json({ message: 'That subscription does not come from a recognised push service.' });
    }

    try {
      await pool.query(
        `INSERT INTO push_subscriptions (user_id, user_role, endpoint, p256dh, auth, user_agent)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET
           user_id = EXCLUDED.user_id,
           user_role = EXCLUDED.user_role,
           p256dh = EXCLUDED.p256dh,
           auth = EXCLUDED.auth,
           user_agent = EXCLUDED.user_agent,
           updated_at = CURRENT_TIMESTAMP`,
        [req.user.id, req.user.role, endpoint, keys.p256dh, keys.auth, (req.get('user-agent') || '').slice(0, 255) || null]
      );
      res.status(201).json({ message: 'Push notifications turned on for this device.' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Could not turn on push notifications.' });
    }
  }
);

/* Removes this browser from the signed-in account. Scoped to the caller, so
   knowing another device's endpoint doesn't let you switch it off. */
router.delete(
  '/subscribe',
  [body('endpoint').isString().isLength({ min: 1, max: 1024 }).withMessage('An endpoint is required')],
  async (req, res) => {
    if (handleValidation(req, res)) return;
    try {
      const [result] = await pool.query(
        'DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ? AND user_role = ?',
        [req.body.endpoint, req.user.id, req.user.role]
      );
      if (!result.affectedRows) return res.status(404).json({ message: 'This device is not registered for push notifications.' });
      res.json({ message: 'Push notifications turned off for this device.' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Could not turn off push notifications.' });
    }
  }
);

// A test push is a real message to a real phone, so it gets its own small
// limit rather than just the general API one.
const testLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  keyGenerator: userOrIpKey,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { message: 'Too many test notifications. Please wait a minute and try again.' },
});

/* Sends a test notification to every device on the caller's account, so
   someone who just turned push on can see it actually works. */
router.post('/test', testLimiter, async (req, res) => {
  if (!isPushConfigured()) return notConfigured(res);

  const result = await sendPushToUser(req.user.id, req.user.role, {
    title: 'GCTU Consult',
    body: 'Push notifications are working on this device.',
    url: notificationUrl(req.user.role, 'general'),
    tag: 'push-test',
    type: 'push_test',
  });

  if (result.sent === 0) {
    return res.status(409).json({
      message: 'No device on this account is set up for push notifications yet.',
      ...result,
    });
  }
  res.json({ message: `Test notification sent to ${result.sent} device${result.sent === 1 ? '' : 's'}.`, ...result });
});

module.exports = router;
