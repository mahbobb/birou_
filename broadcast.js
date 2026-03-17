#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
//  broadcast.js — إرسال رسالة جماعية للزبائن الذين تمت إجابتهم
//
//  الاستخدام:
//    node broadcast.js                        ← رسالة افتراضية
//    node broadcast.js "رسالتك هنا"           ← رسالة مخصصة
//    node broadcast.js --days 7               ← زبائن آخر 7 أيام فقط
//    node broadcast.js --dry-run              ← معاينة بدون إرسال
//    node broadcast.js --bot bot2             ← استخدام بوت معين
// ═══════════════════════════════════════════════════════════════

require("dotenv").config();
const pool = require("./db");

// ── إعدادات ───────────────────────────────────────────────────
const DEFAULT_MSG = `مرحباً 👋

أنا هنا وجاهز للإجابة عن أسئلتك في أي وقت 😊
لا تتردد في التواصل معي!`;

const DELAY_MS    = 3000;   // تأخير بين كل رسالة (3 ثواني)
const PORT        = process.env.PORT || 3000;

// ── قراءة الأوامر ─────────────────────────────────────────────
const args    = process.argv.slice(2);
const dryRun  = args.includes("--dry-run");
const dayIdx  = args.indexOf("--days");
const botIdx  = args.indexOf("--bot");
const days    = dayIdx !== -1 ? parseInt(args[dayIdx + 1]) || 30 : 30;
const botId   = botIdx !== -1 ? args[botIdx + 1] : null;
const msgArg  = args.find(a => !a.startsWith("--") && args.indexOf(a) !== dayIdx + 1 && args.indexOf(a) !== botIdx + 1);
const message = msgArg || DEFAULT_MSG;

// ── جلب الزبائن الذين تمت إجابتهم ─────────────────────────────
async function getAnsweredContacts(days) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const [rows] = await pool.query(`
    SELECT DISTINCT m.contact AS phone, c.name
    FROM messages m
    LEFT JOIN contacts c ON c.phone = m.contact
    WHERE m.direction = 'out'
      AND m.created_at >= ?
      AND m.contact IS NOT NULL
      AND m.contact != ''
    ORDER BY MAX(m.created_at) DESC
  `, [since]);

  return rows;
}

// ── إرسال رسالة عبر API ────────────────────────────────────────
async function sendMessage(phone, text, botId) {
  const http = require("http");
  const body = JSON.stringify({ phone, message: text, ...(botId ? { botId } : {}) });

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "localhost",
      port: PORT,
      path: "/api/send",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, (res) => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ ok: false, error: "parse error" }); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatPhone(p) {
  const digits = String(p).replace(/\D/g, "");
  return digits.length > 9 ? "+" + digits : digits;
}

// ── التشغيل الرئيسي ───────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════");
  console.log("  📢 Broadcast — إرسال تذكير جماعي");
  console.log("═══════════════════════════════════════");
  console.log(`📅 آخر ${days} يوم`);
  console.log(`🤖 البوت: ${botId || "تلقائي"}`);
  console.log(`📝 الرسالة:\n${message}\n`);
  if (dryRun) console.log("⚠️  DRY RUN — لن يتم إرسال أي رسالة\n");

  const contacts = await getAnsweredContacts(days);

  if (!contacts.length) {
    console.log("⚠️  لا يوجد زبائن في الفترة المحددة");
    process.exit(0);
  }

  console.log(`📋 عدد الزبائن: ${contacts.length}\n`);
  console.log("─────────────────────────────────────");

  let sent = 0, failed = 0;

  for (let i = 0; i < contacts.length; i++) {
    const { phone, name } = contacts[i];
    const label = name && !/^\d+$/.test(name) ? name : formatPhone(phone);
    process.stdout.write(`[${i + 1}/${contacts.length}] ${label} ... `);

    if (dryRun) {
      console.log("✓ (dry-run)");
      continue;
    }

    try {
      const result = await sendMessage(phone, message, botId);
      if (result.ok) {
        console.log("✅ تم");
        sent++;
      } else {
        console.log(`❌ ${result.error || "فشل"}`);
        failed++;
      }
    } catch (err) {
      console.log(`❌ ${err.message}`);
      failed++;
    }

    if (i < contacts.length - 1) await sleep(DELAY_MS);
  }

  console.log("\n═══════════════════════════════════════");
  if (dryRun) {
    console.log(`  ✅ معاينة فقط — ${contacts.length} زبون`);
  } else {
    console.log(`  ✅ تم الإرسال: ${sent}`);
    console.log(`  ❌ فشل:       ${failed}`);
    console.log(`  📊 المجموع:   ${contacts.length}`);
  }
  console.log("═══════════════════════════════════════");

  await pool.end();
  process.exit(0);
}

main().catch(err => {
  console.error("❌ خطأ:", err.message);
  process.exit(1);
});
