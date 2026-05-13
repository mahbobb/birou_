const pool   = require("./db");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

const IMAGES_DIR = path.join(__dirname, "public", "uploads", "images");
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

// ─── حفظ صورة (مع dedup par contenu) ─────────────────────────────────────
async function saveImage(phone, name, media, createdAt = null) {
  try {
    const rawData = (media.data || "").includes(",") ? media.data.split(",")[1] : media.data;
    const buffer  = Buffer.from(rawData, "base64");

    // ── hash SHA-256 du contenu ───────────────────────────────────────────
    const hash     = crypto.createHash("sha256").update(buffer).digest("hex");
    const last9    = String(phone).replace(/\D/g, "").slice(-9);

    // ── Vérifier si (phone, hash) existe déjà ────────────────────────────
    const [[existing]] = await pool.query(
      `SELECT filename FROM images
       WHERE content_hash = ? AND RIGHT(phone, 9) = ? LIMIT 1`,
      [hash, last9]
    );
    if (existing) {
      console.log(`⚡ image déjà enregistrée pour ${phone}: ${existing.filename}`);
      return existing.filename;
    }

    const ext      = (media.mimetype || "image/jpeg").split("/")[1].split(";")[0] || "jpg";
    const ts       = createdAt ? new Date(createdAt).getTime() : Date.now();
    const filename = `${ts}_${phone}.${ext}`;
    const filepath = path.join(IMAGES_DIR, filename);

    fs.writeFileSync(filepath, buffer);

    const created = createdAt ? new Date(createdAt) : new Date();

    // INSERT IGNORE: double garde — UNIQUE(filename) + UNIQUE(phone, content_hash)
    await pool.query(
      `INSERT IGNORE INTO images
         (phone, name, filename, mimetype, filesize, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [phone, name || "غير معروف", filename, media.mimetype || "image/jpeg",
       buffer.length, hash, created]
    );

    console.log(`📸 image enregistrée — ${name} (${phone}): ${filename}`);
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
      const last9 = String(phone).replace(/\D/g, "").slice(-9);
      const [rows] = await pool.query(
        `SELECT * FROM images WHERE RIGHT(phone,9) = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [last9, parseInt(limit), parseInt(offset)]
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

// ─── Mettre à jour la note d'une image ────────────────────────────────────────
async function updateImageNote(id, note) {
  try {
    await pool.query(`UPDATE images SET note = ? WHERE id = ?`, [note || null, id]);
    return true;
  } catch (err) {
    console.error("❌ خطأ في حفظ الملاحظة:", err.message);
    return false;
  }
}

module.exports = { saveImage, getImages, getImageStats, deleteImage, updateImageNote };
