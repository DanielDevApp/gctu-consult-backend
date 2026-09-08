require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const { pool, getSchemaState } = require('./config/db');
const { isAllowedOrigin } = require('./config/clientUrls');
const { userOrIpKey } = require('./middleware/rateLimitKeys');
const authRoutes = require('./routes/auth');
const profileRoutes = require('./routes/profile');
const lecturerRoutes = require('./routes/lecturer');
const studentRoutes = require('./routes/student');
const adminRoutes = require('./routes/admin');
const notificationRoutes = require('./routes/notifications');

/**
 * The configured Express app, with no side effects beyond wiring middleware
 * and routes — it doesn't listen on a port, connect to anything, or start the
 * background sweeps. server.js does all of that.
 *
 * Split out so the test suite can drive the real app in-process instead of
 * spawning a server and guessing when it's ready, and so importing the app
 * never kicks off timers that would keep a test run alive.
 */
const app = express();

// Standard security headers (X-Content-Type-Options, X-Frame-Options, HSTS,
// etc). CSP and Cross-Origin-Resource-Policy are disabled — this server only
// ever answers JSON to a separate frontend origin, never serves HTML, so a
// document-oriented CSP has nothing to protect and a strict CORP header
// would just be one more thing to debug for no real gain here.
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));

app.use(
  cors({
    // CLIENT_URL may list several origins (see config/clientUrls.js) so the
    // old and new frontend domains can both work during a domain change.
    origin(origin, callback) {
      // No Origin header at all: same-origin requests, curl, and Render's
      // own health checks. Nothing to enforce, so let them through.
      if (!origin) return callback(null, true);
      callback(null, isAllowedOrigin(origin));
    },
    credentials: true,
    exposedHeaders: ['Content-Disposition'], // lets the frontend read the real filename off CSV export downloads
  })
);
app.use(express.json());
// Quiet during tests — a few hundred request log lines would bury the results.
if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));

// Uploaded profile photos. Created on boot if missing (a fresh clone won't
// have it — git doesn't track empty directories). Served as plain static
// files; CORP is already disabled above so the frontend origin can load them.
const uploadsRoot = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(path.join(uploadsRoot, 'avatars'), { recursive: true });
app.use('/uploads', express.static(uploadsRoot));

// Render terminates TLS at its own proxy and forwards the real client address
// in X-Forwarded-For. Without this, req.ip is the *proxy's* address for every
// request, so every user in the world shares one rate-limit bucket and one
// person's burst locks out the entire platform. '1' = trust exactly one hop,
// which is what Render puts in front of the app — trusting more would let a
// caller spoof the header and pick their own bucket.
app.set('trust proxy', 1);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // Per account (or per IP when signed out), not per platform. The dashboards
  // poll notifications every 30s, which alone is ~30 requests per user per
  // window, so this needs headroom well above the old shared 300.
  limit: 600,
  keyGenerator: userOrIpKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please slow down and try again shortly.' },
  // The suite fires hundreds of requests as a handful of users; the limiter
  // has its own dedicated tests rather than throttling every other one.
  skip: () => process.env.NODE_ENV === 'test',
});
app.use('/api', limiter);

// Liveness *and* readiness in one place. This deliberately still answers 200
// when the schema is broken — Render uses this endpoint to decide whether a
// deploy is healthy, and failing it would roll the service into a restart
// loop rather than leaving a diagnosable instance up. The body carries the
// real story: `schema.ready === false` means the API is serving but the
// database shape is wrong, which is otherwise invisible from outside.
app.get('/api/health', async (req, res) => {
  const schema = getSchemaState();
  let database = 'ok';
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    database = `unreachable: ${err.message}`;
  }
  res.json({
    status: schema.ready && database === 'ok' ? 'ok' : 'degraded',
    database,
    schema,
    time: new Date().toISOString(),
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/lecturer', lecturerRoutes);
app.use('/api/student', studentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/notifications', notificationRoutes);

app.use((req, res) => res.status(404).json({ message: 'Route not found.' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: 'Something went wrong on the server.' });
});

module.exports = app;
