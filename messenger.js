const pool = require("./db");

// ─── إنشاء جدول messenger_contacts ───────────────────────────────────────
async function initMessengerTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messenger_contacts (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      fb_id        VARCHAR(50)  NOT NULL,
      name         VARCHAR(100) NOT NULL DEFAULT 'مجهول',
      last_message TEXT,
      last_seen    DATETIME     NOT NULL,
      direction    ENUM('in','out') NOT NULL DEFAULT 'in',
      UNIQUE KEY uq_fb_id (fb_id),
      INDEX idx_last_seen (last_seen)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}
initMessengerTable().catch(() => {});

// ─── حفظ أو تحديث جهة اتصال ──────────────────────────────────────────────
async function saveMessengerContact(fbId, name, message, direction = "in") {
  try {
    const now = new Date();
    await pool.query(
      `INSERT INTO messenger_contacts (fb_id, name, last_message, last_seen, direction)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name         = COALESCE(NULLIF(?, ''), name),
         last_message = ?,
         last_seen    = ?,
         direction    = ?`,
      [fbId, name || "مجهول", message, now, direction,
       name || "", message, now, direction]
    );
  } catch (err) {
    console.error("❌ [Messenger] خطأ في حفظ الزبون:", err.message || err.code);
  }
}

// ─── جلب جميع الزبائن ────────────────────────────────────────────────────
async function getMessengerContacts({ limit = 200, offset = 0, onlyUnanswered = false } = {}) {
  try {
    const where = onlyUnanswered ? "WHERE direction = 'in'" : "";
    const [rows] = await pool.query(
      `SELECT * FROM messenger_contacts ${where}
       ORDER BY last_seen DESC LIMIT ? OFFSET ?`,
      [parseInt(limit), parseInt(offset)]
    );
    return rows;
  } catch (err) {
    console.error("❌ [Messenger] خطأ في جلب الزبائن:", err.message || err.code);
    return [];
  }
}

// ─── عدد غير المجاب عليهم ─────────────────────────────────────────────────
async function countUnanswered() {
  try {
    const [[{ n }]] = await pool.query(
      `SELECT COUNT(*) AS n FROM messenger_contacts WHERE direction = 'in'`
    );
    return n;
  } catch { return 0; }
}

module.exports = { saveMessengerContact, getMessengerContacts, countUnanswered };
