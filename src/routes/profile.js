const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { pool } = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { PROGRAMMES, DEPARTMENTS } = require('../utils/academic');

const router = express.Router();

const AVATAR_DIR = path.join(__dirname, '..', '..', 'uploads', 'avatars');
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, AVATAR_DIR),
    filename: (req, file, cb) => {
      const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[file.mimetype] || '';
      cb(null, `${req.user.role}-${req.user.id}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB — plenty for a profile photo, small enough to not bloat the DB backup / disk fast
  fileFilter: (req, file, cb) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      return cb(new Error('Only JPG, PNG, or WEBP images are allowed.'));
    }
    cb(null, true);
  },
});

function handleValidation(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ message: errors.array()[0].msg });
    return true;
  }
  return false;
}

/* Update profile (student or lecturer) */
router.put('/', requireAuth, async (req, res) => {
  const { role, id } = req.user;

  try {
    if (role === 'student') {
      const { firstName, lastName, level, programme } = req.body;
      if (!PROGRAMMES.includes(programme)) {
        return res.status(400).json({ message: 'Please select a valid programme.' });
      }
      await pool.query(
        `UPDATE students SET first_name = ?, last_name = ?, level = ?, programme = ? WHERE id = ?`,
        [firstName, lastName, level, programme, id]
      );
    } else if (role === 'lecturer') {
      const { firstName, lastName, department, title, office, bio } = req.body;
      if (!DEPARTMENTS.includes(department)) {
        return res.status(400).json({ message: 'Please select a valid department.' });
      }
      await pool.query(
        `UPDATE lecturers SET first_name = ?, last_name = ?, department = ?, title = ?, office = ?, bio = ? WHERE id = ?`,
        [firstName, lastName, department, title || null, office || null, bio || null, id]
      );
    } else {
      const { name } = req.body;
      await pool.query(`UPDATE admins SET name = ? WHERE id = ?`, [name, id]);
    }
    return res.json({ message: 'Profile updated successfully.' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Could not update profile.' });
  }
});

/* Change password (self-service, all roles) */
router.put(
  '/password',
  requireAuth,
  [
    body('currentPassword').notEmpty().withMessage('Current password is required'),
    body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters'),
  ],
  async (req, res) => {
    if (handleValidation(req, res)) return;
    const { role, id } = req.user;
    const { currentPassword, newPassword } = req.body;
    const table = role === 'student' ? 'students' : role === 'lecturer' ? 'lecturers' : 'admins';

    try {
      const [[user]] = [(await pool.query(`SELECT password_hash FROM ${table} WHERE id = ?`, [id]))[0]];
      if (!user) return res.status(404).json({ message: 'User not found.' });

      const match = await bcrypt.compare(currentPassword, user.password_hash);
      if (!match) return res.status(401).json({ message: 'Current password is incorrect.' });

      const newHash = await bcrypt.hash(newPassword, 10);
      await pool.query(`UPDATE ${table} SET password_hash = ? WHERE id = ?`, [newHash, id]);
      return res.json({ message: 'Password changed successfully.' });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: 'Could not change password.' });
    }
  }
);

/* Upload a profile photo — student or lecturer only (admins don't have an
 * avatar_url column; their identity chip is initials-only). Replaces
 * whatever photo was there before, deleting the old file off disk so
 * uploads/avatars doesn't grow unbounded with orphaned images. */
router.put('/photo', requireAuth, (req, res) => {
  if (!['student', 'lecturer'].includes(req.user.role)) {
    return res.status(403).json({ message: 'Profile photos are only available for student and lecturer accounts.' });
  }
  upload.single('photo')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ message: err.message || 'Could not upload photo.' });
    }
    if (!req.file) {
      return res.status(400).json({ message: 'No photo file was received.' });
    }

    const { role, id } = req.user;
    const table = role === 'student' ? 'students' : 'lecturers';
    const avatarUrl = `/uploads/avatars/${req.file.filename}`;

    try {
      const [[existing]] = [(await pool.query(`SELECT avatar_url FROM ${table} WHERE id = ?`, [id]))[0]];
      await pool.query(`UPDATE ${table} SET avatar_url = ? WHERE id = ?`, [avatarUrl, id]);

      if (existing?.avatar_url) {
        const oldPath = path.join(AVATAR_DIR, path.basename(existing.avatar_url));
        fs.unlink(oldPath, () => {}); // best-effort — a missing old file is fine
      }

      return res.json({ message: 'Photo updated.', avatarUrl });
    } catch (dbErr) {
      console.error(dbErr);
      fs.unlink(req.file.path, () => {});
      return res.status(500).json({ message: 'Could not save photo.' });
    }
  });
});

/* Remove the current profile photo, reverting to the color-initials avatar. */
router.delete('/photo', requireAuth, async (req, res) => {
  if (!['student', 'lecturer'].includes(req.user.role)) {
    return res.status(403).json({ message: 'Profile photos are only available for student and lecturer accounts.' });
  }
  const { role, id } = req.user;
  const table = role === 'student' ? 'students' : 'lecturers';

  try {
    const [[existing]] = [(await pool.query(`SELECT avatar_url FROM ${table} WHERE id = ?`, [id]))[0]];
    await pool.query(`UPDATE ${table} SET avatar_url = NULL WHERE id = ?`, [id]);
    if (existing?.avatar_url) {
      fs.unlink(path.join(AVATAR_DIR, path.basename(existing.avatar_url)), () => {});
    }
    return res.json({ message: 'Photo removed.' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Could not remove photo.' });
  }
});

module.exports = router;
