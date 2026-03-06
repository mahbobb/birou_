const mysql = require("mysql2/promise");

// ─── الاتصال بقاعدة البيانات ───────────────────────────────────────────────

const pool = mysql.createPool({
  host:     process.env.DB_HOST     || "localhost",
  port:     parseInt(process.env.DB_PORT) || 3306,
  user:     process.env.DB_USER     || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME     || "whatsapp_bot",
  waitForConnections: true,
  connectionLimit:    10,
});

// ─── تسجيل أو تحديث جهة اتصال ────────────────────────────────────────────

async function registerContact(phone, name, message) {
  const now = new Date();
  try {
    const [rows] = await pool.query(
      "SELECT id, name FROM contacts WHERE phone = ?",
      [phone]
    );

    if (rows.length > 0) {
      await pool.query(
        `UPDATE contacts
            SET name = ?, last_message = ?, last_seen = ?, total_messages = total_messages + 1
          WHERE phone = ?`,
        [name || rows[0].name, message, now, phone]
      );
      return false; // زبون موجود
    } else {
      await pool.query(
        `INSERT INTO contacts (phone, name, first_seen, last_seen, last_message, total_messages)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [phone, name || "غير معروف", now, now, message]
      );
      console.log(`📋 زبون جديد مسجل: ${name || phone} (+${phone})`);
      return true; // زبون جديد
    }
  } catch (err) {
    console.error("❌ خطأ في تسجيل الزبون:", err.message);
    return false;
  }
}

// ─── إحصائيات ─────────────────────────────────────────────────────────────

async function getStats() {
  try {
    const [[{ total }]] = await pool.query("SELECT COUNT(*) AS total FROM contacts");
    const [[{ today }]] = await pool.query(
      "SELECT COUNT(*) AS today FROM contacts WHERE DATE(last_seen) = CURDATE()"
    );
    return { total, today };
  } catch (err) {
    console.error("❌ خطأ في الإحصائيات:", err.message);
    return { total: 0, today: 0 };
  }
}

// ─── قائمة جميع الزبائن ───────────────────────────────────────────────────

async function getAllContacts() {
  try {
    const [rows] = await pool.query(
      `SELECT c.phone, c.name,
              c.first_seen       AS firstSeen,
              c.last_seen        AS lastSeen,
              c.last_message     AS lastMessage,
              c.total_messages   AS totalMessages,
              (SELECT direction FROM messages
                WHERE phone = c.phone
                ORDER BY created_at DESC LIMIT 1) AS lastDirection
         FROM contacts c
        ORDER BY c.last_seen DESC`
    );
    return rows;
  } catch (err) {
    console.error("❌ خطأ في جلب الزبائن:", err.message);
    return [];
  }
}

module.exports = { registerContact, getStats, getAllContacts };
