const pool = require("./db");

// ─── تطبيع رقم الهاتف ────────────────────────────────────────────────────

function normalizePhone(phone) {
  let p = String(phone || "").replace(/\D/g, "");
  if (p.startsWith("00")) p = p.slice(2);
  return p.length > 9 ? p.slice(-9) : p;
}

// ─── تحديد نوع الوسيلة من الـbody ────────────────────────────────────────

function parseBody(body) {
  const b = (body || "").trim();
  if (b.startsWith("/uploads/images/"))  return { text: null, media_url: b, media_type: "image"  };
  if (b.startsWith("/uploads/videos/"))  return { text: null, media_url: b, media_type: "video"  };
  if (b.startsWith("/uploads/voices/"))  return { text: null, media_url: b, media_type: "audio"  };
  return { text: b || null, media_url: null, media_type: null };
}

// ─── حفظ رسالة ────────────────────────────────────────────────────────────
// UNIQUE KEY (contact, body(200), created_at) يمنع التكرار تلقائياً

async function saveMessage(phone, _name, direction, body, source, createdAt = null, wa_msg_id = null) {
  try {
    const contact  = normalizePhone(phone);
    const dir      = direction === "out" ? "out" : "in";
    const ts       = createdAt ? new Date(createdAt) : new Date();
    const { text, media_url, media_type } = parseBody(body);
    const bodyVal  = text || media_url || body || "";
    const src      = source  || null;
    const waId     = wa_msg_id || null;

    if (waId) {
      // تكرار: يمنعه الفهرس الفريد على wa_msg_id
      await pool.query(
        `INSERT IGNORE INTO messages (contact, direction, body, media_url, media_type, source, wa_msg_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [contact, dir, bodyVal, media_url, media_type, src, waId, ts]
      );
    } else {
      // INSERT IGNORE: إذا (contact, body, created_at) موجود → يتجاهل
      await pool.query(
        `INSERT IGNORE INTO messages (contact, direction, body, media_url, media_type, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [contact, dir, bodyVal, media_url, media_type, src, ts]
      );
    }
  } catch (err) {
    console.error("❌ خطأ في حفظ الرسالة:", err.message || err.code || String(err));
  }
}

// ─── تحقق من وجود رسالة (نافذة ±90 ثانية) ─────────────────────────────────

async function checkMessageExists(phone, direction, timestampMs) {
  try {
    const contact = normalizePhone(phone);
    const dir     = direction === "out" ? "out" : "in";
    const [rows]  = await pool.query(
      `SELECT id FROM messages
        WHERE contact = ? AND direction = ?
          AND created_at BETWEEN ? AND ?
        LIMIT 1`,
      [contact, dir, new Date(timestampMs - 90000), new Date(timestampMs + 90000)]
    );
    return rows.length > 0;
  } catch { return false; }
}

// ─── جلب الرسائل (مع alias للتوافق مع الـfrontend) ───────────────────────

async function getMessages({ phone, limit = 200, offset = 0, from_date = null } = {}) {
  try {
    const contact = normalizePhone(phone || "");
    const lim     = Math.min(parseInt(limit)  || 200, 500);
    const off     = parseInt(offset) || 0;

    const select = `
      SELECT id,
             contact                          AS phone,
             IF(direction='out','out','in')   AS direction,
             COALESCE(media_url, body)        AS body,
             media_url,
             media_type,
             source,
             wa_msg_id,
             created_at
        FROM messages
    `;

    const dateClause = from_date ? `AND created_at >= ?` : "";
    const dateParam  = from_date ? [new Date(from_date)] : [];

    if (contact) {
      const [rows] = await pool.query(
        `${select} WHERE contact = ? ${dateClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [contact, ...dateParam, lim, off]
      );
      return rows;
    }
    const [rows] = await pool.query(
      `${select} WHERE 1=1 ${dateClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...dateParam, lim, off]
    );
    return rows;
  } catch (err) {
    console.error("❌ خطأ في جلب الرسائل:", err.message);
    return [];
  }
}

// ─── إحصائيات ─────────────────────────────────────────────────────────────

async function getMessageStats() {
  try {
    const [[row]] = await pool.query(`
      SELECT
        COUNT(*)                          AS total,
        SUM(DATE(created_at) = CURDATE()) AS today,
        SUM(direction = 'in')             AS incoming,
        SUM(direction = 'out')            AS outgoing
      FROM messages
    `);
    return {
      total:    Number(row.total    || 0),
      today:    Number(row.today    || 0),
      incoming: Number(row.incoming || 0),
      outgoing: Number(row.outgoing || 0),
    };
  } catch { return { total: 0, today: 0, incoming: 0, outgoing: 0 }; }
}

// ─── جلب المحادثات غير المردودة ───────────────────────────────────────────
// الزبائن الذين آخر رسالتهم واردة ولا يوجد رد بعدها

async function getUnansweredContacts() {
  try {
    const [rows] = await pool.query(`
      SELECT
        m.contact                              AS phone,
        COALESCE(c.name, m.contact)            AS name,
        COALESCE(m.media_url, m.body)          AS lastBody,
        m.created_at                           AS lastAt
      FROM messages m
      LEFT JOIN contacts c ON c.phone = m.contact
      WHERE m.direction = 'in'
        AND m.created_at = (
          SELECT MAX(m2.created_at) FROM messages m2
          WHERE m2.contact = m.contact
        )
        AND NOT EXISTS (
          SELECT 1 FROM messages m3
          WHERE m3.contact = m.contact
            AND m3.direction = 'out'
            AND m3.created_at > m.created_at
        )
      ORDER BY m.created_at DESC
    `);
    return rows;
  } catch (err) {
    console.error("❌ خطأ في getUnansweredContacts:", err.message);
    return [];
  }
}

module.exports = { saveMessage, checkMessageExists, getMessages, getMessageStats, getUnansweredContacts };
