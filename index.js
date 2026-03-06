require("dotenv").config();
const crypto = require("crypto");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const express = require("express");
const { clearHistory, generateResponse } = require("./claude");
const { findCustomResponse } = require("./customResponses");
const { verifyWebhook, handleWebhook } = require("./facebook");
const { registerContact, getStats, getAllContacts } = require("./contacts");
const { saveMessage, getMessages, getMessageStats } = require("./messages");
const { saveImage, getImages, getImageStats }         = require("./images");
const { saveVoice, getVoices, getVoiceStats, deleteVoice, updateVoiceNote } = require("./voices");
const { saveVideo, getVideos, getVideoStats, deleteVideo, updateVideoNote } = require("./videos");

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
let botPaused = false;
let botPhone   = process.env.CONTACT_PHONE || "";
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

// ─── عميل WhatsApp ────────────────────────────────────────────────────────

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: "./session" }),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox", "--disable-setuid-sandbox",
      "--disable-dev-shm-usage", "--disable-gpu",
      "--no-first-run", "--no-zygote", "--single-process",
    ],
  },
});

// ─── أحداث WhatsApp ───────────────────────────────────────────────────────

client.on("qr", (qr) => {
  console.log("\n📱 اسكان QR code بالواتساب:\n");
  qrcode.generate(qr, { small: true });
  console.log("\n⏳ في انتظار السكان...\n");
});

client.on("loading_screen", (percent, msg) => {
  process.stdout.write(`\r⏳ تحميل: ${percent}% — ${msg}   `);
});

client.on("authenticated", () => {
  console.log("\n✅ تم التوثيق!");
});

client.on("auth_failure", (msg) => {
  console.error("\n❌ فشل التوثيق:", msg);
  console.error("   احذف مجلد 'session' وأعد التشغيل.");
});

client.on("ready", async () => {
  if (!botPhone) botPhone = client.info.wid.user;

  const model = AI_PROVIDER === "openai"
    ? (process.env.OPENAI_MODEL || "gpt-4o-mini")
    : (process.env.GROQ_MODEL  || "llama-3.3-70b-versatile");

  console.log("\n🤖 بوت واتساب IA شغال!");
  console.log("━".repeat(40));
  console.log(`📞 رقم البوت:       +${botPhone}`);
  console.log(`🧠 موديل IA:        ${model} (${AI_PROVIDER})`);
  console.log(`📡 رسائل خاصة:      ${config.respondToPrivate ? "✅" : "❌"}`);
  console.log(`👥 مجموعات:         ${config.respondToGroups  ? "✅" : "❌"}`);
  console.log("━".repeat(40));
  console.log(`\n💡 أوامر (من حسابك في واتساب):`);
  console.log(`   ${config.pauseKeyword}  — إيقاف البوت مؤقتاً`);
  console.log(`   ${config.resumeKeyword} — استئناف البوت`);
  console.log(`   !clear    — مسح سجل المحادثة`);
  console.log(`   !status   — حالة البوت`);
  console.log(`   !contacts — قائمة الزبائن`);
  const stats = await getStats();
  console.log(`\n📋 الزبائن المسجلين: ${stats.total} | اليوم: ${stats.today}`);
  console.log("\n🟢 في انتظار الرسائل...\n");
});

client.on("disconnected", (reason) => {
  console.log("\n🔴 انقطع الاتصال:", reason);
});

// ─── معالجة الرسائل ───────────────────────────────────────────────────────

client.on("message", async (message) => {
  try {
    // تجاهل الرسائل القديمة (قبل بدء البوت) — يمنع إعادة المعالجة عند إعادة التشغيل
    if (message.timestamp < BOT_START_TIME) return;

    const chat      = await message.getChat();
    const contact   = await message.getContact();
    const contactId = contact.id._serialized;
    const name      = contact.pushname || contact.name || "صاحبي";
    const body      = (message.body || "").trim();

    if (message.fromMe) {
      await handleAdminCommand(body, chat, contactId);
      return;
    }

    // فلترة
    const senderNumber = contactId.replace("@c.us", "");
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
        await saveImage(senderNumber, name, media);
        await saveMessage(senderNumber, name, "in", "📷 صورة", "user");
        const imgReply = "📸 وصلتنا صورتك، شكرا! إذا عندك أي سؤال على الشقق كلمنا على 0680040002 😊";
        await message.reply(imgReply);
        await saveMessage(senderNumber, "البوت", "out", imgReply, "default");
        return;
      }

      // رسالة صوتية أو ملف صوتي
      if ((media.mimetype && media.mimetype.startsWith("audio/")) || message.type === "ptt") {
        await registerContact(senderNumber, name, "🎤 رسالة صوتية");
        const voiceFile = await saveVoice(senderNumber, name, media);
        const voiceUrl  = voiceFile ? `/uploads/voices/${voiceFile}` : "🎤 رسالة صوتية";
        await saveMessage(senderNumber, name, "in", voiceUrl, "user");
        const audioReply = "🎤 وصلتنا رسالتك الصوتية! إذا عندك سؤال على الشقق كلمنا على 0680040002 😊";
        await message.reply(audioReply);
        await saveMessage(senderNumber, "البوت", "out", audioReply, "default");
        return;
      }

      // فيديو
      if ((media.mimetype && media.mimetype.startsWith("video/")) || message.type === "video") {
        await registerContact(senderNumber, name, "🎬 فيديو");
        const videoFile = await saveVideo(senderNumber, name, media);
        const videoUrl  = videoFile ? `/uploads/videos/${videoFile}` : "🎬 فيديو";
        await saveMessage(senderNumber, name, "in", videoUrl, "user");
        const videoReply = "🎬 وصلنا الفيديو ديالك، شكرا! إذا عندك سؤال على الشقق كلمنا على 0680040002 😊";
        await message.reply(videoReply);
        await saveMessage(senderNumber, "البوت", "out", videoReply, "default");
        return;
      }

      return;
    }

    if (!body) return;

    // تسجيل الزبون
    await registerContact(senderNumber, name, body);

    // السؤال المكرر — تجاهل بدون رد
    if (isDuplicate(contactId, body)) {
      console.log(`🔁 مكرر من ${name} — تجاهل`);
      return;
    }

    console.log(`\n📩 ${name} (${senderNumber}): ${body}`);

    await chat.sendStateTyping();
    await sleep(Math.random() * (config.delayMax - config.delayMin) + config.delayMin);

    // أولاً: الأجوبة المبرمجة
    const { text: customText, voiceFile, defaultText } = findCustomResponse(body);
    let source = "custom";

    await chat.clearState();

    // حفظ الرسالة الواردة
    await saveMessage(senderNumber, name, "in", body, "user");

    let botReply = "";
    if (voiceFile) {
      const media = MessageMedia.fromFilePath(voiceFile);
      await message.reply(media, null, { sendAudioAsVoice: true });
      botReply = customText || "🎤 رسالة صوتية";
      if (customText) await message.reply(customText);
      console.log(`✅ [🎤 صوت] → ${name}`);
    } else if (customText) {
      await message.reply(customText);
      botReply = customText;
      console.log(`✅ [مبرمج] → ${name}: ${customText.substring(0, 70)}...`);
    } else {
      // رد افتراضي — بدون ذكاء اصطناعي
      await message.reply(defaultText);
      botReply = defaultText;
      source = "default";
      console.log(`↩️  [افتراضي] → ${name}: ${defaultText.substring(0, 70)}...`);
    }

    // حفظ رد البوت
    await saveMessage(senderNumber, name, "out", botReply, source);

  } catch (err) {
    console.error("\n❌ خطأ:", err.message);
  }
});

// ─── Utilitaires ──────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── أوامر المدير ─────────────────────────────────────────────────────────

async function handleAdminCommand(body, chat, contactId) {
  const cmd = body.toLowerCase().trim();

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

// ─── Express Server (Dashboard + Webhook) ─────────────────────────────────

const app  = express();
const path = require("path");
app.use(express.json());

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
  const pub = ["/login.html", "/api/login", "/webhook"];
  if (pub.some(p => req.path === p || req.path.startsWith("/webhook"))) return next();
  const cookies = parseCookies(req.headers.cookie);
  if (validTokens.has(cookies.auth_token)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "غير مصرح" });
  res.redirect("/login.html");
}

app.use(requireAuth);
app.use(express.static(path.join(__dirname, "public")));

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

// Facebook Webhook
if (process.env.FACEBOOK_PAGE_ACCESS_TOKEN) {
  app.get("/webhook", verifyWebhook);
  app.post("/webhook", handleWebhook);
}

// ── Dashboard API ──────────────────────────────────────────────────────────

app.get("/api/stats", async (req, res) => {
  const stats = await getStats();
  res.json({ ...stats, botPaused });
});

app.get("/api/contacts", async (req, res) => {
  const list = await getAllContacts();
  res.json(list);
});

app.post("/api/send", async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: "phone و message مطلوبين" });
  try {
    const chatId = phone.replace(/\D/g, "") + "@c.us";
    await client.sendMessage(chatId, message);
    await saveMessage(phone.replace(/\D/g, ""), "سمير", "out", message, "manual");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/send-voice", async (req, res) => {
  const { phone, data, mimetype } = req.body;
  if (!phone || !data || !mimetype) return res.status(400).json({ error: "phone, data و mimetype مطلوبين" });
  try {
    const senderNum = phone.replace(/\D/g, "");
    const chatId    = senderNum + "@c.us";
    const mimeBase  = (mimetype || "audio/ogg").split(";")[0].trim();
    const ext       = mimeBase.split("/")[1] || "ogg";
    const filename  = `${Date.now()}_${senderNum}.${ext}`;
    const uploadDir = path.join(__dirname, "public", "uploads", "voices");
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    fs.writeFileSync(path.join(uploadDir, filename), Buffer.from(data, "base64"));
    const fileUrl = `/uploads/voices/${filename}`;
    const media   = new MessageMedia(mimeBase, data, filename);
    await client.sendMessage(chatId, media, { sendAudioAsVoice: true });
    await saveMessage(senderNum, "سمير", "out", fileUrl, "manual");
    res.json({ ok: true, url: fileUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/send-media", async (req, res) => {
  const { phone, data, mimetype, ext, filename: origName } = req.body;
  if (!phone || !data || !mimetype) return res.status(400).json({ error: "phone, data و mimetype مطلوبين" });
  try {
    const senderNum = phone.replace(/\D/g, "");
    const chatId    = senderNum + "@c.us";
    const isImage   = mimetype.startsWith("image/");
    const isVideo   = mimetype.startsWith("video/");
    const isAudio   = mimetype.startsWith("audio/");
    const safeExt   = ext || mimetype.split("/")[1]?.split(";")[0] || "bin";
    const filename  = `${Date.now()}_${senderNum}.${safeExt}`;

    // تحديد مجلد الحفظ
    const subDir   = isImage ? "images" : isVideo ? "videos" : "files";
    const uploadDir = path.join(__dirname, "public", "uploads", subDir);
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    fs.writeFileSync(path.join(uploadDir, filename), Buffer.from(data, "base64"));
    const fileUrl = `/uploads/${subDir}/${filename}`;

    // إرسال عبر واتساب
    const media = new MessageMedia(mimetype, data, origName || filename);
    const opts  = isAudio ? { sendAudioAsVoice: false }
                : (!isImage && !isVideo) ? { sendMediaAsDocument: true }
                : {};
    await client.sendMessage(chatId, media, opts);

    // حفظ في قاعدة البيانات (الصور والفيديوهات بالـ URL، الملفات بالاسم)
    const msgBody = (isImage || isVideo) ? fileUrl : `📎 ${origName || filename}`;
    await saveMessage(senderNum, "سمير", "out", msgBody, "manual");

    res.json({ ok: true, url: fileUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/pause", (req, res) => {
  botPaused = true;
  res.json({ ok: true, botPaused });
});

app.post("/api/resume", (req, res) => {
  botPaused = false;
  pausedChats.clear();
  res.json({ ok: true, botPaused });
});

app.get("/api/messages", async (req, res) => {
  const { phone, limit = 100, offset = 0 } = req.query;
  const list = await getMessages({ phone, limit: parseInt(limit), offset: parseInt(offset) });
  res.json(list);
});

app.get("/api/messages/stats", async (req, res) => {
  const stats = await getMessageStats();
  res.json(stats);
});

// ── CRUD الردود المبرمجة ───────────────────────────────────────────────────
const RESPONSES_FILE = path.join(__dirname, "responses.json");

app.get("/api/responses", (req, res) => {
  try {
    const data = JSON.parse(require("fs").readFileSync(RESPONSES_FILE, "utf8"));
    res.json(data.responses || []);
  } catch { res.json([]); }
});

app.post("/api/responses", (req, res) => {
  try {
    const { keywords, reply, voice } = req.body;
    if (!keywords || !reply) return res.status(400).json({ error: "keywords و reply مطلوبين" });
    const data = JSON.parse(require("fs").readFileSync(RESPONSES_FILE, "utf8"));
    const kws = keywords.split(",").map(k => k.trim()).filter(Boolean);
    const entry = { keywords: kws, reply };
    if (voice) entry.voice = voice;
    data.responses.push(entry);
    require("fs").writeFileSync(RESPONSES_FILE, JSON.stringify(data, null, 2), "utf8");
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/responses/:index", (req, res) => {
  try {
    const idx  = parseInt(req.params.index);
    const data = JSON.parse(require("fs").readFileSync(RESPONSES_FILE, "utf8"));
    if (idx < 0 || idx >= data.responses.length) return res.status(404).json({ error: "غير موجود" });
    data.responses.splice(idx, 1);
    require("fs").writeFileSync(RESPONSES_FILE, JSON.stringify(data, null, 2), "utf8");
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── الصور المستلمة ─────────────────────────────────────────────────────────

app.get("/api/images", async (req, res) => {
  const { phone, limit = 50, offset = 0 } = req.query;
  const list = await getImages({ phone, limit: parseInt(limit), offset: parseInt(offset) });
  res.json(list);
});

app.get("/api/images/stats", async (req, res) => {
  const stats = await getImageStats();
  res.json(stats);
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

// Dashboard HTML
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🖥️  Dashboard: http://localhost:${PORT}`);
  if (process.env.FACEBOOK_PAGE_ACCESS_TOKEN) {
    console.log(`📘 Facebook Webhook: http://localhost:${PORT}/webhook`);
  }
});

// ─── أخطاء عامة ───────────────────────────────────────────────────────────

process.on("unhandledRejection", (reason) => {
  console.error("\n⚠️  خطأ غير متوقع:", reason);
});

process.on("SIGINT", async () => {
  console.log("\n\n🛑 إيقاف البوت...");
  await client.destroy();
  process.exit(0);
});

// ─── تشغيل ────────────────────────────────────────────────────────────────

console.log(`🚀 تشغيل بوت واتساب IA (${AI_PROVIDER})...`);
client.initialize();
