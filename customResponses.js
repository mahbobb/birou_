const fs   = require("fs");
const path = require("path");

const RESPONSES_FILE = path.join(__dirname, "responses.json");
const VOICE_DIR      = path.join(__dirname, "voice");

function loadResponses() {
  try {
    const data = fs.readFileSync(RESPONSES_FILE, "utf8");
    return JSON.parse(data).responses || [];
  } catch (error) {
    console.error("⚠️  خطأ في تحميل responses.json:", error.message);
    return [];
  }
}

/**
 * البحث عن جواب مبرمج يطابق الرسالة
 * @returns {{ text: string|null, voiceFile: string|null }}
 */
function loadDefaultReply() {
  try {
    const data = fs.readFileSync(RESPONSES_FILE, "utf8");
    return JSON.parse(data).defaultReply ||
      "شكرا على تواصلك 😊 لأي سؤال كلمنا: 0680040002\nabrajeimmo.com";
  } catch {
    return "شكرا على تواصلك 😊 لأي سؤال كلمنا: 0680040002";
  }
}

function findCustomResponse(message) {
  const responses    = loadResponses();
  const defaultText  = loadDefaultReply();
  const messageLower = message.toLowerCase().trim();

  for (const item of responses) {
    // shortOnly: فقط للرسائل القصيرة (تحيات، شكرا) — تجاهل إذا الرسالة طويلة
    if (item.shortOnly && messageLower.length > 40) continue;

    const matched = item.keywords.some((kw) =>
      messageLower.includes(kw.toLowerCase())
    );

    if (matched) {
      // نص الرد
      let text = null;
      if (item.reply) {
        text = Array.isArray(item.reply)
          ? item.reply[Math.floor(Math.random() * item.reply.length)]
          : item.reply;
      }

      // ملف صوتي (اختياري)
      let voiceFile = null;
      if (item.voice) {
        const filePath = path.join(VOICE_DIR, item.voice);
        if (fs.existsSync(filePath)) {
          voiceFile = filePath;
        } else {
          console.warn(`⚠️  ملف الصوت مش موجود: ${filePath}`);
        }
      }

      // معلومات للتسجيل
      const matchedKw     = item.keywords.find(kw => messageLower.includes(kw.toLowerCase())) || "";
      const keywordsLabel = (item.keywords || []).slice(0, 4).join(", ");

      return { text, voiceFile, defaultText, matchedKw, keywordsLabel };
    }
  }

  return { text: null, voiceFile: null, defaultText, matchedKw: null, keywordsLabel: null };
}

module.exports = { findCustomResponse };
