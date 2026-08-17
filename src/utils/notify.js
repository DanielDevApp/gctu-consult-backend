const { pool } = require('../config/db');
const { sendMail } = require('./mailer');
const { buildNotificationEmail } = require('./notificationEmail');

const DASHBOARD_PATH = { student: '/student/dashboard', lecturer: '/lecturer/dashboard', admin: '/admin/dashboard' };

/**
 * Create an in-app notification for a user, and best-effort send the same
 * update as an email. The email is fire-and-forget — it's never awaited by
 * the caller, so a slow or misconfigured mail server can't delay the API
 * response, and any failure is just logged, never thrown.
 * @param {number} recipientId
 * @param {'student'|'lecturer'|'admin'} recipientRole
 * @param {string} title
 * @param {string} message
 * @param {string} type
 */
async function notify(recipientId, recipientRole, title, message, type = 'general') {
  try {
    await pool.query(
      `INSERT INTO notifications (recipient_id, recipient_role, title, message, type)
       VALUES (?, ?, ?, ?, ?)`,
      [recipientId, recipientRole, title, message, type]
    );
  } catch (err) {
    console.error('Failed to create notification:', err.message);
  }

  emailNotification(recipientId, recipientRole, title, message).catch((err) => {
    console.error('Failed to send notification email:', err.message);
  });
}

async function emailNotification(recipientId, recipientRole, title, message) {
  const table = recipientRole === 'student' ? 'students' : recipientRole === 'lecturer' ? 'lecturers' : 'admins';
  const nameColumn = recipientRole === 'admin' ? 'name AS first_name' : 'first_name';

  const [[user]] = [
    (await pool.query(`SELECT email, ${nameColumn} FROM ${table} WHERE id = ?`, [recipientId]))[0],
  ];
  if (!user || !user.email) return;

  const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';
  const { subject, text, html } = buildNotificationEmail({
    firstName: user.first_name || 'there',
    title,
    message,
    dashboardLink: `${clientUrl}${DASHBOARD_PATH[recipientRole] || ''}`,
  });
  await sendMail({ to: user.email, subject, text, html });
}

module.exports = { notify };
