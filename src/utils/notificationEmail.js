/** Builds the HTML/text body for a generic notification email — mirrors the
 *  in-app notification's title/message so the two channels stay in sync. */
function buildNotificationEmail({ firstName, title, message, dashboardLink }) {
  const subject = title;
  const text =
    `Hi ${firstName},\n\n${message}\n\n` +
    (dashboardLink ? `View it here: ${dashboardLink}\n\n` : '') +
    `— GCTU Consult`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #101826;">
      <div style="background: #0B2942; padding: 20px 24px; border-radius: 12px 12px 0 0;">
        <p style="color: #E3A008; font-size: 12px; letter-spacing: 1px; text-transform: uppercase; font-weight: 600; margin: 0;">GCTU Consult</p>
        <p style="color: #ffffff; font-size: 18px; font-weight: 700; margin: 8px 0 0;">${title}</p>
      </div>
      <div style="border: 1px solid #e5e0d5; border-top: none; border-radius: 0 0 12px 12px; padding: 24px;">
        <p>Hi ${firstName},</p>
        <p>${message}</p>
        ${dashboardLink ? `
        <p style="text-align: center; margin: 28px 0;">
          <a href="${dashboardLink}" style="background: #0E7C7B; color: #ffffff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 600; display: inline-block;">Open GCTU Consult</a>
        </p>` : ''}
        <p style="font-size: 12px; color: #4B5A70; margin-top: 20px;">You're receiving this because it relates to your GCTU Consult account.</p>
      </div>
    </div>
  `;

  return { subject, text, html };
}

module.exports = { buildNotificationEmail };
