const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host:     process.env.DB_HOST     || "localhost",
  port:     parseInt(process.env.DB_PORT) || 3306,
  user:     process.env.DB_USER     || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME     || "whatsapp_bot",
  waitForConnections: true,
  connectionLimit: 10,
});

async function saveMessage(phone, name, direction, body, source) {
  try {
    await pool.query(
      `INSERT INTO messages (phone, name, direction, body, source) VALUES (?, ?, ?, ?, ?)`,
      [phone, name || "غير معروف", direction, body, source]
    );
  } catch (err) {
    console.error("❌ خطأ في حفظ الرسالة:", err.message);
  }
}

async function getMessages({ phone, limit = 100, offset = 0 }) {
  try {
    let sql    = `SELECT * FROM messages`;
    const vals = [];
    if (phone) { sql += ` WHERE phone = ?`; vals.push(phone); }
    sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    vals.push(limit, offset);
    const [rows] = await pool.query(sql, vals);
    return rows;
  } catch (err) {
    console.error("❌ خطأ في جلب الرسائل:", err.message);
    return [];
  }
}

async function getMessageStats() {
  try {
    const [[{ total }]]   = await pool.query(`SELECT COUNT(*) AS total FROM messages`);
    const [[{ today }]]   = await pool.query(`SELECT COUNT(*) AS today FROM messages WHERE DATE(created_at) = CURDATE()`);
    const [[{ incoming }]]= await pool.query(`SELECT COUNT(*) AS incoming FROM messages WHERE direction='in'`);
    const [[{ outgoing }]]= await pool.query(`SELECT COUNT(*) AS outgoing FROM messages WHERE direction='out'`);
    return { total, today, incoming, outgoing };
  } catch (err) {
    return { total: 0, today: 0, incoming: 0, outgoing: 0 };
  }
}

module.exports = { saveMessage, getMessages, getMessageStats };
