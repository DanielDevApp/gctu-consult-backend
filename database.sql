-- =====================================================================
-- GCTU Lecturer Consultation Booking System
-- PostgreSQL schema — create the database first, then run this against it:
--   createdb gctu_consult
--   psql -U postgres -d gctu_consult -f database.sql
-- (The backend also applies this same shape itself on every boot via
-- ensureSchema() in src/config/db.js, so running this file by hand is
-- optional — it's here as a readable reference / for a manual setup.)
-- =====================================================================

-- Booleans are stored as SMALLINT (0/1), not native BOOLEAN — the whole
-- app compares them as `=== 0` / `=== 1` in JS and `= 1` in SQL, the exact
-- shape MySQL's TINYINT(1) always returned. Keeping that shape avoids
-- rewriting every comparison across both repos for this migration.

-- Shared trigger: Postgres has no MySQL-style "ON UPDATE CURRENT_TIMESTAMP"
-- column clause — a BEFORE UPDATE trigger does the equivalent.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- STUDENTS
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS students (
  id SERIAL PRIMARY KEY,
  first_name VARCHAR(60) NOT NULL,
  last_name VARCHAR(60) NOT NULL,
  student_id VARCHAR(30) NOT NULL UNIQUE,
  level VARCHAR(10) NOT NULL,           -- e.g. 100, 200, 300, 400
  programme VARCHAR(120) NOT NULL,
  email VARCHAR(120) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  avatar_color VARCHAR(20) DEFAULT NULL,
  avatar_url VARCHAR(255) DEFAULT NULL,
  email_verified SMALLINT NOT NULL DEFAULT 0,  -- set on self-registration; flips to 1 once the emailed code is verified
  is_active SMALLINT NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
DROP TRIGGER IF EXISTS trg_students_updated_at ON students;
CREATE TRIGGER trg_students_updated_at BEFORE UPDATE ON students
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- LECTURERS
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lecturers (
  id SERIAL PRIMARY KEY,
  first_name VARCHAR(60) NOT NULL,
  last_name VARCHAR(60) NOT NULL,
  staff_id VARCHAR(30) NOT NULL UNIQUE,
  department VARCHAR(120) NOT NULL,
  title VARCHAR(30) DEFAULT NULL,        -- e.g. Dr., Prof., Mr., Mrs.
  office VARCHAR(80) DEFAULT NULL,
  bio VARCHAR(500) DEFAULT NULL,
  email VARCHAR(120) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  avatar_color VARCHAR(20) DEFAULT NULL,
  avatar_url VARCHAR(255) DEFAULT NULL,
  email_verified SMALLINT NOT NULL DEFAULT 0,
  is_verified SMALLINT NOT NULL DEFAULT 0,   -- admin must verify before they are publicly listed
  is_active SMALLINT NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
DROP TRIGGER IF EXISTS trg_lecturers_updated_at ON lecturers;
CREATE TRIGGER trg_lecturers_updated_at BEFORE UPDATE ON lecturers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- LECTURER COURSES (courses a lecturer teaches — shown to students on
-- that lecturer's profile)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lecturer_courses (
  id SERIAL PRIMARY KEY,
  lecturer_id INT NOT NULL REFERENCES lecturers(id) ON DELETE CASCADE,
  course_code VARCHAR(20) DEFAULT NULL,   -- e.g. "CS101", optional
  course_name VARCHAR(150) NOT NULL,      -- e.g. "Introduction to Programming"
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_course_lecturer ON lecturer_courses(lecturer_id);

-- ---------------------------------------------------------------------
-- ADMINS
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(120) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  is_super_admin SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
DROP TRIGGER IF EXISTS trg_admins_updated_at ON admins;
CREATE TRIGGER trg_admins_updated_at BEFORE UPDATE ON admins
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- AVAILABILITY SLOTS (created by lecturers)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS availability_slots (
  id SERIAL PRIMARY KEY,
  lecturer_id INT NOT NULL REFERENCES lecturers(id) ON DELETE CASCADE,
  slot_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  duration_minutes INT NOT NULL,
  mode VARCHAR(20) NOT NULL CHECK (mode IN ('online', 'in_person')),
  venue VARCHAR(150) DEFAULT NULL,       -- required when mode = in_person
  meeting_link VARCHAR(255) DEFAULT NULL, -- required when mode = online
  notes VARCHAR(255) DEFAULT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'booked', 'cancelled', 'completed', 'expired')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_slot_lecturer ON availability_slots(lecturer_id);
CREATE INDEX IF NOT EXISTS idx_slot_status ON availability_slots(status);
DROP TRIGGER IF EXISTS trg_slots_updated_at ON availability_slots;
CREATE TRIGGER trg_slots_updated_at BEFORE UPDATE ON availability_slots
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- BOOKINGS (made by students against a slot)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bookings (
  id SERIAL PRIMARY KEY,
  slot_id INT NOT NULL REFERENCES availability_slots(id) ON DELETE CASCADE,
  student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  lecturer_id INT NOT NULL REFERENCES lecturers(id) ON DELETE CASCADE,
  reason VARCHAR(500) DEFAULT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed', 'declined', 'expired', 'no_show')),
  cancelled_by VARCHAR(20) DEFAULT NULL CHECK (cancelled_by IN ('student', 'lecturer', 'admin')),
  cancel_reason VARCHAR(500) DEFAULT NULL,
  reminder_sent SMALLINT NOT NULL DEFAULT 0,  -- flips to 1 once the "coming up" reminder has gone out
  -- Per-viewer soft delete: each side can clear a booking from their own
  -- history without affecting what the other parties can see.
  hidden_by_student SMALLINT NOT NULL DEFAULT 0,
  hidden_by_lecturer SMALLINT NOT NULL DEFAULT 0,
  hidden_by_admin SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_booking_student ON bookings(student_id);
CREATE INDEX IF NOT EXISTS idx_booking_lecturer ON bookings(lecturer_id);
DROP TRIGGER IF EXISTS trg_bookings_updated_at ON bookings;
CREATE TRIGGER trg_bookings_updated_at BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- BOOKING RATINGS (a student's 1-5 star rating of a completed consultation)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS booking_ratings (
  id SERIAL PRIMARY KEY,
  booking_id INT NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
  lecturer_id INT NOT NULL REFERENCES lecturers(id) ON DELETE CASCADE,
  student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment VARCHAR(500) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_rating_lecturer ON booking_ratings(lecturer_id);

-- ---------------------------------------------------------------------
-- LECTURER WAITLIST ("notify me" when a fully-booked lecturer opens a slot)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lecturer_waitlist (
  id SERIAL PRIMARY KEY,
  student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  lecturer_id INT NOT NULL REFERENCES lecturers(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (student_id, lecturer_id)
);
CREATE INDEX IF NOT EXISTS idx_waitlist_lecturer ON lecturer_waitlist(lecturer_id);

-- ---------------------------------------------------------------------
-- NOTIFICATIONS (in-app pop-up / bell notifications)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  recipient_id INT NOT NULL,
  recipient_role VARCHAR(20) NOT NULL CHECK (recipient_role IN ('student', 'lecturer', 'admin')),
  title VARCHAR(150) NOT NULL,
  message VARCHAR(500) NOT NULL,
  type VARCHAR(40) DEFAULT 'general',   -- booking_created, booking_confirmed, booking_cancelled, account_verified, general
  is_read SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notif_recipient ON notifications(recipient_id, recipient_role);
CREATE INDEX IF NOT EXISTS idx_notif_unread ON notifications(is_read);

-- ---------------------------------------------------------------------
-- EMAIL VERIFICATIONS (self-registration confirms the address via a
-- 6-digit OTP emailed to the user, student/lecturer only)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_verifications (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL,
  user_role VARCHAR(20) NOT NULL CHECK (user_role IN ('student', 'lecturer')),
  code_hash VARCHAR(255) NOT NULL,    -- SHA-256 of the 6-digit code mailed to the user; the raw code is never stored
  attempts INT NOT NULL DEFAULT 0,    -- wrong guesses against this code; locked out past MAX_VERIFY_ATTEMPTS
  expires_at TIMESTAMP NOT NULL,
  used SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_verify_user ON email_verifications(user_id, user_role);

-- ---------------------------------------------------------------------
-- PASSWORD RESETS (self-service "forgot password" flow, any role)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS password_resets (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL,
  user_role VARCHAR(20) NOT NULL CHECK (user_role IN ('student', 'lecturer', 'admin')),
  token_hash VARCHAR(255) NOT NULL,   -- SHA-256 of the token mailed to the user; the raw token is never stored
  expires_at TIMESTAMP NOT NULL,
  used SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_reset_user ON password_resets(user_id, user_role);
CREATE INDEX IF NOT EXISTS idx_reset_token ON password_resets(token_hash);

-- ---------------------------------------------------------------------
-- ADMIN AUDIT LOG (accountability trail for admin dashboard actions)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id SERIAL PRIMARY KEY,
  admin_id INT NOT NULL,
  admin_name VARCHAR(120) NOT NULL,   -- snapshot, so the log still reads fine if that admin is later deleted
  action VARCHAR(60) NOT NULL,        -- e.g. verify_lecturer, deactivate_student, delete_lecturer, add_admin
  target_type VARCHAR(30) NOT NULL,   -- lecturer | student | admin | booking
  target_id INT DEFAULT NULL,
  details VARCHAR(255) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON admin_audit_log(created_at);

-- ---------------------------------------------------------------------
-- Seed: departments & programmes are free text, no lookup table needed.
-- Create your first admin with:  npm run seed:admin   (see backend README)
-- ---------------------------------------------------------------------
