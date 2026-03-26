const axios = require("axios");
const { generateResponse } = require("./claude");
const { findCustomResponse } = require("./customResponses");
const { saveMessengerContact, saveMessengerMessage } = require("./messenger");

let _io = null;
function setIo(io) { _io = io; }
function emitMsg(fbId, msg) { if (_io) _io.to(`msng:${fbId}`).emit("new_messenger_msg", msg); }

const PAGE_ACCESS_TOKEN = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.FACEBOOK_VERIFY_TOKEN || "my_verify_token";

/**
 * التحقق من webhook عند ربطه بـ Meta
 */
function verifyWebhook(req, res) {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Facebook Webhook vérifié !");
    res.status(200).send(challenge);
  } else {
    console.error("❌ Verify token incorrect !");
    res.sendStatus(403);
  }
}

/**
 * معالجة الرسائل الواردة من Facebook
 */
async function handleWebhook(req, res) {
  const body = req.body;

  if (body.object !== "page") {
    return res.sendStatus(404);
  }

  // إجابة فورية لـ Meta (خلال 5 ثواني)
  res.status(200).send("EVENT_RECEIVED");

  for (const entry of body.entry) {

    // ── Messenger (رسائل خاصة) ─────────────────────────
    const events = entry.messaging || [];
    for (const event of events) {
      if (event.message?.is_echo) continue;
      if (!event.message?.text) continue;

      const senderId   = event.sender.id;
      const messageText = event.message.text.trim();
      console.log(`\n📘 [Messenger] رسالة من ${senderId}: ${messageText}`);

      try {
        const userName = await getUserName(senderId);
        await saveMessengerContact(senderId, userName, messageText, "in");
        await saveMessengerMessage(senderId, userName, "in", messageText);
        emitMsg(senderId, { fb_id: senderId, direction: "in", body: messageText, name: userName, created_at: new Date().toISOString() });

        await sendTyping(senderId);
        const { text: customText } = findCustomResponse(messageText);
        let response = customText;
        let source   = "📋 مبرمج";

        if (!response) {
          response = await generateResponse(`fb_${senderId}`, userName, messageText);
          source   = "🤖 IA";
        }

        await sendMessage(senderId, response);
        await saveMessengerContact(senderId, userName, response, "out");
        await saveMessengerMessage(senderId, userName, "out", response);
        console.log(`✅ [Messenger][${source}] → ${senderId}: ${response.substring(0, 60)}...`);
      } catch (error) {
        console.error(`❌ [Messenger] خطأ:`, error.message);
      }
    }

    // ── تعليقات المنشورات ──────────────────────────────
    const changes = entry.changes || [];
    for (const change of changes) {
      const v = change.value;
      // فقط تعليقات جديدة (مش تعديل أو حذف، ومش تعليقاتنا)
      if (change.field !== "feed")         continue;
      if (v.item !== "comment")            continue;
      if (v.verb !== "add")                continue;
      if (v.from?.id === entry.id)         continue; // تعليق الصفحة نفسها

      const commentId   = v.comment_id;
      const commentText = v.message?.trim();
      const userName    = v.from?.name || "صاحبي";

      if (!commentText) continue;
      console.log(`\n💬 [تعليق] ${userName}: ${commentText}`);

      try {
        const { text: customText } = findCustomResponse(commentText);
        let response = customText;
        let source   = "📋 مبرمج";

        if (!response) {
          response = await generateResponse(`comment_${commentId}`, userName, commentText);
          source   = "🤖 IA";
        }

        await replyToComment(commentId, response);
        console.log(`✅ [تعليق][${source}] → ${userName}: ${response.substring(0, 60)}...`);
      } catch (error) {
        console.error(`❌ [تعليق] خطأ:`, error.message);
      }
    }

  }
}

/**
 * إرسال رسالة عبر Messenger API
 */
async function sendMessage(recipientId, text) {
  await axios.post(
    `https://graph.facebook.com/v19.0/me/messages`,
    {
      recipient: { id: recipientId },
      message: { text },
      messaging_type: "RESPONSE",
    },
    {
      params: { access_token: PAGE_ACCESS_TOKEN },
    }
  );
}

/**
 * إرسال مؤشر "جاري الكتابة"
 */
async function sendTyping(recipientId) {
  await axios.post(
    `https://graph.facebook.com/v19.0/me/messages`,
    {
      recipient: { id: recipientId },
      sender_action: "typing_on",
    },
    {
      params: { access_token: PAGE_ACCESS_TOKEN },
    }
  ).catch(() => {}); // تجاهل الأخطاء هنا
}

/**
 * جلب اسم المستخدم من Facebook
 */
async function getUserName(userId) {
  try {
    const res = await axios.get(
      `https://graph.facebook.com/v19.0/${userId}`,
      { params: { access_token: PAGE_ACCESS_TOKEN, fields: "name" } }
    );
    return res.data.name || "صاحبي";
  } catch {
    return "صاحبي";
  }
}

/**
 * الرد على تعليق في منشور
 */
async function replyToComment(commentId, text) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${commentId}/comments`,
    { message: text },
    { params: { access_token: PAGE_ACCESS_TOKEN } }
  );
}

module.exports = { verifyWebhook, handleWebhook, setIo };
