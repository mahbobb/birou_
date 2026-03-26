const pool = require("./db");

async function saveCall({ phone, name = "غير معروف", callType = "voice", botId = "bot1" }) {
  await pool.query(
    `INSERT INTO calls (phone, name, call_type, bot_id) VALUES (?, ?, ?, ?)`,
    [String(phone || "").slice(0, 20), String(name || "غير معروف").slice(0, 100), callType, botId]
  );
}

async function getCalls({ phone, search, limit = 50, offset = 0 } = {}) {
  const lim = Math.min(parseInt(limit) || 50, 500);
  const off = parseInt(offset) || 0;
  const conditions = [], params = [];

  if (phone) {
    conditions.push("c.phone = ?");
    params.push(phone);
  } else if (search) {
    conditions.push("(c.phone LIKE ? OR c.name LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const [rows] = await pool.query(
    `SELECT c.id, c.phone, COALESCE(ct.name, c.name) AS name, c.call_type, c.bot_id, c.created_at
       FROM calls c LEFT JOIN contacts ct ON ct.phone = c.phone
     ${where} ORDER BY c.created_at DESC LIMIT ? OFFSET ?`,
    [...params, lim, off]
  );
  return rows;
}

async function getCallsCount({ phone, search } = {}) {
  const conditions = [], params = [];
  if (phone) { conditions.push("phone = ?"); params.push(phone); }
  else if (search) { conditions.push("(phone LIKE ? OR name LIKE ?)"); params.push(`%${search}%`, `%${search}%`); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM calls ${where}`, params);
  return total;
}

async function getCallStats() {
  const [[{ total }]]   = await pool.query(`SELECT COUNT(*) AS total FROM calls`);
  const [[{ today }]]   = await pool.query(`SELECT COUNT(*) AS today FROM calls WHERE DATE(created_at) = CURDATE()`);
  const [[{ voice }]]   = await pool.query(`SELECT COUNT(*) AS voice FROM calls WHERE call_type = 'voice'`);
  const [[{ video }]]   = await pool.query(`SELECT COUNT(*) AS video FROM calls WHERE call_type = 'video'`);
  return { total, today, voice, video };
}

module.exports = { saveCall, getCalls, getCallsCount, getCallStats };
