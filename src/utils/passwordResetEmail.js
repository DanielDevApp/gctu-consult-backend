/** Builds the HTML/text body for a password reset email. */
function buildResetEmail({ firstName, resetLink, expiresInMinutes }) {
  const subject = 'Reset your GCTU Consult password';
  const text =
    `Hi ${firstName},\n\n` +
    `We received a request to reset your GCTU Consult password. Open the link below to choose a new one:\n\n` +
    `${resetLink}\n\n` +
    `This link expires in ${expiresInMinutes} minutes. If you didn't request this, you can safely ignore this email — your password won't be changed.`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #101826;">
      <div style="background: #0B2942; padding: 20px 24px; border-radius: 12px 12px 0 0;">
        <p style="color: #E3A008; font-size: 12px; letter-spacing: 1px; text-transform: uppercase; font-weight: 600; margin: 0;">GCTU Consult</p>
        <p style="color: #ffffff; font-size: 18px; font-weight: 700; margin: 8px 0 0;">Reset your password</p>
      </div>
      <div style="border: 1px solid #e5e0d5; border-top: none; border-radius: 0 0 12px 12px; padding: 24px;">
        <p>Hi ${firstName},</p>
        <p>We received a request to reset your GCTU Consult password. Click the button below to choose a new one:</p>
        <p style="text-align: center; margin: 28px 0;">
          <a href="${resetLink}" style="background: #0E7C7B; color: #ffffff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 600; display: inline-block;">Reset password</a>
        </p>
        <p style="font-size: 13px; color: #4B5A70;">Or paste this link into your browser:<br><a href="${resetLink}" style="color: #0E7C7B; word-break: break-all;">${resetLink}</a></p>
        <p style="font-size: 13px; color: #4B5A70; margin-top: 20px;">This link expires in ${expiresInMinutes} minutes. If you didn't request this, you can safely ignore this email — your password won't be changed.</p>
      </div>
    </div>
  `;

  return { subject, text, html };
}

module.exports = { buildResetEmail };
