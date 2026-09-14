const { body } = require('express-validator');
const { pool } = require('../config/db');
const { PROGRAMMES, DEPARTMENTS } = require('./academic');

/**
 * What a valid student or lecturer account looks like — shared by public
 * self-registration and by admins creating accounts on someone's behalf.
 *
 * Kept in one place so the two doors can't drift apart: a rule tightened for
 * one (as the digits-only index number was) must not stay loose on the other.
 * Length caps match the column sizes, so an over-long value comes back as a
 * clear 400 rather than a database error surfacing as a 500.
 */

const MIN_PASSWORD_LENGTH = 6;

const requiredText = (field, label, max) =>
  body(field).trim().notEmpty().withMessage(`${label} is required`)
    .isLength({ max }).withMessage(`${label} is too long`);

const emailField = () =>
  body('email').isEmail().withMessage('A valid GCTU email is required').normalizeEmail()
    .isLength({ max: 120 }).withMessage('Email is too long');

const passwordField = (field = 'password', label = 'Password') =>
  body(field).isLength({ min: MIN_PASSWORD_LENGTH })
    .withMessage(`${label} must be at least ${MIN_PASSWORD_LENGTH} characters`);

const studentFields = [
  requiredText('firstName', 'First name', 60),
  requiredText('lastName', 'Last name', 60),
  // Index numbers are digits only, up to 10. Enforced on the server as well as
  // in the forms: filtering input in a browser is a convenience that a direct
  // API call walks straight past.
  body('studentId').trim().matches(/^\d{1,10}$/).withMessage('Student ID must be numbers only, up to 10 digits'),
  body('level').trim().notEmpty().withMessage('Level is required'),
  body('programme').isIn(PROGRAMMES).withMessage('Please select a valid programme'),
  emailField(),
  passwordField(),
];

const lecturerFields = [
  requiredText('firstName', 'First name', 60),
  requiredText('lastName', 'Last name', 60),
  requiredText('staffId', 'Staff ID', 30),
  body('title').optional({ values: 'falsy' }).trim().isLength({ max: 30 }).withMessage('Title is too long'),
  body('department').isIn(DEPARTMENTS).withMessage('Please select a valid department'),
  emailField(),
  passwordField(),
];

const AVATAR_COLORS = ['#0F3D5F', '#1D6F5C', '#B8860B', '#7A2E4A', '#2E5C8A', '#8A4B2E'];
const randomAvatarColor = () => AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

/**
 * The specific unique field a new account would clash on, or null. Named
 * precisely because "email or ID already exists" leaves an admin guessing
 * which of the two to fix.
 */
async function findAccountConflict(role, { email, schoolId }) {
  const table = role === 'student' ? 'students' : 'lecturers';
  const idColumn = role === 'student' ? 'student_id' : 'staff_id';
  const [rows] = await pool.query(
    `SELECT email, ${idColumn} AS school_id FROM ${table} WHERE email = ? OR ${idColumn} = ?`,
    [email, schoolId]
  );
  if (rows.some((r) => r.email === email)) return 'An account with this email already exists.';
  if (rows.some((r) => r.school_id === schoolId)) {
    return `An account with this ${role === 'student' ? 'student ID' : 'staff ID'} already exists.`;
  }
  return null;
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  studentFields,
  lecturerFields,
  passwordField,
  randomAvatarColor,
  findAccountConflict,
};
