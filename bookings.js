const pool = require("./db");

// ─── إنشاء جدول الحجوزات ────────────────────────────────────────────────────
async function initBookingsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      name        VARCHAR(100) NOT NULL,
      phone       VARCHAR(30)  NOT NULL,
      apartment   VARCHAR(150) NOT NULL DEFAULT '',
      check_in    DATE         NOT NULL,
      check_out   DATE         NOT NULL,
      adults      TINYINT      NOT NULL DEFAULT 1,
      children    TINYINT      NOT NULL DEFAULT 0,
      message     TEXT,
      status      ENUM('pending','confirmed','cancelled') NOT NULL DEFAULT 'pending',
      source      VARCHAR(50)  NOT NULL DEFAULT 'widget',
      notified    TINYINT(1)   NOT NULL DEFAULT 0,
      created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_bookings_status     (status),
      INDEX idx_bookings_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}
initBookingsTable().catch(() => {});

// ─── إنشاء حجز ──────────────────────────────────────────────────────────────
async function createBooking({ name, phone, apartment, check_in, check_out, adults, children, message, source = "widget" }) {
  const [result] = await pool.query(
    `INSERT INTO bookings (name, phone, apartment, check_in, check_out, adults, children, message, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, phone, apartment || "", check_in, check_out, adults || 1, children || 0, message || "", source]
  );
  return result.insertId;
}

// ─── جلب كل الحجوزات ────────────────────────────────────────────────────────
async function getBookings({ limit = 100, offset = 0, status = null } = {}) {
  try {
    const where = status ? "WHERE status = ?" : "";
    const params = status ? [status, parseInt(limit), parseInt(offset)] : [parseInt(limit), parseInt(offset)];
    const [rows] = await pool.query(
      `SELECT * FROM bookings ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      params
    );
    return rows;
  } catch (err) {
    console.error("❌ [Bookings] خطأ في جلب الحجوزات:", err.message || err.code);
    return [];
  }
}

// ─── تحديث حالة حجز ─────────────────────────────────────────────────────────
async function updateBookingStatus(id, status) {
  await pool.query(`UPDATE bookings SET status = ? WHERE id = ?`, [status, id]);
}

// ─── تحديث حقل notified ──────────────────────────────────────────────────────
async function markNotified(id) {
  await pool.query(`UPDATE bookings SET notified = 1 WHERE id = ?`, [id]);
}

// ─── إحصائيات ────────────────────────────────────────────────────────────────
async function getBookingStats() {
  try {
    const [[row]] = await pool.query(`
      SELECT
        COUNT(*) AS total,
        SUM(status = 'pending')   AS pending,
        SUM(status = 'confirmed') AS confirmed,
        SUM(status = 'cancelled') AS cancelled
      FROM bookings
    `);
    return row;
  } catch { return { total: 0, pending: 0, confirmed: 0, cancelled: 0 }; }
}

module.exports = { createBooking, getBookings, updateBookingStatus, markNotified, getBookingStats };
