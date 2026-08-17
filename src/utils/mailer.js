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
 * Send via SendGrid's HTTP API (a plain HTTPS POST) instead of raw SMTP.
 * Several free-tier PaaS hosts — Render among them — block or blackhole
 * outbound SMTP entirely as an anti-spam measure, which made registration
 * emails hang for minutes and never arrive. HTTPS isn't blocked, so this is
 * the path production uses whenever SENDGRID_API_KEY is set. The sender
 * address (SMTP_USER) must be verified in SendGrid under Settings > Sender
 * Authentication > Single Sender Verification, or SendGrid rejects the send.
 * Local dev keeps using plain SMTP below, since that var is normally unset
 * there. Content order matters to SendGrid's API: text/plain must precede
 * text/html when both are present.
 */
async function sendViaSendGrid({ to, subject, html, text }) {
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: process.env.SMTP_USER, name: 'GCTU Consult' },
      subject,
      content: [
        ...(text ? [{ type: 'text/plain', value: text }] : []),
        ...(html ? [{ type: 'text/html', value: html }] : []),
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SendGrid responded ${res.status}: ${body}`);
  }
}

/**
 * Send an email. Tries SendGrid's HTTP API first (if SENDGRID_API_KEY is
 * set), then SMTP (if SMTP_HOST is set), then falls back to logging to the
 * console — lets the rest of the app (and anyone testing locally) keep
 * working before real credentials exist either way.
 *
 * Returns `true` if the message was actually handed off for delivery,
 * `false` otherwise (nothing configured, or the send failed — the error is
 * still logged either way). Callers that need the user to know delivery
 * failed — e.g. so the UI can say so instead of claiming an email was sent —
 * should check this return value rather than assuming success.
 */
async function sendMail({ to, subject, html, text }) {
  if (process.env.SENDGRID_API_KEY) {
    try {
      await sendViaSendGrid({ to, subject, html, text });
      return true;
    } catch (err) {
      console.error('Failed to send email via SendGrid:', err.message);
      return false;
    }
  }

  const t = getTransporter();
  if (!t) {
    console.log('\n✉️  Email not configured — email not sent. Would have sent:');
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
