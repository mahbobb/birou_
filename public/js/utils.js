// ── Avatar colors ─────────────────────────────────────────────────────────
const AVATAR_COLORS = [
  "#ab47bc","#7e57c2","#5c6bc0","#42a5f5","#26c6da",
  "#26a69a","#66bb6a","#ffa726","#ff7043","#ef5350",
  "#ec407a","#8d6e63","#78909c","#00acc1","#43a047",
];

function avatarColor(str) {
  let h = 0;
  for (let i = 0; i < (str || "").length; i++) h = (h * 31 + str.charCodeAt(i)) & 0xffff;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

// ── Clean JID / phone ────────────────────────────────────────────────────
function cleanPhone(jid){
  if(!jid) return ""
  jid = jid.toString()
  if(jid.includes("@")) jid = jid.split("@")[0]
  return jid.replace(/\D/g,"")
}

// ── Phone normalization ───────────────────────────────────────────────────

// مفتاح 9 أرقام لمطابقة الجهات والـsocket
function normalizeKey(phone) {
  let p = String(phone || "").replace(/\D/g, "");
  if (p.startsWith("00")) p = p.slice(2);
  return p.length > 9 ? p.slice(-9) : p;
}

// إعادة بناء الرقم الدولي الكامل (للإرسال)
function normalizeOutPhone(raw) {
  let p = String(raw || "").replace(/\D/g, "");
  if (p.startsWith("00")) p = p.slice(2);
  if (p.startsWith("0") && p.length === 10) p = "212" + p.slice(1); // 06/07 مغربي
  if (p.length === 9 && /^[5-7]/.test(p))   p = "212" + p;          // 9 أرقام بدون رمز بلد
  return p;
}

// ── Time formatting ───────────────────────────────────────────────────────
function formatTime(dateStr) {
  const d    = new Date(dateStr);
  const now  = new Date();
  const diff = (now - d) / 1000;
  if (isNaN(diff) || diff < 0) return "";
  if (diff < 60)     return "الآن";
  if (diff < 3600)   return `${Math.floor(diff / 60)}د`;
  if (diff < 86400)  return d.toLocaleTimeString("ar-MA", { hour: "2-digit", minute: "2-digit" });
  if (diff < 604800) return d.toLocaleDateString("ar-MA", { weekday: "short" });
  return d.toLocaleDateString("ar-MA", { day: "numeric", month: "short" });
}

function friendlyDate(dateStr) {
  const d       = new Date(dateStr);
  const now     = new Date();
  const diffDays = Math.floor((now - d) / 86400000);
  if (diffDays === 0) return "اليوم";
  if (diffDays === 1) return "أمس";
  return d.toLocaleDateString("ar-MA", { day: "numeric", month: "long", year: "numeric" });
}

// ── HTML escaping ─────────────────────────────────────────────────────────
function escHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Toast notification ────────────────────────────────────────────────────
function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 3000);
}

// ── Message preview text ──────────────────────────────────────────────────
function previewText(body) {
  if ((body || "").startsWith("/uploads/images/")) return "📷 صورة";
  if ((body || "").startsWith("/uploads/videos/")) return "🎬 فيديو";
  if ((body || "").startsWith("/uploads/voices/")) return "🎤 رسالة صوتية";
  return (body || "").substring(0, 42);
}

// ── Format message count (1200 → 1.2k) ───────────────────────────────────
function formatCount(n) {
  n = parseInt(n) || 0;
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return n;
}

// ── Source label ──────────────────────────────────────────────────────────
function srcLabel(s) {
  return s === "ai"      ? "ذكاء"
       : s === "custom"  ? "مبرمج"
       : s === "default" ? "افتراضي"
       : s;
}

// ── File icon ─────────────────────────────────────────────────────────────
function fileIcon(mime) {
  if (mime.startsWith("image/"))  return "🖼️";
  if (mime.startsWith("video/"))  return "🎬";
  if (mime.startsWith("audio/"))  return "🎵";
  if (mime.includes("pdf"))       return "📄";
  if (mime.includes("word") || mime.includes("document")) return "📝";
  if (mime.includes("excel") || mime.includes("spreadsheet")) return "📊";
  if (mime.includes("zip") || mime.includes("rar")) return "🗜️";
  return "📎";
}
