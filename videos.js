const pool = require("./db");
const fs   = require("fs");
const path = require("path");

const VIDEOS_DIR = path.join(__dirname, "public", "uploads", "videos");
if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });

// ─── حفظ فيديو ────────────────────────────────────────────────────────────

async function saveVideo(phone, name, media, createdAt = null) {
  try {
    const mimeBase = (media.mimetype || "video/mp4").split(";")[0].trim();
    const ext      = mimeBase.split("/")[1] || "mp4";
    const ts       = createdAt ? new Date(createdAt).getTime() : Date.now();
    const filename = `${ts}_${phone}.${ext}`;
    const filepath = path.join(VIDEOS_DIR, filename);

    const rawData = (media.data || "").includes(",") ? media.data.split(",")[1] : media.data;
    const buffer  = Buffer.from(rawData, "base64");
    fs.writeFileSync(filepath, buffer);

    const created = createdAt ? new Date(createdAt) : new Date();

    // INSERT IGNORE: UNIQUE(filename) يمنع التكرار
    await pool.query(
      `INSERT IGNORE INTO videos (phone, name, filename, mimetype, filesize, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [phone, name || "غير معروف", filename, mimeBase, buffer.length, created]
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
    const lim   = parseInt(limit);
    const off   = parseInt(offset);
    const conds = [];
    const vals  = [];
    if (phone)  { const last9 = String(phone).replace(/\D/g,"").slice(-9); conds.push(`RIGHT(phone,9) = ?`); vals.push(last9); }
    if (search) { conds.push(`(name LIKE ? OR note LIKE ?)`); vals.push(`%${search}%`, `%${search}%`); }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const [rows] = await pool.query(
      `SELECT * FROM videos ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...vals, lim, off]
    );
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
  } catch { return false; }
}

// ─── إحصائيات ─────────────────────────────────────────────────────────────

async function getVideoStats() {
  try {
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM videos`);
    const [[{ today }]] = await pool.query(`SELECT COUNT(*) AS today FROM videos WHERE DATE(created_at) = CURDATE()`);
    return { total, today };
  } catch { return { total: 0, today: 0 }; }
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
  } catch { return false; }
}

module.exports = { saveVideo, getVideos, getVideoStats, deleteVideo, updateVideoNote };
