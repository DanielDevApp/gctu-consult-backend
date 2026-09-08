require('dotenv').config();
// Some hosts (Render's free tier among them) advertise outbound IPv6 but
// silently blackhole it, so any Node dns.lookup() that returns an AAAA
// record first (the default since Node 18) hangs for minutes before ever
// trying IPv4 — hit this on smtp.gmail.com specifically (port 465, from a
// registration request). Forcing IPv4 first sidesteps it everywhere in the
// process, not just SMTP.
require('dns').setDefaultResultOrder('ipv4first');

const app = require('./src/app');
const { testConnection, ensureSchema } = require('./src/config/db');
const { allowedOrigins } = require('./src/config/clientUrls');
const { expirePastSlots } = require('./src/utils/expireSlots');
const { sendUpcomingReminders } = require('./src/utils/reminders');

const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  console.log(`🚀 GCTU Consult API running on http://localhost:${PORT}`);
  // Printed on every boot because a CORS mismatch is invisible from the
  // outside — the frontend just fails every request with no server-side
  // error to find. Seeing the exact allowed list here turns "the site is
  // broken" into a one-glance diagnosis.
  console.log(`🌐 Allowed frontend origin(s): ${allowedOrigins.join(', ')}`);

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
