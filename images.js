const pool = require("./db");
const fs   = require("fs");
const path = require("path");

const IMAGES_DIR = path.join(__dirname, "public", "uploads", "images");
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

// ─── حفظ صورة ─────────────────────────────────────────────────────────────

async function saveImage(phone, name, media, createdAt = null) {
  try {
    const ext      = (media.mimetype || "image/jpeg").split("/")[1].split(";")[0] || "jpg";
    const ts       = createdAt ? new Date(createdAt).getTime() : Date.now();
    const filename = `${ts}_${phone}.${ext}`;
    const filepath = path.join(IMAGES_DIR, filename);

    const rawData = (media.data || "").includes(",") ? media.data.split(",")[1] : media.data;
    const buffer  = Buffer.from(rawData, "base64");
    fs.writeFileSync(filepath, buffer);

    const created = createdAt ? new Date(createdAt) : new Date();

    // INSERT IGNORE: UNIQUE(filename) يمنع حفظ نفس الملف مرتين
    await pool.query(
      `INSERT IGNORE INTO images (phone, name, filename, mimetype, filesize, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [phone, name || "غير معروف", filename, media.mimetype || "image/jpeg", buffer.length, created]
    );

    console.log(`📸 صورة محفوظة من ${name} (${phone}): ${filename}`);
    return filename;
  } catch (err) {
    console.error("❌ خطأ في حفظ الصورة:", err.message);
    return null;
  }
}

// ─── جلب قائمة الصور ──────────────────────────────────────────────────────

async function getImages({ phone, limit = 50, offset = 0 } = {}) {
  try {
    if (phone) {
      const [rows] = await pool.query(
        `SELECT * FROM images WHERE phone = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [phone, parseInt(limit), parseInt(offset)]
      );
      return rows;
    }
    const [rows] = await pool.query(
      `SELECT * FROM images ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [parseInt(limit), parseInt(offset)]
    );
    return rows;
  } catch (err) {
    console.error("❌ خطأ في جلب الصور:", err.message);
    return [];
  }
}

// ─── إحصائيات ─────────────────────────────────────────────────────────────

async function getImageStats() {
  try {
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM images`);
    const [[{ today }]] = await pool.query(`SELECT COUNT(*) AS today FROM images WHERE DATE(created_at) = CURDATE()`);
    return { total, today };
  } catch { return { total: 0, today: 0 }; }
}

// ─── حذف صورة ─────────────────────────────────────────────────────────────

async function deleteImage(id) {
  try {
    const [[row]] = await pool.query(`SELECT filename FROM images WHERE id = ?`, [id]);
    if (!row) return false;
    const filepath = path.join(IMAGES_DIR, row.filename);
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    await pool.query(`DELETE FROM images WHERE id = ?`, [id]);
    return true;
  } catch (err) {
    console.error("❌ خطأ في حذف الصورة:", err.message);
    return false;
  }
}

module.exports = { saveImage, getImages, getImageStats, deleteImage };
