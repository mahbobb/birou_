// ── State ─────────────────────────────────────────────────────────────────
let allContacts = [];
let activeTab   = "all";
let contactsSig = "";

// ── Load & merge contacts from DB + WhatsApp ──────────────────────────────
async function loadContacts() {
  try {
    const [dbRes, waRes] = await Promise.all([
      fetch("/api/contacts"),
      fetch("/api/wa-chats"),
    ]);
    const dbContacts = await dbRes.json();
    const waChats    = await waRes.json();

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
}

// ── Tabs ──────────────────────────────────────────────────────────────────
function setTab(tab) {
  activeTab = tab;
  document.getElementById("tabAll").classList.toggle("active",    tab === "all");
  document.getElementById("tabUnread").classList.toggle("active", tab === "unread");
  applyFilter();
}

// ── Filter + render ───────────────────────────────────────────────────────
function applyFilter() {
  const q = document.getElementById("searchContact").value.trim().toLowerCase();
  let list = activeTab === "unread"
    ? allContacts.filter(c => c.lastDirection === "in")
    : allContacts;
  if (q) list = list.filter(c =>
    (c.name || "").toLowerCase().includes(q) || (c.phone || "").includes(q)
  );
  renderContacts(list);
}

function renderContacts(list) {
  const el = document.getElementById("contactsList");
  const renderedKeys = new Set();
  list = list.filter(c => {
    const key = normalizeKey(c.phone);
    if (!key || renderedKeys.has(key)) return false;
    renderedKeys.add(key);
    return true;
  });

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
