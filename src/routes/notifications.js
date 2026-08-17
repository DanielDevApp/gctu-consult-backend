const express = require('express');
const { pool } = require('../config/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

/* List notifications for the logged-in user (latest 50) */
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM notifications WHERE recipient_id = ? AND recipient_role = ?
       ORDER BY created_at DESC LIMIT 50`,
      [req.user.id, req.user.role]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not load notifications.' });
  }
});

/* Mark one as read */
router.put('/:id/read', async (req, res) => {
  try {
    await pool.query(
      'UPDATE notifications SET is_read = 1 WHERE id = ? AND recipient_id = ? AND recipient_role = ?',
      [req.params.id, req.user.id, req.user.role]
    );
    res.json({ message: 'Marked as read.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not update notification.' });
  }
});

/* Mark all as read */
router.put('/read-all', async (req, res) => {
  try {
    await pool.query(
      'UPDATE notifications SET is_read = 1 WHERE recipient_id = ? AND recipient_role = ?',
      [req.user.id, req.user.role]
    );
    res.json({ message: 'All notifications marked as read.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not update notifications.' });
  }
});

module.exports = router;
