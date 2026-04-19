'use strict';

// ── Auto-redirect to login on 401 ──────────────────────────────────────────
(function(){
  const _fetch = window.fetch;
  window.fetch = function(...args){
    return _fetch.apply(this, args).then(res=>{
      if(res.status===401 && !res.url.includes('/api/login')){
        window.location.href='/login';
      }
      return res;
    });
  };
})();

/**
 * nav.js — Shared navigation component
 *
 * Light header : add  <header id="app-header"></header>  in your HTML
 * Dark sidebar : add  <div   id="app-nav"></div>          in your HTML
 * Footer       : add  <footer id="app-footer"></footer>   in your HTML
 *
 * All three are auto-rendered when this script loads.
 */

(function () {

  /* ── Navigation links definition ── */
  const LINKS = [
    { href: '/chat',      icon: '🗨️',  label: 'الشات' },
    { href: '/messages',  icon: '💬',  label: 'الرسائل' },
    { href: '/calls',     icon: '📞',  label: 'المكالمات' },
    { href: '/groups',    icon: '👥',  label: 'المجموعات' },
    { href: '/grp-chat',  icon: '💬',  label: 'رسائل المجموعات' },
    { href: '/responses', icon: '📋',  label: 'الردود' },
    { href: '/ai-reply',  icon: '🤖',  label: 'رد ذكي' },
    { href: '/bulk-reply',icon: '📤',  label: 'رد جماعي' },
    { href: '/images',    icon: '📸',  label: 'الصور' },
    { href: '/voices',    icon: '🎤',  label: 'الصوتيات' },
    { href: '/videos',    icon: '🎬',  label: 'الفيديوهات' },
    { href: '/notes',     icon: '📝',  label: 'الملاحظات' },
    { href: '/qr',        icon: '📲',  label: 'QR' },
    { href: '/sync',      icon: '🔄',  label: 'مزامنة' },
    { href: '/facebook',        icon: '📘',  label: 'فيسبوك' },
    { href: '/messenger-bulk', icon: '💬',  label: 'رد جماعي Messenger' },
    { href: '/widget',          icon: '🌐',  label: 'ويدجت الموقع' },
    { href: '/bookings-admin', icon: '🏢',  label: 'الحجوزات' },
  ];

  /* SVG icons for the dark sidebar */
  const SVGS = {
    home:     '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>',
    chat:     '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M22 6.667C22 5.194 20.806 4 19.333 4H1.79C1.013 4 .54 4.863.94 5.53L3 9v8.333C3 18.806 4.194 20 5.667 20H19.333C20.806 20 22 18.806 22 17.333V6.667ZM7 10a1 1 0 0 1 1-1h9a1 1 0 1 1 0 2H8a1 1 0 0 1-1-1Zm1 3a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2H8Z"/></svg>',
    messages: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-1 4-7 4.5L5 8V6l7 4.5L19 6v2z"/></svg>',
    groups:   '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>',
    grpchat:  '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM9 11H7V9h2v2zm4 0h-2V9h2v2zm4 0h-2V9h2v2z"/></svg>',
    responses:'<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M13 9h-2V7h2v2zm0 8h-2v-6h2v6zm-1-15C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>',
    notes:    '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M3 18h12v-2H3v2zm0-5h12v-2H3v2zm0-7v2h12V6H3zm14 9.5V16h-2v2.5l3 3 3-3V16h-2v2.5l-1 1-1-1z"/></svg>',
    images:   '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>',
    voices:   '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12 15c1.66 0 2.99-1.34 2.99-3L15 6c0-1.66-1.34-3-3-3S9 4.34 9 6v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 15 6.7 12H5c0 3.42 2.72 6.23 6 6.72V22h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg>',
    videos:   '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="m10 8 6 4-6 4V8zm11-5H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14z"/></svg>',
    qr:       '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M3 11h8V3H3v8zm2-6h4v4H5V5zM3 21h8v-8H3v8zm2-6h4v4H5v-4zM13 3v8h8V3h-8zm6 6h-4V5h4v4zM13 13h2v2h-2v-2zm2 2h2v2h-2v-2zm2-2h2v2h-2v-2zm-4 4h2v2h-2v-2zm2 2h2v2h-2v-2zm2-2h2v2h-2v-2zm0 4h2v2h-2v-2zm-4-4h2v6h-2v-6z"/></svg>',
    sync:     '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>',
    logout:   '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M10.09 15.59 11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5c-1.11 0-2 .9-2 2v4h2V5h14v14H5v-4H3v4c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/></svg>',
  };

  const path = location.pathname.replace(/\/$/, '') || '/';
  const logout = `fetch('/api/logout',{method:'POST'}).then(()=>location.href='/login')`;

  /* ══════════════════════════════════════════
     Light Header
  ══════════════════════════════════════════ */
  const headerEl = document.getElementById('app-header');
  if (headerEl) {
    headerEl.className = 'app-header';
    // page title & icon per route
    const titles = {
      '/':          { icon: '📊', title: 'لوحة التحكم' },
      '/messages':  { icon: '📨', title: 'الرسائل' },
      '/calls':     { icon: '📞', title: 'سجل المكالمات' },
      '/groups':    { icon: '👥', title: 'المجموعات' },
      '/responses': { icon: '📋', title: 'الردود التلقائية' },
      '/ai-reply':  { icon: '🤖', title: 'رد ذكي تلقائي' },
      '/bulk-reply':{ icon: '📤', title: 'رد جماعي على الرسائل' },
      '/images':    { icon: '📸', title: 'الصور' },
      '/voices':    { icon: '🎤', title: 'الصوتيات' },
      '/videos':    { icon: '🎬', title: 'الفيديوهات' },
      '/notes':     { icon: '📝', title: 'الملاحظات' },
      '/qr':        { icon: '📲', title: 'QR Code' },
      '/sync':      { icon: '🔄', title: 'مزامنة' },
      '/facebook':  { icon: '📘', title: 'فيسبوك' },
      '/widget':    { icon: '🌐', title: 'ويدجت الموقع' },
    };
    const meta = titles[path] || { icon: '🤖', title: 'واتساب بوت' };

    const navHTML = LINKS.map(l => {
      const active = l.href === path ? ' class="active"' : '';
      return `<a href="${l.href}"${active}>${l.icon} ${l.label}</a>`;
    }).join('');

    headerEl.innerHTML = `
      <div class="hdr-left">
        <div class="hdr-icon">${meta.icon}</div>
        <h1>${meta.title}</h1>
      </div>
      <nav class="nav-links">
        <a href="/">🏠</a>
        ${navHTML}
        <span id="bot-status-indicator" class="bot-status-dot" title="حالة البوت">🟢</span>
        <a href="#" class="nav-logout" onclick="${logout}">🚪 خروج</a>
      </nav>`;
  }

  /* ══════════════════════════════════════════
     Dark Left-Nav (WhatsApp Web style)
  ══════════════════════════════════════════ */
  const navEl = document.getElementById('app-nav');
  if (navEl) {
    navEl.className = 'app-left-nav';

    // Top icons mapping
    const topIcons = [
      { href: '/',          svg: SVGS.home,      title: 'الرئيسية' },
      { href: '/chat',      svg: SVGS.chat,      title: 'الشات',              badge: true },
      { href: '/messages',  svg: SVGS.messages,  title: 'الرسائل' },
      { href: '/calls',     svg: SVGS.voices,    title: 'المكالمات' },
      { href: '/responses', svg: SVGS.responses, title: 'الردود التلقائية' },
      { href: '/notes',     svg: SVGS.notes,     title: 'الملاحظات' },
      { href: '/groups',    svg: SVGS.groups,    title: 'المجموعات' },
      { href: '/grp-chat',  svg: SVGS.grpchat,   title: 'رسائل المجموعات' },
      { sep: true },
      { href: '/images',    svg: SVGS.images,    title: 'الصور' },
      { href: '/voices',    svg: SVGS.voices,    title: 'الصوتيات' },
      { href: '/videos',    svg: SVGS.videos,    title: 'الفيديوهات' },
    ];
    const botIcons = [
      { href: '/qr',  svg: SVGS.qr,   title: 'QR / الأجهزة' },
      { href: '/sync', svg: SVGS.sync, title: 'مزامنة' },
    ];

    function iconHTML(items) {
      return items.map(item => {
        if (item.sep) return '<div class="ln-sep"></div>';
        const active = item.href === path ? ' active' : '';
        const badge  = item.badge ? '<span class="ln-badge" id="lnBadge" style="display:none"></span>' : '';
        return `<a href="${item.href}" class="ln-icon${active}" title="${item.title}">${item.svg}${badge}</a>`;
      }).join('');
    }

    navEl.innerHTML = `
      <div class="ln-top">${iconHTML(topIcons)}</div>
      <div class="ln-bottom">
        <div class="ln-sep"></div>
        ${iconHTML(botIcons)}
        <a href="#" class="ln-icon ln-logout" onclick="${logout}" title="خروج">${SVGS.logout}</a>
      </div>`;
  }

  /* ══════════════════════════════════════════
     Full Sidebar (230px — responses, notes, etc.)
  ══════════════════════════════════════════ */
  const sidebarEl = document.getElementById('app-sidebar');
  if (sidebarEl) {
    const SB_SECTIONS = [
      { label: 'الرئيسية', links: [
        { href: '/',          icon: '📊', label: 'لوحة التحكم' },
      ]},
      { label: 'التواصل', links: [
        { href: '/chat',      icon: '💬', label: 'الشات' },
        { href: '/messages',  icon: '📨', label: 'الرسائل' },
        { href: '/calls',     icon: '📞', label: 'المكالمات' },
        { href: '/groups',    icon: '👥', label: 'المجموعات' },
        { href: '/grp-chat',  icon: '💬', label: 'رسائل المجموعات' },
        { href: '/responses', icon: '📋', label: 'الردود' },
        { href: '/ai-reply',  icon: '🤖', label: 'رد ذكي' },
        { href: '/bulk-reply',icon: '📤', label: 'رد جماعي' },
        { href: '/facebook',  icon: '📘', label: 'فيسبوك' },
        { href: '/widget',    icon: '🌐', label: 'ويدجت الموقع' },
      ]},
      { label: 'الوسائط', links: [
        { href: '/images',    icon: '📸', label: 'الصور' },
        { href: '/voices',    icon: '🎤', label: 'الصوتيات' },
        { href: '/videos',    icon: '🎬', label: 'الفيديوهات' },
      ]},
      { label: 'الأعمال', links: [
        { href: '/bookings-admin', icon: '🏢', label: 'الحجوزات' },
        { href: '/messenger-bulk', icon: '💬', label: 'Messenger جماعي' },
      ]},
      { label: 'الإعدادات', links: [
        { href: '/notes',     icon: '📝', label: 'الملاحظات' },
        { href: '/qr',        icon: '📲', label: 'QR Code' },
        { href: '/sync',      icon: '🔄', label: 'المزامنة' },
      ]},
    ];

    const sbNavHTML = SB_SECTIONS.map(sec => {
      const linksHTML = sec.links.map(l => {
        const active = l.href === path ? ' active' : '';
        return `<a class="sb-link${active}" href="${l.href}"><span class="ico">${l.icon}</span><span>${l.label}</span></a>`;
      }).join('');
      return `<div class="sb-section">${sec.label}</div>${linksHTML}`;
    }).join('');

    sidebarEl.innerHTML = `
      <div class="sb-brand">
        <div class="brand-row">
          <div class="brand-icon">🤖</div>
          <div><h2>واتساب بوت</h2></div>
        </div>
      </div>
      <nav class="sb-nav">${sbNavHTML}</nav>
      <div class="sb-bottom">
        <button class="sb-logout" onclick="${logout}"><span>🚪</span><span>خروج</span></button>
      </div>`;
  }

  /* ══════════════════════════════════════════
     Footer
  ══════════════════════════════════════════ */
  const footerEl = document.getElementById('app-footer');
  if (footerEl) {
    footerEl.className = 'app-footer';
    footerEl.innerHTML = `
      واتساب بوت &copy; ${new Date().getFullYear()} —
      <a href="/qr">📲 QR</a> ·
      <a href="/chat">💬 الشات</a> ·
      <a href="/groups">👥 المجموعات</a> ·
      <a href="#" onclick="${logout}">🚪 خروج</a>`;
  }

})();

// ─── Bot Status Indicator CSS ─────────────────────────────────────────────
const style = document.createElement("style");
style.textContent = `
  .bot-status-dot {
    display: inline-block;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    animation: bot-pulse 2s ease-in-out infinite;
    cursor: help;
    font-size: 1rem;
  }
  .bot-status-dot.connected { color: #00a884; }
  .bot-status-dot.disconnected { color: #e53935; animation: none; }
  @keyframes bot-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
`;
document.head.appendChild(style);

// ─── HEARTBEAT: إبقاء اتصال البوت حياً ────────────────────────────────────
(function() {
  const HEARTBEAT_INTERVAL = 120000; // كل 2 دقيقة (تقليل من 60s)
  const STATUS_CHECK_INTERVAL = 60000;  // كل دقيقة (تقليل من 30s)

  const updateStatusIndicator = (connected) => {
    const indicator = document.getElementById("bot-status-indicator");
    if (indicator) {
      indicator.classList.toggle("connected", connected);
      indicator.classList.toggle("disconnected", !connected);
      indicator.textContent = connected ? "🟢" : "🔴";
    }
  };

  // Heartbeat ping
  setInterval(async () => {
    try {
      const resp = await fetch("/api/ping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botId: "default" }),
      });
      updateStatusIndicator(resp.ok);
    } catch (err) {
      console.warn("🔔 [Heartbeat] Failed:", err.message);
      updateStatusIndicator(false);
    }
  }, HEARTBEAT_INTERVAL);

  // Status check
  setInterval(async () => {
    try {
      const resp = await fetch("/api/bot-status?botId=bot1");
      const data = await resp.json();
      updateStatusIndicator(data.ok && data.connected);

      if (!data.ok || !data.connected) {
        console.error("🔴 [Bot Status] البوت غير متصل!");
      } else {
        console.log(`✅ [Bot Status] متصل | Uptime: ${data.uptime}`);
      }
    } catch (err) {
      console.warn("⚠️ [Status Check] Error:", err.message);
      updateStatusIndicator(false);
    }
  }, STATUS_CHECK_INTERVAL);

  // First check immediately
  fetch("/api/bot-status?botId=bot1")
    .then(r => r.json())
    .then(data => updateStatusIndicator(data.ok && data.connected))
    .catch(() => updateStatusIndicator(false));
})();
