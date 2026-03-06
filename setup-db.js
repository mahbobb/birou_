require("dotenv").config();
const mysql = require("mysql2/promise");

async function setup() {
  const conn = await mysql.createConnection({
    host:     process.env.DB_HOST     || "localhost",
    port:     parseInt(process.env.DB_PORT) || 3306,
    user:     process.env.DB_USER     || "root",
    password: process.env.DB_PASSWORD || "",
  });

  const db = process.env.DB_NAME || "whatsapp_bot";
  console.log(`\n🔧 إعداد قاعدة البيانات: ${db}\n`);

  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await conn.query(`USE \`${db}\``);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      phone          VARCHAR(20)   NOT NULL UNIQUE,
      name           VARCHAR(100)  NOT NULL DEFAULT 'غير معروف',
      first_seen     DATETIME      NOT NULL,
      last_seen      DATETIME      NOT NULL,
      last_message   TEXT,
      total_messages INT           NOT NULL DEFAULT 1,
      INDEX idx_phone (phone),
      INDEX idx_last_seen (last_seen)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  console.log("✅ جدول contacts جاهز!");

  await conn.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      phone      VARCHAR(20)      NOT NULL,
      name       VARCHAR(100)     NOT NULL DEFAULT 'غير معروف',
      direction  ENUM('in','out') NOT NULL,
      body       TEXT             NOT NULL,
      source     VARCHAR(20)      NOT NULL DEFAULT 'ai',
      created_at DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_phone      (phone),
      INDEX idx_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  console.log("✅ جدول messages جاهز!");

  await conn.query(`
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
  `);
  console.log("✅ جدول images جاهز!");

  await conn.query(`
    CREATE TABLE IF NOT EXISTS voices (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      phone      VARCHAR(20)   NOT NULL,
      name       VARCHAR(100)  NOT NULL DEFAULT 'غير معروف',
      filename   VARCHAR(255)  NOT NULL,
      mimetype   VARCHAR(100)  NOT NULL DEFAULT 'audio/ogg',
      duration   INT           NOT NULL DEFAULT 0,
      filesize   INT           NOT NULL DEFAULT 0,
      created_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_phone      (phone),
      INDEX idx_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  console.log("✅ جدول voices جاهز!");

  await conn.query(`
    CREATE TABLE IF NOT EXISTS videos (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      phone      VARCHAR(20)   NOT NULL,
      name       VARCHAR(100)  NOT NULL DEFAULT 'غير معروف',
      filename   VARCHAR(255)  NOT NULL,
      mimetype   VARCHAR(100)  NOT NULL DEFAULT 'video/mp4',
      filesize   INT           NOT NULL DEFAULT 0,
      created_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_phone      (phone),
      INDEX idx_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  console.log("✅ جدول videos جاهز!");

  console.log("✅ قاعدة البيانات جاهزة للاستخدام!\n");

  await conn.end();
}

setup().catch((err) => {
  console.error("❌ خطأ في إعداد قاعدة البيانات:", err.message);
  process.exit(1);
});
