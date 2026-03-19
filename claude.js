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

async function generateResponse(contactId, contactName, userMessage) {
  if (!conversationHistory.has(contactId)) {
    conversationHistory.set(contactId, []);
  }

  const history = conversationHistory.get(contactId);
  history.push({ role: "user", content: userMessage });

  if (history.length > 20) {
    history.splice(0, history.length - 20);
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

  try {
    const completion = await client.chat.completions.create({
      model: getModel(),
      max_tokens: 500,
      messages: [
        { role: "system", content: systemPrompt },
        ...history,
      ],
    });

    const assistantMessage = completion.choices[0].message.content;
    history.push({ role: "assistant", content: assistantMessage });
    return assistantMessage;

  } catch (error) {
    const provider = AI_PROVIDER === "openai" ? "OpenAI" : "Groq";
    console.error(`Erreur API ${provider}:`, error.message);

    if (error.status === 401) throw new Error(`Clé API ${provider} invalide`);
    if (error.status === 429) throw new Error(`Limite ${provider} dépassée`);
    if (error.status === 402 || error.code === "insufficient_quota") {
      throw new Error(`Crédit ${provider} insuffisant — rechargez votre compte`);
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
