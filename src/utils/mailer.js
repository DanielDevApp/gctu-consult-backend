const nodemailer = require('nodemailer');

let transporter = null;

/** Lazily build the transporter so a missing SMTP config doesn't crash boot. */
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST) return null;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true', // true for port 465, false for 587/25 (STARTTLS)
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  return transporter;
}

/**
 * Send an email. If SMTP isn't configured (no SMTP_HOST in .env), the email
 * is logged to the console instead of sent — lets the rest of the app (and
 * anyone testing locally) keep working before real SMTP credentials exist.
 *
 * Returns `true` if the message was actually handed off to the SMTP server,
 * `false` otherwise (SMTP not configured, or the send failed — the error is
 * still logged either way). Callers that need the user to know delivery
 * failed — e.g. so the UI can say so instead of claiming an email was sent —
 * should check this return value rather than assuming success.
 */
async function sendMail({ to, subject, html, text }) {
  const t = getTransporter();
  if (!t) {
    console.log('\n✉️  SMTP not configured — email not sent. Would have sent:');
    console.log(`   To: ${to}\n   Subject: ${subject}\n   ${text || html}\n`);
    return false;
  }
  try {
    await t.sendMail({
      from: process.env.MAIL_FROM || '"GCTU Consult" <no-reply@gctu-consult.local>',
      to,
      subject,
      html,
      text,
    });
    return true;
  } catch (err) {
    console.error('Failed to send email:', err.message);
    return false;
  }
}

module.exports = { sendMail };
