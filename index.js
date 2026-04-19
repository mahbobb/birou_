require("dotenv").config();
const crypto     = require("crypto");
const rateLimit    = require("express-rate-limit");
const compression  = require("compression");
const { exec }   = require("child_process");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const express = require("express");
const { generateResponse, clearHistory } = require("./claude");
const { findCustomResponse } = require("./customResponses");
const { verifyWebhook, handleWebhook, setIo: fbSetIo } = require("./facebook");
const { getMessengerContacts, countUnanswered, saveMessengerContact, saveMessengerMessage, getMessengerMessages } = require("./messenger");
const { createBooking, getBookings, updateBookingStatus, updateBooking, deleteBooking, getBookingStats, addIdImages } = require("./bookings");
const { registerContact, getStats, getAllContacts } = require("./contacts");
const { saveMessage, checkMessageExists, getMessages, getMessagesCount, getMessageStats, getUnansweredContacts } = require("./messages");
const { saveImage, getImages, getImageStats, deleteImage } = require("./images");
const { saveVoice, getVoices, getVoiceStats, deleteVoice, updateVoiceNote } = require("./voices");
const { saveVideo, getVideos, getVideoStats, deleteVideo, updateVideoNote } = require("./videos");
const { saveCall, getCalls, getCallsCount, getCallStats } = require("./calls");
const path   = require("path");
const fs     = require("fs");
const multer = require("multer");
const uploadIds = multer({
  dest: path.join(__dirname, "public", "uploads", "ids"),
  limits: { fileSize: 8 * 1024 * 1024, files: 4 },
  fileFilter: (_req, file, cb) => {
    cb(null, /^image\/(jpeg|png|webp|jpg)$/.test(file.mimetype));
  },
});

// ─── التحقق من مفاتيح API ──────────────────────────────────────────────────

const AI_PROVIDER = process.env.AI_PROVIDER || "groq";

if (AI_PROVIDER === "openai" && !process.env.OPENAI_API_KEY) {
  console.error("\n❌ OPENAI_API_KEY مفقود في .env\n");
  process.exit(1);
} else if (AI_PROVIDER === "groq" && !process.env.GROQ_API_KEY) {
  console.error("\n❌ GROQ_API_KEY مفقود في .env\n");
  process.exit(1);
}

// ─── الإعدادات ────────────────────────────────────────────────────────────

const config = {
  respondToPrivate:         process.env.RESPOND_TO_PRIVATE !== "false",
  respondToGroups:          process.env.RESPOND_TO_GROUPS === "true",
  respondGroupsMentionOnly: false, // رد فقط عند الإشارة @
  delayMin:         parseInt(process.env.RESPONSE_DELAY_MIN) || 1000,
  delayMax:         parseInt(process.env.RESPONSE_DELAY_MAX) || 3000,
  pauseKeyword:     process.env.PAUSE_KEYWORD  || "!pause",
  resumeKeyword:    process.env.RESUME_KEYWORD || "!resume",
  ignoredNumbers:   (process.env.IGNORED_NUMBERS || "")
    .split(",").map((n) => n.trim()).filter(Boolean),
};

// ─── جلب وحفظ صورة الزبون من واتساب ──────────────────────────────────────
const https  = require("https");
const http   = require("http");
const photoDir = path.join(__dirname, "public", "uploads", "photos");
if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });

const photoQueue   = new Set();   // منع التكرار
const PHOTO_TTL_MS = 24 * 3600 * 1000; // 24 ساعة

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const file  = fs.createWriteStream(dest);
    proto.get(url, res => {
      if (res.statusCode !== 200) { file.close(); fs.unlink(dest, ()=>{}); return reject(new Error("HTTP "+res.statusCode)); }
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
    }).on("error", e => { file.close(); fs.unlink(dest, ()=>{}); reject(e); });
  });
}

async function syncContactPhoto(phone, client) {
  if (photoQueue.has(phone)) return;
  photoQueue.add(phone);
  try {
    const db = require("./db");
    // تحقق من آخر تحديث
    const [[row]] = await db.query("SELECT photo_at FROM contacts WHERE phone=? LIMIT 1",[phone]);
    if (row?.photo_at && (Date.now() - new Date(row.photo_at).getTime()) < PHOTO_TTL_MS) return;

    const wid = phone.includes("@") ? phone : phone + "@c.us";
    const url = await client.getProfilePicUrl(wid).catch(()=>null);
    if (!url) return;

    const filename = phone + ".jpg";
    const dest     = path.join(photoDir, filename);
    await downloadFile(url, dest);
    await db.query("UPDATE contacts SET photo=?, photo_at=NOW() WHERE phone=?", [filename, phone]);
    console.log(`📸 صورة محفوظة: ${phone}`);
  } catch { /* تجاهل — الزبون ربما أخفى صورته */ }
  finally { photoQueue.delete(phone); }
}

// ─── تسجيل استخدام الردود المبرمجة ──────────────────────────────────────
async function logResponseUsage(phone, keywordsLabel, matchedKw, replyText, source = "whatsapp") {
  try {
    const pool = require("./db");
    await pool.query(
      `INSERT INTO response_logs (phone, keywords_label, matched_kw, reply_preview, source)
       VALUES (?, ?, ?, ?, ?)`,
      [
        String(phone || "").slice(0, 20),
        String(keywordsLabel || "").slice(0, 200),
        String(matchedKw || "").slice(0, 100),
        String(replyText || "").slice(0, 200),
        source,
      ]
    );
  } catch (err) {
    console.error("❌ logResponseUsage:", err.message);
  }
}

// ─── الحالة ───────────────────────────────────────────────────────────────

const BOT_START_TIME = Math.floor(Date.now() / 1000); // وقت بدء البوت بالثواني
let botPaused         = false;
let autoReplyEnabled  = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "responses.json"), "utf8")).autoReplyEnabled ?? false; }
  catch { return false; }
})();
let aiAutoReplyEnabled = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "responses.json"), "utf8")).aiAutoReplyEnabled ?? true; }
  catch { return true; }
})();
let mediaSyncStatus   = { running: false, done: 0, total: 0, saved: 0, errors: 0, skipped: 0, currentChat: "", lastError: "" };
const pausedChats   = new Set();

// منع تكرار نفس السؤال خلال 60 ثانية
const lastMessages    = new Map();
const REPEAT_DELAY_MS = 60 * 1000;

// ── Cache بسيط للاستعلامات المتكررة ──────────────────────────────────────
const queryCache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 دقائق

function getCachedQuery(key) {
  const cached = queryCache.get(key);
  if (cached && Date.now() - cached.time < CACHE_DURATION) {
    return cached.data;
  }
  queryCache.delete(key);
  return null;
}

function setCachedQuery(key, data) {
  queryCache.set(key, { data, time: Date.now() });
}

function isDuplicate(contactId, message) {
  const normalized = message.toLowerCase().trim();
  const last = lastMessages.get(contactId);
  if (last && last.msg === normalized && Date.now() - last.time < REPEAT_DELAY_MS) {
    return true;
  }
  lastMessages.set(contactId, { msg: normalized, time: Date.now() });
  return false;
}

// ─── Multi-client setup ────────────────────────────────────────────────────

// BOTS_ENABLED=bot1,bot2,bot3  → يمكن تعطيل أي بوت من .env
const _BOTS_ALL = ["bot1", "bot2", "bot3"];
const _BOTS_ENV = (process.env.BOTS_ENABLED || "").split(",").map(s => s.trim()).filter(Boolean);
const BOT_IDS   = _BOTS_ENV.length ? _BOTS_ALL.filter(id => _BOTS_ENV.includes(id)) : _BOTS_ALL;

const bots = new Map(BOT_IDS.map(id => [id, {
  client:       null,
  latestQr:     null,
  botConnected: false,
  botPhone:     "",
  botMsgIds:    new Set(),
}]));

function getActiveBot(preferredId = null) {
  if (preferredId && bots.has(preferredId)) {
    const b = bots.get(preferredId);
    if (b.botConnected) return b;
  }
  for (const b of bots.values()) if (b.botConnected) return b;
  return null;
}

// ── إيجاد مسار Chrome/Chromium تلقائياً ────────────────────────────────────
function findChromium() {
  const { execSync } = require("child_process");
  // الأولوية: Google Chrome الحقيقي > Chromium snap الداخلي > snap wrapper
  const candidates = [
    process.env.CHROMIUM_PATH,
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/local/bin/google-chrome",
    // snap الداخلي (يتجاوز wrapper)
    "/snap/chromium/current/usr/lib/chromium-browser/chromium-browser",
    "/snap/chromium/current/usr/lib/chromium/chromium",
    "/usr/bin/chromium",
    // snap wrapper — أقل أولوية (قد يفشل مع --no-sandbox)
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      execSync(`test -x "${p}"`, { stdio: "ignore" });
      return p;
    } catch {}
  }
  return null; // استخدم Puppeteer المدمج
}

const CHROMIUM_PATH = findChromium();
if (CHROMIUM_PATH) console.log(`🌐 Chromium: ${CHROMIUM_PATH}`);
else console.warn("⚠️  Chromium غير موجود — سيستخدم Puppeteer المدمج");

// ─── استيراد سجل الرسائل من WhatsApp ──────────────────────────────────────
async function importWhatsAppHistory(client, botId) {
  try {
    console.log(`\n📥 [${botId}] جاري استيراد سجل الرسائل من واتساب...`);
    const chats = await client.getChats();
    let imported = 0;

    for (const chat of chats) {
      if (chat.isGroup) continue; // تخطي المجموعات — ثقيلة جداً

      const phone = chat.id.user || "";
      if (!phone) continue;
      const name  = chat.name || chat.contact?.pushname || phone;

      try {
        const messages = await chat.fetchMessages({ limit: 30 });  // تقليل من 100 إلى 30
        for (const msg of messages) {
          const waMsgId = msg.id?._serialized;
          if (!waMsgId) continue;

          const direction = msg.fromMe ? "out" : "in";
          const sender    = msg.fromMe ? "أنت" : name;
          const ts        = new Date((msg.timestamp || Date.now() / 1000) * 1000);

          let body = msg.body || "";

          // ── تحميل الوسائط ──────────────────────────────────────────────
          if (!body && msg.hasMedia) {
            const mType = msg.type;
            const fallback = mType === "image"    ? "📷 صورة"
                           : mType === "video"    ? "🎬 فيديو"
                           : mType === "ptt"      ? "🎤 رسالة صوتية"
                           : mType === "audio"    ? "🎤 رسالة صوتية"
                           : mType === "document" ? "📄 مستند"
                           : mType === "sticker"  ? "🎭 ملصق"
                                                  : "📎 ملف";
            try {
              const media = await Promise.race([
                msg.downloadMedia(),
                new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 15000)),  // تقليل من 30s إلى 15s
              ]);

              if (media?.data) {
                const mime = media.mimetype || "";
                if (mime.startsWith("image/") && mType !== "sticker") {
                  const f = await saveImage(phone, name, media, ts);
                  body = f ? `/uploads/images/${f}` : fallback;
                } else if (mime.startsWith("audio/") || mType === "ptt" || mType === "audio") {
                  const f = await saveVoice(phone, name, media);
                  body = f ? `/uploads/voices/${f}` : fallback;
                } else if (mime.startsWith("video/") || mType === "video" || mType === "gif") {
                  const f = await saveVideo(phone, name, media, ts);
                  body = f ? `/uploads/videos/${f}` : fallback;
                } else {
                  body = fallback;
                }
              } else {
                body = fallback;
              }
            } catch {
              body = fallback;
            }
          }

          if (!body) continue;

          await registerContact(phone, name, body);
          await saveMessage(phone, sender, direction, body, "import", ts, waMsgId);
          imported++;

          await new Promise(r => setTimeout(r, 150)); // تأخير بين الوسائط
        }
      } catch { /* تخطي المحادثة عند خطأ */ }

      await new Promise(r => setTimeout(r, 500)); // تأخير بين المحادثات
    }

    console.log(`✅ [${botId}] استيراد مكتمل: ${imported} رسالة محفوظة`);
    const s = await getStats();
    console.log(`📋 إجمالي الزبائن: ${s.total}`);
  } catch (err) {
    console.error(`❌ [${botId}] فشل الاستيراد:`, err.message);
  }
}

function setupClient(botId) {
  const puppeteerOpts = {
    headless: true,
    protocolTimeout: 60000,  // تقليل من 120000
    args: [
      "--no-sandbox", "--disable-setuid-sandbox",
      "--disable-dev-shm-usage", "--disable-gpu",
      "--no-first-run", "--no-zygote",
      "--disable-extensions", "--disable-default-apps",
      "--disable-background-networking",
      "--disable-features=TranslateUI,VizDisplayCompositor,AudioServiceOutOfProcess",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--disable-sync", "--disable-translate",
      "--disable-notifications", "--disable-popup-blocking",
      "--disable-site-isolation-trials",
      "--hide-scrollbars", "--mute-audio",
      "--no-default-browser-check", "--no-pings",
      "--safebrowsing-disable-auto-update",
      // ── تسريع الاتصال ────────────────────────────
      "--disable-accelerated-2d-canvas",
      "--disable-webgl",
      "--in-process-gpu",
      "--disable-canvas-aa",
      "--disable-smooth-scrolling",
      "--disable-blink-features=AutomationControlled",  // إخفاء automation
      "--js-flags=--max-old-space-size=512",  // زيادة من 256 إلى 512
    ],
  };
  if (CHROMIUM_PATH) puppeteerOpts.executablePath = CHROMIUM_PATH;

  const c = new Client({
    authStrategy: new LocalAuth({ clientId: botId, dataPath: "./sessions" }),
    puppeteer: puppeteerOpts,
  });

  const bot = bots.get(botId);
  bot.client = c;

  c.on("qr", (qr) => {
    bot.latestQr = qr;
    bot.botConnected = false;
    console.log(`\n📱 [${botId}] اسكان QR code بالواتساب:\n`);
    qrcode.generate(qr, { small: true });
    console.log(`\n⏳ [${botId}] في انتظار السكان...\n`);
  });

  c.on("loading_screen", (percent, msg) => {
    process.stdout.write(`\r⏳ [${botId}] تحميل: ${percent}% — ${msg}   `);
  });

  c.on("authenticated", () => {
    console.log(`\n✅ [${botId}] تم التوثيق!`);
  });

  c.on("auth_failure", (msg) => {
    console.error(`\n❌ [${botId}] فشل التوثيق:`, msg);
    console.error(`   احذف مجلد 'sessions/${botId}' وأعد التشغيل.`);
  });

  c.on("ready", async () => {
    bot.botConnected = true;
    bot.latestQr = null;
    if (!bot.botPhone) bot.botPhone = c.info.wid.user;

    const model = AI_PROVIDER === "openai"
      ? (process.env.OPENAI_MODEL || "gpt-4o-mini")
      : (process.env.GROQ_MODEL  || "llama-3.3-70b-versatile");

    console.log(`\n🤖 [${botId}] بوت واتساب IA شغال!`);
    console.log("━".repeat(40));
    console.log(`📞 [${botId}] رقم البوت:       +${bot.botPhone}`);
    console.log(`🧠 موديل IA:        ${model} (${AI_PROVIDER})`);
    console.log(`📡 رسائل خاصة:      ${config.respondToPrivate ? "✅" : "❌"}`);
    console.log(`👥 مجموعات:         ${config.respondToGroups  ? "✅" : "❌"}`);
    console.log("━".repeat(40));
    const stats = await getStats();
    console.log(`\n📋 الزبائن المسجلين: ${stats.total} | اليوم: ${stats.today}`);
    console.log(`\n🟢 [${botId}] في انتظار الرسائل...\n`);

    // ── استيراد سجل الرسائل مرة واحدة في الحياة (flag ملف ثابت) ───────────
    const flagFile = path.join(__dirname, "data", `imported_${botId}.flag`);
    if (!fs.existsSync(flagFile)) {
      if (!fs.existsSync(path.join(__dirname, "data")))
        fs.mkdirSync(path.join(__dirname, "data"), { recursive: true });
      setTimeout(async () => {
        await importWhatsAppHistory(c, botId);
        fs.writeFileSync(flagFile, new Date().toISOString()); // حفظ الـ flag بعد الانتهاء
      }, 5000);
    } else {
      console.log(`⏭️  [${botId}] سجل الرسائل مستورد مسبقاً — تم التخطي`);
    }

    // ── Watchdog: فحص حالة الاتصال كل 90 ثانية — إعادة تشغيل تلقائية إذا تجمّد ──
    if (bot._keepaliveTimer) clearInterval(bot._keepaliveTimer);
    bot._watchdogFails = 0;
    bot._keepaliveTimer = setInterval(async () => {
      if (!bot.botConnected) return;
      try {
        const state = await Promise.race([
          c.getState(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 10000)),
        ]);
        if (state === "CONNECTED") {
          bot._watchdogFails = 0; // إعادة العدّ عند النجاح
        } else {
          bot._watchdogFails = (bot._watchdogFails || 0) + 1;
          console.warn(`⚠️  [${botId}] حالة WA: ${state} (محاولة ${bot._watchdogFails})`);
          if (bot._watchdogFails >= 2) throw new Error(`state=${state}`);
        }
      } catch (err) {
        console.warn(`⚠️  [${botId}] watchdog فشل: ${err.message} — إعادة تشغيل تلقائية...`);
        bot.botConnected = false;
        bot._watchdogFails = 0;
        clearInterval(bot._keepaliveTimer);
        bot._keepaliveTimer = null;
        try { c.destroy().catch(() => {}); } catch {}
        const delay = 15000 + Math.floor(Math.random() * 15000);
        setTimeout(() => setupClient(botId), delay);
      }
    }, 90000);  // تقليل الفحوصات من 45 إلى 90 ثانية
  });

  c.on("disconnected", (reason) => {
    if (bot._keepaliveTimer) { clearInterval(bot._keepaliveTimer); bot._keepaliveTimer = null; }
    bot.botConnected = false;
    bot.latestQr = null;
    console.log(`\n🔴 [${botId}] انقطع الاتصال:`, reason);
    // إعادة التشغيل بعد 30-50 ثانية (عشوائي لتفادي تصادم البوتات)
    const delay = 30000 + Math.floor(Math.random() * 20000);
    setTimeout(() => {
      console.log(`\n🔄 [${botId}] إعادة تشغيل تلقائية...`);
      try { c.destroy().catch(() => {}); } catch {}
      setupClient(botId);
    }, delay);
  });

  // ── معالج لأخطاء غير متوقعة في الـ client (TargetCloseError, WebSocket, etc) ─
  c.on("error", (err) => {
    console.error(`⚠️  [${botId}] خطأ في client:`, err.message);
    if (err.name === "TargetCloseError" || err.message?.includes("Target closed")) {
      console.warn(`⚠️  [${botId}] فقدان معالج Chromium — إعادة تشغيل...`);
      bot.botConnected = false;
      if (bot._keepaliveTimer) { clearInterval(bot._keepaliveTimer); bot._keepaliveTimer = null; }
      try { c.destroy().catch(() => {}); } catch {}
      setTimeout(() => setupClient(botId), 5000);
    }
  });

  c.on("message", msg => handleIncoming(msg, botId));
  c.on("message_create", msg => handleOutgoing(msg, botId));

  // ── رد تلقائي على المكالمات الواردة ────────────────────────────────────────
  c.on("call", async (call) => {
    try {
      // بعض المكالمات تأتي بدون id (مكالمات مجموعات أو تنسيق غير متوقع)
      if (!call || !call.id) return;
      const callType = call.isVideo ? "video" : "voice";
      const callLabel = call.isVideo ? "📹 مكالمة فيديو" : "📞 مكالمة صوتية";
      const phone = (call.from || "").replace(/@.*/, "");

      // تسجيل المكالمة في قاعدة البيانات
      let callerName = phone;
      try {
        const ct = await require("./db").query(
          `SELECT name FROM contacts WHERE phone = ? LIMIT 1`, [phone]
        );
        if (ct[0] && ct[0][0]) callerName = ct[0][0].name;
      } catch {}
      await saveCall({ phone, name: callerName, callType, botId });
      console.log(`📞 [${botId}] مكالمة واردة من: ${phone} — سيرن على الهاتف`);

      // إشعار socket للوحة التحكم
      io.emit("new_call", { phone, name: callerName, callType, botId, created_at: new Date() });
    } catch (err) {
      console.error(`❌ [${botId}] خطأ في رفض المكالمة:`, err.message);
    }
  });

  // ── احذف ملفات قفل Chrome المتبقية (تمنع إعادة التشغيل بعد SIGKILL) ──────
  const sessionDir = path.join(__dirname, "sessions", `session-${botId}`);
  for (const lock of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try { fs.unlinkSync(path.join(sessionDir, lock)); console.log(`🔓 [${botId}] حذف قفل: ${lock}`); } catch {}
  }

  c.initialize().catch((err) => {
    console.error(`\n❌ [${botId}] فشل التهيئة:`, err.message || err);
    // إذا كان الخطأ بسبب قفل Chrome — احذف القفل وأعد المحاولة بسرعة
    if (err.message?.includes("already running") || err.message?.includes("SingletonLock")) {
      console.warn(`🔓 [${botId}] اكتشاف قفل Chrome — حذف وإعادة المحاولة...`);
      for (const lock of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
        try { fs.unlinkSync(path.join(sessionDir, lock)); } catch {}
      }
      setTimeout(() => { try { c.destroy().catch(() => {}); } catch {} setupClient(botId); }, 2000);  // تقليل من 5s
      return;
    }
    // إعادة المحاولة بعد 20-35 ثانية (أسرع من قبل)
    const delay = 20000 + Math.floor(Math.random() * 15000);  // تقليل من 35-60s
    setTimeout(() => {
      console.log(`\n🔄 [${botId}] إعادة محاولة التهيئة...`);
      try { c.destroy().catch(() => {}); } catch {}
      setupClient(botId);
    }, delay);
  });
}

// ─── معالجة الرسائل الواردة ────────────────────────────────────────────────

async function handleIncoming(message, botId) {
  try {
    // تجاهل الرسائل القديمة (قبل بدء البوت) — يمنع إعادة المعالجة عند إعادة التشغيل
    if (message.timestamp < BOT_START_TIME) return;
    if (!message.id) return; // تجاهل رسائل النظام بدون معرّف

    // getChat / getContact قد يرميان خطأ داخلياً لبعض أنواع الرسائل (broadcast, status, LID)
    let chat, contact;
    try {
      chat    = await message.getChat();
      contact = await message.getContact();
    } catch { return; }
    if (!chat || !chat.id) return; // تجاهل إذا لم يُعرَّف المحادثة
    if (!contact || !contact.id) return; // تجاهل إذا لم يُعرَّف جهة الاتصال
    const contactId = contact.id._serialized;
    const name      = contact.pushname || contact.name || "صاحبي";
    const body      = (message.body || "").trim();

    if (message.fromMe) {
      await handleAdminCommand(body, chat, contactId, botId);
      return;
    }

    // فلترة
    const senderNumber = normalizePhone(contact) || normalizePhone(contactId);
    const key = phoneKey(senderNumber); // مفتاح 9 أرقام — يجب أن يتطابق مع غرفة socket

    // تجاهل رسائل المحجوبين
    try {
      const db = require("./db");
      const [blocked] = await db.query(`SELECT is_blocked FROM contacts WHERE phone = ?`, [key]);
      if (blocked[0]?.is_blocked) return;
    } catch { /* لا تقطع المعالجة عند خطأ DB */ }
    if (config.ignoredNumbers.includes(senderNumber))      return;
    if (chat.isGroup && !config.respondToGroups)           return;
    if (!chat.isGroup && !config.respondToPrivate)         return;
    // رد فقط عند الإشارة @ في المجموعات
    if (chat.isGroup && config.respondGroupsMentionOnly) {
      const botPhone = bots.get(botId)?.botPhone || "";
      const mentioned = (message.mentionedIds || []).some(id =>
        String(id).replace(/\D/g,"").endsWith(botPhone.slice(-9))
      );
      const bodyMention = botPhone && message.body?.includes(botPhone.slice(-9));
      if (!mentioned && !bodyMention) return;
    }
    if (botPaused || pausedChats.has(chat.id._serialized)) return;

    // ─── جلب صورة الزبون في الخلفية (بدون انتظار) ────────────────────────────
    const botObj = bots.get(botId);
    if (botObj?.client) {
      setImmediate(() => syncContactPhoto(key, botObj.client));
    }

    // ─── معالجة الوسائط (صور + صوت + فيديو + ملفات) ──────────────────────────
    if (message.hasMedia) {
      // تحديد نوع الوسائط من type حتى قبل التحميل
      const mType = message.type; // image, ptt, audio, video, document, sticker, gif
      const fallbackEmoji = mType === "ptt" || mType === "audio" ? "🎤 رسالة صوتية"
                          : mType === "video"                    ? "🎬 فيديو"
                          : mType === "image"                    ? "📷 صورة"
                          : mType === "sticker"                  ? "🎭 ملصق"
                          : mType === "document"                 ? "📄 مستند"
                                                                 : "📎 ملف";

      await registerContact(senderNumber, name, fallbackEmoji);

      // تحميل الوسائط مع timeout 25 ثانية
      let media = null;
      try {
        media = await Promise.race([
          message.downloadMedia(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("download timeout")), 25000)),
        ]);
      } catch (dlErr) {
        console.warn(`⚠️ [${botId}] فشل تحميل الوسائط من ${name}: ${dlErr.message}`);
      }

      // إذا فشل التحميل — نحفظ رسالة بالإيموجي فقط
      if (!media?.data) {
        await saveMessage(senderNumber, name, "in", fallbackEmoji, "user", null, message.id._serialized);
        emitMessage(key, { waMsgId: message.id._serialized, phone: key, name, direction: "in", body: fallbackEmoji, source: "user", created_at: new Date().toISOString() });
        return;
      }

      const mime = media.mimetype || "";

      // ── صورة ──────────────────────────────────────────────────────────────
      if (mime.startsWith("image/") && mType !== "sticker") {
        const imgFile = await saveImage(senderNumber, name, media);
        const imgUrl  = imgFile ? `/uploads/images/${imgFile}` : fallbackEmoji;
        await saveMessage(senderNumber, name, "in", imgUrl, "user", null, message.id._serialized);
        emitMessage(key, { waMsgId: message.id._serialized, phone: key, name, direction: "in", body: imgUrl, source: "user", created_at: new Date().toISOString() });
        if (imgFile) io.emit("new_media", { type: "image", phone: key, name, url: imgUrl });
        if (autoReplyEnabled) {
          const r = "📸 وصلتنا صورتك، شكرا! إذا عندك أي سؤال على الشقق كلمنا على 0680040002 😊";
          const s1 = await botReply(message, r, botId);
          await saveMessage(senderNumber, "البوت", "out", r, "default", null, s1?.id?._serialized || null);
          emitMessage(key, { phone: key, name: "البوت", direction: "out", body: r, source: "default", created_at: new Date().toISOString() });
        }
        return;
      }

      // ── صوت / ptt ─────────────────────────────────────────────────────────
      if (mime.startsWith("audio/") || mType === "ptt" || mType === "audio") {
        const voiceFile = await saveVoice(senderNumber, name, media);
        const voiceUrl  = voiceFile ? `/uploads/voices/${voiceFile}` : fallbackEmoji;
        await saveMessage(senderNumber, name, "in", voiceUrl, "user", null, message.id._serialized);
        emitMessage(key, { waMsgId: message.id._serialized, phone: key, name, direction: "in", body: voiceUrl, source: "user", created_at: new Date().toISOString() });
        if (voiceFile) io.emit("new_media", { type: "voice", phone: key, name, url: voiceUrl });
        if (autoReplyEnabled) {
          const r = "🎤 وصلتنا رسالتك الصوتية! إذا عندك سؤال على الشقق كلمنا على 0680040002 😊";
          const s2 = await botReply(message, r, botId);
          await saveMessage(senderNumber, "البوت", "out", r, "default", null, s2?.id?._serialized || null);
          emitMessage(key, { phone: key, name: "البوت", direction: "out", body: r, source: "default", created_at: new Date().toISOString() });
        }
        return;
      }

      // ── فيديو ─────────────────────────────────────────────────────────────
      if (mime.startsWith("video/") || mType === "video" || mType === "gif") {
        const videoFile = await saveVideo(senderNumber, name, media);
        const videoUrl  = videoFile ? `/uploads/videos/${videoFile}` : fallbackEmoji;
        await saveMessage(senderNumber, name, "in", videoUrl, "user", null, message.id._serialized);
        emitMessage(key, { waMsgId: message.id._serialized, phone: key, name, direction: "in", body: videoUrl, source: "user", created_at: new Date().toISOString() });
        if (videoFile) io.emit("new_media", { type: "video", phone: key, name, url: videoUrl });
        if (autoReplyEnabled) {
          const r = "🎬 وصلنا الفيديو ديالك، شكرا! إذا عندك سؤال على الشقق كلمنا على 0680040002 😊";
          const s3 = await botReply(message, r, botId);
          await saveMessage(senderNumber, "البوت", "out", r, "default", null, s3?.id?._serialized || null);
          emitMessage(key, { phone: key, name: "البوت", direction: "out", body: r, source: "default", created_at: new Date().toISOString() });
        }
        return;
      }

      // ── ملفات أخرى (document, sticker, ...) ──────────────────────────────
      await saveMessage(senderNumber, name, "in", fallbackEmoji, "user", null, message.id._serialized);
      emitMessage(key, { waMsgId: message.id._serialized, phone: key, name, direction: "in", body: fallbackEmoji, source: "user", created_at: new Date().toISOString() });
      return;
    }

    if (!body) return;

    // تسجيل الزبون
    await registerContact(senderNumber, name, body);

    // حفظ الرسالة الواردة (مع معرّف واتساب لمنع التكرار)
    await saveMessage(senderNumber, name, "in", body, "user", null, message.id._serialized);
    emitMessage(key, { waMsgId: message.id._serialized, phone: key, name, direction: "in", body, source: "user", created_at: new Date().toISOString() });

    // إذا كانت الردود التلقائية مطفأة — نوقف هنا
    if (!autoReplyEnabled) {
      console.log(`\n📩 [بدون رد] ${name} (${senderNumber}): ${body}`);
      return;
    }

    // السؤال المكرر — تجاهل بدون رد
    if (isDuplicate(contactId, body)) {
      console.log(`🔁 مكرر من ${name} — تجاهل`);
      return;
    }

    console.log(`\n📩 ${name} (${senderNumber}): ${body}`);

    // الأولوية 1: الأجوبة المبرمجة (keywords) — بدون delay
    const { text: customText, voiceFile, defaultText, matchedKw, keywordsLabel } = findCustomResponse(body);
    let source = "custom";

    // replyText: نص الرد المُرسَل
    let replyText = "";
    let sentWaId  = null;
    if (voiceFile) {
      // ملف صوتي مبرمج — بدون delay
      const media = MessageMedia.fromFilePath(voiceFile);
      await botReply(message, media, botId, { sendAudioAsVoice: true });
      replyText = customText || "🎤 رسالة صوتية";
      if (customText) { const s = await botReply(message, customText, botId); sentWaId = s?.id?._serialized || null; }
      console.log(`✅ [🎤 صوت مبرمج] → ${name}`);
    } else if (customText) {
      // رد keyword مبرمج — بدون delay
      const s = await botReply(message, customText, botId);
      sentWaId  = s?.id?._serialized || null;
      replyText = customText;
      logResponseUsage(senderNumber, keywordsLabel, matchedKw, customText, "whatsapp");
      console.log(`✅ [مبرمج] → ${name}: ${customText.substring(0, 70)}`);
    } else if (aiAutoReplyEnabled) {
      // الأولوية 2: الذكاء الاصطناعي — مع typing indicator و delay
      await chat.sendStateTyping();
      await sleep(Math.random() * (config.delayMax - config.delayMin) + config.delayMin);
      await chat.clearState();
      try {
        const aiReply = await generateResponse(contactId, name, body);
        const s = await botReply(message, aiReply, botId);
        sentWaId  = s?.id?._serialized || null;
        replyText = aiReply;
        source    = "ai";
        console.log(`🤖 [AI] → ${name}: ${aiReply.substring(0, 70)}`);
      } catch (aiErr) {
        // الأولوية 3: الرد الافتراضي (fallback)
        console.warn(`⚠️  AI فشل (${aiErr.message}) — جاري استخدام الرد الافتراضي`);
        const s = await botReply(message, defaultText, botId);
        sentWaId  = s?.id?._serialized || null;
        replyText = defaultText;
        source    = "default";
        console.log(`↩️  [افتراضي] → ${name}: ${defaultText.substring(0, 70)}`);
      }
    } else {
      // AI مطفأ — الرد الافتراضي مباشرة
      const s = await botReply(message, defaultText, botId);
      sentWaId  = s?.id?._serialized || null;
      replyText = defaultText;
      source    = "default";
      console.log(`↩️  [افتراضي - AI مطفأ] → ${name}: ${defaultText.substring(0, 70)}`);
    }

    // حفظ رد البوت مع wa_msg_id لمنع التكرار حتى في حالة race condition مع message_create
    await saveMessage(senderNumber, "البوت", "out", replyText, source, null, sentWaId);
    emitMessage(key, { phone: key, name: "البوت", direction: "out", body: replyText, source, created_at: new Date().toISOString() });

  } catch (err) {
    console.error("\n❌ خطأ:", err.stack || err.message);
  }
}

// ─── رسائل المدير اليدوية (من الهاتف مباشرة) ─────────────────────────────

// منع تكرار معالجة نفس رسالة الصادرة
const _processedOutIds = new Set();

async function handleOutgoing(message, botId) {
  try {
    if (!message.fromMe) return;
    if (!message.id) return; // تجاهل رسائل بدون معرّف
    if (message.timestamp < BOT_START_TIME) return;
    if (message.type === "revoked") return;

    // منع التكرار: نفس الرسالة تصل مرتين في بعض الأحيان
    const msgSerial = message.id._serialized;
    if (_processedOutIds.has(msgSerial)) return;
    _processedOutIds.add(msgSerial);
    if (_processedOutIds.size > 500) {
      const first = _processedOutIds.values().next().value;
      _processedOutIds.delete(first);
    }

    // تجاهل الرسائل التي أرسلها البوت تلقائياً (تم تتبعها بـ botMsgIds)
    const bot = bots.get(botId);
    if (bot.botMsgIds.has(msgSerial)) {
      bot.botMsgIds.delete(msgSerial);
      return;
    }

    let chat;
    try { chat = await message.getChat(); } catch { return; }
    if (!chat || !chat.id) return; // تجاهل إذا لم تُعرَّف المحادثة
    if (chat.isGroup) return; // تجاهل المجموعات

    const body = (message.body || "").trim();

    // تجاهل أوامر المدير
    const adminCmds = [config.pauseKeyword, config.resumeKeyword, "!clear", "!status", "!contacts"];
    if (adminCmds.some(cmd => body.toLowerCase() === cmd.toLowerCase())) return;

    // جلب اسم وهوية المستقبل (يدعم @c.us و @lid)
    let recipientPhone = normalizePhone(chat.id._serialized);
    let recipientName  = recipientPhone;
    try {
      const rc = await bot.client.getContactById(chat.id._serialized);
      if (rc) {
        recipientName  = rc.pushname || rc.name || recipientPhone;
        recipientPhone = normalizePhone(rc) || recipientPhone;
      }
    } catch {}

    // تسجيل جهة الاتصال
    const outKey = phoneKey(recipientPhone); // مفتاح 9 أرقام — يجب أن يتطابق مع غرفة socket
    await registerContact(recipientPhone, recipientName, body || "📎 وسائط");

    // معالجة الوسائط الصادرة
    if (message.hasMedia) {
      const mType = message.type;
      const fallback = mType === "ptt" || mType === "audio" ? "🎤 رسالة صوتية"
                     : mType === "video"                    ? "🎬 فيديو"
                     : mType === "image"                    ? "📷 صورة"
                     : mType === "sticker"                  ? "🎭 ملصق"
                     : mType === "document"                 ? "📄 مستند"
                                                            : "📎 ملف";
      let outBody = fallback;
      try {
        const media = await Promise.race([
          message.downloadMedia(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 25000)),
        ]);
        if (media?.data) {
          const mime = media.mimetype || "";
          if (mime.startsWith("image/") && mType !== "sticker") {
            const f = await saveImage(recipientPhone, recipientName, media);
            outBody = f ? `/uploads/images/${f}` : fallback;
          } else if (mime.startsWith("audio/") || mType === "ptt" || mType === "audio") {
            const f = await saveVoice(recipientPhone, recipientName, media);
            outBody = f ? `/uploads/voices/${f}` : fallback;
          } else if (mime.startsWith("video/") || mType === "video" || mType === "gif") {
            const f = await saveVideo(recipientPhone, recipientName, media);
            outBody = f ? `/uploads/videos/${f}` : fallback;
          }
        }
      } catch (dlErr) {
        console.warn(`⚠️ [${botId}] فشل تحميل وسائط صادرة: ${dlErr.message}`);
      }
      await saveMessage(recipientPhone, "أنت", "out", outBody, "manual", null, message.id._serialized);
      emitMessage(outKey, { waMsgId: message.id._serialized, phone: outKey, name: "أنت", direction: "out", body: outBody, source: "manual", created_at: new Date().toISOString() });
      console.log(`📤 [${botId}] [يدوي/وسائط] → ${recipientName} (${recipientPhone}): ${outBody}`);
      return;
    }

    if (!body) return;

    await saveMessage(recipientPhone, "أنت", "out", body, "manual", null, message.id._serialized);
    emitMessage(outKey, { waMsgId: message.id._serialized, phone: outKey, name: "أنت", direction: "out", body, source: "manual", created_at: new Date().toISOString() });
    console.log(`📤 [${botId}] [يدوي] → ${recipientName} (${recipientPhone}): ${body.substring(0, 70)}`);

  } catch (err) {
    console.error(`\n❌ خطأ في message_create [${botId}]:`, err.stack || err.message);
  }
}

// ─── Utilitaires ──────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// تطبيع رقم الهاتف — يدعم @c.us و @lid (WhatsApp Privacy/LID)
function normalizePhone(contactOrId) {
  if (!contactOrId) return "";
  // إذا كان Contact object يحتوي على .number نستخدمه مباشرة
  if (typeof contactOrId === "object" && contactOrId.number) {
    return String(contactOrId.number).replace(/\D/g, "");
  }
  const id = typeof contactOrId === "object" ? contactOrId.id?._serialized || "" : String(contactOrId);
  if (id.endsWith("@c.us"))  return id.slice(0, -5);
  if (id.endsWith("@g.us"))  return ""; // مجموعة — نتجاهل
  if (id.endsWith("@lid"))   return id.slice(0, -4); // LID — نحتفظ بالأرقام
  return id.replace(/@\w+$/, "");
}

async function botReply(msg, content, botId, opts = {}) {
  const sent = await msg.reply(content, undefined, Object.keys(opts).length ? opts : undefined);
  if (sent?.id?._serialized && botId) bots.get(botId)?.botMsgIds.add(sent.id._serialized);
  return sent;
}

function cleanPhone(jid) {
  if (!jid) return "";
  jid = jid.toString();
  if (jid.includes("@")) jid = jid.split("@")[0];
  return jid.replace(/\D/g, "");
}

// إعادة بناء الرقم الدولي الكامل (للإرسال عبر واتساب)
function normalizeOutPhone(p) {
  p = String(p || "").replace(/\D/g, "");
  if (p.startsWith("00")) p = p.slice(2);
  if (p.startsWith("0") && p.length === 10) p = "212" + p.slice(1); // 06/07 مغربي
  if (p.length === 9 && /^[5-7]/.test(p))   p = "212" + p;          // 9 أرقام مغربية
  return p;
}

// مفتاح 9 أرقام للـDB والـsocket (لأن DB تخزن آخر 9 أرقام)
function phoneKey(p) {
  const s = normalizeOutPhone(cleanPhone(p));
  return s.length > 9 ? s.slice(-9) : s;
}

async function botSend(chatId, content, opts = {}, botId = null) {
  const bot = getActiveBot(botId);
  if (!bot) throw new Error("لا يوجد بوت متصل");
  const sent = await bot.client.sendMessage(chatId, content, Object.keys(opts).length ? opts : undefined);
  if (sent?.id?._serialized) bot.botMsgIds.add(sent.id._serialized);
  return sent;
}

// ─── أوامر المدير ─────────────────────────────────────────────────────────

async function handleAdminCommand(body, chat, contactId, botId) {
  const cmd = body.toLowerCase().trim();
  const bot = bots.get(botId);
  const botPhone = bot ? bot.botPhone : "";

  if (cmd === config.pauseKeyword.toLowerCase()) {
    botPaused = true;
    console.log("\n⏸️  البوت في وقفة");
    await chat.sendMessage("⏸️ البوت موقوف. أرسل `!resume` للاستئناف.");

  } else if (cmd === config.resumeKeyword.toLowerCase()) {
    botPaused = false;
    pausedChats.clear();
    console.log("\n▶️  البوت استأنف");
    await chat.sendMessage("▶️ البوت شغال من جديد.");

  } else if (cmd === "!clear") {
    clearHistory(contactId);
    await chat.sendMessage("🗑️ تم مسح السجل.");

  } else if (cmd === "!status") {
    const model = AI_PROVIDER === "openai"
      ? (process.env.OPENAI_MODEL || "gpt-4o-mini")
      : (process.env.GROQ_MODEL  || "llama-3.3-70b-versatile");
    const stats = await getStats();
    await chat.sendMessage([
      `🤖 *حالة البوت*`,
      ``,
      `• الحالة:   ${botPaused ? "⏸️ موقوف" : "🟢 شغال"}`,
      `• الموديل:  ${model} (${AI_PROVIDER})`,
      `• خاص:     ${config.respondToPrivate ? "✅" : "❌"}`,
      `• مجموعات: ${config.respondToGroups  ? "✅" : "❌"}`,
      `• الرقم:    +${botPhone}`,
      `• الزبائن:  ${stats.total} (اليوم: ${stats.today})`,
    ].join("\n"));

  } else if (cmd === "!contacts") {
    const list = await getAllContacts();
    if (list.length === 0) {
      await chat.sendMessage("📋 لا يوجد زبائن مسجلين بعد.");
      return;
    }
    const lines = [`📋 *قائمة الزبائن (${list.length})*`, ``];
    list.slice(-20).forEach((c, i) => {
      const date = new Date(c.lastSeen).toLocaleDateString("ar-MA");
      lines.push(`${i + 1}. ${c.name} — +${c.phone} (${c.totalMessages} رسالة — ${date})`);
    });
    await chat.sendMessage(lines.join("\n"));
  }
}

// ─── Express Server + Socket.io ───────────────────────────────────────────

const { Server: SocketIO } = require("socket.io");
const app  = express();

let server;
const SSL_CERT = process.env.SSL_CERT;
const SSL_KEY  = process.env.SSL_KEY;

if (SSL_CERT && SSL_KEY && fs.existsSync(SSL_CERT) && fs.existsSync(SSL_KEY)) {
  const sslOpts = { cert: fs.readFileSync(SSL_CERT), key: fs.readFileSync(SSL_KEY) };
  server = https.createServer(sslOpts, app);
  // HTTP → HTTPS redirect on port 80
  const HTTPS_PORT = parseInt(process.env.PORT) || 443;
  http.createServer((req, res) => {
    const host = (req.headers.host || "").replace(/:\d+$/, "");
    res.writeHead(301, { Location: `https://${host}:${HTTPS_PORT}${req.url}` });
    res.end();
  }).listen(80, () => console.log("🔀 HTTP→HTTPS redirect active on :80"));
  console.log("🔒 HTTPS mode — cert:", SSL_CERT);
} else {
  server = http.createServer(app);
}

// السماح فقط للدومينات المعروفة
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

const io = new SocketIO(server, {
  cors: {
    origin: (origin, cb) => {
      if (!origin || !ALLOWED_ORIGINS.length) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      cb(new Error("CORS: origin غير مسموح به"));
    },
    credentials: true,
  },
});

// ── gzip لكل الردود ───────────────────────────────────────────────────────
app.use(compression());

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// ── Security headers ──────────────────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), geolocation=()");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://cdn.socket.io; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com data:; " +
    "img-src 'self' data: blob: https:; " +
    "media-src 'self' blob:; " +
    "connect-src 'self' wss: ws:; " +
    "frame-ancestors 'none';"
  );
  next();
});

// ── Rate limiters ─────────────────────────────────────────────────────────
// 10 محاولات تسجيل دخول كل 15 دقيقة
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "محاولات كثيرة، انتظر 15 دقيقة" },
  standardHeaders: true,
  legacyHeaders: false,
});
// 200 طلب / دقيقة للـ API الإدارية
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  message: { error: "طلبات كثيرة، أبطئ قليلاً" },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !req.path.startsWith("/api/"),
});
// 30 طلب / دقيقة على API الحجوزات (عامة بدون auth)
const bookingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "طلبات كثيرة" },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(apiLimiter);

// إرسال رسالة لكل المتصلين بغرفة هاتف معين
function emitMessage(phone, msgObj) {
  io.to(`phone:${phone}`).emit("new_message", msgObj);
  io.to("replies").emit("new_message", msgObj);  // ← user-reply page
}

fbSetIo(io);

io.on("connection", (socket) => {
  // user-reply: ينضم لغرفة replies تلقائياً
  socket.on("join_replies", () => {
    const cookieHeader = socket.handshake.headers.cookie || "";
    const cookies = {};
    cookieHeader.split(";").forEach(part => {
      const [k, ...v] = part.trim().split("=");
      if (k) cookies[k.trim()] = decodeURIComponent(v.join("="));
    });
    if (validTokens.has(cookies.auth_token)) socket.join("replies");
  });

  // التحقق من الـ token عند الانضمام لغرفة (وليس عند الاتصال — لتفادي 400)
  socket.on("join", (phone) => {
    const cookieHeader = socket.handshake.headers.cookie || "";
    const cookies = {};
    cookieHeader.split(";").forEach(part => {
      const [k, ...v] = part.trim().split("=");
      if (k) cookies[k.trim()] = decodeURIComponent(v.join("="));
    });
    if (!validTokens.has(cookies.auth_token)) {
      socket.emit("unauthorized");
      return;
    }
    for (const room of socket.rooms) {
      if (room !== socket.id) socket.leave(room);
    }
    if (phone) socket.join(`phone:${phone}`);
  });
  socket.on("join_messenger", (fbId) => {
    const cookieHeader = socket.handshake.headers.cookie || "";
    const cookies = {};
    cookieHeader.split(";").forEach(part => {
      const [k, ...v] = part.trim().split("=");
      if (k) cookies[k.trim()] = decodeURIComponent(v.join("="));
    });
    if (!validTokens.has(cookies.auth_token)) return;
    for (const room of socket.rooms) {
      if (room !== socket.id) socket.leave(room);
    }
    if (fbId) socket.join(`msng:${fbId}`);
  });
});

// ─── Auth ──────────────────────────────────────────────────────────────────

// ── Persistent tokens — يبقى صالحاً بعد restart ──────────────────────────
const TOKENS_FILE = path.join(__dirname, "data", ".tokens.json");
function loadTokens() {
  try {
    if (!fs.existsSync(path.join(__dirname, "data")))
      fs.mkdirSync(path.join(__dirname, "data"), { recursive: true });
    if (!fs.existsSync(TOKENS_FILE)) return new Set();
    const list = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 أيام
    return new Set(list.filter(t => t.ts > cutoff).map(t => t.token));
  } catch { return new Set(); }
}
function saveTokens(set) {
  try {
    const list = [...set].map(token => ({ token, ts: Date.now() }));
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(list));
  } catch {}
}
const validTokens = loadTokens();
const tokenRoles  = new Map(); // token → { role, name }

function parseCookies(header = "") {
  const cookies = {};
  header.split(";").forEach(part => {
    const [k, ...v] = part.trim().split("=");
    if (k) cookies[k.trim()] = decodeURIComponent(v.join("="));
  });
  return cookies;
}

function requireAuth(req, res, next) {
  const pub = ["/login", "/login.html", "/api/login", "/webhook", "/contact", "/api/contact", "/api/chat-widget"];
  if (pub.some(p => req.path === p || req.path.startsWith("/webhook"))) return next();
  const cookies = parseCookies(req.headers.cookie);
  if (validTokens.has(cookies.auth_token)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "غير مصرح" });
  res.redirect("/login");
}

app.use(requireAuth);
// ملفات ثابتة — cache يوم كامل للـ JS/CSS/images، بدون cache للـ HTML
app.use(express.static(path.join(__dirname, "public"), {
  extensions: ["html"],
  setHeaders(res, filePath) {
    if (/\.(js|css|png|jpg|jpeg|svg|ico|webp|woff2?)$/.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=86400");
    } else {
      res.setHeader("Cache-Control", "no-cache");
    }
  },
}));

app.post("/api/login", loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!password) return res.status(401).json({ error: "كلمة المرور مطلوبة" });

  // أولاً: تحقق من جدول users
  try {
    const db   = require("./db");
    const hash = crypto.createHash("sha256").update(password).digest("hex");
    let query, params;
    if (username) {
      query  = "SELECT * FROM users WHERE username = ? AND active = 1 LIMIT 1";
      params = [username];
    } else {
      // fallback: أي أدمن بهذه الكلمة
      query  = "SELECT * FROM users WHERE role = 'admin' AND active = 1 LIMIT 1";
      params = [];
    }
    const [rows] = await db.query(query, params);
    if (rows.length && rows[0].password === hash) {
      const token = crypto.randomBytes(32).toString("hex");
      validTokens.add(token);
      tokenRoles.set(token, { role: rows[0].role, name: rows[0].name });
      saveTokens(validTokens);
      res.setHeader("Set-Cookie", `auth_token=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`);
      return res.json({ ok: true, name: rows[0].name, role: rows[0].role });
    }
  } catch (_) { /* DB غير جاهز — fallback */ }

  // Fallback: كلمة مرور .env القديمة (للتوافق)
  const PASS = process.env.DASHBOARD_PASSWORD || "admin123";
  if (password === PASS && (!username || username === "admin")) {
    const token = crypto.randomBytes(32).toString("hex");
    validTokens.add(token);
    tokenRoles.set(token, { role: "admin", name: "المدير" });
    saveTokens(validTokens);
    res.setHeader("Set-Cookie", `auth_token=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`);
    return res.json({ ok: true, name: "المدير", role: "admin" });
  }

  res.status(401).json({ error: "اسم المستخدم أو كلمة المرور غير صحيحة" });
});

app.post("/api/logout", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  tokenRoles.delete(cookies.auth_token);
  validTokens.delete(cookies.auth_token);
  saveTokens(validTokens);
  res.setHeader("Set-Cookie", "auth_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const info    = tokenRoles.get(cookies.auth_token) || { role: "admin", name: "المدير" };
  res.json(info);
});

// ── حماية صفحات الأدمن فقط ───────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const info    = tokenRoles.get(cookies.auth_token) || { role: "admin" };
  if (info.role !== "admin") return res.redirect("/user-reply");
  next();
}

// صفحات محظورة على الـ agents
app.get("/dashboard",      requireAdmin, (_req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));
app.get("/users",          requireAdmin, (_req, res) => res.sendFile(path.join(__dirname, "public", "users.html")));
app.get("/ai-reply",       requireAdmin, (_req, res) => res.sendFile(path.join(__dirname, "public", "ai-reply.html")));
app.get("/bulk-reply",     requireAdmin, (_req, res) => res.sendFile(path.join(__dirname, "public", "bulk-reply.html")));
app.get("/sync",           requireAdmin, (_req, res) => res.sendFile(path.join(__dirname, "public", "sync.html")));
app.get("/responses",      requireAdmin, (_req, res) => res.sendFile(path.join(__dirname, "public", "responses.html")));

app.post("/api/admin/change-password", (req, res) => {
  const { current, newPass } = req.body;
  const PASS = process.env.DASHBOARD_PASSWORD || "admin123";
  if (current !== PASS) return res.status(401).json({ error: "كلمة المرور الحالية غير صحيحة" });
  if (!newPass || newPass.length < 8) return res.status(400).json({ error: "كلمة المرور يجب أن تكون 8 أحرف على الأقل" });
  if (!/[0-9]/.test(newPass)) return res.status(400).json({ error: "كلمة المرور يجب أن تحتوي على رقم واحد على الأقل" });
  // حفظ في .env
  try {
    const envPath = path.join(__dirname, ".env");
    let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    if (envContent.includes("DASHBOARD_PASSWORD=")) {
      envContent = envContent.replace(/DASHBOARD_PASSWORD=.*/,`DASHBOARD_PASSWORD=${newPass}`);
    } else {
      envContent += `\nDASHBOARD_PASSWORD=${newPass}`;
    }
    fs.writeFileSync(envPath, envContent);
    process.env.DASHBOARD_PASSWORD = newPass;
    validTokens.clear();
    saveTokens(validTokens);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── إدارة المستخدمين ──────────────────────────────────────────────────────

app.get("/api/users", async (_req, res) => {
  try {
    const db = require("./db");
    const [rows] = await db.query("SELECT id, name, username, role, active, created_at FROM users ORDER BY id");
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/users", async (req, res) => {
  const { name, username, password, role = "agent" } = req.body;
  if (!name || !username || !password) return res.status(400).json({ error: "الاسم واسم المستخدم وكلمة المرور مطلوبة" });
  if (password.length < 4) return res.status(400).json({ error: "كلمة المرور يجب أن تكون 4 أحرف على الأقل" });
  try {
    const db   = require("./db");
    const hash = crypto.createHash("sha256").update(password).digest("hex");
    const [r]  = await db.query(
      "INSERT INTO users (name, username, password, role) VALUES (?, ?, ?, ?)",
      [name.trim(), username.trim().toLowerCase(), hash, role]
    );
    res.json({ ok: true, id: r.insertId });
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") return res.status(400).json({ error: "اسم المستخدم موجود بالفعل" });
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/users/:id", async (req, res) => {
  const { id } = req.params;
  const { name, password, role, active } = req.body;
  try {
    const db     = require("./db");
    const fields = [];
    const vals   = [];
    if (name !== undefined)   { fields.push("name = ?");   vals.push(name); }
    if (role !== undefined)   { fields.push("role = ?");   vals.push(role); }
    if (active !== undefined) { fields.push("active = ?"); vals.push(active ? 1 : 0); }
    if (password) {
      const hash = crypto.createHash("sha256").update(password).digest("hex");
      fields.push("password = ?"); vals.push(hash);
    }
    if (!fields.length) return res.status(400).json({ error: "لا توجد بيانات للتحديث" });
    vals.push(id);
    await db.query(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`, vals);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/users/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const db      = require("./db");
    const [rows]  = await db.query("SELECT role FROM users WHERE id = ?", [id]);
    if (rows[0]?.role === "admin") {
      const [cnt] = await db.query("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1");
      if (cnt[0].c <= 1) return res.status(400).json({ error: "لا يمكن حذف آخر أدمن" });
    }
    await db.query("DELETE FROM users WHERE id = ?", [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/users", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "users.html"));
});

// Facebook Webhook
if (process.env.FACEBOOK_PAGE_ACCESS_TOKEN) {
  app.get("/webhook", verifyWebhook);
  app.post("/webhook", handleWebhook);
}

// ── Facebook Test API ──────────────────────────────────────────────────────
app.get("/api/facebook/status", async (_req, res) => {
  const token     = process.env.FACEBOOK_PAGE_ACCESS_TOKEN || "";
  const verifyTok = process.env.FACEBOOK_VERIFY_TOKEN     || "";
  const pageId    = process.env.FACEBOOK_PAGE_ID          || "";
  const configured = token.length > 20;
  let pageInfo = null;
  if (configured) {
    try {
      const axios = require("axios");
      const r = await axios.get(`https://graph.facebook.com/v19.0/me`, {
        params: { access_token: token, fields: "id,name,link" },
        timeout: 6000
      });
      pageInfo = r.data;
    } catch (e) {
      pageInfo = { error: e.response?.data?.error?.message || e.message };
    }
  }
  res.json({ configured, token: token ? token.slice(0,12)+"..." : "", verifyToken: verifyTok, pageId, pageInfo });
});

app.post("/api/facebook/test-message", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "message مطلوب" });
  try {
    const { findCustomResponse } = require("./customResponses");
    const { generateResponse }   = require("./claude");
    const { text: customText }   = findCustomResponse(message);
    let reply  = customText;
    let source = "custom";
    if (!reply) {
      reply  = await generateResponse("fb_test", "اختبار", message);
      source = "ai";
    }
    res.json({ ok: true, reply, source });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Messenger Bulk Reply ───────────────────────────────────────────────────

app.get("/api/messenger/contacts", async (req, res) => {
  const { limit = 200, offset = 0, unanswered = "0" } = req.query;
  const list = await getMessengerContacts({
    limit: parseInt(limit), offset: parseInt(offset),
    onlyUnanswered: unanswered === "1"
  });
  res.json(list);
});

app.get("/api/messenger/count", async (_req, res) => {
  const n = await countUnanswered();
  res.json({ count: n });
});

// ── رسائل زبون Messenger ──────────────────────────────────────────────────
app.get("/api/messenger/messages", async (req, res) => {
  const { fb_id, limit = 100, from_date } = req.query;
  if (!fb_id) return res.json([]);
  const list = await getMessengerMessages({ fb_id, limit: parseInt(limit), from_date: from_date || null });
  res.json(list.reverse()); // من القديم للجديد
});

// ── إرسال رسالة لـ Messenger ──────────────────────────────────────────────
app.post("/api/messenger/send", async (req, res) => {
  const { fb_id, text, name } = req.body || {};
  if (!fb_id || !text?.trim()) return res.status(400).json({ error: "fb_id و text مطلوبان" });
  const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  if (!token) return res.status(503).json({ error: "Facebook token غير مضبوط" });
  try {
    await axios.post(
      "https://graph.facebook.com/v19.0/me/messages",
      { recipient: { id: fb_id }, message: { text: text.trim() } },
      { params: { access_token: token } }
    );
    await saveMessengerContact(fb_id, name || "مجهول", text.trim(), "out");
    await saveMessengerMessage(fb_id, name || "مجهول", "out", text.trim());
    // إرسال socket للتحديث الفوري
    io.to(`msng:${fb_id}`).emit("new_messenger_msg", {
      fb_id, direction: "out", body: text.trim(), name: "أنت",
      created_at: new Date().toISOString()
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

let messengerBulkStatus = { running: false, done: 0, total: 0, ok: 0, fail: 0 };

app.post("/api/messenger/bulk-reply", async (req, res) => {
  if (messengerBulkStatus.running) return res.json({ ok: true, message: "الإرسال جاري" });
  const { message, delay = 4, onlyUnanswered = true } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: "الرسالة مطلوبة" });

  const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  if (!token) return res.status(503).json({ error: "FACEBOOK_PAGE_ACCESS_TOKEN غير مضبوط" });

  const contacts = await getMessengerContacts({ limit: 500, onlyUnanswered });
  if (!contacts.length) return res.json({ ok: true, message: "لا توجد محادثات Messenger", total: 0 });

  messengerBulkStatus = { running: true, done: 0, total: contacts.length, ok: 0, fail: 0 };
  res.json({ ok: true, total: contacts.length });

  (async () => {
    const axios = require("axios");
    for (const c of contacts) {
      try {
        await axios.post(
          "https://graph.facebook.com/v19.0/me/messages",
          { recipient: { id: c.fb_id }, message: { text: message }, messaging_type: "RESPONSE" },
          { params: { access_token: token }, timeout: 10000 }
        );
        await saveMessengerContact(c.fb_id, c.name, message, "out");
        messengerBulkStatus.ok++;
        console.log(`📘 [Bulk Messenger] → ${c.name}: ${message.substring(0,50)}`);
      } catch (err) {
        messengerBulkStatus.fail++;
        console.error(`❌ [Bulk Messenger] فشل ${c.fb_id}:`, err.response?.data?.error?.message || err.message);
      }
      messengerBulkStatus.done++;
      await new Promise(r => setTimeout(r, delay * 1000));
    }
    messengerBulkStatus.running = false;
    console.log(`✅ [Bulk Messenger] انتهى: ${messengerBulkStatus.ok} نجح / ${messengerBulkStatus.fail} فشل`);
  })();
});

app.get("/api/messenger/bulk-status", (_req, res) => res.json(messengerBulkStatus));

// ── Bookings API ────────────────────────────────────────────────────────────

// CORS للسماح لـ abrajeimmo.com بإرسال الطلبات فقط
const BOOKING_ORIGINS = ["https://abrajeimmo.com","https://www.abrajeimmo.com","https://abraje.uno"];
app.use("/api/bookings", bookingLimiter, (req, res, next) => {
  const origin = req.headers.origin || "";
  const allowed = !origin || BOOKING_ORIGINS.includes(origin);
  if (allowed) {
    res.header("Access-Control-Allow-Origin", origin || "*");
    res.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    res.header("Vary", "Origin");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// إنشاء مجلد الصور تلقائياً عند الحاجة
const IDS_DIR = path.join(__dirname, "public", "uploads", "ids");
if (!fs.existsSync(IDS_DIR)) fs.mkdirSync(IDS_DIR, { recursive: true });

// إنشاء حجز جديد — يقبل JSON (الهاتف) أو multipart/form-data (مع صور)
app.post("/api/bookings", async (req, res) => {
  const { name, phone, apartment, check_in, check_out, adults, children, message, source } = req.body || {};
  if (!name?.trim() || !phone?.trim() || !check_in || !check_out)
    return res.status(400).json({ error: "الاسم والهاتف وتواريخ الحجز مطلوبة" });

  try {
    const id = await createBooking({ name, phone, apartment, check_in, check_out, adults, children, message, source, id_images: [] });

    // إشعار واتساب للمسؤول
    const adminPhone = process.env.ADMIN_PHONE;
    if (adminPhone) {
      const jid = adminPhone.replace(/\D/g, "") + "@c.us";
      const nights = Math.ceil((new Date(check_out) - new Date(check_in)) / 86400000);
      const notifMsg = `🏠 *حجز جديد #${id}*\n👤 الاسم: ${name}\n📱 الهاتف: ${phone}\n🏢 الشقة: ${apartment || "غير محدد"}\n📅 الدخول: ${check_in}\n📅 الخروج: ${check_out} (${nights} ليلة)\n👨‍👩‍👧 ${adults} بالغ${children > 0 ? " + " + children + " طفل" : ""}\n💬 ملاحظة: ${message || "—"}`;
      const bot = [...bots.values()].find(b => b.botConnected);
      if (bot) bot.client.sendMessage(jid, notifMsg).catch(() => {});
    }

    res.json({ ok: true, id });
  } catch (err) {
    console.error("❌ [Bookings] خطأ:", err.message || err.code);
    res.status(500).json({ error: "خطأ في الحجز، حاول مجدداً" });
  }
});

// رفع صور البطاقة الوطنية لحجز موجود
app.post("/api/bookings/:id/images", (req, res) => {
  uploadIds.array("id_images", 4)(req, res, async (multerErr) => {
    if (multerErr) {
      console.error("multer error on image upload:", multerErr.message);
      return res.status(400).json({ ok: false, error: multerErr.message });
    }
    if (!req.files?.length) return res.json({ ok: true });
    try {
      const imgs = [];
      for (const file of req.files) {
        const ext      = (file.mimetype.split("/")[1] || "jpg").replace("jpeg","jpg").replace(/[^a-z0-9]/gi,"");
        const safeName = path.basename(file.filename).replace(/[^a-z0-9_-]/gi,"");
        const dest     = path.join(IDS_DIR, `${safeName}.${ext}`);
        // منع path traversal — التأكد أن الملف داخل IDS_DIR
        if (!dest.startsWith(IDS_DIR + path.sep) && dest !== IDS_DIR) {
          fs.unlinkSync(file.path); continue;
        }
        fs.renameSync(file.path, dest);
        imgs.push(`/uploads/ids/${safeName}.${ext}`);
      }
      await addIdImages(req.params.id, imgs);
      res.json({ ok: true, count: imgs.length });
    } catch (err) {
      console.error("image save error:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
});

// قائمة الحجوزات (للمسؤول)
app.get("/api/bookings", async (req, res) => {
  const { status, limit = 200, offset = 0 } = req.query;
  const rows = await getBookings({ status: status || null, limit, offset });
  res.json(rows);
});

// إحصائيات الحجوزات
app.get("/api/bookings/stats", async (_req, res) => {
  const stats = await getBookingStats();
  res.json(stats);
});

// تحديث حالة الحجز
app.patch("/api/bookings/:id/status", async (req, res) => {
  const { status } = req.body;
  if (!["pending", "confirmed", "cancelled"].includes(status))
    return res.status(400).json({ error: "حالة غير صحيحة" });
  await updateBookingStatus(req.params.id, status);
  res.json({ ok: true });
});

// حذف حجز
app.delete("/api/bookings/:id", async (req, res) => {
  try {
    await deleteBooking(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// تعديل بيانات حجز
app.patch("/api/bookings/:id", async (req, res) => {
  const { name, phone, apartment, check_in, check_out, adults, children, message } = req.body || {};
  if (!name?.trim() || !phone?.trim() || !check_in || !check_out)
    return res.status(400).json({ error: "الاسم والهاتف والتواريخ مطلوبة" });
  try {
    await updateBooking(req.params.id, { name, phone, apartment, check_in, check_out, adults, children, message });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Dashboard API ──────────────────────────────────────────────────────────

let _statsCache = null, _statsCacheAt = 0;
app.get("/api/stats", async (_req, res) => {
  const now = Date.now();
  if (!_statsCache || now - _statsCacheAt > 5000) {
    const stats = await getStats();
    const connected = [...bots.values()].some(b => b.botConnected);
    _statsCache = { ...stats, botPaused, autoReplyEnabled, aiAutoReplyEnabled, botConnected: connected, aiCreditError: aiReplyStatus.creditError || false };
    _statsCacheAt = now;
  }
  res.json(_statsCache);
});

app.post("/api/auto-reply/enable", (_req, res) => {
  autoReplyEnabled = true;
  const d = readResponses(); d.autoReplyEnabled = true; writeResponses(d);
  console.log("\n🤖 الردود التلقائية: مفعّلة");
  res.json({ ok: true, autoReplyEnabled });
});

app.post("/api/auto-reply/disable", (_req, res) => {
  autoReplyEnabled = false;
  const d = readResponses(); d.autoReplyEnabled = false; writeResponses(d);
  console.log("\n🔕 الردود التلقائية: مطفأة");
  res.json({ ok: true, autoReplyEnabled });
});

app.post("/api/ai-reply/enable", (_req, res) => {
  aiAutoReplyEnabled = true;
  const d = readResponses(); d.aiAutoReplyEnabled = true; writeResponses(d);
  console.log("\n🤖 الذكاء الاصطناعي: مفعّل");
  res.json({ ok: true, aiAutoReplyEnabled });
});

app.post("/api/ai-reply/disable", (_req, res) => {
  aiAutoReplyEnabled = false;
  const d = readResponses(); d.aiAutoReplyEnabled = false; writeResponses(d);
  console.log("\n🔕 الذكاء الاصطناعي: مطفأ");
  res.json({ ok: true, aiAutoReplyEnabled });
});

app.get("/api/qr", (_req, res) => {
  const result = {};
  for (const [id, b] of bots) {
    result[id] = { qr: b.latestQr, connected: b.botConnected, phone: b.botPhone || null };
  }
  res.json(result);
});

app.post("/api/restart-bot/:id", async (req, res) => {
  const botId = req.params.id;
  if (!bots.has(botId)) return res.status(404).json({ error: "بوت غير موجود" });
  try {
    const bot = bots.get(botId);
    // أوقف الكلاينت القديم
    if (bot.client) {
      try { await bot.client.destroy(); } catch {}
    }
    // احذف الجلسة حتى يظهر QR جديد
    // احذف ملفات قفل Chrome أولاً (بدون حذف الجلسة كلها)
    const sessionDir2 = path.join(__dirname, "sessions", `session-${botId}`);
    for (const lock of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      try { fs.unlinkSync(path.join(sessionDir2, lock)); } catch {}
    }
    // احذف الجلسة كلها حتى يظهر QR جديد
    const sessionPath = path.join(__dirname, "sessions", botId);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
    // احذف أيضاً مجلد session-botX
    if (fs.existsSync(sessionDir2)) {
      fs.rmSync(sessionDir2, { recursive: true, force: true });
    }
    // أعد تعيين الحالة
    bot.client       = null;
    bot.latestQr     = null;
    bot.botConnected = false;
    bot.botPhone     = "";
    bot.botMsgIds    = new Set();
    // شغّل من جديد
    setupClient(botId);
    res.json({ ok: true, message: `تم إعادة تشغيل ${botId}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/contacts", async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit  || "200"), 2000);
  const offset = parseInt(req.query.offset || "0");
  const search = (req.query.search || "").trim().substring(0, 50);
  const list = await getAllContacts({ limit, offset, search });
  res.setHeader("Cache-Control", "private, max-age=10");
  res.json(list);
});

// جلب صورة زبون واحد
app.get("/api/contacts/:phone/photo", async (req, res) => {
  const phone = req.params.phone.replace(/\D/g,"");
  const key   = phone.length>9 ? phone.slice(-9) : phone;
  const bot   = getActiveBot();
  if (!bot) return res.status(503).json({ error: "البوت غير متصل" });
  await syncContactPhoto(key, bot.client);
  const db = require("./db");
  const [[row]] = await db.query("SELECT photo FROM contacts WHERE phone=? LIMIT 1",[key]);
  res.json({ photo: row?.photo ? `/uploads/photos/${row.photo}` : null });
});

// جلب صور جميع الزبائن في الخلفية
app.post("/api/contacts/sync-photos", async (req, res) => {
  const bot = getActiveBot();
  if (!bot) return res.status(503).json({ error: "البوت غير متصل" });
  const db = require("./db");
  const [rows] = await db.query(
    "SELECT phone FROM contacts WHERE (photo IS NULL OR photo_at < DATE_SUB(NOW(),INTERVAL 24 HOUR)) AND (is_deleted IS NULL OR is_deleted=0) LIMIT 100"
  );
  res.json({ queued: rows.length });
  // معالجة في الخلفية بدون حجب الاستجابة
  (async () => {
    for (const r of rows) {
      await syncContactPhoto(r.phone, bot.client);
      await new Promise(x=>setTimeout(x,500));
    }
    console.log(`📸 sync-photos: تم تحديث ${rows.length} صورة`);
  })();
});

app.delete("/api/contacts/:phone", async (req, res) => {
  try {
    const pool = require("./db");
    const phone = req.params.phone.replace(/\D/g, "");
    const key   = phone.length > 9 ? phone.slice(-9) : phone;
    await pool.query("DELETE FROM messages WHERE contact = ?", [key]);
    // soft-delete: نحتفظ بالسجل مع is_deleted=1 لمنع ظهوره مجدداً من wa-chats
    const [exist] = await pool.query("SELECT id FROM contacts WHERE phone = ?", [key]);
    if (exist.length) {
      await pool.query("UPDATE contacts SET is_deleted = 1 WHERE phone = ?", [key]);
    } else {
      // إذا لم يكن موجوداً نُنشئه كـ deleted لمنعه من الظهور لاحقاً
      await pool.query(
        "INSERT INTO contacts (phone, name, first_seen, last_seen, is_deleted) VALUES (?,?,NOW(),NOW(),1)",
        [key, key]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Broadcast stop flag ───────────────────────────────────────
let broadcastCancelled = false;
app.post("/api/broadcast/stop", (_req, res) => {
  broadcastCancelled = true;
  res.json({ ok: true });
});

// ── Broadcast endpoint ────────────────────────────────────────
app.post("/api/broadcast", async (req, res) => {
  const dbPool = require("./db");
  const { message, hours = 24, botId = null, dryRun = false, imageBase64 = null, imageMime = null } = req.body;
  if (!message && !imageBase64) return res.status(400).json({ error: "message أو image مطلوب" });

  const since = new Date();
  since.setHours(since.getHours() - Number(hours));

  // تحضير الميديا إذا وُجدت صورة
  let media = null;
  if (imageBase64 && imageMime) {
    try {
      media = new MessageMedia(imageMime, imageBase64.replace(/^data:[^;]+;base64,/, ""), "broadcast_image");
    } catch (e) {
      return res.status(400).json({ error: "صورة غير صالحة" });
    }
  }

  try {
    const [contacts] = await dbPool.query(`
      SELECT m.contact AS phone, c.name, MAX(m.created_at) AS lastSent
      FROM messages m
      LEFT JOIN contacts c ON c.phone = m.contact
      WHERE m.direction = 'out'
        AND m.created_at >= ?
        AND m.contact IS NOT NULL AND m.contact != ''
      GROUP BY m.contact, c.name
      ORDER BY lastSent DESC
    `, [since]);

    if (!contacts.length) return res.json({ ok: true, sent: 0, failed: 0, total: 0, results: [] });

    const results = [];
    let sent = 0, failed = 0;
    broadcastCancelled = false; // إعادة ضبط عند بدء إرسال جديد

    for (const { phone, name } of contacts) {
      if (broadcastCancelled) { results.push({ phone, name, status: "stopped" }); continue; }
      if (dryRun) { results.push({ phone, name, status: "dry-run" }); continue; }
      try {
        const outPhone = normalizeOutPhone(cleanPhone(phone));
        const key      = phoneKey(outPhone);
        const jid      = outPhone + "@c.us";

        if (media) {
          // إرسال الصورة — caption فقط إذا يوجد نص
          const mediaOpts = message ? { caption: message } : {};
          const bot = getActiveBot(botId);
          if (!bot) throw new Error("لا يوجد بوت متصل");
          const sent = await bot.client.sendMessage(jid, media, mediaOpts);
          if (sent?.id?._serialized) bot.botMsgIds.add(sent.id._serialized);
        } else {
          await botSend(jid, message, {}, botId);
        }

        const bodyText = message || "📷 صورة";
        await saveMessage(key, "أنت", "out", bodyText, "manual");
        emitMessage(key, { phone: key, name: "أنت", direction: "out", body: bodyText, source: "manual", created_at: new Date().toISOString() });
        results.push({ phone, name, status: "sent" });
        sent++;
        await new Promise(r => setTimeout(r, 2500));
      } catch (err) {
        results.push({ phone, name, status: "failed", error: err.message });
        failed++;
      }
    }

    const stopped = results.filter(r => r.status === "stopped").length;
    res.json({ ok: true, sent, failed, stopped, total: contacts.length, results, cancelled: broadcastCancelled });
  } catch (err) {
    console.error("[broadcast] error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Block / Unblock ───────────────────────────────────────────────────────
app.get("/api/block-status/:phone", async (req, res) => {
  const bot = getActiveBot();
  if (!bot) return res.json({ blocked: false });
  try {
    const key      = phoneKey(cleanPhone(req.params.phone));
    const blocked  = await bot.client.getBlockedContacts();
    const isBlocked = blocked.some(c => {
      const cKey = phoneKey(cleanPhone(c.id._serialized));
      return cKey === key;
    });
    res.json({ blocked: isBlocked });
  } catch { res.json({ blocked: false }); }
});

// ── Block helpers (DB-based) ──────────────────────────────────────────────
async function setBlockedInDb(phone, blocked) {
  const db  = require("./db");
  const key = phoneKey(cleanPhone(phone));
  await db.query(
    `UPDATE contacts SET is_blocked = ? WHERE phone = ?`,
    [blocked ? 1 : 0, key]
  );
}

app.get("/api/block-status/:phone", async (req, res) => {
  const db  = require("./db");
  const key = phoneKey(cleanPhone(req.params.phone));
  try {
    const [rows] = await db.query(`SELECT is_blocked FROM contacts WHERE phone = ?`, [key]);
    res.json({ blocked: rows[0]?.is_blocked === 1 });
  } catch { res.json({ blocked: false }); }
});

app.post("/api/block/:phone", async (req, res) => {
  try {
    await setBlockedInDb(req.params.phone, true);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/unblock/:phone", async (req, res) => {
  try {
    await setBlockedInDb(req.params.phone, false);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/send", async (req, res) => {
  const { phone: rawPhone, message, botId } = req.body;
  if (!rawPhone || !message) return res.status(400).json({ error: "phone و message مطلوبين" });
  const bot = getActiveBot(botId);
  if (!bot) return res.status(503).json({ error: "لا يوجد بوت متصل" });
  try {
    const outPhone = normalizeOutPhone(cleanPhone(rawPhone));
    const key      = phoneKey(outPhone);
    const jid      = outPhone + "@c.us";
    await botSend(jid, message, {}, botId);
    await saveMessage(key, "أنت", "out", message, "manual");
    emitMessage(key, { phone: key, name: "أنت", direction: "out", body: message, source: "manual", created_at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// تحويل صوت إلى ogg باستخدام ffmpeg
function convertToOgg(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    exec(`ffmpeg -y -i "${inputPath}" -c:a libopus -b:a 64k "${outputPath}"`, (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

app.post("/api/send-voice", async (req, res) => {
  const { phone: rawPhone, data, mimetype, botId } = req.body;
  if (!rawPhone || !data) return res.status(400).json({ error: "phone و data مطلوبين" });
  const mimeOk = /^audio\/(ogg|webm|mp4|mpeg|wav|aac|opus)/.test(mimetype || "");
  if (mimetype && !mimeOk) return res.status(400).json({ error: "نوع الملف غير مسموح" });
  const bot = getActiveBot(botId);
  if (!bot) return res.status(503).json({ error: "لا يوجد بوت متصل" });
  try {
    const outPhone  = normalizeOutPhone(cleanPhone(rawPhone));
    const key       = phoneKey(outPhone);
    const jid       = outPhone + "@c.us";
    const mimeClean = (mimetype || "audio/webm").split(";")[0].trim();
    const isOgg     = mimeClean === "audio/ogg";
    const srcExt    = isOgg ? "ogg" : (mimeClean.includes("mp4") ? "mp4" : "webm");
    const ts        = Date.now();
    const uploadDir = path.join(__dirname, "public", "uploads", "voices");
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

    // حفظ الملف الأصلي
    const srcPath = path.join(uploadDir, `${ts}_${key}.${srcExt}`);
    fs.writeFileSync(srcPath, Buffer.from(data, "base64"));

    let sendPath = srcPath;
    let fileUrl  = `/uploads/voices/${ts}_${key}.${srcExt}`;

    // تحويل إلى ogg إذا لم يكن أصلاً ogg وكان ffmpeg متاحاً
    if (!isOgg) {
      const oggPath = path.join(uploadDir, `${ts}_${key}.ogg`);
      try {
        await convertToOgg(srcPath, oggPath);
        fs.unlinkSync(srcPath); // حذف الملف الأصلي
        sendPath = oggPath;
        fileUrl  = `/uploads/voices/${ts}_${key}.ogg`;
      } catch {
        // ffmpeg غير متاح — إرسال الملف كما هو
      }
    }

    const media = MessageMedia.fromFilePath(sendPath);
    const sentMsg = await botSend(jid, media, { sendAudioAsVoice: true }, botId);
    const waId = sentMsg?.id?._serialized || null;
    await saveMessage(key, "أنت", "out", fileUrl, "manual", null, waId);
    emitMessage(key, { phone: key, name: "أنت", direction: "out", body: fileUrl, source: "manual", created_at: new Date().toISOString() });
    res.json({ ok: true, url: fileUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/send-media", async (req, res) => {
  const { phone: rawPhone, data, mimetype, ext, filename: origName, botId } = req.body;
  if (!rawPhone || !data || !mimetype) return res.status(400).json({ error: "phone, data و mimetype مطلوبين" });
  const allowedMime = /^(image\/(jpeg|png|gif|webp)|video\/(mp4|webm|quicktime)|audio\/(ogg|webm|mpeg|mp4)|application\/(pdf))$/;
  if (!allowedMime.test(mimetype)) return res.status(400).json({ error: "نوع الملف غير مسموح" });
  const bot = getActiveBot(botId);
  if (!bot) return res.status(503).json({ error: "لا يوجد بوت متصل" });
  try {
    const outPhone = normalizeOutPhone(cleanPhone(rawPhone));
    const key      = phoneKey(outPhone);
    const jid      = outPhone + "@c.us";
    const isImage  = mimetype.startsWith("image/");
    const isVideo  = mimetype.startsWith("video/");
    const isAudio  = mimetype.startsWith("audio/");
    const safeExt  = ext || mimetype.split("/")[1]?.split(";")[0] || "bin";
    const filename = `${Date.now()}_${key}.${safeExt}`;

    // تحديد مجلد الحفظ
    const subDir    = isImage ? "images" : isVideo ? "videos" : "files";
    const uploadDir = path.join(__dirname, "public", "uploads", subDir);
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    fs.writeFileSync(path.join(uploadDir, filename), Buffer.from(data, "base64"));
    const fileUrl = `/uploads/${subDir}/${filename}`;

    // إرسال عبر واتساب (whatsapp-web.js)
    const media = new MessageMedia(mimetype, data, origName || filename);
    const opts  = isAudio ? { sendAudioAsVoice: false }
                : (!isImage && !isVideo) ? { sendMediaAsDocument: true }
                : {};
    await botSend(jid, media, opts, botId);

    // حفظ في قاعدة البيانات
    const msgBody = (isImage || isVideo) ? fileUrl : `📎 ${origName || filename}`;
    await saveMessage(key, "أنت", "out", msgBody, "manual");
    emitMessage(key, { phone: key, name: "أنت", direction: "out", body: msgBody, source: "manual", created_at: new Date().toISOString() });

    res.json({ ok: true, url: fileUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/pause", (_req, res) => {
  botPaused = true;
  res.json({ ok: true, botPaused });
});

app.post("/api/resume", (_req, res) => {
  botPaused = false;
  pausedChats.clear();
  res.json({ ok: true, botPaused });
});

app.get("/api/messages", async (req, res) => {
  const { phone, search, limit = 50, offset = 0, from_date } = req.query;
  const [list, total] = await Promise.all([
    getMessages({ phone, search, limit: parseInt(limit), offset: parseInt(offset), from_date: from_date || null }),
    getMessagesCount({ phone, search, from_date: from_date || null }),
  ]);
  res.setHeader("X-Total-Count", total);
  res.json(list);
});

app.delete("/api/messages/:id", async (req, res) => {
  const { id } = req.params;
  const numId = Number(id);
  if (!id || isNaN(numId) || numId <= 0) return res.status(400).json({ error: "id غير صالح" });
  const [r] = await pool.query("DELETE FROM messages WHERE id = ?", [numId]);
  if (r.affectedRows === 0) return res.status(404).json({ error: "الرسالة غير موجودة" });
  res.json({ ok: true });
});

// ── جلب قائمة الأرقام المحذوفة (لفلترتها في الـ frontend) ──────────────────
app.get("/api/deleted-phones", async (_req, res) => {
  try {
    const pool = require("./db");
    const [rows] = await pool.query("SELECT phone FROM contacts WHERE is_deleted = 1");
    res.json(rows.map(r => r.phone));
  } catch { res.json([]); }
});

// ── جلب المجموعات من واتساب ───────────────────────────────────────────────
app.get("/api/wa-groups", async (_req, res) => {
  const connectedBots = [...bots.entries()].filter(([,b]) => b.botConnected);
  if (!connectedBots.length) return res.json([]);
  const groups = [];
  const seen   = new Set();
  for (const [botId, bot] of connectedBots) {
    let chats = [];
    try {
      chats = await Promise.race([
        bot.client.getChats(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 20000)),
      ]);
    } catch { continue; }
    for (const c of chats) {
      try {
        if (!c.isGroup) continue;
        const gid = (c.id && c.id._serialized) ? c.id._serialized : String(c.id || "");
        if (!gid || seen.has(gid)) continue;
        seen.add(gid);
        const lastMsg  = c.lastMessage;
        const lastSeen = lastMsg?.timestamp ? new Date(lastMsg.timestamp * 1000).toISOString() : null;
        // participants قد لا تكون محملة — نتجاهل الخطأ
        let participantCount = 0;
        try { participantCount = Array.isArray(c.participants) ? c.participants.length : 0; } catch {}
        groups.push({
          id:           gid,
          name:         c.name || gid,
          participants: participantCount,
          lastMessage:  lastMsg?.body || "",
          lastSeen,
          botId,
        });
      } catch { /* تجاهل chat مكسور */ }
    }
  }
  groups.sort((a, b) => new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0));
  res.json(groups);
});

// ── جلب رسائل مجموعة من واتساب ───────────────────────────────────────────
// ── تحميل صورة من رسالة مجموعة ──────────────────────────────────────────────
app.get("/api/group-media", async (req, res) => {
  const { serialId } = req.query;
  if (!serialId) return res.status(400).json({ error: "serialId مطلوب" });

  // تحقق من الكاش أولاً (صور + فيديو + صوت)
  const safeId = serialId.replace(/[^a-z0-9]/gi, "_");
  for (const [sub, exts] of [["images",["jpg","jpeg","png","webp"]],["videos",["mp4","3gpp","3gp"]],["voices",["ogg","mp3","opus","aac"]]]) {
    for (const ext of exts) {
      const cf = path.join(__dirname, "public", "uploads", sub, `grp_${safeId}.${ext}`);
      if (fs.existsSync(cf)) return res.sendFile(cf);
    }
  }

  const connectedBots = [...bots.values()].filter(b => b.botConnected);
  if (!connectedBots.length) return res.status(503).json({ error: "لا يوجد بوت متصل" });

  try {
    let media = null;
    for (const bot of connectedBots) {
      try {
        const msg = await Promise.race([
          bot.client.getMessageById(serialId),
          new Promise((_, r) => setTimeout(() => r(new Error("to")), 10000)),
        ]);
        if (msg?.hasMedia) {
          media = await Promise.race([
            msg.downloadMedia(),
            new Promise((_, r) => setTimeout(() => r(new Error("to")), 15000)),
          ]);
          if (media) break;
        }
      } catch {}
    }

    if (!media?.data) return res.status(404).json({ error: "لا يمكن تحميل الوسائط" });

    const mime    = media.mimetype || "application/octet-stream";
    const mimeBase = mime.split(";")[0].trim();
    const ext     = mimeBase.split("/")[1] || "bin";
    const subDir  = mimeBase.startsWith("image/") ? "images"
                  : mimeBase.startsWith("video/") ? "videos"
                  : mimeBase.startsWith("audio/") ? "voices"
                  : "images";
    const safe    = serialId.replace(/[^a-z0-9]/gi, "_");
    const dest    = path.join(__dirname, "public", "uploads", subDir, `grp_${safe}.${ext}`);
    const raw     = media.data.includes(",") ? media.data.split(",")[1] : media.data;
    fs.writeFileSync(dest, Buffer.from(raw, "base64"));
    res.setHeader("Content-Type", mimeBase);
    res.sendFile(dest);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/group-messages", async (req, res) => {
  const groupId = req.query.groupId;
  const limit   = Math.min(parseInt(req.query.limit) || 50, 200);
  if (!groupId) return res.status(400).json({ error: "groupId مطلوب" });

  const connectedBots = [...bots.values()].filter(b => b.botConnected);
  if (!connectedBots.length) return res.status(503).json({ error: "لا يوجد بوت متصل" });

  try {
    let chat = null;

    // نبحث في جميع البوتات المتصلة حتى نجد المجموعة
    for (const bot of connectedBots) {
      // محاولة 1: getChatById
      try {
        const c = await Promise.race([
          bot.client.getChatById(groupId),
          new Promise((_, rej) => setTimeout(() => rej(new Error("to")), 8000)),
        ]);
        if (c) { chat = c; break; }
      } catch {}

      // محاولة 2: getChats + filter
      try {
        const all = await Promise.race([
          bot.client.getChats(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("to")), 15000)),
        ]);
        const found = all.find(c => {
          const cid = c.id?._serialized || String(c.id || "");
          return cid === groupId;
        });
        if (found) { chat = found; break; }
      } catch {}
    }

    if (!chat) return res.status(404).json({ error: "المجموعة غير موجودة — تأكد أن البوت عضو فيها" });

    const msgs = await Promise.race([
      chat.fetchMessages({ limit }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 20000)),
    ]);

    const result = msgs.map(m => ({
      id:          m.id?.id || "",
      serialId:    m.id?._serialized || "",
      body:        m.body || "",
      fromMe:      m.fromMe,
      author:      m.author || m.from || "",
      timestamp:   m.timestamp,
      type:        m.type,
      hasMedia:    m.hasMedia,
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── إرسال رسالة لمجموعة ───────────────────────────────────────────────────
app.post("/api/send-group", async (req, res) => {
  const { groupId, message, botId = null } = req.body;
  if (!groupId || !message) return res.status(400).json({ error: "groupId و message مطلوبان" });
  try {
    await botSend(groupId, message, {}, botId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── تفعيل/تعطيل الرد التلقائي في المجموعات ──────────────────────────────
app.post("/api/groups-toggle", (req, res) => {
  const { enabled, mentionOnly } = req.body;
  if (typeof enabled     !== "undefined") config.respondToGroups          = !!enabled;
  if (typeof mentionOnly !== "undefined") config.respondGroupsMentionOnly = !!mentionOnly;
  res.json({ ok: true, respondToGroups: config.respondToGroups, mentionOnly: config.respondGroupsMentionOnly });
});

app.get("/api/groups-status", (_req, res) => {
  res.json({ respondToGroups: config.respondToGroups, mentionOnly: config.respondGroupsMentionOnly });
});

// ── Broadcast لجميع المجموعات ─────────────────────────────────────────────
let groupBroadcastCancelled = false;
app.post("/api/broadcast-groups/stop", (_req, res) => {
  groupBroadcastCancelled = true;
  res.json({ ok: true });
});

app.post("/api/broadcast-groups", async (req, res) => {
  const { message, imageBase64, imageMime, botId = null, dryRun = false } = req.body;
  if (!message && !imageBase64) return res.status(400).json({ error: "message أو image مطلوب" });

  let media = null;
  if (imageBase64 && imageMime) {
    try { media = new MessageMedia(imageMime, imageBase64.replace(/^data:[^;]+;base64,/, ""), "ad"); }
    catch { return res.status(400).json({ error: "صورة غير صالحة" }); }
  }

  // جمع كل المجموعات من جميع البوتات
  const groupsSeen = new Set();
  const groupsList = [];
  for (const [bid, bot] of bots) {
    if (!bot.botConnected) continue;
    try {
      const chats = await Promise.race([
        bot.client.getChats(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("to")), 15000)),
      ]);
      for (const c of chats) {
        try {
          if (!c.isGroup) continue;
          const gid = c.id?._serialized || String(c.id || "");
          if (!gid || groupsSeen.has(gid)) continue;
          groupsSeen.add(gid);
          groupsList.push({ gid, name: c.name || gid, botId: bid });
        } catch {}
      }
    } catch {}
  }

  if (!groupsList.length) return res.json({ ok: true, sent: 0, failed: 0, total: 0, results: [] });

  groupBroadcastCancelled = false;
  const results = [];
  let sent = 0, failed = 0;

  for (const { gid, name, botId: gBotId } of groupsList) {
    if (groupBroadcastCancelled) { results.push({ name, status: "stopped" }); continue; }
    if (dryRun) { results.push({ name, status: "dry-run" }); continue; }
    try {
      const bot = getActiveBot(gBotId) || getActiveBot(botId);
      if (!bot) throw new Error("لا يوجد بوت");
      if (media) {
        const opts = message ? { caption: message } : {};
        const s = await bot.client.sendMessage(gid, media, opts);
        if (s?.id?._serialized) bot.botMsgIds.add(s.id._serialized);
      } else {
        await botSend(gid, message, {}, gBotId);
      }
      results.push({ name, status: "sent" });
      sent++;
      await new Promise(r => setTimeout(r, 3000));
    } catch (err) {
      results.push({ name, status: "failed", error: err.message });
      failed++;
    }
  }

  const stopped = results.filter(r => r.status === "stopped").length;
  res.json({ ok: true, sent, failed, stopped, total: groupsList.length, results, cancelled: groupBroadcastCancelled });
});

// ── جلب كل المحادثات من جميع البوتات المتصلة (للشريط الجانبي) ────────────
app.get("/api/wa-chats", async (_req, res) => {
  const connectedBots = [...bots.values()].filter(b => b.botConnected);
  if (!connectedBots.length) return res.json([]);

  const mediaLabel = { image:"📷 صورة", video:"🎬 فيديو", ptt:"🎤 صوت", audio:"🎤 صوت", document:"📎 ملف" };

  try {
    const seenKeys = new Map(); // dedupeKey → index in merged[]
    const merged   = [];

    for (const [botId, bot] of bots) {
      if (!bot.botConnected) continue;
      let chats = [];
      try { chats = await bot.client.getChats(); } catch { continue; }

      for (const c of chats) {
        if (c.isGroup || c.isBroadcast) continue;
        const phone = cleanPhone(c.id);
        if (!phone || phone.length < 7) continue;
        if (!/^\d{7,15}$/.test(phone)) continue;

        const dedupeKey = phone.slice(-9);
        const lastMsg   = c.lastMessage;
        const lastSeen  = lastMsg ? new Date(lastMsg.timestamp * 1000).toISOString() : new Date(0).toISOString();
        const lastBody  = lastMsg?.body || (lastMsg?.hasMedia ? (mediaLabel[lastMsg.type] || "📎 وسائط") : "");
        const lastDir   = lastMsg ? (lastMsg.fromMe ? "out" : "in") : "in";
        const rawName   = (c.name || c.pushName || "").trim();
        const name      = /^[\d\s\+\-\(\)\.]{7,}$/.test(rawName) ? phone : (rawName || phone);

        if (seenKeys.has(dedupeKey)) {
          // Keep the entry with the most recent last message
          const idx = seenKeys.get(dedupeKey);
          if (new Date(lastSeen) > new Date(merged[idx].lastSeen)) {
            merged[idx] = { ...merged[idx], lastMessage: lastBody, lastSeen, lastDirection: lastDir, botId };
          }
        } else {
          seenKeys.set(dedupeKey, merged.length);
          merged.push({ phone, name, lastMessage: lastBody, lastSeen, lastDirection: lastDir, botId });
        }
      }
    }

    merged.sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
    res.json(merged);
  } catch (err) {
    console.error("wa-chats error:", err.message);
    res.json([]);
  }
});

// ── مزامنة الوسائط القديمة من واتساب ─────────────────────────────────────
app.post("/api/wa-sync-media", async (req, res) => {
  const connectedBots = [...bots.values()].filter(b => b.botConnected);
  if (!connectedBots.length) return res.status(503).json({ error: "البوت غير متصل بواتساب" });
  if (mediaSyncStatus.running) return res.json({ ok: true, message: "المزامنة جارية بالفعل", status: mediaSyncStatus });

  mediaSyncStatus = { running: true, done: 0, total: 0, saved: 0, errors: 0, skipped: 0, currentChat: "", lastError: "" };
  res.json({ ok: true, message: "بدأت المزامنة في الخلفية" });

  (async () => {
    try {
      // ── التحقق من اتصال DB ─────────────────────────────────────────────────
      try {
        const pool = require("./db");
        await pool.query("SELECT 1");
      } catch (dbErr) {
        mediaSyncStatus.running   = false;
        mediaSyncStatus.lastError = "❌ قاعدة البيانات غير متصلة: " + dbErr.message;
        console.error("wa-sync: DB غير متصل:", dbErr.message);
        return;
      }

      // ── جمع كل المحادثات من جميع البوتات ─────────────────────────────────
      const seenPhones = new Set();
      const allChats   = [];
      for (const bot of connectedBots) {
        try {
          const chats = await Promise.race([
            bot.client.getChats(),
            new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 30000)),
          ]);
          for (const c of chats) {
            const cid = c.id?._serialized || "";
            if (!cid.endsWith("@c.us") && !cid.endsWith("@lid")) continue;
            if (c.isGroup || c.isBroadcast) continue;
            const phone = normalizePhone(cid);
            if (!phone || phone.length < 7) continue;
            if (seenPhones.has(phone)) continue;
            seenPhones.add(phone);
            allChats.push({ chat: c, botClient: bot.client });
          }
        } catch (e) {
          console.warn("wa-sync: bot getChats فشل:", e.message);
        }
      }
      mediaSyncStatus.total = allChats.length;
      console.log(`\n📥 [wa-sync] ${allChats.length} محادثة — بدء المزامنة...`);

      for (const { chat, botClient } of allChats) {
        if (!mediaSyncStatus.running) break;

        const phone    = normalizePhone(chat.id._serialized);
        const chatName = chat.name || phone;
        mediaSyncStatus.currentChat = `${chatName} (${phone})`;

        try {
          // ── المرحلة 1: حفظ الكونتكت + آخر رسالة (من getChats مباشرة) ──────
          // lastMessage متاحة دائماً بدون fetchMessages
          const lastMsg = chat.lastMessage;
          const lastBody = (lastMsg?.body || "").trim();

          await registerContact(phone, chatName, lastBody);

          // حفظ آخر رسالة إذا كانت نصية
          if (lastBody && lastMsg && !lastMsg.hasMedia) {
            const dir        = lastMsg.fromMe ? "out" : "in";
            const msgTs      = new Date((lastMsg.timestamp || Date.now() / 1000) * 1000);
            const waMsgId    = lastMsg.id?._serialized;
            const senderName = lastMsg.fromMe ? "أنت" : chatName;
            await saveMessage(phone, senderName, dir, lastBody,
              lastMsg.fromMe ? "manual" : "user", msgTs, waMsgId);
            mediaSyncStatus.saved++;
          }

          // ── المرحلة 2: fetchMessages للرسائل الأخيرة (30 فقط، بدون scroll) ─
          // تخطي @lid — لا يدعم fetchMessages
          if (!chat.id._serialized.endsWith("@lid")) {
            try {
              // limit صغير (30) → يأخذ فقط ما هو محمّل في الذاكرة بدون loadEarlierMsgs
              const msgs = await Promise.race([
                botClient.pupPage.evaluate(async (chatId) => {
                  const chat = window.Store.Chat.get(window.Store.WidFactory.createWid(chatId));
                  if (!chat) return [];
                  return chat.msgs.getModelsArray()
                    .filter(m => !m.isNotification)
                    .slice(-30)
                    .map(m => window.WWebJS.getMessageModel(m));
                }, chat.id._serialized),
                new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 10000)),
              ]);

              let chatSaved = 0;
              for (const msgData of (msgs || [])) {
                try {
                  const body = (msgData.body || "").trim();
                  if (!body || msgData.hasMedia) continue;
                  const dir        = msgData.id?.fromMe ? "out" : "in";
                  const msgTs      = new Date((msgData.t || Date.now() / 1000) * 1000);
                  const waMsgId    = msgData.id?._serialized;
                  const senderName = msgData.id?.fromMe ? "أنت" : chatName;
                  await saveMessage(phone, senderName, dir, body,
                    msgData.id?.fromMe ? "manual" : "user", msgTs, waMsgId);
                  mediaSyncStatus.saved++;
                  chatSaved++;
                } catch { /* رسالة واحدة فشلت — تخطي */ }
              }
              if (chatSaved > 0) console.log(`✅ [wa-sync] ${chatName}: ${chatSaved} رسالة`);

            } catch (fetchErr) {
              // لا يهم — لدينا lastMessage بالفعل
              console.debug(`[wa-sync] in-memory فشل لـ ${chatName}: ${fetchErr.message}`);
            }
          }

        } catch (chatErr) {
          mediaSyncStatus.errors++;
          mediaSyncStatus.lastError = `خطأ في ${chatName}: ${chatErr.message}`;
          console.error(`❌ [wa-sync] ${chatName}:`, chatErr.message);
        }

        mediaSyncStatus.done++;
        // تأخير قصير بين المحادثات
        if (mediaSyncStatus.done % 50 === 0) await new Promise(r => setTimeout(r, 500));
      }

      console.log(`\n✅ [wa-sync] اكتمل: ${mediaSyncStatus.saved} رسالة محفوظة، ${mediaSyncStatus.errors} أخطاء`);

    } catch (err) {
      mediaSyncStatus.errors++;
      mediaSyncStatus.lastError = err.message;
      console.error("wa-sync خطأ عام:", err.message);
    } finally {
      mediaSyncStatus.running = false;
      mediaSyncStatus.currentChat = "";
    }
  })();
});

app.get("/api/wa-sync-status", (_req, res) => {
  res.json(mediaSyncStatus);
});

// ── إيقاف المزامنة يدوياً ──────────────────────────────────────────────────
app.post("/api/wa-sync-stop", (_req, res) => {
  if (mediaSyncStatus.running) {
    mediaSyncStatus.running = false;
    mediaSyncStatus.currentChat = "";
    mediaSyncStatus.lastError = "⏹️ تم الإيقاف يدوياً";
    console.log("⏹️ [wa-sync] إيقاف يدوي");
    res.json({ ok: true, message: "تم إيقاف المزامنة" });
  } else {
    res.json({ ok: false, message: "المزامنة غير جارية" });
  }
});

// ── تاريخ المحادثة من واتساب مباشرة (مدمج مع قاعدة البيانات) ─────────────
app.get("/api/wa-history", async (req, res) => {
  const { phone, limit = 500 } = req.query;
  if (!phone) return res.status(400).json({ error: "phone مطلوب" });

  const phoneClean = phone.replace(/\D/g, "");

  // دائماً نجيب الرسائل من قاعدة البيانات (فيها URLs الوسائط المحفوظة)
  const dbMsgs = await getMessages({ phone: phoneClean, limit: 500 });

  const connectedBots = [...bots.values()].filter(b => b.botConnected);
  if (!connectedBots.length) {
    return res.json(dbMsgs); // لا يوجد بوت متصل — نرجع قاعدة البيانات فقط
  }

  try {
    // نجرب كل البوتات المتصلة حتى نجد المحادثة
    let waChat = null;
    const fullPhone  = normalizeOutPhone(phoneClean);
    const candidates = fullPhone !== phoneClean ? [fullPhone, phoneClean] : [phoneClean];
    outerAll: for (const bot of connectedBots) {
      for (const p of candidates) {
        for (const suffix of ["@c.us", "@lid"]) {
          try { waChat = await bot.client.getChatById(p + suffix); break outerAll; }
          catch { /* جرب التالي */ }
        }
      }
    }
    if (!waChat) return res.json(dbMsgs);
    const waMsgs = await Promise.race([
      waChat.fetchMessages({ limit: Math.min(parseInt(limit), 100) }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 12000)),
    ]);

    if (!waMsgs.length) return res.json(dbMsgs);

    const waTypeLabel = {
      image: "📷 صورة", video: "🎬 فيديو",
      ptt: "🎤 رسالة صوتية", audio: "🎤 صوت", document: "📎 ملف",
    };

    // ── جدول بحث مزدوج: بـwa_msg_id أولاً ثم بالدقيقة كـfallback ────────────
    const dbByWaId  = new Map(); // wa_msg_id → db row
    const dbByKey   = new Map(); // direction:minute → [db rows]
    for (const m of dbMsgs) {
      if (m.wa_msg_id) dbByWaId.set(m.wa_msg_id, m);
      const ts = Math.floor(new Date(m.created_at).getTime() / 60000);
      for (const delta of [0, -1, 1]) {
        const key = `${m.direction}:${ts + delta}`;
        if (!dbByKey.has(key)) dbByKey.set(key, []);
        dbByKey.get(key).push(m);
      }
    }

    const dbUsedIds = new Set();
    const result    = [];

    for (const wm of waMsgs) {
      const dir   = wm.fromMe ? "out" : "in";
      const waId  = wm.id._serialized;

      // 1) تطابق مباشر بـwa_msg_id (الأدق)
      let dbMatch = dbByWaId.get(waId);
      if (dbMatch && !dbUsedIds.has(dbMatch.id)) {
        dbUsedIds.add(dbMatch.id);
        result.push(dbMatch);
        continue;
      }

      // 2) fallback: تطابق بالدقيقة + الاتجاه
      const ts   = Math.floor(wm.timestamp / 60);
      const key  = `${dir}:${ts}`;
      const cands = dbByKey.get(key) || [];
      dbMatch = cands.find(m => !dbUsedIds.has(m.id));
      if (dbMatch) {
        dbUsedIds.add(dbMatch.id);
        result.push(dbMatch);
        continue;
      }

      // 3) رسالة من واتساب فقط — لم تُحفظ في DB
      let body = wm.body || "";
      if (wm.hasMedia && !body) body = waTypeLabel[wm.type] || "📎 وسائط";
      result.push({
        id:         `wa_${waId}`,
        phone:      phoneClean,
        name:       dir === "out" ? "أنت" : "الزبون",
        direction:  dir,
        body:       body || "—",
        source:     dir === "out" ? "manual" : "user",
        created_at: new Date(wm.timestamp * 1000).toISOString(),
        wa_msg_id:  waId,
        hasMedia:   wm.hasMedia || false,
        waType:     wm.type || null,
      });
    }

    // إضافة رسائل قاعدة البيانات الأقدم من أقدم رسالة في واتساب
    const oldestWaMs = (waMsgs[0]?.timestamp || 0) * 1000;
    for (const m of dbMsgs) {
      if (!dbUsedIds.has(m.id) && new Date(m.created_at).getTime() < oldestWaMs - 120000) {
        result.push(m);
      }
    }

    // ترتيب تنازلي (الأحدث أولاً — نفس ترتيب /api/messages)
    result.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json(result);

  } catch (err) {
    console.error("wa-history error:", err.message);
    res.json(dbMsgs); // fallback لقاعدة البيانات عند أي خطأ
  }
});

// ── تحميل وسائط واتساب عند الطلب ─────────────────────────────────────────
app.get("/api/wa-media", async (req, res) => {
  const { msgId, phone } = req.query;
  if (!msgId) return res.status(400).json({ error: "msgId مطلوب" });
  try {
    const connectedBots = [...bots.values()].filter(b => b.botConnected);
    if (!connectedBots.length) return res.status(503).json({ error: "لا يوجد بوت متصل" });
    // جرب كل البوتات حتى تجد الرسالة
    let message = null;
    for (const bot of connectedBots) {
      try { message = await bot.client.getMessageById(msgId); if (message) break; } catch { /* جرب التالي */ }
    }
    if (!message || !message.hasMedia) return res.status(404).json({ error: "لا توجد وسائط" });
    const media = await message.downloadMedia();
    if (!media) return res.status(500).json({ error: "فشل تحميل الوسائط" });

    const phoneClean = phoneKey(phone || message.from);
    const mimeBase   = (media.mimetype || "").split(";")[0].trim();
    let url = null;

    if (mimeBase.startsWith("image/")) {
      const file = await saveImage(phoneClean, "مجهول", media);
      url = file ? `/uploads/images/${file}` : null;
    } else if (mimeBase.startsWith("audio/") || message.type === "ptt") {
      const file = await saveVoice(phoneClean, "مجهول", media);
      url = file ? `/uploads/voices/${file}` : null;
    } else if (mimeBase.startsWith("video/") || message.type === "video") {
      const file = await saveVideo(phoneClean, "مجهول", media);
      url = file ? `/uploads/videos/${file}` : null;
    } else {
      return res.status(400).json({ error: "نوع وسائط غير مدعوم: " + mimeBase });
    }

    if (!url) return res.status(500).json({ error: "فشل حفظ الملف" });
    res.json({ ok: true, url, mimetype: mimeBase });
  } catch (err) {
    console.error("wa-media error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/messages/stats", async (_req, res) => {
  const stats = await getMessageStats();
  res.json(stats);
});

app.get("/api/messages/unanswered", async (_req, res) => {
  const list = await getUnansweredContacts();
  res.json(list);
});

// ── رد جماعي على غير المردود عليهم ────────────────────────────────────────
let bulkReplyStatus = { running: false, done: 0, total: 0, ok: 0, fail: 0 };

app.post("/api/bulk-reply", async (req, res) => {
  if (bulkReplyStatus.running) return res.json({ ok: true, message: "الإرسال جاري بالفعل" });
  const { message, delay = 4 } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: "message مطلوب" });

  const bot = getActiveBot();
  if (!bot) return res.status(503).json({ error: "لا يوجد بوت متصل" });

  const list = await getUnansweredContacts();
  if (!list.length) return res.json({ ok: true, message: "لا يوجد أحد غير مردود عليه" });

  bulkReplyStatus = { running: true, done: 0, total: list.length, ok: 0, fail: 0 };
  res.json({ ok: true, message: `سيتم الإرسال لـ ${list.length} جهة اتصال` });

  (async () => {
    const delayMs = Math.max(2, parseInt(delay)) * 1000;
    for (const contact of list) {
      try {
        const phone = contact.phone;
        const chatId = phone.includes("@") ? phone : `${phone}@c.us`;
        await bot.client.sendMessage(chatId, message);
        await saveMessage(phone, "أنت", "out", message, "manual", Date.now(), null);
        bulkReplyStatus.ok++;
      } catch { bulkReplyStatus.fail++; }
      bulkReplyStatus.done++;
      if (bulkReplyStatus.done < bulkReplyStatus.total) await sleep(delayMs);
    }
    bulkReplyStatus.running = false;
  })();
});

app.get("/api/bulk-reply/status", (_req, res) => {
  res.json(bulkReplyStatus);
});

// ── 🤖 رد ذكي تلقائي باستخدام AI على الرسائل غير المجاب عليها ──────────────
let aiReplyStatus = { running: false, done: 0, total: 0, ok: 0, fail: 0, messages: [] };

app.post("/api/ai-auto-reply", async (req, res) => {
  if (aiReplyStatus.running) {
    return res.json({ ok: true, message: "الرد الذكي جاري بالفعل", status: aiReplyStatus });
  }

  const bot = getActiveBot();
  if (!bot) return res.status(503).json({ error: "لا يوجد بوت متصل" });

  try {
    const pool = require("./db");

    // جلب الرسائل غير المجاب عليها
    const [countResult] = await pool.query(`
      SELECT COUNT(*) as count FROM messages m
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
    `);

    const count = countResult[0]?.count || 0;

    if (count === 0) {
      return res.json({ ok: true, message: "لا توجد رسائل بدون رد 🎉" });
    }

    const [unansweredMsgs] = await pool.query(`
      SELECT
        m.contact as phone,
        COALESCE(c.name, m.contact) as name,
        m.body as message,
        m.created_at as timestamp
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
      LIMIT 50
    `);

    aiReplyStatus = { running: true, done: 0, total: unansweredMsgs.length, ok: 0, fail: 0, messages: [], creditError: false };
    res.json({ ok: true, message: `🤖 بدء الرد الذكي على ${unansweredMsgs.length} رسالة` });

    // معالجة الرسائل بعد الرد الفوري
    (async () => {
      for (const msg of unansweredMsgs) {
        try {
          if (!msg.message?.trim()) {
            aiReplyStatus.fail++;
            aiReplyStatus.done++;
            continue;
          }

          console.log(`\n🤖 [AI-Reply] معالجة رسالة من ${msg.name}: "${msg.message.substring(0, 60)}..."`);

          let replyText = "";
          let source = "ai";

          // الأولوية 1: الأجوبة المبرمجة (keywords) — أسرع وبدون تكلفة API
          const { text: customText, defaultText } = findCustomResponse(msg.message);
          if (customText) {
            replyText = customText;
            source = "custom";
            console.log(`✅ [AI-Reply] رد مبرمج → ${msg.name}`);
          } else {
            // الأولوية 2: الذكاء الاصطناعي — مع contactId صحيح
            try {
              replyText = await generateResponse(msg.phone, msg.name, msg.message);
              if (!replyText?.trim()) throw new Error("رد فارغ من الـ AI");
              console.log(`🤖 [AI-Reply] رد ذكي → ${msg.name}`);
            } catch (aiErr) {
              // تحقق من خطأ الكريدت
              if (aiErr.message?.startsWith("CREDIT_LOW:")) {
                aiReplyStatus.creditError = true;
                const errMsg = aiErr.message.replace("CREDIT_LOW:", "");
                console.warn(`⚠️  [AI-Reply] ${errMsg} — استخدام الرد الافتراضي`);
              } else {
                console.warn(`⚠️  [AI-Reply] AI فشل (${aiErr.message}) — استخدام الرد الافتراضي`);
              }
              // الأولوية 3: الرد الافتراضي
              replyText = defaultText;
              source = "default";
            }
          }

          if (!replyText?.trim()) throw new Error("لا يوجد رد متاح");

          // إرسال الرد
          const chatId = msg.phone.includes("@") ? msg.phone : `${msg.phone}@c.us`;
          await bot.client.sendMessage(chatId, replyText);

          // حفظ الرد
          await saveMessage(msg.phone, "البوت", "out", replyText, source, null, null);
          emitMessage(msg.phone, { phone: msg.phone, name: "البوت", direction: "out", body: replyText, source, created_at: new Date().toISOString() });

          aiReplyStatus.ok++;
          aiReplyStatus.messages.push({
            phone: msg.phone,
            name: msg.name,
            originalMsg: msg.message.substring(0, 50),
            aiReply: replyText.substring(0, 50),
            source,
            status: "✅"
          });

          console.log(`✅ [AI-Reply] تم الرد على ${msg.name} [${source}]`);

          // تأخير 2-3 ثوان بين الرسائل
          await sleep(2000 + Math.random() * 1000);
        } catch (err) {
          aiReplyStatus.fail++;
          aiReplyStatus.messages.push({
            phone: msg.phone,
            name: msg.name,
            originalMsg: msg.message?.substring(0, 50) || "",
            error: err.message,
            status: "❌"
          });
          console.error(`❌ [AI-Reply] فشل الرد على ${msg.name}:`, err.message);
        }
        aiReplyStatus.done++;
      }
      console.log(`\n✅ [AI-Reply] اكتمل: ${aiReplyStatus.ok}/${aiReplyStatus.total}`);
      if (aiReplyStatus.creditError) {
        console.warn("⚠️  [AI-Reply] الكريدت منتهي — اشحن حسابك على groq.com");
      }
      aiReplyStatus.running = false;
    })();

  } catch (err) {
    console.error("❌ [AI-Reply] خطأ:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/ai-auto-reply/status", (_req, res) => {
  res.json(aiReplyStatus);
});

// ── CRUD الردود المبرمجة ───────────────────────────────────────────────────
const RESPONSES_FILE = path.join(__dirname, "responses.json");

function readResponses() {
  try { return JSON.parse(fs.readFileSync(RESPONSES_FILE, "utf8")); }
  catch { return { responses: [], defaultReply: "" }; }
}
function writeResponses(data) {
  fs.writeFileSync(RESPONSES_FILE, JSON.stringify(data, null, 2), "utf8");
}

app.get("/api/responses", (_req, res) => {
  const data = readResponses();
  res.json({ responses: data.responses || [], defaultReply: data.defaultReply || "" });
});

// ── سجل استخدام الردود المبرمجة ───────────────────────────────────────────
app.get("/api/response-logs", async (req, res) => {
  try {
    const pool    = require("./db");
    const limit   = Math.min(parseInt(req.query.limit  || "100"), 500);
    const offset  = parseInt(req.query.offset || "0");
    const keyword = (req.query.keyword || "").trim();
    const params  = keyword ? [`%${keyword}%`, limit, offset] : [limit, offset];
    const where   = keyword ? "WHERE keywords_label LIKE ?" : "";
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM response_logs ${where}`,
      keyword ? [`%${keyword}%`] : []
    );
    const [rows] = await pool.query(
      `SELECT id, phone, keywords_label, matched_kw, reply_preview, source, created_at
         FROM response_logs ${where}
        ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      params
    );
    res.setHeader("X-Total-Count", total);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/response-logs/stats", async (_req, res) => {
  try {
    const pool = require("./db");
    const [[{ total }]] = await pool.query("SELECT COUNT(*) AS total FROM response_logs");
    const [[{ today }]] = await pool.query(
      "SELECT COUNT(*) AS today FROM response_logs WHERE DATE(created_at) = CURDATE()"
    );
    const [topReplies] = await pool.query(`
      SELECT keywords_label, COUNT(*) AS cnt
        FROM response_logs
       GROUP BY keywords_label
       ORDER BY cnt DESC LIMIT 10
    `);
    res.json({ total: Number(total), today: Number(today), topReplies });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── سجل المكالمات ────────────────────────────────────────────────────────
app.get("/api/calls", async (req, res) => {
  try {
    const { phone, search, limit = 50, offset = 0 } = req.query;
    const [list, total] = await Promise.all([
      getCalls({ phone, search, limit: parseInt(limit), offset: parseInt(offset) }),
      getCallsCount({ phone, search }),
    ]);
    res.setHeader("X-Total-Count", total);
    res.json(list);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/calls/stats", async (_req, res) => {
  try {
    res.json(await getCallStats());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/responses", (req, res) => {
  try {
    const { keywords, reply, voice, shortOnly } = req.body;
    if (!keywords || !reply) return res.status(400).json({ error: "keywords و reply مطلوبين" });
    const data = readResponses();
    const kws  = keywords.split(",").map(k => k.trim()).filter(Boolean);
    const entry = { keywords: kws, reply };
    if (voice)     entry.voice     = voice;
    if (shortOnly) entry.shortOnly = true;
    data.responses.push(entry);
    writeResponses(data);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/api/responses/default", (req, res) => {
  try {
    const { defaultReply } = req.body;
    if (!defaultReply) return res.status(400).json({ error: "defaultReply مطلوب" });
    const data = readResponses();
    data.defaultReply = defaultReply;
    writeResponses(data);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/api/responses/:index", (req, res) => {
  try {
    const idx  = parseInt(req.params.index);
    const { keywords, reply, voice, shortOnly } = req.body;
    if (!keywords || !reply) return res.status(400).json({ error: "keywords و reply مطلوبين" });
    const data = readResponses();
    if (idx < 0 || idx >= data.responses.length) return res.status(404).json({ error: "غير موجود" });
    const kws  = keywords.split(",").map(k => k.trim()).filter(Boolean);
    const entry = { keywords: kws, reply };
    if (voice)     entry.voice     = voice;
    if (shortOnly) entry.shortOnly = true;
    data.responses[idx] = entry;
    writeResponses(data);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/responses/:index", (req, res) => {
  try {
    const idx  = parseInt(req.params.index);
    const data = readResponses();
    if (idx < 0 || idx >= data.responses.length) return res.status(404).json({ error: "غير موجود" });
    data.responses.splice(idx, 1);
    writeResponses(data);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── الصور المستلمة ─────────────────────────────────────────────────────────

app.get("/api/images", async (req, res) => {
  const { phone, limit = 50, offset = 0 } = req.query;
  const list = await getImages({ phone, limit: parseInt(limit), offset: parseInt(offset) });
  res.json(list);
});

app.get("/api/images/stats", async (_req, res) => {
  const stats = await getImageStats();
  res.json(stats);
});

app.delete("/api/images/:id", async (req, res) => {
  const ok = await deleteImage(parseInt(req.params.id));
  ok ? res.json({ ok: true }) : res.status(404).json({ error: "غير موجود" });
});

app.post("/api/images/upload", async (req, res) => {
  const { phone, name, data, mimetype } = req.body;
  if (!phone || !data || !mimetype) return res.status(400).json({ error: "phone, data و mimetype مطلوبين" });
  try {
    const ext      = mimetype.split("/")[1]?.split(";")[0] || "jpg";
    const key      = phoneKey(normalizeOutPhone(cleanPhone(phone)));
    const filename = `${Date.now()}_${key}.${ext}`;
    const filepath = path.join(__dirname, "public", "uploads", "images", filename);
    const buffer   = Buffer.from(data, "base64");
    fs.writeFileSync(filepath, buffer);
    await pool.query(
      `INSERT IGNORE INTO images (phone, name, filename, mimetype, filesize, created_at) VALUES (?, ?, ?, ?, ?, NOW())`,
      [key, name || "يدوي", filename, mimetype, buffer.length]
    );
    res.json({ ok: true, filename, url: `/uploads/images/${filename}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── الصوتيات المستلمة ──────────────────────────────────────────────────────

app.get("/api/voices", async (req, res) => {
  const { phone, search, limit = 50, offset = 0 } = req.query;
  const list = await getVoices({ phone, search, limit: parseInt(limit), offset: parseInt(offset) });
  res.json(list);
});

app.get("/api/voices/stats", async (_req, res) => {
  const stats = await getVoiceStats();
  res.json(stats);
});

app.patch("/api/voices/:id/note", async (req, res) => {
  const ok = await updateVoiceNote(parseInt(req.params.id), req.body.note);
  ok ? res.json({ ok: true }) : res.status(500).json({ error: "فشل الحفظ" });
});

app.delete("/api/voices/:id", async (req, res) => {
  const ok = await deleteVoice(parseInt(req.params.id));
  ok ? res.json({ ok: true }) : res.status(404).json({ error: "غير موجود" });
});

app.post("/api/voices/upload", async (req, res) => {
  const { phone, name, data, mimetype } = req.body;
  if (!phone || !data || !mimetype) return res.status(400).json({ error: "phone, data و mimetype مطلوبين" });
  try {
    const mimeBase = mimetype.split(";")[0].trim();
    const ext      = mimeBase.split("/")[1] || "ogg";
    const key      = phoneKey(normalizeOutPhone(cleanPhone(phone)));
    const filename = `${Date.now()}_${key}.${ext}`;
    const uploadDir = path.join(__dirname, "public", "uploads", "voices");
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    const filepath = path.join(uploadDir, filename);
    const buffer   = Buffer.from(data, "base64");
    fs.writeFileSync(filepath, buffer);
    await pool.query(
      `INSERT IGNORE INTO voices (phone, name, filename, mimetype, filesize, created_at) VALUES (?, ?, ?, ?, ?, NOW())`,
      [key, name || "يدوي", filename, mimeBase, buffer.length]
    );
    res.json({ ok: true, filename, url: `/uploads/voices/${filename}` });
  } catch (err) {
    console.error("❌ خطأ في رفع الصوت:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── الفيديوهات المستلمة ────────────────────────────────────────────────────

app.get("/api/videos", async (req, res) => {
  const { phone, search, limit = 50, offset = 0 } = req.query;
  const list = await getVideos({ phone, search, limit: parseInt(limit), offset: parseInt(offset) });
  res.json(list);
});

app.get("/api/videos/stats", async (_req, res) => {
  const stats = await getVideoStats();
  res.json(stats);
});

app.patch("/api/videos/:id/note", async (req, res) => {
  const ok = await updateVideoNote(parseInt(req.params.id), req.body.note);
  ok ? res.json({ ok: true }) : res.status(500).json({ error: "فشل الحفظ" });
});

app.delete("/api/videos/:id", async (req, res) => {
  const ok = await deleteVideo(parseInt(req.params.id));
  ok ? res.json({ ok: true }) : res.status(404).json({ error: "غير موجود" });
});

app.post("/api/videos/upload", async (req, res) => {
  const { phone, name, data, mimetype } = req.body;
  if (!phone || !data || !mimetype) return res.status(400).json({ error: "phone, data و mimetype مطلوبين" });
  try {
    const mimeBase = mimetype.split(";")[0].trim();
    const ext      = mimeBase.split("/")[1] || "mp4";
    const key      = phoneKey(normalizeOutPhone(cleanPhone(phone)));
    const filename = `${Date.now()}_${key}.${ext}`;
    const filepath = path.join(__dirname, "public", "uploads", "videos", filename);
    const buffer   = Buffer.from(data, "base64");
    if (!fs.existsSync(path.dirname(filepath))) fs.mkdirSync(path.dirname(filepath), { recursive: true });
    fs.writeFileSync(filepath, buffer);
    await pool.query(
      `INSERT IGNORE INTO videos (phone, name, filename, mimetype, filesize, created_at) VALUES (?, ?, ?, ?, ?, NOW())`,
      [key, name || "يدوي", filename, mimeBase, buffer.length]
    );
    res.json({ ok: true, filename, url: `/uploads/videos/${filename}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── الملاحظات ────────────────────────────────────────────────────────────

const NOTES_FILE  = path.join(__dirname, "notes.json");
const NOTES_DIR   = path.join(__dirname, "public", "uploads", "notes");
if (!fs.existsSync(NOTES_DIR)) fs.mkdirSync(NOTES_DIR, { recursive: true });

function readNotes() {
  try { return JSON.parse(fs.readFileSync(NOTES_FILE, "utf8")); }
  catch { return []; }
}
function writeNotes(notes) {
  fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2));
}

app.get("/api/notes", (_req, res) => {
  res.json(readNotes());
});

app.post("/api/notes", (req, res) => {
  const { title, text, images = [] } = req.body;
  const note = { id: Date.now().toString(), title: title || "", text: text || "", images, createdAt: new Date().toISOString() };
  const notes = readNotes();
  notes.unshift(note);
  writeNotes(notes);
  res.json({ ok: true, note });
});

app.delete("/api/notes/:id", (req, res) => {
  const notes = readNotes();
  const idx   = notes.findIndex(n => n.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "غير موجود" });
  // حذف صور الملاحظة
  (notes[idx].images || []).forEach(url => {
    try { fs.unlinkSync(path.join(__dirname, "public", url)); } catch {}
  });
  notes.splice(idx, 1);
  writeNotes(notes);
  res.json({ ok: true });
});

app.post("/api/notes/upload-image", (req, res) => {
  const { data, mimetype } = req.body;
  if (!data || !mimetype) return res.status(400).json({ error: "data و mimetype مطلوبين" });
  try {
    const ext      = mimetype.split("/")[1]?.split(";")[0] || "jpg";
    const filename = `${Date.now()}_note.${ext}`;
    const filepath = path.join(NOTES_DIR, filename);
    fs.writeFileSync(filepath, Buffer.from(data, "base64"));
    res.json({ ok: true, url: `/uploads/notes/${filename}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/notes", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "notes.html"));
});

app.get("/user-reply", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "user-reply.html"));
});

// ─── Bot Health Check & Keepalive ────────────────────────────────────────

app.get("/api/bot-status", (req, res) => {
  const botId = req.query.botId || "default";
  const bot = bots.get(botId);

  if (!bot) {
    return res.status(404).json({
      ok: false,
      connected: false,
      message: "البوت غير موجود",
    });
  }

  const uptime = Math.floor((Date.now() - (BOT_START_TIME * 1000)) / 1000);
  const uptimeStr = uptime > 3600
    ? `${Math.floor(uptime / 3600)}س ${Math.floor((uptime % 3600) / 60)}د`
    : `${Math.floor(uptime / 60)}د`;

  res.json({
    ok: bot.botConnected,
    connected: bot.botConnected,
    botId,
    phone: bot.botPhone || "—",
    uptime: uptimeStr,
    uptimeSec: uptime,
    watchdogFails: bot._watchdogFails || 0,
    lastPing: new Date().toISOString(),
  });
});

// ─── Heartbeat/Ping لإبقاء الاتصال حياً ──────────────────────────────────

app.post("/api/ping", (req, res) => {
  const botId = req.body?.botId || "default";
  const bot = bots.get(botId);

  if (!bot) {
    return res.status(503).json({ error: "البوت غير متصل" });
  }

  if (!bot.botConnected) {
    return res.status(503).json({ error: "البوت غير متصل حالياً" });
  }

  // Trigger watchdog check
  if (bot._keepaliveTimer) {
    res.json({ ok: true, connected: true, message: "البوت نشط" });
  } else {
    res.status(503).json({ error: "watchdog غير فعال" });
  }
});

// ─── Get All Bots Status ────────────────────────────────────────────────

app.get("/api/bots-status", (req, res) => {
  const botsStatus = Array.from(bots.values()).map(bot => ({
    botId: bot.botId || "default",
    connected: bot.botConnected,
    phone: bot.botPhone || "—",
    watchdogFails: bot._watchdogFails || 0,
  }));

  res.json({
    ok: true,
    bots: botsStatus,
    totalBots: bots.size,
  });
});

// ─── Public Contact Widget (no auth) ──────────────────────────────────────

// Rate limit: 5 messages per hour per IP
const _contactRL = new Map();

app.get("/contact", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "contact.html"));
});

app.get("/widget", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "widget.html"));
});

// نموذج الحجز العام (يمكن تضمينه على abrajeimmo.com عبر iframe)
app.get("/booking", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "booking.html"));
});

app.get("/bookings-admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "bookings-admin.html"));
});

app.post("/api/contact", async (req, res) => {
  // Rate limiting
  const ip  = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const now = Date.now();
  let rl = _contactRL.get(ip);
  if (!rl || now > rl.resetAt) { rl = { count: 0, resetAt: now + 3600000 }; _contactRL.set(ip, rl); }
  if (rl.count >= 5) return res.status(429).json({ error: "تجاوزت الحد المسموح — حاول بعد ساعة" });
  rl.count++;

  const { name, phone, message } = req.body;
  if (!name    || name.trim().length    < 1) return res.status(400).json({ error: "الاسم مطلوب" });
  if (!message || message.trim().length < 2) return res.status(400).json({ error: "الرسالة مطلوبة" });

  const ownerPhone = process.env.OWNER_PHONE;
  if (!ownerPhone) return res.status(503).json({ error: "لم يتم إعداد رقم المستلم (OWNER_PHONE)" });

  const bot = getActiveBot();
  if (!bot) return res.status(503).json({ error: "البوت غير متصل حالياً — حاول لاحقاً" });

  const sName = String(name    || "").trim().substring(0, 80);
  const sPhone= String(phone   || "—").trim().substring(0, 25);
  const sMsg  = String(message || "").trim().substring(0, 500);
  const ts    = new Date().toLocaleString("ar-MA", { timeZone: "Africa/Casablanca" });

  const text = `🔔 *رسالة جديدة من الموقع*\n\n👤 الاسم: ${sName}\n📞 الرقم: ${sPhone}\n🕐 الوقت: ${ts}\n\n💬 الرسالة:\n${sMsg}`;

  try {
    const outPhone = normalizeOutPhone(cleanPhone(ownerPhone));
    await botSend(outPhone + "@c.us", text);
    res.json({ ok: true });
  } catch (err) {
    console.error("[contact-widget]", err.message);
    res.status(500).json({ error: "فشل الإرسال — حاول لاحقاً" });
  }
});

// ── Chat Widget API (عام — بدون auth) ────────────────────────────────────
const _chatWidgetRL = new Map();
app.post("/api/chat-widget", async (req, res) => {
  const ip  = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const now = Date.now();
  let rl = _chatWidgetRL.get(ip);
  if (!rl || now > rl.resetAt) { rl = { count: 0, resetAt: now + 3600000 }; _chatWidgetRL.set(ip, rl); }
  if (rl.count >= 30) return res.status(429).json({ reply: "كلمنا مباشرة على 0680040002 📞" });
  rl.count++;

  const { name, message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: "message مطلوب" });

  const sName = String(name || "زبون").trim().substring(0, 60);
  const sMsg  = String(message).trim().substring(0, 500);

  try {
    const { generateResponse } = require("./claude");
    const { findCustomResponse } = require("./customResponses");

    // جرب الردود المبرمجة أولاً
    const custom = findCustomResponse(sMsg);
    if (custom?.text) {
      // أرسل إشعار للمالك في الخلفية
      const ownerPhone = process.env.OWNER_PHONE;
      const bot = getActiveBot();
      if (ownerPhone && bot) {
        const ts = new Date().toLocaleString("ar-MA", { timeZone: "Africa/Casablanca" });
        const outPhone = normalizeOutPhone(cleanPhone(ownerPhone));
        botSend(outPhone + "@c.us", `💬 *محادثة موقع*\n👤 ${sName}\n🕐 ${ts}\n\n📩 ${sMsg}\n🤖 ${custom.text}`).catch(() => {});
      }
      return res.json({ reply: custom.text, source: "custom" });
    }

    // ذكاء اصطناعي مع timeout 15 ثانية
    const reply = await Promise.race([
      generateResponse(`widget_${ip}`, sName, sMsg),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 15000)),
    ]);

    // إشعار للمالك
    const ownerPhone = process.env.OWNER_PHONE;
    const bot = getActiveBot();
    if (ownerPhone && bot) {
      const ts = new Date().toLocaleString("ar-MA", { timeZone: "Africa/Casablanca" });
      const outPhone = normalizeOutPhone(cleanPhone(ownerPhone));
      botSend(outPhone + "@c.us", `💬 *محادثة موقع*\n👤 ${sName}\n🕐 ${ts}\n\n📩 ${sMsg}\n🤖 ${reply}`).catch(() => {});
    }

    res.json({ reply, source: "ai" });
  } catch {
    res.json({ reply: "شكراً لتواصلك! للرد السريع كلمنا على واتساب: 0680040002 😊", source: "fallback" });
  }
});

// Dashboard HTML — توجيه حسب الدور
app.get("/", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const info    = tokenRoles.get(cookies.auth_token) || { role: "admin" };
  if (info.role === "admin") {
    res.sendFile(path.join(__dirname, "public", "dashboard.html"));
  } else {
    res.redirect("/user-reply");
  }
});

const PORT     = parseInt(process.env.PORT) || (SSL_CERT && SSL_KEY ? 443 : 3000);
const protocol = (SSL_CERT && SSL_KEY) ? "https" : "http";
server.listen(PORT, () => {
  console.log(`\n🖥️  Dashboard: ${protocol}://localhost:${PORT}`);
  if (process.env.FACEBOOK_PAGE_ACCESS_TOKEN) {
    console.log(`📘 Facebook Webhook: ${protocol}://localhost:${PORT}/webhook`);
  }
});

// ─── أخطاء عامة ───────────────────────────────────────────────────────────

process.on("unhandledRejection", (reason) => {
  console.error("\n⚠️  خطأ غير متوقع:", reason);
});

process.on("SIGINT", async () => {
  console.log("\n\n🛑 إيقاف البوت...");
  for (const [, bot] of bots) {
    if (bot.client) {
      try { await bot.client.destroy(); } catch {}
    }
  }
  process.exit(0);
});

// ─── تشغيل ────────────────────────────────────────────────────────────────

console.log(`🚀 تشغيل بوت واتساب IA (${AI_PROVIDER}) — البوتات المفعّلة: ${BOT_IDS.join(", ")}`);
// تشغيل البوتات بتأخير 60 ثانية بين كل واحد — يمنع تعارض Chrome instances على الـ VPS
BOT_IDS.forEach((id, i) => {
  if (i === 0) { setupClient(id); return; }
  setTimeout(() => {
    console.log(`\n⏱️  [${id}] بدء التشغيل (تأخير ${i * 60}ث)...`);
    setupClient(id);
  }, i * 60000);
});
