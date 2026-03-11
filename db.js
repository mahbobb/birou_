const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host:               process.env.DB_HOST     || "localhost",
  port:               parseInt(process.env.DB_PORT) || 3306,
  user:               process.env.DB_USER     || "root",
  password:           process.env.DB_PASSWORD || "",
  database:           process.env.DB_NAME     || "whatsapp_bot",
  waitForConnections: true,
  connectionLimit:    10,
  charset:            "utf8mb4",
});

// ─── إنشاء الجداول مع UNIQUE constraints ─────────────────────────────────

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      phone          VARCHAR(20)  NOT NULL,
      name           VARCHAR(100) NOT NULL DEFAULT 'غير معروف',
      first_seen     DATETIME     NOT NULL,
      last_seen      DATETIME     NOT NULL,
      last_message   TEXT,
      total_messages INT          NOT NULL DEFAULT 1,
      UNIQUE KEY uq_contacts_phone (phone),
      INDEX idx_contacts_last_seen (last_seen)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id         BIGINT PRIMARY KEY AUTO_INCREMENT,
      contact    VARCHAR(50),
      direction  ENUM('incoming','outgoing'),
      body       TEXT,
      media_url  TEXT,
      media_type VARCHAR(20),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_message (contact, body(200), created_at),
      INDEX idx_messages_contact    (contact),
      INDEX idx_messages_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // ── Migration: إعادة تسمية عمود phone → contact إذا كان الجدول قديماً ──
  try {
    await pool.query(`ALTER TABLE messages CHANGE COLUMN phone contact VARCHAR(50)`);
    console.log("✅ Migration: messages.phone → messages.contact");
  } catch (_) { /* العمود مسمى contact بالفعل، نتجاهل */ }

  // ── Migration: إضافة أعمدة إذا لم تكن موجودة ────────────────────────
  for (const col of [
    `ALTER TABLE messages ADD COLUMN media_url  TEXT         AFTER body`,
    `ALTER TABLE messages ADD COLUMN media_type VARCHAR(20)  AFTER media_url`,
    `ALTER TABLE messages ADD COLUMN source     VARCHAR(20)  AFTER media_type`,
    `ALTER TABLE messages ADD COLUMN wa_msg_id  VARCHAR(100) AFTER source`,
  ]) {
    try { await pool.query(col); } catch (_) { /* العمود موجود، نتجاهل */ }
  }
  // فهرس فريد على wa_msg_id (يسمح بـ NULL متعدد)
  try {
    await pool.query(`ALTER TABLE messages ADD UNIQUE KEY uq_wa_msg_id (wa_msg_id)`);
  } catch (_) { /* الفهرس موجود */ }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS images (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      phone      VARCHAR(20)  NOT NULL,
      name       VARCHAR(100) NOT NULL DEFAULT 'غير معروف',
      filename   VARCHAR(255) NOT NULL,
      mimetype   VARCHAR(100) NOT NULL DEFAULT 'image/jpeg',
      filesize   INT          NOT NULL DEFAULT 0,
      note       TEXT         DEFAULT NULL,
      created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_images_filename (filename),
      INDEX idx_images_phone      (phone),
      INDEX idx_images_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS voices (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      phone      VARCHAR(20)  NOT NULL,
      name       VARCHAR(100) NOT NULL DEFAULT 'غير معروف',
      filename   VARCHAR(255) NOT NULL,
      mimetype   VARCHAR(100) NOT NULL DEFAULT 'audio/ogg',
      duration   INT          NOT NULL DEFAULT 0,
      filesize   INT          NOT NULL DEFAULT 0,
      note       TEXT         DEFAULT NULL,
      created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_voices_filename (filename),
      INDEX idx_voices_phone      (phone),
      INDEX idx_voices_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS videos (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      phone      VARCHAR(20)  NOT NULL,
      name       VARCHAR(100) NOT NULL DEFAULT 'غير معروف',
      filename   VARCHAR(255) NOT NULL,
      mimetype   VARCHAR(100) NOT NULL DEFAULT 'video/mp4',
      filesize   INT          NOT NULL DEFAULT 0,
      note       TEXT         DEFAULT NULL,
      created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_videos_filename (filename),
      INDEX idx_videos_phone      (phone),
      INDEX idx_videos_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  console.log("✅ MySQL جاهز — كل الجداول والـ UNIQUE constraints محدّثة");
}

initDb().catch(err => console.error("❌ خطأ في إعداد DB:", err.message));

module.exports = pool;
