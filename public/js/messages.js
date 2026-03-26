// ─────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────
let lastMessageId = 0;
let lastDateRendered = "";
// from_date: اليوم الحالي منتصف الليل — تُحمَّل رسائل اليوم فقط افتراضياً
let chatFromDate = todayMidnight();
let hasOlderMessages = true; // نفترض أن هناك رسائل أقدم حتى نتحقق

function todayMidnight() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

const socketSeenId = new Set();
const socketSeenSig = new Set();

// ─────────────────────────────────────────────────────
// تحميل رسائل أقدم (يوم سابق)
// ─────────────────────────────────────────────────────
async function loadOlderMessages() {
  if (!selectedPhone) return;
  const wrap = document.getElementById("messagesWrap");
  const btn  = document.getElementById("loadOlderBtn");
  if (btn) { btn.disabled = true; btn.textContent = "⏳ جاري التحميل..."; }

  // نرجع 7 أيام في الوقت لكل ضغطة
  const d = new Date(chatFromDate);
  d.setDate(d.getDate() - 7);
  chatFromDate = d.toISOString();

  const phone = encodeURIComponent(selectedPhone);
  const url = `/api/messages?phone=${phone}&limit=200&from_date=${encodeURIComponent(chatFromDate)}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    const raw = await res.json();
    const list = Array.isArray(raw) ? raw : [];
    // فلتر الرسائل الجديدة فقط (غير موجودة في الـ DOM)
    const existing = new Set([...wrap.querySelectorAll("[data-msgid]")].map(el => el.dataset.msgid));
    const newMsgs = list
      .filter(m => isValidMessageObject(m) && !existing.has(String(m.id)))
      .reverse();

    if (newMsgs.length > 0) {
      const prevH = wrap.scrollHeight;
      wrap.insertAdjacentHTML("afterbegin", renderMessages(newMsgs));
      wrap.scrollTop = wrap.scrollHeight - prevH; // حافظ على موضع التمرير
    }
    // إذا رجعنا 60+ يوم بدون رسائل — أخفِ الزر
    const daysDiff = (new Date() - new Date(chatFromDate)) / 86400000;
    if (newMsgs.length === 0 && daysDiff > 60) {
      hasOlderMessages = false;
      if (btn) btn.remove();
    } else {
      if (btn) { btn.disabled = false; btn.textContent = "📅 تحميل رسائل أقدم (7 أيام)"; }
    }
  } catch { if (btn) { btn.disabled = false; btn.textContent = "📅 تحميل رسائل أقدم (7 أيام)"; } }
}

// ─────────────────────────────────────────────────────
// Messages loading
// ─────────────────────────────────────────────────────
async function loadMessages(scrollToBottom = false) {
  if (!selectedPhone) return;

  // reset عند تغيير المحادثة
  if (scrollToBottom) { chatFromDate = todayMidnight(); hasOlderMessages = true; }

  const wrap = document.getElementById("messagesWrap");
  if (!wrap) return;

  try {
    const isFullLoad = lastMessageId === 0 || scrollToBottom;
    const phone = encodeURIComponent(selectedPhone);
    const fromParam = isFullLoad ? `&from_date=${encodeURIComponent(chatFromDate)}` : "";
    const url = `/api/messages?phone=${phone}&limit=200${fromParam}`;

    if (isFullLoad) {
      wrap.innerHTML = `
        <div style="text-align:center;color:#8696a0;padding:40px;font-size:0.85rem">
          ⏳ جاري تحميل المحادثة...
        </div>
      `;
    }

    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const raw = await res.json();
    const list = Array.isArray(raw) ? raw : [];

    const seenId = new Set();
    const seenSig = new Set();

    const msgs = list
      .filter((m) => isValidMessageObject(m))
      .filter((m) => {
        const idKey = String(m.id ?? "");
        if (idKey && seenId.has(idKey)) return false;
        if (idKey) seenId.add(idKey);

        const minute = Math.floor(new Date(m.created_at).getTime() / 60000);
        const sig = buildMessageSignature(m, minute);
        if (seenSig.has(sig)) return false;
        seenSig.add(sig);

        return true;
      })
      .reverse();

    if (isFullLoad) {
      socketSeenId.clear();
      socketSeenSig.clear();
    }

    seenId.forEach((k) => socketSeenId.add(k));
    seenSig.forEach((k) => socketSeenSig.add(k));

    if (!msgs.length) {
      if (lastMessageId === 0 || isFullLoad) {
        wrap.innerHTML = `
          <div style="text-align:center;color:#8696a0;padding:30px">
            لا توجد رسائل بعد
          </div>
        `;
      }
      return;
    }

    const newLastDbId = getLastDbId(msgs);

    if (lastMessageId === 0 || scrollToBottom) {
      lastDateRendered = "";
      const olderBtn = hasOlderMessages ? `
        <div style="text-align:center;padding:10px 0 4px">
          <button id="loadOlderBtn" onclick="loadOlderMessages()"
            style="background:none;border:1px solid #ccc;border-radius:20px;padding:6px 18px;
                   font-size:0.8rem;color:#667;cursor:pointer;direction:rtl">
            📅 تحميل رسائل أقدم (7 أيام)
          </button>
        </div>` : "";
      wrap.innerHTML = olderBtn + renderMessages(msgs);
      markUnansweredMessages();
      requestAnimationFrame(() => { wrap.scrollTop = wrap.scrollHeight; });
      if (newLastDbId > 0) lastMessageId = newLastDbId;
      return;
    }

    if (newLastDbId > 0 && newLastDbId <= lastMessageId) return;

    // Only show messages with a DB numeric ID strictly greater than lastMessageId
    const newMsgs = newLastDbId > 0
      ? msgs.filter((m) => {
          const mid = Number(m.id);
          return Number.isInteger(mid) && mid > lastMessageId;
        })
      : [];

    if (newMsgs.length > 0) {
      const wasAtBottom =
        wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80;

      const html = newMsgs.map((m) => renderSingleMessage(m)).join("");
      wrap.insertAdjacentHTML("beforeend", html);
      markUnansweredMessages();

      if (wasAtBottom) {
        requestAnimationFrame(() => { wrap.scrollTop = wrap.scrollHeight; });
      }
    }

    if (newLastDbId > 0) lastMessageId = newLastDbId;
  } catch (err) {
    console.error("خطأ في loadMessages:", err);
    if (wrap && !wrap.innerHTML.trim()) {
      wrap.innerHTML = `
        <div style="text-align:center;color:#ff6b6b;padding:30px">
          ❌ تعذر تحميل الرسائل
        </div>
      `;
    }
  }
}

// ─────────────────────────────────────────────────────
// Render helpers
// ─────────────────────────────────────────────────────
// فلتر الرسائل الحالي: 'all' | 'in' | 'out'
let msgFilter = "all";

function setMsgFilter(f) {
  msgFilter = f;
}

function renderMessages(msgs) {
  if (!Array.isArray(msgs) || !msgs.length) {
    return `<div style="text-align:center;color:#8696a0;padding:30px">لا توجد رسائل بعد</div>`;
  }

  let filtered = msgs;
  if (msgFilter === "in")  filtered = msgs.filter(m => m.direction === "in");
  if (msgFilter === "out") filtered = msgs.filter(m => m.direction === "out");

  if (!filtered.length) {
    const label = msgFilter === "in" ? "لا توجد رسائل واردة" : "لا توجد ردود";
    return `<div style="text-align:center;color:#8696a0;padding:30px">${label}</div>`;
  }

  lastDateRendered = "";
  return filtered.map((m) => renderSingleMessage(m)).join("");
}

function renderSingleMessage(m) {
  if (!isValidMessageObject(m)) return "";

  const createdAt = new Date(m.created_at);
  const body = String(m.body || "").trim();
  const direction = m.direction === "out" ? "out" : "in";

  // Skip only if there is no body AND no on-demand WA media to render
  if (!body && !(m.hasMedia && m.wa_msg_id)) return "";

  let html = "";

  const dateKey = createdAt.toLocaleDateString("ar-MA");
  if (dateKey !== lastDateRendered) {
    html += `<div class="msg-date-sep">${friendlyDate(m.created_at)}</div>`;
    lastDateRendered = dateKey;
  }

  const time = createdAt.toLocaleTimeString("ar-MA", {
    hour: "2-digit",
    minute: "2-digit",
  });

  const src =
    m.source && m.source !== "user"
      ? `<span class="source-badge">${escHtml(srcLabel(m.source))}</span>`
      : "";

  const ticks =
    direction === "out" ? `<span class="msg-ticks">✓✓</span>` : "";

  let content = "";
  let extraClass = "";
  let skipMeta = false;

  if (isImagePath(body)) {
    const safe = escAttr(body);
    extraClass = "img-only";
    skipMeta = true;
    content = `
      <div class="img-wrap" onclick="openLightbox('${safe}')">
        <img src="${safe}" loading="lazy" alt="">
        <div class="img-meta">${src} ${time} ${ticks}</div>
      </div>`;
  } else if (isVideoPath(body)) {
    const safe = escAttr(body);
    content = `
      <div class="vid-wrap">
        <video src="${safe}" controls preload="metadata" playsinline
          style="max-width:280px;max-height:220px;border-radius:8px;display:block;background:#000;outline:none">
        </video>
      </div>`;
  } else if (isVoicePath(body)) {
    const safe = escAttr(body);
    const apId = buildAudioId(m.id);

    content = `
      <audio
        id="${apId}"
        src="${safe}"
        preload="metadata"
        style="display:none"
        ontimeupdate="updateAudioProgress('${apId}')"
        onended="resetAudioPlayer('${apId}')"
        onloadedmetadata="setAudioDuration('${apId}')"
      ></audio>

      <div class="wa-audio">
        <button class="wa-ap-btn" id="btn_${apId}" onclick="toggleAudio('${apId}')">
          ${getPlayIcon()}
        </button>

        <div class="wa-ap-track" onclick="seekAudio('${apId}', event)">
          <div class="wa-ap-rail">
            <div class="wa-ap-fill" id="fill_${apId}"></div>
            <div class="wa-ap-thumb" id="thumb_${apId}"></div>
          </div>
        </div>

        <span class="wa-ap-time" id="time_${apId}">0:00</span>
      </div>
    `;
  } else if (isFilePath(body)) {
    const safe = escAttr(body);
    const fileName = body.split("/").pop() || "ملف";
    content = `
      <a href="${safe}" target="_blank" rel="noopener noreferrer" class="msg-file-link">
        📎 ${escHtml(fileName)}
      </a>
    `;
  } else if (m.hasMedia && m.wa_msg_id) {
    const isAudio = m.waType === "ptt" || m.waType === "audio";
    const isVideo = m.waType === "video";
    const icon    = isAudio ? "🎤" : isVideo ? "🎬" : "📷";
    const label   = isAudio ? "رسالة صوتية" : isVideo ? "فيديو" : "صورة";
    content = `
      <div class="wa-media-dl"
        data-wa-id="${escAttr(m.wa_msg_id)}"
        data-phone="${escAttr(String(m.phone || ""))}">
        <span class="wa-media-icon">${icon}</span>
        <span class="wa-media-label">${label}</span>
        <button class="wa-media-btn" onclick="downloadWaMedia(this)">▶ تشغيل</button>
      </div>`;
  } else {
    content = `<span>${escHtml(body)}</span>`;
  }

  const msgId = escAttr(String(m.id ?? ""));
  html += `
    <div class="msg-bubble ${direction}${extraClass ? " " + extraClass : ""}" data-id="${msgId}" data-msgid="${msgId}" data-source="${escAttr(m.source||'')}">
      <button class="msg-menu-btn" onclick="toggleMsgMenu(this)" title="خيارات">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <path d="M7 10l5 5 5-5z"/>
        </svg>
      </button>
      <div class="msg-menu">
        <div class="msg-menu-item delete" onclick="deleteMessage('${msgId}', this)">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
          حذف
        </div>
      </div>
      ${content}
      ${skipMeta ? "" : `<div class="msg-meta">${src} ${time} ${ticks}</div>`}
    </div>
  `;

  return html;
}

// ─────────────────────────────────────────────────────
// Message context menu
// ─────────────────────────────────────────────────────
function toggleMsgMenu(btn) {
  const menu = btn.nextElementSibling;
  const isOpen = menu.classList.contains("open");
  // أغلق كل القوائم المفتوحة
  document.querySelectorAll(".msg-menu.open").forEach(m => m.classList.remove("open"));
  if (!isOpen) menu.classList.add("open");
}

// أغلق القوائم عند الضغط خارجها
document.addEventListener("click", (e) => {
  if (!e.target.closest(".msg-bubble")) {
    document.querySelectorAll(".msg-menu.open").forEach(m => m.classList.remove("open"));
  }
});

async function deleteMessage(msgId, el) {
  if (!msgId) return;
  const bubble = el.closest(".msg-bubble");
  el.closest(".msg-menu").classList.remove("open");

  // أنيميشن اختفاء
  bubble.style.transition = "opacity 0.22s, transform 0.22s, max-height 0.28s 0.15s, margin 0.28s 0.15s, padding 0.28s 0.15s";
  bubble.style.opacity    = "0";
  bubble.style.transform  = "scale(0.88)";
  bubble.style.maxHeight  = bubble.offsetHeight + "px";
  bubble.style.overflow   = "hidden";

  const collapse = () => {
    bubble.style.maxHeight   = "0";
    bubble.style.marginBottom = "0";
    bubble.style.paddingTop   = "0";
    bubble.style.paddingBottom = "0";
    setTimeout(() => bubble.remove(), 300);
  };

  // رسائل من قاعدة البيانات — id رقمي
  const isDbMsg = msgId && !isNaN(Number(msgId)) && Number(msgId) > 0;

  if (!isDbMsg) {
    // رسالة WA فقط (id = "wa_...") — حذف من الواجهة فقط
    setTimeout(collapse, 180);
    return;
  }

  // حذف من قاعدة البيانات
  try {
    const r = await fetch(`/api/messages/${msgId}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    setTimeout(collapse, 180);
  } catch (err) {
    // إرجاع الرسالة عند الفشل
    bubble.style.transition = "opacity 0.2s";
    bubble.style.opacity    = "1";
    bubble.style.transform  = "";
    bubble.style.maxHeight  = "";
    bubble.style.marginBottom = "";
    console.error("حذف فشل:", err);
    if (typeof showToast === "function") showToast("❌ فشل الحذف");
  }
}

// ─────────────────────────────────────────────────────
// WA media on-demand download
// ─────────────────────────────────────────────────────
async function downloadWaMedia(btn) {
  const container = btn.closest(".wa-media-dl");
  if (!container) return;
  const waId  = container.dataset.waId;
  const phone = container.dataset.phone;
  btn.disabled = true;
  btn.textContent = "⏳";
  try {
    const res  = await fetch(`/api/wa-media?msgId=${encodeURIComponent(waId)}&phone=${encodeURIComponent(phone)}`);
    const data = await res.json();
    if (!data.ok || !data.url) {
      btn.textContent = "❌ فشل";
      btn.disabled = false;
      return;
    }
    const bubble = container.closest(".msg-bubble");
    const msgId  = bubble?.dataset?.id || String(Math.random());
    let playerHtml = "";
    if (isVoicePath(data.url)) {
      const apId = buildAudioId(msgId + "_dl");
      playerHtml = `
        <audio id="${apId}" src="${escAttr(data.url)}" preload="metadata" style="display:none"
          ontimeupdate="updateAudioProgress('${apId}')"
          onended="resetAudioPlayer('${apId}')"
          onloadedmetadata="setAudioDuration('${apId}')"></audio>
        <div class="wa-audio">
          <button class="wa-ap-btn" id="btn_${apId}" onclick="toggleAudio('${apId}')">${getPlayIcon()}</button>
          <div class="wa-ap-track" onclick="seekAudio('${apId}', event)">
            <div class="wa-ap-rail">
              <div class="wa-ap-fill" id="fill_${apId}"></div>
              <div class="wa-ap-thumb" id="thumb_${apId}"></div>
            </div>
          </div>
          <span class="wa-ap-time" id="time_${apId}">0:00</span>
        </div>`;
    } else if (isVideoPath(data.url)) {
      playerHtml = `<video src="${escAttr(data.url)}" controls preload="metadata"
        style="max-width:280px;max-height:220px;border-radius:6px;display:block;margin-bottom:4px;"></video>`;
    } else if (isImagePath(data.url)) {
      const safe = escAttr(data.url);
      playerHtml = `<img src="${safe}" loading="lazy" alt="image"
        onclick="openLightbox('${safe}')"
        style="max-width:100%;max-height:280px;border-radius:6px;display:block;cursor:zoom-in;margin-bottom:4px;">`;
    }
    if (playerHtml) container.outerHTML = playerHtml;
  } catch {
    btn.textContent = "❌ خطأ";
    btn.disabled = false;
  }
}

// ─────────────────────────────────────────────────────
// Audio player
// ─────────────────────────────────────────────────────
function toggleAudio(id) {
  const audio = document.getElementById(id);
  const btn = document.getElementById(`btn_${id}`);
  if (!audio || !btn) return;

  document.querySelectorAll("audio").forEach((a) => {
    if (a.id !== id && !a.paused) {
      a.pause();
      const otherBtn = document.getElementById(`btn_${a.id}`);
      if (otherBtn) otherBtn.innerHTML = getPlayIcon();
    }
  });

  if (audio.paused) {
    audio.play().catch((err) => {
      console.error("Audio play error:", err);
    });
    btn.innerHTML = getPauseIcon();
  } else {
    audio.pause();
    btn.innerHTML = getPlayIcon();
  }
}

function updateAudioProgress(id) {
  const audio = document.getElementById(id);
  const fill = document.getElementById(`fill_${id}`);
  const thumb = document.getElementById(`thumb_${id}`);
  const time = document.getElementById(`time_${id}`);

  if (!audio || !fill || !thumb || !time || !audio.duration || isNaN(audio.duration)) {
    return;
  }

  const pct = Math.max(0, Math.min(100, (audio.currentTime / audio.duration) * 100));
  fill.style.width = `${pct}%`;
  thumb.style.left = `${pct}%`;

  const s = Math.floor(audio.currentTime);
  time.textContent = formatSeconds(s);
}

function resetAudioPlayer(id) {
  const btn = document.getElementById(`btn_${id}`);
  const fill = document.getElementById(`fill_${id}`);
  const thumb = document.getElementById(`thumb_${id}`);
  const audio = document.getElementById(id);

  if (btn) btn.innerHTML = getPlayIcon();
  if (fill) fill.style.width = "0%";
  if (thumb) thumb.style.left = "0%";
  if (audio) audio.currentTime = 0;
}

function setAudioDuration(id) {
  const audio = document.getElementById(id);
  const time = document.getElementById(`time_${id}`);

  if (!audio || !time || !audio.duration || isNaN(audio.duration)) return;
  time.textContent = formatSeconds(Math.floor(audio.duration));
}

function seekAudio(id, event) {
  const audio = document.getElementById(id);
  const track = event.currentTarget;
  if (!audio || !track || !audio.duration || isNaN(audio.duration)) return;

  const rect = track.getBoundingClientRect();
  const ratio = (event.clientX - rect.left) / rect.width;
  const clamped = Math.max(0, Math.min(1, ratio));
  audio.currentTime = clamped * audio.duration;
}

// ─────────────────────────────────────────────────────
// Lightbox
// ─────────────────────────────────────────────────────
function openLightbox(src) {
  const box = document.getElementById("lightbox");
  const img = document.getElementById("lightbox-img");
  if (!box || !img) return;

  img.src = src;
  box.classList.add("open");
  document.addEventListener("keydown", onLightboxKey);
}

function closeLightbox() {
  const box = document.getElementById("lightbox");
  const img = document.getElementById("lightbox-img");
  if (!box || !img) return;

  box.classList.remove("open");
  img.src = "";
  document.removeEventListener("keydown", onLightboxKey);
}

function onLightboxKey(e) {
  if (e.key === "Escape") closeLightbox();
}

(function bindLightboxClose() {
  const box = document.getElementById("lightbox");
  if (!box) return;

  box.addEventListener("click", (e) => {
    if (e.target === box) closeLightbox();
  });
})();

// ─────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────
function getLastDbId(msgs) {
  let max = 0;
  for (const m of msgs) {
    const mid = Number(m.id);
    if (Number.isInteger(mid) && mid > max) max = mid;
  }
  return max;
}

function isValidMessageObject(m) {
  if (!m || typeof m !== "object") return false;
  if (!m.created_at) return false;
  if (isNaN(new Date(m.created_at).getTime())) return false;
  if (m.direction !== "in" && m.direction !== "out") return false;
  return true;
}

function buildMessageSignature(m, minute) {
  return `${m.direction}|${String(m.body || "").trim()}|${minute}`;
}

function buildAudioId(id) {
  return `ap_${String(id ?? Math.random()).replace(/[^a-z0-9]/gi, "").slice(-12)}`;
}

function isImagePath(value) {
  return /^\/uploads\/images\//i.test(value);
}

function isVideoPath(value) {
  return /^\/uploads\/videos\//i.test(value);
}

function isVoicePath(value) {
  return /^\/uploads\/voices\//i.test(value);
}

function isFilePath(value) {
  return /^\/uploads\//i.test(value) &&
    !isImagePath(value) &&
    !isVideoPath(value) &&
    !isVoicePath(value);
}

function formatSeconds(totalSeconds) {
  const s = Math.max(0, Number(totalSeconds) || 0);
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function getPlayIcon() {
  return `
    <svg viewBox="0 0 24 24" width="20" height="20" fill="white" aria-hidden="true">
      <path d="M8 5v14l11-7z"></path>
    </svg>
  `;
}

function getPauseIcon() {
  return `
    <svg viewBox="0 0 24 24" width="20" height="20" fill="white" aria-hidden="true">
      <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"></path>
    </svg>
  `;
}

function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escAttr(str) {
  return escHtml(str);
}

function friendlyDate(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.floor((today - target) / 86400000);

  if (diffDays === 0) return "اليوم";
  if (diffDays === 1) return "أمس";

  return d.toLocaleDateString("ar-MA", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function srcLabel(s) {
  if (s === "ai") return "ذكاء";
  if (s === "custom") return "مبرمج";
  if (s === "default") return "افتراضي";
  return String(s || "");
}

// ─────────────────────────────────────────────────────
// Unanswered message markers
// ─────────────────────────────────────────────────────
function markUnansweredMessages() {
  const wrap = document.getElementById("messagesWrap");
  if (!wrap) return;

  const bubbles = Array.from(wrap.querySelectorAll(".msg-bubble"));

  // clear existing marks
  bubbles.forEach(b => b.classList.remove("unanswered"));

  // walk from bottom: mark incoming messages until first outgoing found
  for (let i = bubbles.length - 1; i >= 0; i--) {
    if (bubbles[i].classList.contains("out")) break;
    if (bubbles[i].classList.contains("in")) {
      bubbles[i].classList.add("unanswered");
    }
  }
}

function clearUnansweredMarks() {
  document.querySelectorAll(".msg-bubble.unanswered")
    .forEach(b => b.classList.remove("unanswered"));
}