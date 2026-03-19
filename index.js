require("dotenv").config();
const crypto     = require("crypto");
const { exec }   = require("child_process");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const express = require("express");
const { generateResponse, clearHistory } = require("./claude");
const { findCustomResponse } = require("./customResponses");
const { verifyWebhook, handleWebhook } = require("./facebook");
const { registerContact, getStats, getAllContacts } = require("./contacts");
const { saveMessage, checkMessageExists, getMessages, getMessageStats, getUnansweredContacts } = require("./messages");
const { saveImage, getImages, getImageStats, deleteImage } = require("./images");
const { saveVoice, getVoices, getVoiceStats, deleteVoice, updateVoiceNote } = require("./voices");
const { saveVideo, getVideos, getVideoStats, deleteVideo, updateVideoNote } = require("./videos");
const path   = require("path");
const fs     = require("fs");

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
  respondToPrivate: process.env.RESPOND_TO_PRIVATE !== "false",
  respondToGroups:  process.env.RESPOND_TO_GROUPS === "true",
  delayMin:         parseInt(process.env.RESPONSE_DELAY_MIN) || 1000,
  delayMax:         parseInt(process.env.RESPONSE_DELAY_MAX) || 3000,
  pauseKeyword:     process.env.PAUSE_KEYWORD  || "!pause",
  resumeKeyword:    process.env.RESUME_KEYWORD || "!resume",
  ignoredNumbers:   (process.env.IGNORED_NUMBERS || "")
    .split(",").map((n) => n.trim()).filter(Boolean),
};

// ─── الحالة ───────────────────────────────────────────────────────────────

const BOT_START_TIME = Math.floor(Date.now() / 1000); // وقت بدء البوت بالثواني
let botPaused         = false;
let autoReplyEnabled  = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "responses.json"), "utf8")).autoReplyEnabled ?? false; }
  catch { return false; }
})();
let mediaSyncStatus   = { running: false, done: 0, total: 0, saved: 0, errors: 0, currentChat: "" };
const pausedChats   = new Set();

// منع تكرار نفس السؤال خلال 60 ثانية
const lastMessages    = new Map();
const REPEAT_DELAY_MS = 60 * 1000;

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

const BOT_IDS = ["bot1", "bot2", "bot3"];

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

function setupClient(botId) {
  const puppeteerOpts = {
    headless: true,
    protocolTimeout: 120000,
    args: [
      "--no-sandbox", "--disable-setuid-sandbox",
      "--disable-dev-shm-usage", "--disable-gpu",
      "--no-first-run", "--no-zygote",
      "--disable-extensions", "--disable-default-apps",
      "--disable-background-networking",
      "--disable-features=TranslateUI,VizDisplayCompositor",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--js-flags=--max-old-space-size=256",
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

    // ── Watchdog: فحص حالة الاتصال كل 45 ثانية — إعادة تشغيل تلقائية إذا تجمّد ──
    if (bot._keepaliveTimer) clearInterval(bot._keepaliveTimer);
    bot._watchdogFails = 0;
    bot._keepaliveTimer = setInterval(async () => {
      if (!bot.botConnected) return;
      try {
        const state = await Promise.race([
          c.getState(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 15000)),
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
    }, 45000);
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

  c.on("message", msg => handleIncoming(msg, botId));
  c.on("message_create", msg => handleOutgoing(msg, botId));

  c.initialize().catch((err) => {
    console.error(`\n❌ [${botId}] فشل التهيئة:`, err.message || err);
    // إعادة المحاولة بعد 35-60 ثانية (عشوائي لتفادي تصادم البوتات)
    const delay = 35000 + Math.floor(Math.random() * 25000);
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
    if (botPaused || pausedChats.has(chat.id._serialized)) return;

    // ─── معالجة الوسائط (صور + صوت) ─────────────────────────────────────────
    if (message.hasMedia) {
      const media = await message.downloadMedia();
      if (!media) return;

      // صورة
      if (media.mimetype && media.mimetype.startsWith("image/")) {
        await registerContact(senderNumber, name, "📷 صورة");
        const imgFile = await saveImage(senderNumber, name, media);
        const imgUrl  = imgFile ? `/uploads/images/${imgFile}` : "📷 صورة";
        await saveMessage(senderNumber, name, "in", imgUrl, "user", null, message.id._serialized);
        emitMessage(key, { waMsgId: message.id._serialized, phone: key, name, direction: "in", body: imgUrl, source: "user", created_at: new Date().toISOString() });
        if (imgFile) io.emit("new_media", { type: "image", phone: key, name, url: imgUrl });
        if (autoReplyEnabled) {
          const imgReply = "📸 وصلتنا صورتك، شكرا! إذا عندك أي سؤال على الشقق كلمنا على 0680040002 😊";
          await botReply(message, imgReply, botId);
          await saveMessage(senderNumber, "البوت", "out", imgReply, "default");
          emitMessage(key, { phone: key, name: "البوت", direction: "out", body: imgReply, source: "default", created_at: new Date().toISOString() });
        }
        return;
      }

      // رسالة صوتية أو ملف صوتي
      if ((media.mimetype && media.mimetype.startsWith("audio/")) || message.type === "ptt") {
        await registerContact(senderNumber, name, "🎤 رسالة صوتية");
        const voiceFile = await saveVoice(senderNumber, name, media);
        const voiceUrl  = voiceFile ? `/uploads/voices/${voiceFile}` : "🎤 رسالة صوتية";
        await saveMessage(senderNumber, name, "in", voiceUrl, "user", null, message.id._serialized);
        emitMessage(key, { waMsgId: message.id._serialized, phone: key, name, direction: "in", body: voiceUrl, source: "user", created_at: new Date().toISOString() });
        if (voiceFile) io.emit("new_media", { type: "voice", phone: key, name, url: voiceUrl });
        if (autoReplyEnabled) {
          const audioReply = "🎤 وصلتنا رسالتك الصوتية! إذا عندك سؤال على الشقق كلمنا على 0680040002 😊";
          await botReply(message, audioReply, botId);
          await saveMessage(senderNumber, "البوت", "out", audioReply, "default");
          emitMessage(key, { phone: key, name: "البوت", direction: "out", body: audioReply, source: "default", created_at: new Date().toISOString() });
        }
        return;
      }

      // فيديو
      if ((media.mimetype && media.mimetype.startsWith("video/")) || message.type === "video") {
        await registerContact(senderNumber, name, "🎬 فيديو");
        const videoFile = await saveVideo(senderNumber, name, media);
        const videoUrl  = videoFile ? `/uploads/videos/${videoFile}` : "🎬 فيديو";
        await saveMessage(senderNumber, name, "in", videoUrl, "user", null, message.id._serialized);
        emitMessage(key, { waMsgId: message.id._serialized, phone: key, name, direction: "in", body: videoUrl, source: "user", created_at: new Date().toISOString() });
        if (videoFile) io.emit("new_media", { type: "video", phone: key, name, url: videoUrl });
        if (autoReplyEnabled) {
          const videoReply = "🎬 وصلنا الفيديو ديالك، شكرا! إذا عندك سؤال على الشقق كلمنا على 0680040002 😊";
          await botReply(message, videoReply, botId);
          await saveMessage(senderNumber, "البوت", "out", videoReply, "default");
          emitMessage(key, { phone: key, name: "البوت", direction: "out", body: videoReply, source: "default", created_at: new Date().toISOString() });
        }
        return;
      }

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

    await chat.sendStateTyping();
    await sleep(Math.random() * (config.delayMax - config.delayMin) + config.delayMin);

    // الأولوية 1: الأجوبة المبرمجة (keywords)
    const { text: customText, voiceFile, defaultText } = findCustomResponse(body);
    let source = "custom";

    await chat.clearState();

    // replyText: نص الرد المُرسَل
    let replyText = "";
    if (voiceFile) {
      // ملف صوتي مبرمج
      const media = MessageMedia.fromFilePath(voiceFile);
      await botReply(message, media, botId, { sendAudioAsVoice: true });
      replyText = customText || "🎤 رسالة صوتية";
      if (customText) await botReply(message, customText, botId);
      console.log(`✅ [🎤 صوت مبرمج] → ${name}`);
    } else if (customText) {
      // رد keyword مبرمج
      await botReply(message, customText, botId);
      replyText = customText;
      console.log(`✅ [مبرمج] → ${name}: ${customText.substring(0, 70)}`);
    } else {
      // الأولوية 2: الذكاء الاصطناعي
      try {
        const aiReply = await generateResponse(contactId, name, body);
        await botReply(message, aiReply, botId);
        replyText = aiReply;
        source    = "ai";
        console.log(`🤖 [AI] → ${name}: ${aiReply.substring(0, 70)}`);
      } catch (aiErr) {
        // الأولوية 3: الرد الافتراضي (fallback)
        console.warn(`⚠️  AI فشل (${aiErr.message}) — جاري استخدام الرد الافتراضي`);
        await botReply(message, defaultText, botId);
        replyText = defaultText;
        source    = "default";
        console.log(`↩️  [افتراضي] → ${name}: ${defaultText.substring(0, 70)}`);
      }
    }

    // حفظ رد البوت (بدون wa_msg_id لأن botMsgIds يمنع التكرار من message_create)
    await saveMessage(senderNumber, "البوت", "out", replyText, source);
    emitMessage(key, { phone: key, name: "البوت", direction: "out", body: replyText, source, created_at: new Date().toISOString() });

  } catch (err) {
    console.error("\n❌ خطأ:", err.stack || err.message);
  }
}

// ─── رسائل المدير اليدوية (من الهاتف مباشرة) ─────────────────────────────

async function handleOutgoing(message, botId) {
  try {
    if (!message.fromMe) return;
    if (!message.id) return; // تجاهل رسائل بدون معرّف
    if (message.timestamp < BOT_START_TIME) return;
    if (message.type === "revoked") return;

    // تجاهل الرسائل التي أرسلها البوت تلقائياً (تم تتبعها بـ botMsgIds)
    const bot = bots.get(botId);
    if (bot.botMsgIds.has(message.id._serialized)) {
      bot.botMsgIds.delete(message.id._serialized);
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

    // معالجة الوسائط
    if (message.hasMedia) {
      try {
        const media = await message.downloadMedia();
        if (media) {
          const waMsgId = message.id._serialized;
          let outBody = "📎 ملف";
          if (media.mimetype?.startsWith("image/")) {
            const imgFile = await saveImage(recipientPhone, recipientName, media);
            outBody = imgFile ? `/uploads/images/${imgFile}` : "📷 صورة";
            await saveMessage(recipientPhone, "أنت", "out", outBody, "manual", null, waMsgId);
          } else if (media.mimetype?.startsWith("audio/") || message.type === "ptt") {
            const vf = await saveVoice(recipientPhone, recipientName, media);
            outBody = vf ? `/uploads/voices/${vf}` : "🎤 رسالة صوتية";
            await saveMessage(recipientPhone, "أنت", "out", outBody, "manual", null, waMsgId);
          } else if (media.mimetype?.startsWith("video/") || message.type === "video") {
            const vf = await saveVideo(recipientPhone, recipientName, media);
            outBody = vf ? `/uploads/videos/${vf}` : "🎬 فيديو";
            await saveMessage(recipientPhone, "أنت", "out", outBody, "manual", null, waMsgId);
          } else {
            await saveMessage(recipientPhone, "أنت", "out", outBody, "manual", null, waMsgId);
          }
          emitMessage(outKey, { waMsgId: message.id._serialized, phone: outKey, name: "أنت", direction: "out", body: outBody, source: "manual", created_at: new Date().toISOString() });
        }
      } catch {}
      console.log(`📤 [${botId}] [يدوي/وسائط] → ${recipientName} (${recipientPhone})`);
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

const http = require("http");
const { Server: SocketIO } = require("socket.io");
const app  = express();

let server;
const SSL_CERT = process.env.SSL_CERT;
const SSL_KEY  = process.env.SSL_KEY;

if (SSL_CERT && SSL_KEY && fs.existsSync(SSL_CERT) && fs.existsSync(SSL_KEY)) {
  const https = require("https");
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

const io = new SocketIO(server, { cors: { origin: "*" } });
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// إرسال رسالة لكل المتصلين بغرفة هاتف معين
function emitMessage(phone, msgObj) {
  io.to(`phone:${phone}`).emit("new_message", msgObj);
}

io.on("connection", (socket) => {
  socket.on("join", (phone) => {
    // غادر الغرف القديمة وانضم للغرفة الجديدة
    for (const room of socket.rooms) {
      if (room !== socket.id) socket.leave(room);
    }
    if (phone) socket.join(`phone:${phone}`);
  });
});

// ─── Auth ──────────────────────────────────────────────────────────────────

const validTokens = new Set();

function parseCookies(header = "") {
  const cookies = {};
  header.split(";").forEach(part => {
    const [k, ...v] = part.trim().split("=");
    if (k) cookies[k.trim()] = decodeURIComponent(v.join("="));
  });
  return cookies;
}

function requireAuth(req, res, next) {
  const pub = ["/login", "/login.html", "/api/login", "/webhook"];
  if (pub.some(p => req.path === p || req.path.startsWith("/webhook"))) return next();
  const cookies = parseCookies(req.headers.cookie);
  if (validTokens.has(cookies.auth_token)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "غير مصرح" });
  res.redirect("/login");
}

app.use(requireAuth);
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

app.post("/api/login", (req, res) => {
  const { password } = req.body;
  const PASS = process.env.DASHBOARD_PASSWORD || "admin123";
  if (password !== PASS) return res.status(401).json({ error: "كلمة المرور غير صحيحة" });
  const token = crypto.randomBytes(32).toString("hex");
  validTokens.add(token);
  res.setHeader("Set-Cookie", `auth_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  validTokens.delete(cookies.auth_token);
  res.setHeader("Set-Cookie", "auth_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.post("/api/admin/change-password", (req, res) => {
  const { current, newPass } = req.body;
  const PASS = process.env.DASHBOARD_PASSWORD || "admin123";
  if (current !== PASS) return res.status(401).json({ error: "كلمة المرور الحالية غير صحيحة" });
  if (!newPass || newPass.length < 6) return res.status(400).json({ error: "كلمة المرور الجديدة قصيرة جداً (6 أحرف على الأقل)" });
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
    validTokens.clear(); // إلغاء جميع الجلسات
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// ── Dashboard API ──────────────────────────────────────────────────────────

app.get("/api/stats", async (_req, res) => {
  const stats = await getStats();
  const connected = [...bots.values()].some(b => b.botConnected);
  res.json({ ...stats, botPaused, autoReplyEnabled, botConnected: connected });
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
    const sessionPath = path.join(__dirname, "sessions", botId);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
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

app.get("/api/contacts", async (_req, res) => {
  const list = await getAllContacts();
  res.json(list);
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

    for (const { phone, name } of contacts) {
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

    res.json({ ok: true, sent, failed, total: contacts.length, results });
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
    await botSend(jid, media, { sendAudioAsVoice: true }, botId);
    await saveMessage(key, "أنت", "out", fileUrl, "manual");
    emitMessage(key, { phone: key, name: "أنت", direction: "out", body: fileUrl, source: "manual", created_at: new Date().toISOString() });
    res.json({ ok: true, url: fileUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/send-media", async (req, res) => {
  const { phone: rawPhone, data, mimetype, ext, filename: origName, botId } = req.body;
  if (!rawPhone || !data || !mimetype) return res.status(400).json({ error: "phone, data و mimetype مطلوبين" });
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
  const { phone, limit = 100, offset = 0 } = req.query;
  const list = await getMessages({ phone, limit: parseInt(limit), offset: parseInt(offset) });
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
  const activeBot = getActiveBot();
  if (!activeBot) return res.status(503).json({ error: "البوت غير متصل بواتساب" });
  if (mediaSyncStatus.running) return res.json({ ok: true, message: "المزامنة جارية بالفعل", status: mediaSyncStatus });

  const msgLimit = parseInt(req.body?.limit) || 3000;
  mediaSyncStatus = { running: true, done: 0, total: 0, saved: 0, errors: 0, currentChat: "" };
  res.json({ ok: true, message: "بدأت المزامنة في الخلفية" });

  (async () => {
    try {
      const chats        = await activeBot.client.getChats();
      const privateChats = chats.filter(c => !c.isGroup);
      mediaSyncStatus.total = privateChats.length;

      for (const chat of privateChats) {
        const phone = normalizePhone(chat.id._serialized);
        if (!phone || phone.length < 7) { mediaSyncStatus.done++; continue; }
        const chatName = chat.name || phone;
        mediaSyncStatus.currentChat = `${chatName} (${phone})`;

        try {
          const msgs = await chat.fetchMessages({ limit: msgLimit });
          for (const msg of msgs) {
            try {
              const dir     = msg.fromMe ? "out" : "in";
              const msgTs   = msg.timestamp * 1000;
              const waMsgId = msg.id._serialized;
              const senderName = msg.fromMe ? "أنت" : chatName;

              // ── رسائل نصية ─────────────────────────────────────────────
              if (!msg.hasMedia) {
                const body = (msg.body || "").trim();
                if (!body) continue;
                // INSERT IGNORE على wa_msg_id يمنع التكرار تلقائياً
                await saveMessage(phone, senderName, dir, body,
                  msg.fromMe ? "manual" : "user", msgTs, waMsgId);
                mediaSyncStatus.saved++;
                continue;
              }

              // ── وسائط: صور وفيديو فقط ──────────────────────────────────
              if (!["image", "video"].includes(msg.type)) continue;

              // تحقق أولي بـwa_msg_id (أسرع من البحث في DB)
              const exists = await checkMessageExists(phone, dir, msgTs);
              if (exists) continue;

              const media = await msg.downloadMedia();
              if (!media) continue;

              if (media.mimetype?.startsWith("image/")) {
                const file = await saveImage(phone, chatName, media, msgTs);
                if (file) {
                  await saveMessage(phone, senderName, dir, `/uploads/images/${file}`,
                    msg.fromMe ? "manual" : "user", msgTs, waMsgId);
                  mediaSyncStatus.saved++;
                }
              } else if (media.mimetype?.startsWith("video/")) {
                const file = await saveVideo(phone, chatName, media, msgTs);
                if (file) {
                  await saveMessage(phone, senderName, dir, `/uploads/videos/${file}`,
                    msg.fromMe ? "manual" : "user", msgTs, waMsgId);
                  mediaSyncStatus.saved++;
                }
              }
            } catch { mediaSyncStatus.errors++; }
          }
        } catch { mediaSyncStatus.errors++; }

        mediaSyncStatus.done++;
      }
    } catch (err) {
      mediaSyncStatus.errors++;
      console.error("wa-sync-media error:", err.message);
    } finally {
      mediaSyncStatus.running = false;
      mediaSyncStatus.currentChat = "";
    }
  })();
});

app.get("/api/wa-sync-status", (_req, res) => {
  res.json(mediaSyncStatus);
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
    const waMsgs = await waChat.fetchMessages({ limit: parseInt(limit) });

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

// Dashboard HTML
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
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

console.log(`🚀 تشغيل بوت واتساب IA (${AI_PROVIDER}) — 3 أرقام...`);
// تشغيل البوتات بتأخير 40 ثانية بين كل واحد — يمنع تعارض Chrome instances
BOT_IDS.forEach((id, i) => {
  if (i === 0) { setupClient(id); return; }
  setTimeout(() => {
    console.log(`\n⏱️  [${id}] بدء التشغيل (تأخير ${i * 40}ث)...`);
    setupClient(id);
  }, i * 40000);
});
