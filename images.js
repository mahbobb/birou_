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

// ─── مجلد حفظ الصور ────────────────────────────────────────────────────────

const IMAGES_DIR = path.join(__dirname, "public", "uploads", "images");
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

// ─── إنشاء الجدول تلقائياً إذا لم يكن موجوداً ────────────────────────────

pool.query(`
  CREATE TABLE IF NOT EXISTS images (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    phone      VARCHAR(20)   NOT NULL,
    name       VARCHAR(100)  NOT NULL DEFAULT 'غير معروف',
    filename   VARCHAR(255)  NOT NULL,
    mimetype   VARCHAR(100)  NOT NULL DEFAULT 'image/jpeg',
    filesize   INT           NOT NULL DEFAULT 0,
    created_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_phone      (phone),
    INDEX idx_created_at (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`).then(() => {
  console.log("✅ جدول images جاهز");
}).catch(err => {
  console.error("⚠️ تعذر إنشاء جدول images:", err.message);
});

// ─── حفظ صورة واردة ────────────────────────────────────────────────────────

async function saveImage(phone, name, media) {
  try {
    // تحديد الامتداد من mimetype
    const ext = (media.mimetype || "image/jpeg").split("/")[1].split(";")[0] || "jpg";
    const filename = `${Date.now()}_${phone}.${ext}`;
    const filepath = path.join(IMAGES_DIR, filename);

    // بعض الإصدارات ترجع data URL كاملة — نأخذ الجزء بعد الفاصلة فقط
    const rawData = (media.data || "").includes(",")
      ? media.data.split(",")[1]
      : media.data;

    const buffer = Buffer.from(rawData, "base64");
    fs.writeFileSync(filepath, buffer);

    // حفظ المعلومات في قاعدة البيانات
    await pool.query(
      `INSERT INTO images (phone, name, filename, mimetype, filesize) VALUES (?, ?, ?, ?, ?)`,
      [phone, name || "غير معروف", filename, media.mimetype || "image/jpeg", buffer.length]
    );

    console.log(`📸 صورة محفوظة من ${name} (${phone}): ${filename}`);
    return filename;
  } catch (err) {
    console.error("❌ خطأ في حفظ الصورة:", err.message);
    return null;
  }
}

// ─── جلب قائمة الصور ───────────────────────────────────────────────────────

async function getImages({ phone, limit = 50, offset = 0 } = {}) {
  try {
    let sql    = `SELECT * FROM images`;
    const vals = [];
    if (phone) { sql += ` WHERE phone = ?`; vals.push(phone); }
    sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    vals.push(parseInt(limit), parseInt(offset));
    const [rows] = await pool.query(sql, vals);
    return rows;
  } catch (err) {
    console.error("❌ خطأ في جلب الصور:", err.message);
    return [];
  }
}

// ─── إحصائيات الصور ────────────────────────────────────────────────────────

async function getImageStats() {
  try {
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM images`);
    const [[{ today }]] = await pool.query(
      `SELECT COUNT(*) AS today FROM images WHERE DATE(created_at) = CURDATE()`
    );
    return { total, today };
  } catch (err) {
    return { total: 0, today: 0 };
  }
}

module.exports = { saveImage, getImages, getImageStats };
