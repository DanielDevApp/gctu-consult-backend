/** Builds the HTML/text body for the "verify your email" OTP sent on registration. */
function buildVerificationEmail({ firstName, code, expiresInMinutes }) {
  const subject = `${code} is your GCTU Consult verification code`;
  const text =
    `Hi ${firstName},\n\n` +
    `Welcome to GCTU Consult! Your verification code is:\n\n` +
    `${code}\n\n` +
    `Enter this code on the verification page to activate your account. It expires in ${expiresInMinutes} minutes. ` +
    `If you didn't create this account, you can safely ignore this email.`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #101826;">
      <div style="background: #0B2942; padding: 20px 24px; border-radius: 12px 12px 0 0;">
        <p style="color: #E3A008; font-size: 12px; letter-spacing: 1px; text-transform: uppercase; font-weight: 600; margin: 0;">GCTU Consult</p>
        <p style="color: #ffffff; font-size: 18px; font-weight: 700; margin: 8px 0 0;">Verify your email</p>
      </div>
      <div style="border: 1px solid #e5e0d5; border-top: none; border-radius: 0 0 12px 12px; padding: 24px;">
        <p>Hi ${firstName},</p>
        <p>Welcome to GCTU Consult! Enter this code on the verification page to activate your account:</p>
        <p style="text-align: center; margin: 28px 0;">
          <span style="display: inline-block; background: #F4F1E8; color: #0B2942; font-size: 32px; font-weight: 700; letter-spacing: 8px; padding: 14px 20px; border-radius: 10px;">${code}</span>
        </p>
        <p style="font-size: 13px; color: #4B5A70; margin-top: 20px;">This code expires in ${expiresInMinutes} minutes. If you didn't create this account, you can safely ignore this email.</p>
      </div>
    </div>
  `;

  return { subject, text, html };
}

module.exports = { buildVerificationEmail };
