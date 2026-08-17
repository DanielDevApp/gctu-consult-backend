require('dotenv').config();
// Some hosts (Render's free tier among them) advertise outbound IPv6 but
// silently blackhole it, so any Node dns.lookup() that returns an AAAA
// record first (the default since Node 18) hangs for minutes before ever
// trying IPv4 — hit this on smtp.gmail.com specifically (port 465, from a
// registration request). Forcing IPv4 first sidesteps it everywhere in the
// process, not just SMTP.
require('dns').setDefaultResultOrder('ipv4first');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const { testConnection, ensureSchema } = require('./src/config/db');
const { expirePastSlots } = require('./src/utils/expireSlots');
const { sendUpcomingReminders } = require('./src/utils/reminders');
const authRoutes = require('./src/routes/auth');
const profileRoutes = require('./src/routes/profile');
const lecturerRoutes = require('./src/routes/lecturer');
const studentRoutes = require('./src/routes/student');
const adminRoutes = require('./src/routes/admin');
const notificationRoutes = require('./src/routes/notifications');

const app = express();

// Standard security headers (X-Content-Type-Options, X-Frame-Options, HSTS,
// etc). CSP and Cross-Origin-Resource-Policy are disabled — this server only
// ever answers JSON to a separate frontend origin, never serves HTML, so a
// document-oriented CSP has nothing to protect and a strict CORP header
// would just be one more thing to debug for no real gain here.
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));

app.use(
  cors({
    origin: process.env.CLIENT_URL || 'http://localhost:3000',
    credentials: true,
    exposedHeaders: ['Content-Disposition'], // lets the frontend read the real filename off CSV export downloads
  })
);
app.use(express.json());
app.use(morgan('dev'));

// Uploaded profile photos. Created on boot if missing (a fresh clone won't
// have it — git doesn't track empty directories). Served as plain static
// files; CORP is already disabled above so the frontend origin can load them.
const uploadsDir = path.join(__dirname, 'uploads', 'avatars');
fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', limiter);

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

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

const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  console.log(`🚀 GCTU Consult API running on http://localhost:${PORT}`);
  await testConnection();
  await ensureSchema();

  // Catch-all sweep: the routes that actually list availability also expire
  // past slots inline (so there's no lag on the pages that matter), but this
  // periodic sweep keeps everything else (dashboard counts, etc.) fresh too.
  await expirePastSlots();
  setInterval(expirePastSlots, 60 * 1000);

  // "Your consultation is coming up" reminders — purely proactive, so it
  // doesn't need the inline-on-every-request treatment expiry gets. A
  // 5-minute cadence is plenty against a default 60-minute reminder window.
  await sendUpcomingReminders();
  setInterval(sendUpcomingReminders, 5 * 60 * 1000);
});
