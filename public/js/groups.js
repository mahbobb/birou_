'use strict';

let allGroups   = [];
let sendGroupId = null;
let sendBotId   = null;
let chatGroupId = null;
let chatBotId   = null;

/* ── Load ── */
async function load() {
  document.getElementById("groupsWrap").innerHTML = '<div class="empty">⏳ جاري التحميل...</div>';
  try {
    const [groups, status] = await Promise.all([
      fetch("/api/wa-groups").then(r => r.json()),
      fetch("/api/groups-status").then(r => r.json()),
    ]);
    allGroups = groups;
    updateBotStatusUI(status.respondToGroups, status.mentionOnly);
    document.getElementById("sTotal").textContent   = groups.length;
    document.getElementById("sMembers").textContent = groups.reduce((s, g) => s + (g.participants || 0), 0);
    render(groups);
  } catch { showToast("❌ خطأ في التحميل"); }
}

/* ── Render ── */
function render(list) {
  const wrap = document.getElementById("groupsWrap");
  if (!list.length) {
    wrap.innerHTML = '<div class="empty">لا توجد مجموعات متصلة 📭<br><small>تأكد أن البوت متصل وفيه مجموعات</small></div>';
    return;
  }
  wrap.innerHTML = list.map(g => {
    const initial = (g.name || "?")[0].toUpperCase();
    const time    = g.lastSeen ? new Date(g.lastSeen).toLocaleString("ar-MA") : "—";
    return `
      <div class="group-card">
        <div class="group-avatar">${initial}</div>
        <div class="group-info">
          <div class="group-name" title="${escHtml(g.name)}">${escHtml(g.name)}</div>
          <div class="group-meta">
            <span class="badge">👤 ${g.participants} عضو</span>
            <span class="bot-tag">🤖 ${g.botId}</span>
            <span>${time}</span>
          </div>
          ${g.lastMessage ? `<div class="group-last">💬 ${escHtml(g.lastMessage)}</div>` : ""}
        </div>
        <div class="group-actions">
          <button class="action-btn ab-view" onclick="openChat('${escHtml(g.id)}','${escHtml(g.name)}','${g.botId}')">💬 الرسائل</button>
          <button class="action-btn ab-send" onclick="openSend('${escHtml(g.id)}','${escHtml(g.name)}','${g.botId}')">📤 إرسال</button>
        </div>
      </div>`;
  }).join("");
}

/* ── Search ── */
document.getElementById("searchGroup").addEventListener("input", function() {
  const q = this.value.trim().toLowerCase();
  render(q ? allGroups.filter(g => g.name.toLowerCase().includes(q)) : allGroups);
});

/* ── Toggle bot in groups ── */
async function toggleBotGroups(opts) {
  try {
    const d = await fetch("/api/groups-toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    }).then(r => r.json());
    updateBotStatusUI(d.respondToGroups, d.mentionOnly);
  } catch { showToast("❌ خطأ"); }
}

function updateBotStatusUI(enabled, mentionOnly) {
  document.getElementById("toggleBot").checked     = enabled;
  document.getElementById("toggleMention").checked = mentionOnly;
  const mWrap = document.getElementById("mentionWrap");
  mWrap.style.opacity       = enabled ? "1" : ".5";
  mWrap.style.pointerEvents = enabled ? "auto" : "none";
  document.getElementById("sBotStatus").textContent = !enabled ? "❌ معطّل" : (mentionOnly ? "@ إشارة فقط" : "✅ يرد للكل");
}

/* ── Broadcast ── */
let _bcGrpImg = null, _bcGrpMime = null;

function previewGrpImg(input) {
  const file = input.files[0]; if (!file) return;
  const img = new Image(); const url = URL.createObjectURL(file);
  img.onload = () => {
    const MAX = 1200; let w = img.width, h = img.height;
    if (w > MAX) { h = Math.round(h * MAX / w); w = MAX; }
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    c.getContext("2d").drawImage(img, 0, 0, w, h);
    _bcGrpImg = c.toDataURL("image/jpeg", 0.8); _bcGrpMime = "image/jpeg";
    URL.revokeObjectURL(url);
    document.getElementById("bcGrpImgPreview").src              = _bcGrpImg;
    document.getElementById("bcGrpImgPreview").style.display    = "block";
    document.getElementById("bcGrpImgPlaceholder").style.display = "none";
    document.getElementById("bcGrpImgRemove").style.display     = "block";
    document.getElementById("bcGrpImgArea").style.borderColor   = "var(--green)";
  }; img.src = url;
}

function removeGrpImg(e) {
  e.stopPropagation(); _bcGrpImg = null; _bcGrpMime = null;
  document.getElementById("bcGrpImgInput").value                = "";
  document.getElementById("bcGrpImgPreview").style.display      = "none";
  document.getElementById("bcGrpImgPlaceholder").style.display  = "block";
  document.getElementById("bcGrpImgRemove").style.display       = "none";
  document.getElementById("bcGrpImgArea").style.borderColor     = "";
}

function openBroadcast() {
  _bcGrpImg = null; _bcGrpMime = null;
  document.getElementById("bcGrpMsg").value             = "";
  document.getElementById("bcGrpDry").checked           = false;
  document.getElementById("bcGrpSpinner").style.display = "none";
  document.getElementById("bcGrpResult").style.display  = "none";
  document.getElementById("bcGrpSummary").style.display = "none";
  document.getElementById("bcGrpStopBtn").style.display = "none";
  document.getElementById("bcGrpSendBtn").disabled      = false;
  removeGrpImg({ stopPropagation: () => {} });
  document.getElementById("broadcastOverlay").classList.add("open");
}
function closeBroadcast() { document.getElementById("broadcastOverlay").classList.remove("open"); }

document.getElementById("broadcastOverlay").addEventListener("click", e => {
  if (e.target === document.getElementById("broadcastOverlay")) closeBroadcast();
});

async function stopGrpBroadcast() {
  document.getElementById("bcGrpStopBtn").disabled = true;
  await fetch("/api/broadcast-groups/stop", { method: "POST" });
}

async function runGrpBroadcast() {
  const msg    = document.getElementById("bcGrpMsg").value.trim();
  const dryRun = document.getElementById("bcGrpDry").checked;
  if (!msg && !_bcGrpImg) return showToast("⚠️ اكتب رسالة أو أضف صورة");

  const sendBtn = document.getElementById("bcGrpSendBtn");
  const stopBtn = document.getElementById("bcGrpStopBtn");
  sendBtn.disabled = true; stopBtn.style.display = "inline-flex"; stopBtn.disabled = false;
  document.getElementById("bcGrpSpinner").style.display = "block";
  document.getElementById("bcGrpResult").style.display  = "none";
  document.getElementById("bcGrpSummary").style.display = "none";

  const payload = { message: msg, dryRun };
  if (_bcGrpImg) { payload.imageBase64 = _bcGrpImg; payload.imageMime = _bcGrpMime; }

  try {
    const d = await fetch("/api/broadcast-groups", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(r => r.json());

    document.getElementById("bcGrpSpinner").style.display = "none";
    stopBtn.style.display = "none"; sendBtn.disabled = false;

    if (!d.ok) { showToast("❌ " + (d.error || "خطأ")); return; }

    const lines = d.results.map(r => {
      const icon = r.status === "sent" ? "✅" : r.status === "dry-run" ? "👁" : r.status === "stopped" ? "⏹" : "❌";
      return `${icon} ${r.name}${r.error ? " — " + r.error : ""}`;
    }).join("\n");

    const res = document.getElementById("bcGrpResult");
    res.textContent = lines || "لا توجد مجموعات";
    res.style.display = "block";

    document.getElementById("bcGrpSent").textContent  = `✅ ${d.sent} تم`;
    document.getElementById("bcGrpFail").textContent  = `❌ ${d.failed} فشل`;
    document.getElementById("bcGrpTotal").textContent = `📊 ${d.total} مجموع`;
    document.getElementById("bcGrpSummary").style.display = "flex";

    showToast(d.cancelled ? `⏹ توقف: ${d.sent}/${d.total}` : `✅ أُرسل لـ ${d.sent} مجموعة`);
  } catch {
    document.getElementById("bcGrpSpinner").style.display = "none";
    stopBtn.style.display = "none"; sendBtn.disabled = false;
    showToast("❌ فشل الاتصال");
  }
}

/* ── Chat view modal ── */
function openChat(groupId, groupName, botId) {
  chatGroupId = groupId;
  chatBotId   = botId;
  document.getElementById("chatTitle").textContent    = groupName;
  document.getElementById("chatSubtitle").textContent = "";
  document.getElementById("chatSendMsg").value        = "";
  document.getElementById("msgsWrap").innerHTML       = '<div class="chat-spinner">⏳ جاري التحميل...</div>';
  document.getElementById("chatOverlay").classList.add("open");
  fetchChatMsgs();
}

function closeChat() {
  document.getElementById("chatOverlay").classList.remove("open");
  chatGroupId = null;
}

function reloadChat() { if (chatGroupId) fetchChatMsgs(); }

async function fetchChatMsgs() {
  const limit = document.getElementById("msgLimit").value;
  const wrap  = document.getElementById("msgsWrap");
  wrap.innerHTML = '<div class="chat-spinner">⏳ جاري التحميل...</div>';
  try {
    const msgs = await fetch(
      `/api/group-messages?groupId=${encodeURIComponent(chatGroupId)}&limit=${limit}&botId=${encodeURIComponent(chatBotId || "")}`
    ).then(r => r.json());

    if (msgs.error) { wrap.innerHTML = `<div class="chat-spinner">❌ ${escHtml(msgs.error)}</div>`; return; }
    if (!msgs.length) { wrap.innerHTML = '<div class="chat-spinner">لا توجد رسائل</div>'; return; }

    document.getElementById("chatSubtitle").textContent = `${msgs.length} رسالة`;

    const icons = { image:"🖼️ صورة", video:"🎬 فيديو", audio:"🎵 صوت", document:"📄 ملف", sticker:"🎭 ملصق" };
    wrap.innerHTML = msgs.map(m => {
      const cls    = m.fromMe ? "me" : "them";
      const time   = m.timestamp ? new Date(m.timestamp * 1000).toLocaleTimeString("ar-MA", { hour:"2-digit", minute:"2-digit" }) : "";
      const date   = m.timestamp ? new Date(m.timestamp * 1000).toLocaleDateString("ar-MA") : "";
      const author = !m.fromMe && m.author ? `<div class="b-author">${escHtml(m.author.replace(/@.+/,""))}</div>` : "";
      const body   = m.hasMedia
        ? `<span class="b-media">${icons[m.type] || "📎 وسائط"}</span>`
        : escHtml(m.body || "");
      return `<div class="bubble ${cls}">${author}${body}<span class="b-time">${date} ${time}</span></div>`;
    }).join("");

    wrap.scrollTop = wrap.scrollHeight;
  } catch (err) {
    wrap.innerHTML = `<div class="chat-spinner">❌ ${escHtml(err.message)}</div>`;
  }
}

async function sendFromChat() {
  const msg = document.getElementById("chatSendMsg").value.trim();
  if (!msg || !chatGroupId) return;
  try {
    const d = await fetch("/api/send-group", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: chatGroupId, message: msg, botId: chatBotId }),
    }).then(r => r.json());
    if (d.ok) {
      document.getElementById("chatSendMsg").value = "";
      setTimeout(fetchChatMsgs, 1000);
    } else showToast("❌ " + (d.error || "فشل"));
  } catch { showToast("❌ خطأ"); }
}

document.getElementById("chatSendMsg").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendFromChat(); }
});

document.getElementById("chatOverlay").addEventListener("click", e => {
  if (e.target === document.getElementById("chatOverlay")) closeChat();
});

/* ── Send modal ── */
function openSend(groupId, groupName, botId) {
  sendGroupId = groupId;
  sendBotId   = botId;
  document.getElementById("sendGroupName").textContent = "📌 " + groupName;
  document.getElementById("sendMsg").value = "";
  document.getElementById("sendOverlay").classList.add("open");
  setTimeout(() => document.getElementById("sendMsg").focus(), 100);
}
function closeSend() {
  document.getElementById("sendOverlay").classList.remove("open");
  sendGroupId = null;
}
document.getElementById("sendOverlay").addEventListener("click", e => {
  if (e.target === document.getElementById("sendOverlay")) closeSend();
});

async function doSend() {
  const msg = document.getElementById("sendMsg").value.trim();
  if (!msg) return showToast("⚠️ اكتب رسالة أولاً");
  try {
    const d = await fetch("/api/send-group", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: sendGroupId, message: msg, botId: sendBotId }),
    }).then(r => r.json());
    if (d.ok) { showToast("✅ تم الإرسال"); closeSend(); }
    else       showToast("❌ " + (d.error || "فشل الإرسال"));
  } catch { showToast("❌ خطأ في الاتصال"); }
}

/* ── Helpers ── */
function escHtml(s) {
  return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 3000);
}

load();
setInterval(load, 60000);
