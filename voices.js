const pool = require("./db");
const fs   = require("fs");
const path = require("path");

const VOICES_DIR = path.join(__dirname, "public", "uploads", "voices");
if (!fs.existsSync(VOICES_DIR)) fs.mkdirSync(VOICES_DIR, { recursive: true });

// ─── حفظ رسالة صوتية ──────────────────────────────────────────────────────

async function saveVoice(phone, name, media) {
  try {
    const mimeBase = (media.mimetype || "audio/ogg").split(";")[0].trim();
    const ext      = mimeBase.split("/")[1] || "ogg";
    const filename = `${Date.now()}_${phone}.${ext}`;
    const filepath = path.join(VOICES_DIR, filename);

    const rawData = (media.data || "").includes(",") ? media.data.split(",")[1] : media.data;
    const buffer  = Buffer.from(rawData, "base64");
    fs.writeFileSync(filepath, buffer);

    // INSERT IGNORE: UNIQUE(filename) يمنع التكرار
    await pool.query(
      `INSERT IGNORE INTO voices (phone, name, filename, mimetype, filesize)
       VALUES (?, ?, ?, ?, ?)`,
      [phone, name || "غير معروف", filename, mimeBase, buffer.length]
    );

    console.log(`🎤 صوت محفوظ من ${name} (${phone}): ${filename}`);
    return filename;
  } catch (err) {
    console.error("❌ خطأ في حفظ الصوت:", err.message);
    return null;
  }
}

// ─── جلب قائمة الصوتيات ───────────────────────────────────────────────────

async function getVoices({ phone, search, limit = 50, offset = 0 } = {}) {
  try {
    const lim  = parseInt(limit);
    const off  = parseInt(offset);
    const conds = [];
    const vals  = [];
    if (phone)  { const last9 = String(phone).replace(/\D/g,"").slice(-9); conds.push(`RIGHT(phone,9) = ?`); vals.push(last9); }
    if (search) { conds.push(`(name LIKE ? OR note LIKE ?)`); vals.push(`%${search}%`, `%${search}%`); }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const [rows] = await pool.query(
      `SELECT * FROM voices ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...vals, lim, off]
    );
    return rows;
  } catch (err) {
    console.error("❌ خطأ في جلب الصوتيات:", err.message);
    return [];
  }
}

async function updateVoiceNote(id, note) {
  try {
    await pool.query(`UPDATE voices SET note = ? WHERE id = ?`, [note || null, id]);
    return true;
  } catch { return false; }
}

// ─── إحصائيات ─────────────────────────────────────────────────────────────

async function getVoiceStats() {
  try {
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM voices`);
    const [[{ today }]] = await pool.query(`SELECT COUNT(*) AS today FROM voices WHERE DATE(created_at) = CURDATE()`);
    return { total, today };
  } catch { return { total: 0, today: 0 }; }
}

// ─── حذف رسالة صوتية ──────────────────────────────────────────────────────

async function deleteVoice(id) {
  try {
    const [[row]] = await pool.query(`SELECT filename FROM voices WHERE id = ?`, [id]);
    if (!row) return false;
    const filepath = path.join(VOICES_DIR, row.filename);
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    await pool.query(`DELETE FROM voices WHERE id = ?`, [id]);
    return true;
  } catch { return false; }
}

module.exports = { saveVoice, getVoices, getVoiceStats, deleteVoice, updateVoiceNote };
