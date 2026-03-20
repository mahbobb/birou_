'use strict';

let allGroups  = [];
let curGroupId = null;
let curBotId   = null;
let curName    = "";

/* ── Load group list ── */
async function loadGroups() {
  try {
    const list = await fetch("/api/wa-groups").then(r => r.json());
    allGroups = list;
    document.getElementById("grpCount").textContent = list.length;
    renderList(list);
  } catch {
    document.getElementById("groupsList").innerHTML =
      '<div class="empty-list">❌ خطأ في التحميل<br><small>تأكد أن البوت متصل</small></div>';
  }
}

function renderList(list) {
  const wrap = document.getElementById("groupsList");
  if (!list.length) {
    wrap.innerHTML = '<div class="empty-list">لا توجد مجموعات 📭</div>';
    return;
  }
  wrap.innerHTML = list.map(g => {
    const initial = (g.name || "?")[0].toUpperCase();
    const time    = g.lastSeen ? fmtTime(new Date(g.lastSeen)) : "";
    const preview = g.lastMessage
      ? esc(g.lastMessage).slice(0, 50)
      : '<em style="opacity:.5">لا توجد رسائل</em>';
    const active  = g.id === curGroupId ? " active" : "";
    return `<div class="grp-item${active}" onclick="openGroup('${esc(g.id)}','${esc(g.name)}','${g.botId}','${g.participants||0}')">
      <div class="grp-avatar">${initial}</div>
      <div class="grp-body">
        <div class="grp-name">${esc(g.name)}</div>
        <div class="grp-preview">${preview}</div>
      </div>
      <div class="grp-meta">
        <span class="grp-time">${time}</span>
        <span class="grp-members">👤 ${g.participants||0}</span>
      </div>
    </div>`;
  }).join("");
}

/* ── Open group ── */
function openGroup(groupId, groupName, botId, members) {
  curGroupId = groupId;
  curBotId   = botId;
  curName    = groupName;

  document.querySelectorAll(".grp-item").forEach(el => el.classList.remove("active"));
  event?.currentTarget?.classList.add("active");

  document.getElementById("chAvatar").textContent = (groupName||"?")[0].toUpperCase();
  document.getElementById("chName").textContent   = groupName;
  document.getElementById("chSub").textContent    = `👤 ${members} عضو · 🤖 ${botId}`;

  document.getElementById("noSel").style.display = "none";
  const cv = document.getElementById("chatView");
  cv.style.display = "flex";

  if (window.innerWidth <= 700) {
    document.getElementById("sidebar").classList.add("hidden");
  }

  loadMsgs();
}

function backToList() {
  document.getElementById("sidebar").classList.remove("hidden");
}

/* ── Load messages ── */
async function loadMsgs() {
  if (!curGroupId) return;
  const limit = document.getElementById("msgLimit").value;
  const wrap  = document.getElementById("msgsWrap");
  wrap.innerHTML = '<div class="msg-spinner">⏳ جاري التحميل...</div>';
  try {
    const msgs = await fetch(
      `/api/group-messages?groupId=${encodeURIComponent(curGroupId)}&limit=${limit}&botId=${encodeURIComponent(curBotId||"")}`
    ).then(r => r.json());

    if (msgs.error) { wrap.innerHTML = `<div class="msg-spinner">❌ ${esc(msgs.error)}</div>`; return; }
    if (!msgs.length) { wrap.innerHTML = '<div class="msg-spinner">لا توجد رسائل في هذه المجموعة</div>'; return; }

    const mediaIcons = { image:"🖼️ صورة", video:"🎬 فيديو", audio:"🎵 صوت", ptt:"🎤 رسالة صوتية", document:"📄 ملف", sticker:"🎭 ملصق" };

    let lastDate = "";
    const html = msgs.map(m => {
      const cls     = m.fromMe ? "out" : "in";
      const dt      = m.timestamp ? new Date(m.timestamp * 1000) : null;
      const dateStr = dt ? dt.toLocaleDateString("ar-MA", { day:"2-digit", month:"2-digit", year:"numeric" }) : "";
      const timeStr = dt ? dt.toLocaleTimeString("ar-MA", { hour:"2-digit", minute:"2-digit" }) : "";

      let divider = "";
      if (dateStr && dateStr !== lastDate) {
        lastDate = dateStr;
        divider = `<div class="date-divider"><span>${dateStr}</span></div>`;
      }

      const author = !m.fromMe && m.author
        ? `<div class="b-author">${esc(m.author.replace(/@.+/,""))}</div>` : "";
      const body = m.hasMedia
        ? `<span class="b-media">${mediaIcons[m.type] || "📎 وسائط"}</span>`
        : `<span class="b-body">${esc(m.body || "")}</span>`;

      return `${divider}<div class="bubble ${cls}">${author}${body}<span class="b-time">${timeStr}</span></div>`;
    }).join("");

    wrap.innerHTML = html;
    wrap.scrollTop = wrap.scrollHeight;
  } catch (err) {
    wrap.innerHTML = `<div class="msg-spinner">❌ ${esc(err.message)}</div>`;
  }
}

/* ── Send from input bar ── */
async function sendMsg() {
  const msg = document.getElementById("msgInput").value.trim();
  if (!msg || !curGroupId) return;
  document.getElementById("msgInput").value      = "";
  document.getElementById("msgInput").style.height = "";
  try {
    const d = await fetch("/api/send-group", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: curGroupId, message: msg, botId: curBotId }),
    }).then(r => r.json());
    if (d.ok) { showToast("✅ تم الإرسال"); setTimeout(loadMsgs, 1200); }
    else showToast("❌ " + (d.error || "فشل"));
  } catch { showToast("❌ خطأ في الاتصال"); }
}

document.getElementById("msgInput").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMsg(); }
});

/* ── Send modal ── */
function openSendModal() {
  if (!curGroupId) return;
  document.getElementById("smName").textContent = curName;
  document.getElementById("smInput").value = "";
  document.getElementById("sendModal").style.display = "flex";
  setTimeout(() => document.getElementById("smInput").focus(), 100);
}
function closeSendModal() {
  document.getElementById("sendModal").style.display = "none";
}
async function doSendModal() {
  const msg = document.getElementById("smInput").value.trim();
  if (!msg) return showToast("⚠️ اكتب رسالة");
  closeSendModal();
  try {
    const d = await fetch("/api/send-group", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: curGroupId, message: msg, botId: curBotId }),
    }).then(r => r.json());
    if (d.ok) { showToast("✅ تم الإرسال"); setTimeout(loadMsgs, 1200); }
    else showToast("❌ " + (d.error || "فشل"));
  } catch { showToast("❌ خطأ"); }
}
document.getElementById("sendModal").addEventListener("click", e => {
  if (e.target === document.getElementById("sendModal")) closeSendModal();
});

/* ── Search ── */
document.getElementById("searchGrp").addEventListener("input", function() {
  const q = this.value.trim().toLowerCase();
  renderList(q ? allGroups.filter(g => g.name.toLowerCase().includes(q)) : allGroups);
});

/* ── Helpers ── */
function esc(s) {
  return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function fmtTime(dt) {
  const now = new Date();
  if (dt.toDateString() === now.toDateString())
    return dt.toLocaleTimeString("ar-MA", { hour:"2-digit", minute:"2-digit" });
  if ((now - dt) < 7 * 86400000)
    return dt.toLocaleDateString("ar-MA", { weekday:"short" });
  return dt.toLocaleDateString("ar-MA", { day:"2-digit", month:"2-digit" });
}
function autoResize(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}
function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2800);
}

loadGroups();
