const { pool } = require('../config/db');
const { sendMail } = require('./mailer');
const { buildNotificationEmail } = require('./notificationEmail');
const { primaryClientUrl } = require('../config/clientUrls');
const { sendPushToUser } = require('./push');

const DASHBOARD_PATH = { student: '/student/dashboard', lecturer: '/lecturer/dashboard', admin: '/admin/dashboard' };

/**
 * Where opening a notification should land the user — the email's button and
 * a push notification's click both go here. Booking updates open straight on
 * the Bookings tab instead of making someone find it from the overview.
 */
function notificationUrl(role, type = 'general') {
  const base = DASHBOARD_PATH[role] || '/';
  return String(type).startsWith('booking_') ? `${base}?tab=bookings` : base;
}

/**
 * Create an in-app notification for a user, and best-effort send the same
 * update by email and as a push notification to any device they've turned
 * push on for.
 *
 * Email and push are both fire-and-forget — neither is awaited — so a slow
 * mail server or push service can't delay the response to whoever caused the
 * notification, and a failure in either is logged, never thrown.
 * @param {number} recipientId
 * @param {'student'|'lecturer'|'admin'} recipientRole
 * @param {string} title
 * @param {string} message
 * @param {string} type
 */
async function notify(recipientId, recipientRole, title, message, type = 'general') {
  let notificationId = null;
  try {
    const [result] = await pool.query(
      `INSERT INTO notifications (recipient_id, recipient_role, title, message, type)
       VALUES (?, ?, ?, ?, ?)`,
      [recipientId, recipientRole, title, message, type]
    );
    notificationId = result.insertId;
  } catch (err) {
    console.error('Failed to create notification:', err.message);
  }

  emailNotification(recipientId, recipientRole, title, message, type).catch((err) => {
    console.error('Failed to send notification email:', err.message);
  });

  // sendPushToUser handles its own failures and never rejects.
  sendPushToUser(recipientId, recipientRole, {
    title,
    body: message,
    type,
    notificationId,
    url: notificationUrl(recipientRole, type),
    // Distinct per notification, so two booking updates in quick succession
    // show as two alerts instead of the second silently replacing the first.
    tag: notificationId ? `notification-${notificationId}` : `notification-${Date.now()}`,
  });
}

async function emailNotification(recipientId, recipientRole, title, message, type) {
  const table = recipientRole === 'student' ? 'students' : recipientRole === 'lecturer' ? 'lecturers' : 'admins';
  const nameColumn = recipientRole === 'admin' ? 'name AS first_name' : 'first_name';

  const [[user]] = [
    (await pool.query(`SELECT email, ${nameColumn} FROM ${table} WHERE id = ?`, [recipientId]))[0],
  ];
  if (!user || !user.email) return;

  const { subject, text, html } = buildNotificationEmail({
    firstName: user.first_name || 'there',
    title,
    message,
    // primaryClientUrl, not CLIENT_URL directly — that env var may hold a
    // list of allowed origins, which would paste straight into the link.
    dashboardLink: `${primaryClientUrl}${notificationUrl(recipientRole, type)}`,
  });
  await sendMail({ to: user.email, subject, text, html });
}

module.exports = { notify, notificationUrl };
