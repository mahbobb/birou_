// ── State ─────────────────────────────────────────────────────────────────
let allContacts = [];
let activeTab   = "all";
let contactsSig = "";
let currentPage = 1;
const PAGE_SIZE  = 50;

// ── Load & merge contacts from DB + WhatsApp ──────────────────────────────
async function loadContacts() {
  try {
    const [dbRes, waRes, delRes, msngRes] = await Promise.all([
      fetch("/api/contacts?limit=1000"),
      fetch("/api/wa-chats"),
      fetch("/api/deleted-phones"),
      fetch("/api/messenger/contacts?limit=200"),
    ]);
    const dbContacts    = await dbRes.json();
    const waChats       = await waRes.json();
    const deletedKeys   = new Set((await delRes.json()).map(p => normalizeKey(p)));
    const msngContacts  = await msngRes.json();

    const merged = new Map();

    // helper: اختار الرقم الأطول (يحتوي على رمز البلد)
    function bestPhone(a, b) {
      const pa = String(a || "").replace(/\D/g, "");
      const pb = String(b || "").replace(/\D/g, "");
      return pb.length > pa.length ? pb : pa;
    }

    for (const c of dbContacts) {
      const key   = normalizeKey(c.phone);
      if (!key || key.length < 7) continue;
      const phone = String(c.phone || "").replace(/\D/g, "") || key;
      if (!merged.has(key)) {
        merged.set(key, { ...c, phone });
      } else {
        const prev = merged.get(key);
        const bp   = bestPhone(prev.phone, phone);
        if (new Date(c.lastSeen) > new Date(prev.lastSeen)) {
          merged.set(key, { ...c, phone: bp });
        } else {
          merged.set(key, { ...prev, phone: bp });
        }
      }
    }

    for (const c of waChats) {
      const key   = normalizeKey(c.phone);
      if (!key || key.length < 7) continue;
      const phone = String(c.phone || "").replace(/\D/g, "") || key;
      if (!merged.has(key)) {
        merged.set(key, { ...c, phone });
      } else {
        const prev = merged.get(key);
        const bp   = bestPhone(prev.phone, phone);
        // اسم WA أفضل إذا لم يكن مجرد أرقام
        const name = (c.name && !/^\d+$/.test(c.name)) ? c.name : (prev.name || c.name);
        if (new Date(c.lastSeen) > new Date(prev.lastSeen)) {
          merged.set(key, {
            ...prev,
            phone:         bp,
            name,
            lastMessage:   c.lastMessage,
            lastSeen:      c.lastSeen,
            lastDirection: c.lastDirection,
            botId:         c.botId || prev.botId,
          });
        } else {
          merged.set(key, { ...prev, phone: bp, name, botId: prev.botId || c.botId });
        }
      }
    }

    // دمج Messenger contacts
    const msngList = Array.isArray(msngContacts) ? msngContacts : [];
    for (const m of msngList) {
      merged.set(`msng_${m.fb_id}`, {
        phone:         m.fb_id,
        name:          m.name || "مجهول",
        lastMessage:   m.last_message || "",
        lastSeen:      m.last_seen,
        lastDirection: m.direction,
        totalMessages: 0,
        source:        "messenger",
        fb_id:         m.fb_id,
      });
    }

    const newList = Array.from(merged.values())
      .filter(c => c.source === "messenger" || !deletedKeys.has(normalizeKey(c.phone)))
      .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));

    const newSig = newList.map(c => c.phone + c.lastSeen).join("|");
    if (newSig !== contactsSig) {
      contactsSig = newSig;
      allContacts = newList;
      updateBadges();
      applyFilter();
    }
  } catch { /* silent */ }
}

// ── Badges ────────────────────────────────────────────────────────────────
function updateBadges() {
  const unread = allContacts.filter(c => c.lastDirection === "in").length;
  document.getElementById("badgeAll").textContent    = allContacts.length;
  document.getElementById("badgeUnread").textContent = unread;
  // أحمر إذا يوجد محادثات تنتظر رد
  const badge = document.getElementById("badgeUnread");
  badge.style.background = unread > 0 ? "#e53935" : "";
  // ln-badge في الشريط الجانبي الأيسر
  const ln = document.getElementById("lnBadge");
  if (ln) {
    ln.textContent = unread > 0 ? (unread > 99 ? "99+" : unread) : "";
    ln.style.display = unread > 0 ? "flex" : "none";
  }
}

// ── Tabs ──────────────────────────────────────────────────────────────────
function setTab(tab) {
  activeTab = tab;
  document.getElementById("tabAll").classList.toggle("active",    tab === "all");
  document.getElementById("tabUnread").classList.toggle("active", tab === "unread");
  // تحديث الـ wf-tab class (نفس الـ IDs)
  document.getElementById("tabAll").classList.toggle("wf-tab",    true);
  document.getElementById("tabUnread").classList.toggle("wf-tab", true);
  applyFilter();
}

// ── Filter + render ───────────────────────────────────────────────────────
function applyFilter(resetPage = true) {
  if (resetPage) currentPage = 1;
  const q = document.getElementById("searchContact").value.trim().toLowerCase();
  let list = activeTab === "unread"
    ? allContacts.filter(c => c.lastDirection === "in")
    : allContacts;
  if (q) list = list.filter(c =>
    (c.name || "").toLowerCase().includes(q) || (c.phone || "").includes(q)
  );
  // dedup
  const seen = new Set();
  list = list.filter(c => {
    const k = normalizeKey(c.phone);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const totalPages = Math.ceil(list.length / PAGE_SIZE) || 1;
  if (currentPage > totalPages) currentPage = totalPages;
  const start = (currentPage - 1) * PAGE_SIZE;
  const page  = list.slice(start, start + PAGE_SIZE);
  renderContacts(page);
  renderPagination(list.length, totalPages);
}

function renderPagination(total, totalPages) {
  let el = document.getElementById("contactsPagination");
  if (!el) {
    el = document.createElement("div");
    el.id = "contactsPagination";
    el.className = "contacts-pagination";
    const sidebar = document.getElementById("contactsList");
    sidebar.parentNode.insertBefore(el, sidebar.nextSibling);
  }
  if (totalPages <= 1) { el.innerHTML = ""; return; }

  const pages = [];
  // always show first
  pages.push(1);
  // show window around current
  for (let i = Math.max(2, currentPage - 1); i <= Math.min(totalPages - 1, currentPage + 1); i++) {
    pages.push(i);
  }
  // always show last
  if (totalPages > 1) pages.push(totalPages);
  // dedupe
  const unique = [...new Set(pages)];

  let html = "";
  // prev arrow
  if (currentPage > 1) {
    html += `<button class="pg-btn pg-arrow" onclick="goPage(${currentPage - 1})">&#8249;</button>`;
  }
  let prev = 0;
  for (const p of unique) {
    if (p - prev > 1) html += `<span class="pg-dots">…</span>`;
    html += `<button class="pg-btn${p === currentPage ? " pg-active" : ""}" onclick="goPage(${p})">${p}</button>`;
    prev = p;
  }
  // next arrow
  if (currentPage < totalPages) {
    html += `<button class="pg-btn pg-arrow" onclick="goPage(${currentPage + 1})">&#8250;</button>`;
  }
  el.innerHTML = html;
}

function goPage(p) {
  currentPage = p;
  applyFilter(false);
  document.getElementById("contactsList").scrollTop = 0;
}

function renderContacts(list) {
  const el = document.getElementById("contactsList");
  if (!list.length) {
    el.innerHTML = `<div class="empty-contacts">${
      activeTab === "unread" ? "✅ لا توجد محادثات تنتظر رداً" : "لا توجد محادثات بعد"
    }</div>`;
    return;
  }

  el.innerHTML = list.map(c => {
    const initial  = (c.name || c.phone || "?")[0].toUpperCase();
    const color    = avatarColor(c.name || c.phone);
    const time     = formatTime(c.lastSeen);
    const preview  = previewText(c.lastMessage || "");
    const isUnread = c.lastDirection === "in";
    const isActive = normalizeKey(c.phone) === normalizeKey(selectedPhone);
    const classes  = ["contact-item", isActive ? "active" : "", isUnread ? "unread" : ""].filter(Boolean).join(" ");
    const isMsng   = c.source === "messenger";
    const botNum   = !isMsng && (c.botId === "bot1" ? "1" : c.botId === "bot2" ? "2" : c.botId === "bot3" ? "3" : "");
    const botBadge = isMsng
      ? `<span class="bot-badge" style="background:#1877f2">📘</span>`
      : botNum ? `<span class="bot-badge">${botNum}</span>` : "";
    const total    = c.totalMessages > 0 ? formatCount(c.totalMessages) : "";
    const msgCount = total ? `<span class="msg-count-badge">${total}</span>` : "";

    // عرض رقم الهاتف بوضوح
    const phoneDisplay = c.phone ? `<span class="contact-phone" title="رقم WhatsApp">📱 ${c.phone}</span>` : "";

    return `
      <div class="${classes}"
        data-phone="${escHtml(c.phone)}" data-name="${escHtml(c.name || c.phone)}"
        data-source="${c.source || 'whatsapp'}"
        data-botid="${escHtml(c.botId || '')}"
        onclick="selectContact(this)">
        <div class="contact-avatar" style="background:${color}">${initial}</div>
        <div class="contact-details">
          <div class="contact-top">
            <div style="flex:1;min-width:0;">
              <span class="contact-name">${escHtml(c.name || "غير معروف")}</span>
              ${phoneDisplay}
            </div>
            <div style="display:flex;align-items:center;gap:4px;flex-shrink:0;">
              ${botBadge}
              <span class="contact-time${isUnread ? " new" : ""}">${time}</span>
            </div>
          </div>
          <div class="contact-bottom">
            <span class="contact-preview">${escHtml(preview)}</span>
            <div style="display:flex;align-items:center;gap:4px;flex-shrink:0;">
              ${msgCount}
              ${isUnread ? `<span class="unread-badge">💬 رد</span>` : ""}
            </div>
          </div>
        </div>
      </div>`;
  }).join("");
}

// ── Delete contact ────────────────────────────────────────────────────────
async function deleteContact(phone, e) {
  e.stopPropagation();
  if (!confirm("حذف هذه المحادثة وجميع رسائلها؟")) return;
  try {
    const res = await fetch(`/api/contacts/${encodeURIComponent(phone)}`, { method: "DELETE" });
    const d   = await res.json();
    if (!d.ok) { showToast("❌ فشل الحذف"); return; }
    allContacts = allContacts.filter(c => normalizeKey(c.phone) !== normalizeKey(phone));
    if (normalizeKey(selectedPhone) === normalizeKey(phone)) {
      selectedPhone = "";
      document.getElementById("chatView").classList.remove("open");
      document.getElementById("noSelection").style.display = "";
    }
    updateBadges();
    applyFilter();
    showToast("🗑 تم الحذف");
  } catch { showToast("❌ خطأ في الاتصال"); }
}

// ── Mark contact as replied (remove from unread instantly) ────────────────
function markContactReplied(phone) {
  const key = normalizeKey(phone);
  const idx = allContacts.findIndex(c => normalizeKey(c.phone) === key);
  if (idx === -1 || allContacts[idx].lastDirection === "out") return;
  allContacts[idx] = { ...allContacts[idx], lastDirection: "out" };
  updateBadges();
  applyFilter();
}

// ── Search event ──────────────────────────────────────────────────────────
document.getElementById("searchContact").addEventListener("input", applyFilter);

// ── AUTO PRELOAD DATA ─────────────────────────────────────────────────────
// تحميل مسبق لجميع البيانات في الخلفية عند فتح الصفحة
const preloadCache = {
  messages: new Map(),    // phone → messages[]
  images: new Map(),      // phone → images[]
  videos: new Map(),      // phone → videos[]
  voices: new Map(),      // phone → voices[]
  loaded: new Set(),      // هواتف تم تحميل بياناتها
  inProgress: new Set(),  // هواتف قيد التحميل الآن
};

async function preloadDataForContact(phone, source = "whatsapp") {
  const key = normalizeKey(phone);
  if (!key || preloadCache.inProgress.has(key) || preloadCache.loaded.has(key)) return;

  preloadCache.inProgress.add(key);

  try {
    const isMsng = source === "messenger";
    const encodedPhone = encodeURIComponent(phone);

    // تحميل آخر 150 رسالة
    if (!isMsng) {
      try {
        const msgRes = await fetch(`/api/messages?phone=${encodedPhone}&limit=150&cache=${Date.now()}`,
          { cache: "no-store" });
        if (msgRes.ok) {
          const msgs = await msgRes.json();
          preloadCache.messages.set(key, Array.isArray(msgs) ? msgs : []);
        }
      } catch (e) {
        console.warn(`[preload] Failed to load messages for ${phone}:`, e.message);
      }

      // تحميل الصور (أول 50)
      try {
        const imgRes = await fetch(`/api/images?phone=${encodedPhone}&limit=50`,
          { cache: "no-store" });
        if (imgRes.ok) {
          const imgs = await imgRes.json();
          preloadCache.images.set(key, Array.isArray(imgs) ? imgs : []);
        }
      } catch (e) {
        console.warn(`[preload] Failed to load images for ${phone}:`, e.message);
      }

      // تحميل الفيديوهات والملفات الصوتية
      Promise.all([
        fetch(`/api/videos?phone=${encodedPhone}&limit=50`, { cache: "no-store" })
          .then(r => r.ok ? r.json() : [])
          .catch(() => [])
          .then(v => preloadCache.videos.set(key, Array.isArray(v) ? v : [])),

        fetch(`/api/voices?phone=${encodedPhone}&limit=50`, { cache: "no-store" })
          .then(r => r.ok ? r.json() : [])
          .catch(() => [])
          .then(v => preloadCache.voices.set(key, Array.isArray(v) ? v : [])),
      ]);
    }
  } catch (e) {
    console.warn(`[preload] Error for ${phone}:`, e.message);
  } finally {
    preloadCache.inProgress.delete(key);
    preloadCache.loaded.add(key);
  }
}

async function autoPreloadAllContacts() {
  if (!allContacts.length) return;

  const progressBar = document.getElementById("preloadProgress");
  const progressFill = document.getElementById("preloadBar");
  const progressText = document.getElementById("preloadPercent");

  if (progressBar) progressBar.style.display = "block";

  console.log(`🔄 [preload] بدء تحميل مسبق لـ ${allContacts.length} محادثة...`);

  // تحميل الأولى 10 بسرعة (على التوازي)
  const first10 = allContacts.slice(0, 10);
  await Promise.allSettled(
    first10.map(c => preloadDataForContact(c.phone, c.source))
  );

  let progress = 10;
  if (progressFill) progressFill.style.width = `${(progress / allContacts.length) * 100}%`;
  if (progressText) progressText.textContent = `${Math.round((progress / allContacts.length) * 100)}%`;

  // باقي البيانات في الخلفية (تسلسلي بتأخير صغير)
  const remaining = allContacts.slice(10);
  for (const contact of remaining) {
    if (document.hidden) break; // توقف إذا أغلق المستخدم التبويب
    preloadDataForContact(contact.phone, contact.source);
    progress++;

    // تحديث الشريط كل 5 جهات
    if (progress % 5 === 0) {
      const percent = Math.round((progress / allContacts.length) * 100);
      if (progressFill) progressFill.style.width = `${percent}%`;
      if (progressText) progressText.textContent = `${percent}%`;
    }

    await new Promise(resolve => setTimeout(resolve, 200)); // تأخير 200ms بين الجهات
  }

  // إخفاء الشريط بعد الانتهاء
  if (progressFill) progressFill.style.width = "100%";
  if (progressText) progressText.textContent = "✅ تم";
  setTimeout(() => {
    if (progressBar) progressBar.style.display = "none";
  }, 1500);

  console.log(`✅ [preload] تم تحميل جميع البيانات مسبقاً`);
}

// تفعيل التحميل المسبق عند تحديث جهات الاتصال
const originalLoadContacts = window.loadContacts;
window.loadContacts = async function() {
  await originalLoadContacts.call(this);
  // بدء التحميل المسبق بعد تحميل جهات الاتصال
  setTimeout(() => autoPreloadAllContacts(), 500);
};

// أيضاً عند تحديث قائمة المحادثات
const originalApplyFilter = window.applyFilter;
window.applyFilter = function(resetPage = true) {
  originalApplyFilter.call(this, resetPage);
  // preload أي جهات جديدة في الصفحة الحالية
  const visibleContacts = document.querySelectorAll(".contact-item");
  visibleContacts.forEach(el => {
    const phone = el.dataset.phone;
    const source = el.dataset.source || "whatsapp";
    if (phone) preloadDataForContact(phone, source);
  });
};
