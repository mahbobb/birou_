// ── State ─────────────────────────────────────────────────────────────────
let allContacts = [];
let activeTab   = "all";
let contactsSig = "";
let currentPage = 1;
const PAGE_SIZE  = 50;

// ── Load & merge contacts from DB + WhatsApp ──────────────────────────────
async function loadContacts() {
  try {
    const [dbRes, waRes, delRes] = await Promise.all([
      fetch("/api/contacts"),
      fetch("/api/wa-chats"),
      fetch("/api/deleted-phones"),
    ]);
    const dbContacts   = await dbRes.json();
    const waChats      = await waRes.json();
    const deletedKeys  = new Set((await delRes.json()).map(p => normalizeKey(p)));

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

    const newList = Array.from(merged.values())
      .filter(c => !deletedKeys.has(normalizeKey(c.phone)))
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
    const botNum   = c.botId === "bot1" ? "1" : c.botId === "bot2" ? "2" : c.botId === "bot3" ? "3" : "";
    const botBadge = botNum ? `<span class="bot-badge">${botNum}</span>` : "";
    const total    = c.totalMessages > 0 ? formatCount(c.totalMessages) : "";
    const msgCount = total ? `<span class="msg-count-badge">${total}</span>` : "";
    return `
      <div class="${classes}"
        data-phone="${escHtml(c.phone)}" data-name="${escHtml(c.name || c.phone)}"
        onclick="selectContact(this)">
        <div class="contact-avatar" style="background:${color}">${initial}</div>
        <div class="contact-details">
          <div class="contact-top">
            <span class="contact-name">${escHtml(c.name || c.phone)}</span>
            <div style="display:flex;align-items:center;gap:4px;">
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
