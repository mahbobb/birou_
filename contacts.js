const pool = require("./db");

// ─── تطبيع رقم الهاتف ────────────────────────────────────────────────────

function normalizePhone(phone) {
  let p = String(phone || "").replace(/\D/g, "");
  if (p.startsWith("00")) p = p.slice(2);
  // آخر 9 أرقام كمفتاح موحّد (212600... == 0600...)
  return p.length > 9 ? p.slice(-9) : p;
}

// ─── تسجيل أو تحديث جهة اتصال ────────────────────────────────────────────
// UNIQUE(phone) → INSERT IGNORE ثم UPDATE

async function registerContact(phone, name, message) {
  const pNorm = normalizePhone(phone);
  if (!pNorm || pNorm.length < 7) return false;
  const now = new Date();
  try {
    // INSERT IGNORE: إذا الرقم موجود لا يفعل شيئاً (UNIQUE constraint)
    await pool.query(
      `INSERT IGNORE INTO contacts (phone, name, first_seen, last_seen, last_message, total_messages)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [pNorm, name || "غير معروف", now, now, message]
    );
    // UPDATE دائماً: يُحدّث بيانات الزيارة الأخيرة
    await pool.query(
      `UPDATE contacts
          SET name           = COALESCE(NULLIF(?, ''), name),
              last_seen      = ?,
              last_message   = ?,
              total_messages = total_messages + 1
        WHERE phone = ?`,
      [name || "", now, message, pNorm]
    );
    return true;
  } catch (err) {
    console.error("❌ خطأ في تسجيل الزبون:", err.message || err.code || String(err));
    return false;
  }
}

// ─── إحصائيات ─────────────────────────────────────────────────────────────

async function getStats() {
  try {
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM contacts`);
    const [[{ today }]] = await pool.query(
      `SELECT COUNT(*) AS today FROM contacts WHERE DATE(last_seen) = CURDATE()`
    );
    return { total, today };
  } catch { return { total: 0, today: 0 }; }
}

// ─── قائمة جميع الزبائن ───────────────────────────────────────────────────

async function getAllContacts({ limit = 200, offset = 0, search = "" } = {}) {
  try {
    const where = search
      ? `WHERE (c.is_deleted IS NULL OR c.is_deleted = 0) AND (c.name LIKE ? OR c.phone LIKE ?)`
      : `WHERE (c.is_deleted IS NULL OR c.is_deleted = 0)`;
    const params = search
      ? [`%${search}%`, `%${search}%`, limit, offset]
      : [limit, offset];

    const [rows] = await pool.query(`
      SELECT c.phone, c.name,
             c.first_seen        AS firstSeen,
             c.last_seen         AS lastSeen,
             c.total_messages    AS totalMessages,
             m.body              AS lastMessage,
             m.direction         AS lastDirection,
             m.created_at        AS lastMessageAt
        FROM contacts c
        LEFT JOIN messages m ON m.id = (
          SELECT MAX(id) FROM messages WHERE contact = c.phone
        )
        ${where}
       ORDER BY COALESCE(m.created_at, c.last_seen) DESC
       LIMIT ? OFFSET ?
    `, params);
    return rows;
  } catch (err) {
    console.error("❌ خطأ في جلب الزبائن:", err.message || err.code || String(err));
    return [];
  }
}

module.exports = { registerContact, getStats, getAllContacts };
