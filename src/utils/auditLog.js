const { pool } = require('../config/db');

/**
 * Record an admin action for accountability — who did what, to which
 * record, and when. Best-effort: a logging failure never blocks the actual
 * admin action, it's just console-logged like the rest of this app's
 * fire-and-forget side effects (see notify()).
 * @param {{id:number, firstName?:string, email?:string}} admin  req.user for the acting admin
 * @param {string} action       short machine-readable verb, e.g. 'verify_lecturer'
 * @param {string} targetType   'lecturer' | 'student' | 'admin' | 'booking'
 * @param {number|null} targetId
 * @param {string|null} details human-readable extra context, e.g. the target's name
 */
async function logAdminAction(admin, action, targetType, targetId, details) {
  try {
    await pool.query(
      `INSERT INTO admin_audit_log (admin_id, admin_name, action, target_type, target_id, details)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [admin.id, admin.firstName || admin.email || 'Admin', action, targetType, targetId ?? null, details ?? null]
    );
  } catch (err) {
    console.error('Failed to write audit log:', err.message);
  }
}

module.exports = { logAdminAction };
