const mysql = require("mysql2/promise");
const fs    = require("fs");
const path  = require("path");

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

// ─── مجلد حفظ الفيديوهات ──────────────────────────────────────────────────

const VIDEOS_DIR = path.join(__dirname, "public", "uploads", "videos");
if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });

// ─── إنشاء الجدول تلقائياً ────────────────────────────────────────────────

pool.query(`
  CREATE TABLE IF NOT EXISTS videos (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    phone      VARCHAR(20)   NOT NULL,
    name       VARCHAR(100)  NOT NULL DEFAULT 'غير معروف',
    filename   VARCHAR(255)  NOT NULL,
    mimetype   VARCHAR(100)  NOT NULL DEFAULT 'video/mp4',
    filesize   INT           NOT NULL DEFAULT 0,
    note       TEXT          DEFAULT NULL,
    created_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_phone      (phone),
    INDEX idx_created_at (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`).then(() => {
  console.log("✅ جدول videos جاهز");
  return pool.query(`ALTER TABLE videos ADD COLUMN note TEXT DEFAULT NULL`).catch(() => {});
}).catch(err => {
  console.error("⚠️ تعذر إنشاء جدول videos:", err.message);
});

// ─── حفظ فيديو ────────────────────────────────────────────────────────────

async function saveVideo(phone, name, media) {
  try {
    const mimeBase = (media.mimetype || "video/mp4").split(";")[0].trim();
    const ext      = mimeBase.split("/")[1] || "mp4";
    const filename = `${Date.now()}_${phone}.${ext}`;
    const filepath = path.join(VIDEOS_DIR, filename);

    const rawData = (media.data || "").includes(",")
      ? media.data.split(",")[1]
      : media.data;

    const buffer = Buffer.from(rawData, "base64");
    fs.writeFileSync(filepath, buffer);

    await pool.query(
      `INSERT INTO videos (phone, name, filename, mimetype, filesize) VALUES (?, ?, ?, ?, ?)`,
      [phone, name || "غير معروف", filename, mimeBase, buffer.length]
    );

    console.log(`🎬 فيديو محفوظ من ${name} (${phone}): ${filename}`);
    return filename;
  } catch (err) {
    console.error("❌ خطأ في حفظ الفيديو:", err.message);
    return null;
  }
}

// ─── جلب قائمة الفيديوهات ─────────────────────────────────────────────────

async function getVideos({ phone, search, limit = 50, offset = 0 } = {}) {
  try {
    let sql    = `SELECT * FROM videos`;
    const vals = [];
    const conds = [];
    if (phone)  { conds.push(`phone = ?`);                     vals.push(phone); }
    if (search) { conds.push(`(name LIKE ? OR note LIKE ?)`);  vals.push(`%${search}%`, `%${search}%`); }
    if (conds.length) sql += ` WHERE ` + conds.join(" AND ");
    sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    vals.push(parseInt(limit), parseInt(offset));
    const [rows] = await pool.query(sql, vals);
    return rows;
  } catch (err) {
    console.error("❌ خطأ في جلب الفيديوهات:", err.message);
    return [];
  }
}

async function updateVideoNote(id, note) {
  try {
    await pool.query(`UPDATE videos SET note = ? WHERE id = ?`, [note || null, id]);
    return true;
  } catch (err) {
    console.error("❌ خطأ في تحديث التعليق:", err.message);
    return false;
  }
}

// ─── إحصائيات ─────────────────────────────────────────────────────────────

async function getVideoStats() {
  try {
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM videos`);
    const [[{ today }]] = await pool.query(
      `SELECT COUNT(*) AS today FROM videos WHERE DATE(created_at) = CURDATE()`
    );
    return { total, today };
  } catch (err) {
    return { total: 0, today: 0 };
  }
}

// ─── حذف فيديو ────────────────────────────────────────────────────────────

async function deleteVideo(id) {
  try {
    const [[row]] = await pool.query(`SELECT filename FROM videos WHERE id = ?`, [id]);
    if (!row) return false;
    const filepath = path.join(VIDEOS_DIR, row.filename);
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    await pool.query(`DELETE FROM videos WHERE id = ?`, [id]);
    return true;
  } catch (err) {
    console.error("❌ خطأ في حذف الفيديو:", err.message);
    return false;
  }
}

module.exports = { saveVideo, getVideos, getVideoStats, deleteVideo, updateVideoNote };
