const Groq = require("groq-sdk");
const OpenAI = require("openai");

// اختيار الـ AI بناء على المتغيرات
const AI_PROVIDER = process.env.AI_PROVIDER || "groq"; // "groq" أو "openai"

let client;

if (AI_PROVIDER === "openai" && process.env.OPENAI_API_KEY) {
  client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  console.log("🤖 IA: ChatGPT (OpenAI)");
} else {
  client = new Groq({ apiKey: process.env.GROQ_API_KEY });
  console.log("🤖 IA: Groq (LLaMA)");
}

// الحصول على اسم الموديل حسب المزود
function getModel() {
  if (AI_PROVIDER === "openai") {
    return process.env.OPENAI_MODEL || "gpt-4o-mini";
  }
  return process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
}

// Historique des conversations par contact
const conversationHistory = new Map();

const AI_TIMEOUT_MS = 12000; // 12 ثانية — الحد الأقصى لانتظار الـ AI

async function callAI(messages) {
  const apiCall = client.chat.completions.create({
    model:      getModel(),
    max_tokens: 250,
    temperature: 0.7,
    messages,
  });
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("AI_TIMEOUT")), AI_TIMEOUT_MS)
  );
  return Promise.race([apiCall, timeout]);
}

async function generateResponse(contactId, contactName, userMessage) {
  if (!conversationHistory.has(contactId)) {
    conversationHistory.set(contactId, []);
  }

  const history = conversationHistory.get(contactId);
  history.push({ role: "user", content: userMessage });

  // احتفظ فقط بآخر 8 رسائل (4 تبادلات) — سرعة أفضل وتكلفة أقل
  if (history.length > 8) {
    history.splice(0, history.length - 8);
  }

  const systemPrompt = `${process.env.BOT_PERSONALITY || "نت مساعد لكراء الشقق ديال أبراج إيمو بمراكش."}

كتجاوب على رسائل ${contactName || "واحد"} فالواتساب.

معلومات الأثمنة (مهم جداً):
- الأثمنة تبدا من 400 درهم لليلة
- علال الفاسي: 400–500 درهم/ليلة
- باب دكالة: 500–600 درهم/ليلة
- الحد الأدنى هو 400 درهم، مكاينش أرخص من هذا

RÈGLES ABSOLUES:
- الدارجة المغربية فقط، جملة واحدة قصيرة
- جاوب فقط على أسئلة الشقق والكراء والأثمنة والتواريخ
- إذا سألو على التمن: قول "الأثمنة تبدا من 400 درهم حسب الشقة والتاريخ"
- إذا السؤال خارج موضوع الكراء: قول "هذا خارج اختصاصي، تواصل معنا على 0680040002"
- JAMAIS "vous", JAMAIS répéter la question`;

  const provider = AI_PROVIDER === "openai" ? "OpenAI" : "Groq";

  try {
    const completion = await callAI([
      { role: "system", content: systemPrompt },
      ...history,
    ]);

    const assistantMessage = completion.choices[0].message.content;
    history.push({ role: "assistant", content: assistantMessage });
    return assistantMessage;

  } catch (error) {
    // عند timeout — retry مرة واحدة بتاريخ مختصر (آخر رسالة فقط)
    if (error.message === "AI_TIMEOUT") {
      console.warn(`⏱️  AI timeout — retry بتاريخ مختصر`);
      try {
        const completion = await callAI([
          { role: "system", content: systemPrompt },
          { role: "user",   content: userMessage },
        ]);
        const assistantMessage = completion.choices[0].message.content;
        history.push({ role: "assistant", content: assistantMessage });
        return assistantMessage;
      } catch (retryErr) {
        throw new Error(`AI_TIMEOUT:فشل الاتصال بـ ${provider}`);
      }
    }

    console.error(`Erreur API ${provider}:`, error.message);
    if (error.status === 401) throw new Error(`CREDIT_LOW:Clé API ${provider} invalide`);
    if (error.status === 429) throw new Error(`RATE_LIMIT:Limite ${provider} dépassée`);
    if (error.status === 402 || error.code === "insufficient_quota" ||
        (error.message && error.message.toLowerCase().includes("credit"))) {
      throw new Error(`CREDIT_LOW:Crédit ${provider} insuffisant`);
    }
    throw new Error(`Erreur ${provider}: ${error.message}`);
  }
}

function clearHistory(contactId) {
  conversationHistory.delete(contactId);
}

function clearAllHistory() {
  conversationHistory.clear();
}

function getHistoryLength(contactId) {
  return conversationHistory.get(contactId)?.length || 0;
}

module.exports = {
  generateResponse,
  clearHistory,
  clearAllHistory,
  getHistoryLength,
};
