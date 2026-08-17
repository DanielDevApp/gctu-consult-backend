require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');

(async () => {
  const name = process.env.SEED_ADMIN_NAME || 'Super Admin';
  const email = process.env.SEED_ADMIN_EMAIL || 'admin@gctu.edu.gh';
  const password = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!';

  try {
    const [existing] = await pool.query('SELECT id FROM admins WHERE email = ?', [email]);
    if (existing.length) {
      console.log(`ℹ️  Admin with email ${email} already exists. Nothing to do.`);
      process.exit(0);
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO admins (name, email, password_hash, is_super_admin) VALUES (?, ?, ?, 1)',
      [name, email, passwordHash]
    );

    console.log('✅ Super admin created!');
    console.log(`   Email:    ${email}`);
    console.log(`   Password: ${password}`);
    console.log('   Log in at /admin and change this password immediately.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Failed to seed admin:', err.message);
    process.exit(1);
  }
})();
