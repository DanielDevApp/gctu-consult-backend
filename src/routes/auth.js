const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const { pool } = require('../config/db');
const { signToken } = require('../utils/token');
const { requireAuth } = require('../middleware/auth');
const { sendMail } = require('../utils/mailer');
const { buildResetEmail } = require('../utils/passwordResetEmail');
const { buildVerificationEmail } = require('../utils/verificationEmail');
const { PROGRAMMES, DEPARTMENTS } = require('../utils/academic');

const router = express.Router();

const RESET_TOKEN_TTL_MINUTES = 30;
const VERIFY_CODE_TTL_MINUTES = 10;
const MAX_VERIFY_ATTEMPTS = 5;

// Forgot-password is a target for abuse (email bombing a real address, or
// brute-forcing tokens) — keep it far tighter than the general API limiter.
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many reset requests. Please try again later.' },
});

// Same abuse profile as forgot-password (repeated resends could be used to
// spam an inbox), so it gets the same tight limiter.
const resendVerificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many verification requests. Please try again later.' },
});

// A 6-digit code only has 1,000,000 combinations, so on top of the
// per-code attempt cap (MAX_VERIFY_ATTEMPTS) we also cap how many guesses
// an IP can throw at this endpoint overall.
const verifyEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attempts. Please request a new code and try again later.' },
});

// /login has no rate limiting anywhere else in front of it (unlike every
// other auth-abuse-prone route above), which makes it the one place an
// attacker could brute-force a password unthrottled. Same shape as the
// others but a little looser — a real user mistyping a password a few
// times in a row shouldn't get locked out.
const loginLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many login attempts. Please wait a few minutes and try again.' },
});

const AVATAR_COLORS = ['#0F3D5F', '#1D6F5C', '#B8860B', '#7A2E4A', '#2E5C8A', '#8A4B2E'];
const randomColor = () => AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

function handleValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ message: errors.array()[0].msg, errors: errors.array() });
    return true;
  }
  return false;
}

/** Issues a fresh 6-digit email-verification OTP for a student/lecturer
 *  and emails it — shared by registration and the "resend" endpoint.
 *  Invalidates any earlier outstanding code first, same pattern as the
 *  password-reset flow. Returns whether the email actually went out, so
 *  callers can warn the user instead of assuming delivery succeeded. */
async function issueVerificationEmail(user, role) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  const expiresAt = new Date(Date.now() + VERIFY_CODE_TTL_MINUTES * 60 * 1000);

  await pool.query(
    'UPDATE email_verifications SET used = 1 WHERE user_id = ? AND user_role = ? AND used = 0',
    [user.id, role]
  );
  await pool.query(
    'INSERT INTO email_verifications (user_id, user_role, code_hash, expires_at) VALUES (?, ?, ?, ?)',
    [user.id, role, codeHash, expiresAt]
  );

  const { subject, text, html } = buildVerificationEmail({
    firstName: user.first_name || 'there',
    code,
    expiresInMinutes: VERIFY_CODE_TTL_MINUTES,
  });
  return sendMail({ to: user.email, subject, text, html });
}

/* ------------------------------------------------------------------ */
/* STUDENT REGISTER                                                    */
/* ------------------------------------------------------------------ */
router.post(
  '/register/student',
  [
    body('firstName').trim().notEmpty().withMessage('First name is required'),
    body('lastName').trim().notEmpty().withMessage('Last name is required'),
    body('studentId').trim().notEmpty().withMessage('Student ID is required'),
    body('level').trim().notEmpty().withMessage('Level is required'),
    body('programme').isIn(PROGRAMMES).withMessage('Please select a valid programme'),
    body('email').isEmail().withMessage('A valid GCTU email is required').normalizeEmail(),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  ],
  async (req, res) => {
    if (handleValidation(req, res)) return;
    const { firstName, lastName, studentId, level, programme, email, password } = req.body;

    try {
      const [existing] = await pool.query(
        'SELECT id FROM students WHERE email = ? OR student_id = ?',
        [email, studentId]
      );
      if (existing.length) {
        return res.status(409).json({ message: 'An account with this email or student ID already exists.' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const [result] = await pool.query(
        `INSERT INTO students (first_name, last_name, student_id, level, programme, email, password_hash, avatar_color, email_verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [firstName, lastName, studentId, level, programme, email, passwordHash, randomColor()]
      );

      const emailSent = await issueVerificationEmail(
        { id: result.insertId, email, first_name: firstName },
        'student'
      );

      return res.status(201).json({
        message: emailSent
          ? 'Registration successful! Check your email for a 6-digit verification code — you\'ll need to enter it before you can log in.'
          : 'Registration successful, but we couldn\'t send the verification email right now. Use "Resend code" on the verification page in a moment, or contact support if it keeps failing.',
        id: result.insertId,
        emailSent,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: 'Registration failed. Please try again.' });
    }
  }
);

/* ------------------------------------------------------------------ */
/* LECTURER REGISTER                                                   */
/* ------------------------------------------------------------------ */
router.post(
  '/register/lecturer',
  [
    body('firstName').trim().notEmpty().withMessage('First name is required'),
    body('lastName').trim().notEmpty().withMessage('Last name is required'),
    body('staffId').trim().notEmpty().withMessage('Staff ID is required'),
    body('department').isIn(DEPARTMENTS).withMessage('Please select a valid department'),
    body('email').isEmail().withMessage('A valid GCTU email is required').normalizeEmail(),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  ],
  async (req, res) => {
    if (handleValidation(req, res)) return;
    const { firstName, lastName, staffId, department, title, email, password } = req.body;

    try {
      const [existing] = await pool.query(
        'SELECT id FROM lecturers WHERE email = ? OR staff_id = ?',
        [email, staffId]
      );
      if (existing.length) {
        return res.status(409).json({ message: 'An account with this email or staff ID already exists.' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const [result] = await pool.query(
        `INSERT INTO lecturers (first_name, last_name, staff_id, department, title, email, password_hash, avatar_color, email_verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [firstName, lastName, staffId, department, title || null, email, passwordHash, randomColor()]
      );

      const emailSent = await issueVerificationEmail(
        { id: result.insertId, email, first_name: firstName },
        'lecturer'
      );

      return res.status(201).json({
        message: emailSent
          ? 'Registration successful! Check your email for a 6-digit verification code — you\'ll need to enter it before you can log in. Your profile will also need admin verification before students can see it.'
          : 'Registration successful, but we couldn\'t send the verification email right now. Use "Resend code" on the verification page in a moment, or contact support if it keeps failing.',
        id: result.insertId,
        emailSent,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: 'Registration failed. Please try again.' });
    }
  }
);

/* ------------------------------------------------------------------ */
/* LOGIN (role-aware: student | lecturer | admin)                      */
/* ------------------------------------------------------------------ */
router.post(
  '/login',
  loginLimiter,
  [
    body('role').isIn(['student', 'lecturer', 'admin']).withMessage('Invalid role'),
    body('identifier').trim().notEmpty().withMessage('ID / email is required'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  async (req, res) => {
    if (handleValidation(req, res)) return;
    const { role, identifier, password } = req.body;

    try {
      let table, idColumn, user;

      if (role === 'student') {
        [[user]] = [
          (await pool.query(
            'SELECT * FROM students WHERE student_id = ? OR email = ? LIMIT 1',
            [identifier, identifier]
          ))[0],
        ];
      } else if (role === 'lecturer') {
        [[user]] = [
          (await pool.query(
            'SELECT * FROM lecturers WHERE staff_id = ? OR email = ? LIMIT 1',
            [identifier, identifier]
          ))[0],
        ];
      } else {
        [[user]] = [
          (await pool.query('SELECT * FROM admins WHERE email = ? LIMIT 1', [identifier]))[0],
        ];
      }

      if (!user) {
        return res.status(401).json({ message: 'Invalid credentials. Please check your ID and password.' });
      }
      if (user.is_active === 0) {
        return res.status(403).json({ message: 'Your account has been deactivated. Contact the admin office.' });
      }

      const match = await bcrypt.compare(password, user.password_hash);
      if (!match) {
        return res.status(401).json({ message: 'Invalid credentials. Please check your ID and password.' });
      }

      // Only self-registered roles (student/lecturer) go through email
      // verification — checked after the password match so a wrong-password
      // attempt can't be used to probe whether an account is unverified.
      if ((role === 'student' || role === 'lecturer') && user.email_verified === 0) {
        return res.status(403).json({
          message: 'Please verify your email before logging in. Check your inbox for the link, or request a new one below.',
          code: 'EMAIL_NOT_VERIFIED',
        });
      }

      const payload = {
        id: user.id,
        role,
        email: user.email,
        firstName: user.first_name || user.name,
        lastName: user.last_name || '',
      };
      const token = signToken(payload);

      const { password_hash, ...safeUser } = user;
      return res.json({ token, role, user: safeUser });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: 'Login failed. Please try again.' });
    }
  }
);

/* ------------------------------------------------------------------ */
/* VERIFY EMAIL — consume the 6-digit OTP sent at registration          */
/* ------------------------------------------------------------------ */
router.post(
  '/verify-email',
  verifyEmailLimiter,
  [
    body('role').isIn(['student', 'lecturer']).withMessage('Invalid role'),
    body('identifier').trim().notEmpty().withMessage('ID or email is required'),
    body('code').trim().matches(/^\d{6}$/).withMessage('Enter the 6-digit code from your email'),
  ],
  async (req, res) => {
    if (handleValidation(req, res)) return;
    const { role, identifier, code } = req.body;
    const table = role === 'student' ? 'students' : 'lecturers';
    const idColumn = role === 'student' ? 'student_id' : 'staff_id';
    const invalidResponse = { message: 'That code is incorrect or has expired. Please request a new one.' };

    try {
      const [[user]] = [
        (await pool.query(`SELECT * FROM ${table} WHERE ${idColumn} = ? OR email = ?`, [identifier, identifier]))[0],
      ];
      if (!user) return res.status(400).json(invalidResponse);
      if (user.email_verified) {
        return res.json({ message: 'Your email is already verified. You can log in.' });
      }

      const [[record]] = [
        (await pool.query(
          `SELECT * FROM email_verifications
           WHERE user_id = ? AND user_role = ? AND used = 0 AND expires_at > NOW()
           ORDER BY created_at DESC LIMIT 1`,
          [user.id, role]
        ))[0],
      ];
      if (!record) return res.status(400).json(invalidResponse);
      if (record.attempts >= MAX_VERIFY_ATTEMPTS) {
        return res.status(400).json({ message: 'Too many incorrect attempts. Please request a new code.' });
      }

      const codeHash = crypto.createHash('sha256').update(code).digest('hex');
      const submittedHash = Buffer.from(codeHash, 'hex');
      const storedHash = Buffer.from(record.code_hash, 'hex');
      const match = submittedHash.length === storedHash.length && crypto.timingSafeEqual(submittedHash, storedHash);

      if (!match) {
        await pool.query('UPDATE email_verifications SET attempts = attempts + 1 WHERE id = ?', [record.id]);
        const remaining = MAX_VERIFY_ATTEMPTS - (record.attempts + 1);
        return res.status(400).json({
          message: remaining > 0
            ? `That code is incorrect. ${remaining} attempt${remaining === 1 ? '' : 's'} left.`
            : 'That code is incorrect. Please request a new one.',
        });
      }

      await pool.query(`UPDATE ${table} SET email_verified = 1 WHERE id = ?`, [user.id]);
      await pool.query('UPDATE email_verifications SET used = 1 WHERE id = ?', [record.id]);

      return res.json({ message: 'Your email has been verified. You can now log in.' });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: 'Could not verify your email. Please try again.' });
    }
  }
);

/* ------------------------------------------------------------------ */
/* RESEND VERIFICATION — same ID/email lookup as login                 */
/* ------------------------------------------------------------------ */
router.post(
  '/resend-verification',
  resendVerificationLimiter,
  [
    body('role').isIn(['student', 'lecturer']).withMessage('Invalid role'),
    body('identifier').trim().notEmpty().withMessage('ID or email is required'),
  ],
  async (req, res) => {
    if (handleValidation(req, res)) return;
    const { role, identifier } = req.body;
    const table = role === 'student' ? 'students' : 'lecturers';
    const idColumn = role === 'student' ? 'student_id' : 'staff_id';

    // Same-message-either-way as forgot-password, for the same reason: this
    // shouldn't be usable to probe which IDs/emails have accounts.
    const genericResponse = {
      message: 'If an unverified account matches that ID or email, a new verification code has been sent.',
    };

    try {
      const [[user]] = [
        (await pool.query(`SELECT * FROM ${table} WHERE ${idColumn} = ? OR email = ?`, [identifier, identifier]))[0],
      ];
      if (!user || user.email_verified) return res.json(genericResponse);

      await issueVerificationEmail(user, role);
      return res.json(genericResponse);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: 'Could not resend the verification email. Please try again.' });
    }
  }
);

/* ------------------------------------------------------------------ */
/* CURRENT USER                                                        */
/* ------------------------------------------------------------------ */
router.get('/me', requireAuth, async (req, res) => {
  const { role, id } = req.user;
  try {
    let rows;
    if (role === 'student') {
      [rows] = await pool.query(
        'SELECT id, first_name, last_name, student_id, level, programme, email, avatar_color, avatar_url, created_at FROM students WHERE id = ?',
        [id]
      );
    } else if (role === 'lecturer') {
      [rows] = await pool.query(
        'SELECT id, first_name, last_name, staff_id, department, title, office, bio, email, avatar_color, avatar_url, is_verified, created_at FROM lecturers WHERE id = ?',
        [id]
      );
    } else {
      [rows] = await pool.query(
        'SELECT id, name, email, is_super_admin, created_at FROM admins WHERE id = ?',
        [id]
      );
    }
    if (!rows.length) return res.status(404).json({ message: 'User not found.' });
    return res.json({ role, user: rows[0] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Could not load profile.' });
  }
});

/* ------------------------------------------------------------------ */
/* FORGOT PASSWORD — request a reset link by email                     */
/* ------------------------------------------------------------------ */
router.post(
  '/forgot-password',
  forgotPasswordLimiter,
  [
    body('role').isIn(['student', 'lecturer', 'admin']).withMessage('Invalid role'),
    body('email').isEmail().withMessage('A valid email is required').normalizeEmail(),
  ],
  async (req, res) => {
    if (handleValidation(req, res)) return;
    const { role, email } = req.body;
    const table = role === 'student' ? 'students' : role === 'lecturer' ? 'lecturers' : 'admins';

    // Always respond with the same generic message, whether or not the
    // email matches an account — this prevents the endpoint being used to
    // discover which emails are registered.
    const genericResponse = {
      message: 'If an account exists for that email, a password reset link has been sent to it.',
    };

    try {
      const [[user]] = [(await pool.query(`SELECT * FROM ${table} WHERE email = ?`, [email]))[0]];
      if (!user) return res.json(genericResponse);

      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);

      // Invalidate any earlier outstanding links for this user before issuing a new one.
      await pool.query(
        'UPDATE password_resets SET used = 1 WHERE user_id = ? AND user_role = ? AND used = 0',
        [user.id, role]
      );
      await pool.query(
        'INSERT INTO password_resets (user_id, user_role, token_hash, expires_at) VALUES (?, ?, ?, ?)',
        [user.id, role, tokenHash, expiresAt]
      );

      const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';
      const resetLink = `${clientUrl}/reset-password?token=${token}&role=${role}`;
      const { subject, text, html } = buildResetEmail({
        firstName: user.first_name || user.name || 'there',
        resetLink,
        expiresInMinutes: RESET_TOKEN_TTL_MINUTES,
      });
      await sendMail({ to: user.email, subject, text, html });

      return res.json(genericResponse);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: 'Could not process the reset request. Please try again.' });
    }
  }
);

/* ------------------------------------------------------------------ */
/* RESET PASSWORD — consume a token and set a new password             */
/* ------------------------------------------------------------------ */
router.post(
  '/reset-password',
  [
    body('role').isIn(['student', 'lecturer', 'admin']).withMessage('Invalid role'),
    body('token').notEmpty().withMessage('Reset token is required'),
    body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters'),
  ],
  async (req, res) => {
    if (handleValidation(req, res)) return;
    const { role, token, newPassword } = req.body;
    const table = role === 'student' ? 'students' : role === 'lecturer' ? 'lecturers' : 'admins';
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    try {
      const [[reset]] = [
        (await pool.query(
          `SELECT * FROM password_resets
           WHERE token_hash = ? AND user_role = ? AND used = 0 AND expires_at > NOW()`,
          [tokenHash, role]
        ))[0],
      ];
      if (!reset) {
        return res.status(400).json({ message: 'This reset link is invalid or has expired. Please request a new one.' });
      }

      const newHash = await bcrypt.hash(newPassword, 10);
      await pool.query(`UPDATE ${table} SET password_hash = ? WHERE id = ?`, [newHash, reset.user_id]);
      await pool.query('UPDATE password_resets SET used = 1 WHERE id = ?', [reset.id]);

      return res.json({ message: 'Your password has been reset. You can now log in.' });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: 'Could not reset your password. Please try again.' });
    }
  }
);

module.exports = router;
