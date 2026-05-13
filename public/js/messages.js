// ─────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────
let lastMessageId = 0;
let lastDateRendered = "";
// from_date: آخر 24 ساعة افتراضياً
let chatFromDate = last24h();
let hasOlderMessages = true;
let isLoadingOlder   = false;

function last24h() {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

const socketSeenId = new Set();
const socketSeenSig = new Set();

// ─────────────────────────────────────────────────────
// Infinite scroll — تحميل رسائل أقدم تلقائياً عند التمرير للأعلى
// ─────────────────────────────────────────────────────
function _olderIndicatorHtml() {
  return `<div id="olderIndicator" style="text-align:center;padding:6px 0 2px;color:#8696a0;font-size:0.78rem;direction:ltr">
    <span id="olderSpinner" style="display:none">⏳ Chargement des messages plus anciens…</span>
    <span id="olderTrigger" style="opacity:.55;font-size:0.75rem">↑ Défiler vers le haut pour charger plus</span>
  </div>`;
}

function _setOlderLoading(loading) {
  const sp = document.getElementById("olderSpinner");
  const tr = document.getElementById("olderTrigger");
  if (sp) sp.style.display = loading ? "inline" : "none";
  if (tr) tr.style.display = loading ? "none" : "inline";
}

function _removeOlderIndicator() {
  document.getElementById("olderIndicator")?.remove();
  const wrap = document.getElementById("messagesWrap");
  if (wrap) wrap.removeEventListener("scroll", _onWrapScroll);
}

function _onWrapScroll() {
  const wrap = document.getElementById("messagesWrap");
  if (!wrap || isLoadingOlder || !hasOlderMessages) return;
  if (wrap.scrollTop < 80) loadOlderMessages();
}

function setupInfiniteScroll() {
  const wrap = document.getElementById("messagesWrap");
  if (!wrap) return;
  wrap.removeEventListener("scroll", _onWrapScroll);
  if (hasOlderMessages) {
    wrap.addEventListener("scroll", _onWrapScroll, { passive: true });
  }
}

async function loadOlderMessages() {
  if (!selectedPhone || isLoadingOlder || !hasOlderMessages) return;
  isLoadingOlder = true;
  _setOlderLoading(true);

  const wrap = document.getElementById("messagesWrap");

  // نرجع 7 أيام في الوقت لكل تحميل
  const d = new Date(chatFromDate);
  d.setDate(d.getDate() - 7);
  chatFromDate = d.toISOString();

  const url = (typeof selectedCid !== "undefined" && selectedCid)
    ? `/api/messages?cid=${encodeURIComponent(selectedCid)}&limit=200&from_date=${encodeURIComponent(chatFromDate)}`
    : `/api/messages?phone=${encodeURIComponent(selectedPhone)}&limit=200&from_date=${encodeURIComponent(chatFromDate)}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    const raw = await res.json();
    const list = Array.isArray(raw) ? raw : [];
    const existing = new Set([...wrap.querySelectorAll("[data-msgid]")].map(el => el.dataset.msgid));
    const newMsgs = list
      .filter(m => isValidMessageObject(m) && !existing.has(String(m.id)))
      .reverse();

    if (newMsgs.length > 0) {
      const prevH = wrap.scrollHeight;
      const indicator = document.getElementById("olderIndicator");
      if (indicator) {
        indicator.insertAdjacentHTML("afterend", renderMessages(newMsgs));
      } else {
        wrap.insertAdjacentHTML("afterbegin", renderMessages(newMsgs));
      }
      wrap.scrollTop = wrap.scrollHeight - prevH; // حافظ على موضع التمرير
    }

    const daysDiff = (new Date() - new Date(chatFromDate)) / 86400000;
    if (newMsgs.length === 0 && daysDiff > 60) {
      hasOlderMessages = false;
      _removeOlderIndicator();
    } else {
      _setOlderLoading(false);
    }
  } catch {
    _setOlderLoading(false);
  } finally {
    isLoadingOlder = false;
  }
}

// ─────────────────────────────────────────────────────
// Messages loading
// ─────────────────────────────────────────────────────
async function loadMessages(scrollToBottom = false) {
  if (!selectedPhone) return;

  // reset عند تغيير المحادثة
  if (scrollToBottom) { chatFromDate = last24h(); hasOlderMessages = true; isLoadingOlder = false; }

  const wrap = document.getElementById("messagesWrap");
  if (!wrap) return;

  try {
    const isFullLoad = lastMessageId === 0 || scrollToBottom;
    const fromParam = isFullLoad ? `&from_date=${encodeURIComponent(chatFromDate)}` : "";

    // Messenger أو WhatsApp
    const isMsng = (typeof selectedSource !== "undefined" && selectedSource === "messenger");

    // ── استخدام البيانات المحملة مسبقاً إن أمكن ──
    let msgs = [];
    if (isFullLoad && !isMsng && typeof preloadCache !== "undefined") {
      const key = normalizeKey(selectedPhone);
      const cached = preloadCache.messages.get(key);
      if (cached && cached.length > 0) {
        console.log(`💾 [cache] استخدام الرسائل المحملة مسبقاً (${cached.length} رسالة)`);
        msgs = cached
          .filter(isValidMessageObject)
          .reverse();

        const seenId = new Set();
        const seenSig = new Set();
        msgs = msgs.filter(m => {
          const idKey = String(m.id ?? "");
          if (idKey && seenId.has(idKey)) return false;
          if (idKey) seenId.add(idKey);
          const minute = Math.floor(new Date(m.created_at).getTime() / 60000);
          const sig = buildMessageSignature(m, minute);
          if (seenSig.has(sig)) return false;
          seenSig.add(sig);
          return true;
        });

        socketSeenId.clear();
        socketSeenSig.clear();
        seenId.forEach(k => socketSeenId.add(k));
        seenSig.forEach(k => socketSeenSig.add(k));
      }
    }

    // إذا لم نستخدم cache - احمّل من الخادم
    if (msgs.length === 0) {
      if (isFullLoad) {
        wrap.innerHTML = `
          <div style="text-align:center;color:#8696a0;padding:40px;font-size:0.85rem">
            ⏳ Chargement de la conversation...
          </div>
        `;
      }

      const url = isMsng
        ? `/api/messenger/messages?fb_id=${encodeURIComponent(selectedPhone)}&limit=200${fromParam}`
        : (typeof selectedCid !== "undefined" && selectedCid)
          ? `/api/messages?cid=${encodeURIComponent(selectedCid)}&limit=200${fromParam}`
          : `/api/messages?phone=${encodeURIComponent(selectedPhone)}&limit=200${fromParam}`;

      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const raw = await res.json();
      const list = Array.isArray(raw) ? raw : [];

      const seenId = new Set();
      const seenSig = new Set();

      msgs = list
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
        // إذا لم تأتِ رسائل من آخر 24 ساعة — احمّل آخر 100 رسالة بدون فلتر الوقت
        if (isFullLoad && chatFromDate) {
          chatFromDate = "";
          hasOlderMessages = false;
          const isMsng2 = (typeof selectedSource !== "undefined" && selectedSource === "messenger");
          const url2 = isMsng2
            ? `/api/messenger/messages?fb_id=${encodeURIComponent(selectedPhone)}&limit=100`
            : `/api/messages?phone=${encodeURIComponent(selectedPhone)}&limit=100`;
          try {
            const res2 = await fetch(url2, { cache: "no-store" });
            const raw2 = await res2.json();
            const list2 = (Array.isArray(raw2) ? raw2 : []).filter(isValidMessageObject).reverse();
            if (list2.length) {
              lastDateRendered = "";
              list2.forEach(m => { const k = String(m.id ?? ""); if (k) socketSeenId.add(k); });
              wrap.innerHTML = renderMessages(list2);
              markUnansweredMessages();
              requestAnimationFrame(() => { wrap.scrollTop = wrap.scrollHeight; });
              lastMessageId = getLastDbId(list2) || 0;
              setupInfiniteScroll();
              return;
            }
          } catch {}
        }
        if (lastMessageId === 0 || isFullLoad) {
          wrap.innerHTML = `<div style="text-align:center;color:#8696a0;padding:30px">Aucun message pour l'instant</div>`;
        }
        return;
      }
    }

    const newLastDbId = getLastDbId(msgs);

    if (lastMessageId === 0 || scrollToBottom) {
      lastDateRendered = "";
      const olderHtml = hasOlderMessages ? _olderIndicatorHtml() : "";
      wrap.innerHTML = olderHtml + renderMessages(msgs);
      markUnansweredMessages();
      requestAnimationFrame(() => { wrap.scrollTop = wrap.scrollHeight; });
      if (newLastDbId > 0) lastMessageId = newLastDbId;
      setupInfiniteScroll();
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
          ❌ Impossible de charger les messages
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
    return `<div style="text-align:center;color:#8696a0;padding:30px">Aucun message pour l'instant</div>`;
  }

  let filtered = msgs;
  if (msgFilter === "in")  filtered = msgs.filter(m => m.direction === "in");
  if (msgFilter === "out") filtered = msgs.filter(m => m.direction === "out");

  if (!filtered.length) {
    const label = msgFilter === "in" ? "Aucun message reçu" : "Aucune réponse";
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

  const dateKey = createdAt.toLocaleDateString("fr-FR");
  if (dateKey !== lastDateRendered) {
    html += `<div class="msg-date-sep">${friendlyDate(m.created_at)}</div>`;
    lastDateRendered = dateKey;
  }

  const time = createdAt.toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
  });

  const src =
    m.source && m.source !== "user"
      ? `<span class="source-badge">${escHtml(srcLabel(m.source))}</span>`
      : "";

  // ── عرض رقم البوت المستقبل ────────────────────────────────
  let botPhoneDisplay = "";
  if (typeof _botPhones !== "undefined" && typeof selectedPhone !== "undefined") {
    // إذا كانت الرسالة واردة (من الزبون)، عرض رقم البوت المستقبل
    if (direction === "in" && Object.keys(_botPhones).length > 0) {
      const botNum = Object.values(_botPhones)[0]; // أول بوت متصل
      if (botNum) {
        botPhoneDisplay = `<span class="bot-phone-badge" title="Numéro du bot récepteur">🤖 +${botNum}</span>`;
      }
    }
  }

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
        <div class="img-meta">${botPhoneDisplay} ${src} ${time} ${ticks}</div>
      </div>`;
  } else if (isVideoPath(body)) {
    const safe = escAttr(body);
    content = `
      <div class="vid-wrap">
        <div class="vid-container">
          <video src="${safe}" controls preload="metadata" playsinline
            style="max-width:280px;max-height:220px;border-radius:8px;display:block;background:#000;outline:none"
            onloadedmetadata="extractVideoThumbnail(this)">
          </video>
          <a href="${safe}" target="_blank" rel="noopener noreferrer" class="vid-download-btn" title="Télécharger">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="white"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
          </a>
        </div>
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
    const label   = isAudio ? "Message vocal" : isVideo ? "Vidéo" : "Photo";
    content = `
      <div class="wa-media-dl"
        data-wa-id="${escAttr(m.wa_msg_id)}"
        data-phone="${escAttr(String(m.phone || ""))}">
        <span class="wa-media-icon">${icon}</span>
        <span class="wa-media-label">${label}</span>
        <button class="wa-media-btn" onclick="downloadWaMedia(this)">▶ Lire</button>
      </div>`;
  } else {
    content = formatMessageBody(body);
  }

  const msgId = escAttr(String(m.id ?? ""));
  html += `
    <div class="msg-bubble ${direction}${extraClass ? " " + extraClass : ""}" data-id="${msgId}" data-msgid="${msgId}" data-source="${escAttr(m.source||'')}">
      <button class="msg-menu-btn" onclick="toggleMsgMenu(this)" title="Options">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <path d="M7 10l5 5 5-5z"/>
        </svg>
      </button>
      <div class="msg-menu">
        <div class="msg-menu-item delete" onclick="deleteMessage('${msgId}', this)">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
          Supprimer
        </div>
      </div>
      ${content}
      ${skipMeta ? "" : `<div class="msg-meta">${botPhoneDisplay} ${src} ${time} ${ticks}</div>`}
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
    if (typeof showToast === "function") showToast("❌ Échec de suppression");
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
      btn.textContent = "❌ Échec";
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
    btn.textContent = "❌ Erreur";
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

// ─────────────────────────────────────────────────────
// Maps & URL rendering
// ─────────────────────────────────────────────────────
const _URL_RE = /https?:\/\/[^\s<>"'{}|\\^`\[\]،؛]+/gi;

function _isMapsUrl(url) {
  return /maps\.google\.|google\.[a-z]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps/i.test(url);
}

function _parseMapsCoords(url) {
  let m;
  // /@lat,lng,zoom
  m = url.match(/@([-\d.]+),([-\d.]+)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
  // ?q=lat,lng  or  &q=lat,lng
  m = url.match(/[?&]q=([-\d.]+),([-\d.]+)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
  // !3d...!4d...  (embed format)
  m = url.match(/!3d([-\d.]+)!4d([-\d.]+)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
  return null;
}

function _renderMapsCard(url) {
  const coords = _parseMapsCoords(url);
  const coordsText = coords
    ? `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`
    : "";
  // thumbnail via OpenStreetMap staticmap (free, no API key)
  const thumbUrl = coords
    ? `https://staticmap.openstreetmap.de/staticmap.php?center=${coords.lat},${coords.lng}&zoom=15&size=280x120&markers=${coords.lat},${coords.lng},lightblue1-pushpin`
    : "";

  return `
    <div class="maps-card" onclick="window.open('${escAttr(url)}','_blank')">
      <div class="maps-card-map">
        ${thumbUrl
          ? `<img src="${escAttr(thumbUrl)}" alt="Carte" loading="lazy"
               onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
          : ""}
        <div class="maps-pin-ph" ${thumbUrl ? 'style="display:none"' : ""}>
          <svg viewBox="0 0 24 24" width="48" height="48" fill="#25d366"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
        </div>
      </div>
      <div class="maps-card-info">
        <div class="maps-card-title">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="#25d366" style="flex-shrink:0"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
          Localisation
        </div>
        ${coordsText ? `<div class="maps-card-coords">${escHtml(coordsText)}</div>` : ""}
        <div class="maps-card-open">Ouvrir dans Google Maps ›</div>
      </div>
    </div>`;
}

function formatMessageBody(body) {
  const trimmed = body.trim();
  _URL_RE.lastIndex = 0;

  // If the whole message is just a Maps URL → show card only (no text)
  if (_URL_RE.test(trimmed) && _isMapsUrl(trimmed) && !trimmed.includes(" ")) {
    return _renderMapsCard(trimmed);
  }

  // Otherwise scan for URLs inline
  _URL_RE.lastIndex = 0;
  let html = "";
  let last = 0;
  let m;

  while ((m = _URL_RE.exec(body)) !== null) {
    html += escHtml(body.slice(last, m.index));
    const url = m[0];
    if (_isMapsUrl(url)) {
      html += _renderMapsCard(url);
    } else {
      html += `<a href="${escAttr(url)}" target="_blank" rel="noopener noreferrer" class="msg-url">${escHtml(url)}</a>`;
    }
    last = m.index + url.length;
  }
  html += escHtml(body.slice(last));

  return `<span class="msg-text">${html}</span>`;
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

  if (diffDays === 0) return "Aujourd'hui";
  if (diffDays === 1) return "Hier";

  return d.toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function srcLabel(s) {
  if (s === "ai") return "IA";
  if (s === "custom") return "programmé";
  if (s === "default") return "auto";
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