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
 * nav.js — Navigation trilingue : عربية / Français / English
 */

(function () {

  /* ══════════════════════════════════════════
     Language switcher
  ══════════════════════════════════════════ */
  const LANGS = ['ar', 'fr', 'en'];
  function getLang() { return localStorage.getItem('navLang') || 'fr'; }
  function applyLang(l) {
    localStorage.setItem('navLang', l);
    document.documentElement.dataset.lang = l;
    const lbl = document.getElementById('bnavLangLabel');
    if (lbl) lbl.textContent = { ar: 'عر', fr: 'FR', en: 'EN' }[l] || l.toUpperCase();
  }
  window._cycleLang = function() {
    applyLang(LANGS[(LANGS.indexOf(getLang()) + 1) % LANGS.length]);
  };

  // Apply saved language immediately (before DOM builds, avoids flash)
  if (!localStorage.getItem('navLang')) localStorage.setItem('navLang', 'fr');
  document.documentElement.dataset.lang = getLang();

  /* ── Helper: render trilingual spans ── */
  function lv(ar, fr, en, baseClass) {
    const bc = baseClass ? ` ${baseClass}` : '';
    return `<span class="lv-ar${bc}" data-lv="ar">${ar}</span>`
         + `<span class="lv-fr${bc}" data-lv="fr">${fr}</span>`
         + `<span class="lv-en${bc}" data-lv="en">${en}</span>`;
  }

  /* ── Nav links ── */
  const LINKS = [
    { href: '/chat',           icon: '🗨️', ar: 'الشات',           fr: 'Chat',             en: 'Chat' },
    { href: '/messages',       icon: '💬', ar: 'الرسائل',          fr: 'Messages',         en: 'Messages' },
    { href: '/calls',          icon: '📞', ar: 'المكالمات',         fr: 'Appels',           en: 'Calls' },
    { href: '/groups',         icon: '👥', ar: 'المجموعات',         fr: 'Groupes',          en: 'Groups' },
    { href: '/grp-chat',       icon: '💬', ar: 'رسائل المجموعات',   fr: 'Messages groupes', en: 'Group Msgs' },
    { href: '/responses',      icon: '📋', ar: 'الردود',            fr: 'Réponses',         en: 'Responses' },
    { href: '/ai-reply',       icon: '🤖', ar: 'رد ذكي',           fr: 'Réponse IA',       en: 'AI Reply' },
    { href: '/bulk-reply',     icon: '📤', ar: 'رد جماعي',         fr: 'Envoi groupé',     en: 'Bulk Send' },
    { href: '/images',         icon: '📸', ar: 'الصور',            fr: 'Photos',           en: 'Photos' },
    { href: '/voices',         icon: '🎤', ar: 'الصوتيات',         fr: 'Vocaux',           en: 'Voice' },
    { href: '/videos',         icon: '🎬', ar: 'الفيديوهات',       fr: 'Vidéos',           en: 'Videos' },
    { href: '/notes',          icon: '📝', ar: 'الملاحظات',        fr: 'Notes',            en: 'Notes' },
    { href: '/qr',             icon: '📲', ar: 'QR',               fr: 'QR',               en: 'QR' },
    { href: '/sync',           icon: '🔄', ar: 'مزامنة',           fr: 'Sync',             en: 'Sync' },
    { href: '/facebook',       icon: '📘', ar: 'فيسبوك',           fr: 'Facebook',         en: 'Facebook' },
    { href: '/messenger-bulk', icon: '💬', ar: 'Messenger جماعي',  fr: 'Messenger groupé', en: 'Bulk Messenger' },
    { href: '/widget',         icon: '🌐', ar: 'ويدجت الموقع',      fr: 'Widget site',      en: 'Site Widget' },
    { href: '/bookings-admin', icon: '🏢', ar: 'الحجوزات',         fr: 'Réservations',     en: 'Bookings' },
  ];

  /* ── SVG icons ── */
  const SVGS = {
    home:     '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>',
    chat:     '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M22 6.667C22 5.194 20.806 4 19.333 4H1.79C1.013 4 .54 4.863.94 5.53L3 9v8.333C3 18.806 4.194 20 5.667 20H19.333C20.806 20 22 18.806 22 17.333V6.667ZM7 10a1 1 0 0 1 1-1h9a1 1 0 1 1 0 2H8a1 1 0 0 1-1-1Zm1 3a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2H8Z"/></svg>',
    messages: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-1 4-7 4.5L5 8V6l7 4.5L19 6v2z"/></svg>',
    calls:    '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1-9.4 0-17-7.6-17-17 0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z"/></svg>',
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
    more:     '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M6 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm12 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm-6 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>',
    dashboard:'<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/></svg>',
    globe:    '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>',
  };

  const path   = location.pathname.replace(/\/$/, '') || '/';
  const logout = `fetch('/api/logout',{method:'POST'}).then(()=>location.href='/login')`;

  /* ══════════════════════════════════════════
     Light Header
  ══════════════════════════════════════════ */
  const headerEl = document.getElementById('app-header');
  if (headerEl) {
    headerEl.className = 'app-header';
    const titles = {
      '/':             { icon: '📊', ar: 'لوحة التحكم',        fr: 'Tableau de bord',   en: 'Dashboard' },
      '/messages':     { icon: '📨', ar: 'الرسائل',            fr: 'Messages',           en: 'Messages' },
      '/calls':        { icon: '📞', ar: 'المكالمات',           fr: 'Appels',             en: 'Calls' },
      '/groups':       { icon: '👥', ar: 'المجموعات',           fr: 'Groupes',            en: 'Groups' },
      '/responses':    { icon: '📋', ar: 'الردود التلقائية',    fr: 'Réponses auto',      en: 'Auto Responses' },
      '/ai-reply':     { icon: '🤖', ar: 'رد ذكي',             fr: 'Réponse IA',         en: 'AI Reply' },
      '/bulk-reply':   { icon: '📤', ar: 'رد جماعي',           fr: 'Envoi groupé',       en: 'Bulk Send' },
      '/images':       { icon: '📸', ar: 'الصور',              fr: 'Photos',             en: 'Photos' },
      '/voices':       { icon: '🎤', ar: 'الصوتيات',           fr: 'Vocaux',             en: 'Voice' },
      '/videos':       { icon: '🎬', ar: 'الفيديوهات',         fr: 'Vidéos',             en: 'Videos' },
      '/notes':        { icon: '📝', ar: 'الملاحظات',          fr: 'Notes',              en: 'Notes' },
      '/qr':           { icon: '📲', ar: 'QR Code',            fr: 'Code QR',            en: 'QR Code' },
      '/sync':         { icon: '🔄', ar: 'مزامنة',             fr: 'Synchronisation',    en: 'Sync' },
      '/facebook':     { icon: '📘', ar: 'فيسبوك',             fr: 'Facebook',           en: 'Facebook' },
      '/widget':       { icon: '🌐', ar: 'ويدجت الموقع',        fr: 'Widget site',        en: 'Site Widget' },
    };
    const meta = titles[path] || { icon: '🤖', ar: 'واتساب بوت', fr: 'WhatsApp Bot', en: 'WhatsApp Bot' };

    const navHTML = LINKS.map(l => {
      const active = l.href === path ? ' class="active"' : '';
      return `<a href="${l.href}"${active} title="${l.en}">${l.icon} ${lv(l.ar, l.fr, l.en, 'nav')}</a>`;
    }).join('');

    headerEl.innerHTML = `
      <div class="hdr-left">
        <div class="hdr-icon">${meta.icon}</div>
        <h1>${lv(meta.ar, meta.fr, meta.en, 'hdr')}</h1>
      </div>
      <nav class="nav-links">
        <a href="/" title="Home / الرئيسية">🏠</a>
        ${navHTML}
        <span id="bot-status-indicator" class="bot-status-dot" title="Bot status">🟢</span>
        <a href="#" class="nav-logout" onclick="${logout}" title="Logout">🚪 <span data-lv="fr" class="lv-fr nav-fr">Déco.</span><span data-lv="en" class="lv-en nav-en">Out</span></a>
      </nav>`;
  }

  /* ══════════════════════════════════════════
     Dark Left-Nav (WhatsApp Web style)
  ══════════════════════════════════════════ */
  const navEl = document.getElementById('app-nav');
  if (navEl) {
    navEl.className = 'app-left-nav';

    const topIcons = [
      { href: '/',          svg: SVGS.home,      ar: 'الرئيسية',          fr: 'Accueil',       en: 'Home' },
      { href: '/chat',      svg: SVGS.chat,      ar: 'الشات',             fr: 'Chat',          en: 'Chat',         badge: true },
      { href: '/messages',  svg: SVGS.messages,  ar: 'الرسائل',           fr: 'Messages',      en: 'Messages' },
      { href: '/calls',     svg: SVGS.calls,     ar: 'المكالمات',          fr: 'Appels',        en: 'Calls' },
      { href: '/responses', svg: SVGS.responses, ar: 'الردود',            fr: 'Réponses',      en: 'Responses' },
      { href: '/notes',     svg: SVGS.notes,     ar: 'الملاحظات',         fr: 'Notes',         en: 'Notes' },
      { href: '/groups',    svg: SVGS.groups,    ar: 'المجموعات',          fr: 'Groupes',       en: 'Groups' },
      { href: '/grp-chat',  svg: SVGS.grpchat,   ar: 'رسائل المجموعات',   fr: 'Msgs groupes',  en: 'Group Msgs' },
      { sep: true },
      { href: '/images',    svg: SVGS.images,    ar: 'الصور',             fr: 'Photos',        en: 'Photos' },
      { href: '/voices',    svg: SVGS.voices,    ar: 'الصوتيات',          fr: 'Vocaux',        en: 'Voice' },
      { href: '/videos',    svg: SVGS.videos,    ar: 'الفيديوهات',        fr: 'Vidéos',        en: 'Videos' },
    ];
    const botIcons = [
      { href: '/qr',   svg: SVGS.qr,   ar: 'QR',      fr: 'QR',   en: 'QR' },
      { href: '/sync', svg: SVGS.sync, ar: 'مزامنة',  fr: 'Sync', en: 'Sync' },
    ];

    function iconHTML(items) {
      return items.map(item => {
        if (item.sep) return '<div class="ln-sep"></div>';
        const active = item.href === path ? ' active' : '';
        const badge  = item.badge ? '<span class="ln-badge" id="lnBadge" style="display:none"></span>' : '';
        const tip    = `${item.ar} · ${item.fr} · ${item.en}`;
        return `<a href="${item.href}" class="ln-icon${active}" title="${tip}">${item.svg}${badge}</a>`;
      }).join('');
    }

    navEl.innerHTML = `
      <div class="ln-top">${iconHTML(topIcons)}</div>
      <div class="ln-bottom">
        <div class="ln-sep"></div>
        ${iconHTML(botIcons)}
        <a href="#" class="ln-icon ln-logout" onclick="${logout}" title="خروج · Déco. · Logout">${SVGS.logout}</a>
      </div>`;
  }

  /* ══════════════════════════════════════════
     Full Sidebar (230px)
  ══════════════════════════════════════════ */
  const sidebarEl = document.getElementById('app-sidebar');
  if (sidebarEl) {
    const SB_SECTIONS = [
      { ar: 'الرئيسية',  fr: 'Accueil',        en: 'Home',          links: [
        { href: '/',               icon: '📊', ar: 'لوحة التحكم',    fr: 'Tableau de bord', en: 'Dashboard' },
      ]},
      { ar: 'التواصل',  fr: 'Communication',   en: 'Messaging',     links: [
        { href: '/chat',           icon: '💬', ar: 'الشات',           fr: 'Chat',            en: 'Chat' },
        { href: '/messages',       icon: '📨', ar: 'الرسائل',         fr: 'Messages',        en: 'Messages' },
        { href: '/calls',          icon: '📞', ar: 'المكالمات',        fr: 'Appels',          en: 'Calls' },
        { href: '/groups',         icon: '👥', ar: 'المجموعات',        fr: 'Groupes',         en: 'Groups' },
        { href: '/grp-chat',       icon: '💬', ar: 'رسائل المجموعات', fr: 'Msgs groupes',    en: 'Group Msgs' },
        { href: '/responses',      icon: '📋', ar: 'الردود',           fr: 'Réponses',        en: 'Responses' },
        { href: '/ai-reply',       icon: '🤖', ar: 'رد ذكي',          fr: 'Réponse IA',      en: 'AI Reply' },
        { href: '/bulk-reply',     icon: '📤', ar: 'رد جماعي',        fr: 'Envoi groupé',    en: 'Bulk Send' },
        { href: '/facebook',       icon: '📘', ar: 'فيسبوك',          fr: 'Facebook',        en: 'Facebook' },
        { href: '/widget',         icon: '🌐', ar: 'ويدجت الموقع',     fr: 'Widget site',     en: 'Site Widget' },
      ]},
      { ar: 'الوسائط',  fr: 'Médias',          en: 'Media',         links: [
        { href: '/images',         icon: '📸', ar: 'الصور',           fr: 'Photos',          en: 'Photos' },
        { href: '/voices',         icon: '🎤', ar: 'الصوتيات',        fr: 'Vocaux',          en: 'Voice' },
        { href: '/videos',         icon: '🎬', ar: 'الفيديوهات',      fr: 'Vidéos',          en: 'Videos' },
      ]},
      { ar: 'الأعمال',  fr: 'Affaires',        en: 'Business',      links: [
        { href: '/bookings-admin', icon: '🏢', ar: 'الحجوزات',        fr: 'Réservations',    en: 'Bookings' },
        { href: '/messenger-bulk', icon: '💬', ar: 'Messenger جماعي', fr: 'Messenger groupé',en: 'Bulk Messenger' },
        { href: '/register',       icon: '📝', ar: 'تسجيل عميل',      fr: 'Inscrire client', en: 'Register Client' },
      ]},
      { ar: 'الإعدادات',fr: 'Paramètres',      en: 'Settings',      links: [
        { href: '/notes',          icon: '📝', ar: 'الملاحظات',       fr: 'Notes',           en: 'Notes' },
        { href: '/qr',             icon: '📲', ar: 'QR Code',         fr: 'Code QR',         en: 'QR Code' },
        { href: '/sync',           icon: '🔄', ar: 'المزامنة',        fr: 'Synchronisation', en: 'Sync' },
      ]},
    ];

    const sbNavHTML = SB_SECTIONS.map(sec => {
      const linksHTML = sec.links.map(l => {
        const active = l.href === path ? ' active' : '';
        return `<a class="sb-link${active}" href="${l.href}">
          <span class="ico">${l.icon}</span>
          <span class="sb-label">${lv(l.ar, l.fr, l.en, 'sb')}</span>
        </a>`;
      }).join('');
      return `<div class="sb-section">${lv(sec.ar, sec.fr, sec.en, 'sb-sec')}</div>${linksHTML}`;
    }).join('');

    sidebarEl.innerHTML = `
      <div class="sb-brand">
        <div class="brand-row">
          <div class="brand-icon">🤖</div>
          <div>
            <h2>واتساب بوت</h2>
            <small style="color:#8696a0;font-size:0.7rem">WhatsApp Bot</small>
          </div>
        </div>
      </div>
      <nav class="sb-nav">${sbNavHTML}</nav>
      <div class="sb-bottom">
        <button class="sb-logout" onclick="${logout}">
          <span>🚪</span>
          ${lv('خروج', 'Déco.', 'Logout', 'sb')}
        </button>
      </div>`;
  }

  /* ══════════════════════════════════════════
     Footer
  ══════════════════════════════════════════ */
  const footerEl = document.getElementById('app-footer');
  if (footerEl) {
    footerEl.className = 'app-footer';
    footerEl.innerHTML = `
      واتساب بوت · WhatsApp Bot &copy; ${new Date().getFullYear()} —
      <a href="/qr">📲 QR</a> ·
      <a href="/chat">💬 الشات · Chat</a> ·
      <a href="/groups">👥 المجموعات · Groupes · Groups</a> ·
      <a href="#" onclick="${logout}">🚪 خروج · Déco. · Logout</a>`;
  }

  /* ══════════════════════════════════════════
     Bottom Navigation Bar
  ══════════════════════════════════════════ */
  const BOT_NAV_ITEMS = [
    { href: '/',         svg: SVGS.dashboard, ar: 'الرئيسية', fr: 'Accueil',  en: 'Home' },
    { href: '/chat',     svg: SVGS.chat,      ar: 'الشات',    fr: 'Chat',     en: 'Chat',     badge: true },
    { href: '/messages', svg: SVGS.messages,  ar: 'الرسائل',  fr: 'Messages', en: 'Messages' },
    { href: '/calls',    svg: SVGS.calls,     ar: 'مكالمات',  fr: 'Appels',   en: 'Calls' },
    { href: '/qr',       svg: SVGS.qr,        ar: 'QR',       fr: 'QR',       en: 'QR' },
  ];

  const bnav = document.createElement('nav');
  bnav.id        = 'app-bottom-nav';
  bnav.className = 'app-bottom-nav';
  bnav.setAttribute('role', 'navigation');
  bnav.setAttribute('aria-label', 'Navigation principale');

  const langCode = { ar: 'عر', fr: 'FR', en: 'EN' };

  bnav.innerHTML = BOT_NAV_ITEMS.map(item => {
    const active = item.href === path ? ' bnav-active' : '';
    const badge  = item.badge ? '<span class="bnav-badge" id="bnavBadge" style="display:none"></span>' : '';
    return `
      <a href="${item.href}" class="bnav-item${active}">
        <div class="bnav-icon-wrap">${item.svg}${badge}</div>
        <span class="bnav-lbl" data-lv="ar">${item.ar}</span>
        <span class="bnav-lbl" data-lv="fr">${item.fr}</span>
        <span class="bnav-lbl" data-lv="en">${item.en}</span>
      </a>`;
  }).join('') + `
    <button class="bnav-item bnav-lang-btn" onclick="window._cycleLang()" title="Changer la langue / Change language / تغيير اللغة">
      <div class="bnav-icon-wrap">${SVGS.globe}</div>
      <span class="bnav-lang-label" id="bnavLangLabel">${langCode[getLang()]}</span>
    </button>`;

  document.body.appendChild(bnav);

  // Sync label after DOM ready
  applyLang(getLang());

})();

/* ══════════════════════════════════════════
   Styles globaux nav
══════════════════════════════════════════ */
const _navStyle = document.createElement('style');
_navStyle.textContent = `

/* ══ LANGUAGE VISIBILITY ════════════════════════════════════════════════════
   All [data-lv] spans are hidden by default.
   The html[data-lang] attribute reveals only the selected language.
   display:revert restores each element's natural default (inline for span, block for div).
══════════════════════════════════════════════════════════════════════════ */
[data-lv] { display: none !important; }
html[data-lang="ar"] [data-lv="ar"]                   { display: revert !important; }
html[data-lang="fr"] [data-lv="fr"],
html:not([data-lang]) [data-lv="fr"]                  { display: revert !important; }
html[data-lang="en"] [data-lv="en"]                   { display: revert !important; }

/* ── Per-element sizing (language-agnostic) ── */
.nav-ar, .nav-fr, .nav-en { font-size: 0.72rem; }
.hdr-ar, .hdr-fr, .hdr-en { font-size: 1rem; }

.sb-sec-ar, .sb-sec-fr, .sb-sec-en {
  font-size: 0.7rem; color: #8696a0; font-weight: 600;
}
.sb-ar, .sb-fr, .sb-en { font-size: 0.82rem; }

.bnav-lbl {
  font-size: 0.62rem;
  font-weight: 600;
  line-height: 1;
  text-align: center;
}

/* ══ BOTTOM NAV ══════════════════════════════════════════════════════════ */
.app-bottom-nav {
  position: fixed;
  bottom: 0; left: 0; right: 0;
  height: 62px;
  background: #202c33;
  border-top: 1px solid rgba(255,255,255,0.08);
  display: flex;
  align-items: stretch;
  z-index: 200;
  box-shadow: 0 -4px 20px rgba(0,0,0,0.3);
  padding-bottom: env(safe-area-inset-bottom);
}

.bnav-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  color: #8696a0;
  text-decoration: none;
  padding: 6px 2px 4px;
  transition: color 0.18s, background 0.18s;
  position: relative;
  -webkit-tap-highlight-color: transparent;
  background: none;
  border: none;
  cursor: pointer;
  font-family: inherit;
}
.bnav-item:hover { background: rgba(255,255,255,0.05); color: #e9edef; }
.bnav-item.bnav-active { color: #00a884; }
.bnav-item.bnav-active::before {
  content: '';
  position: absolute;
  top: 0; left: 20%; right: 20%;
  height: 2px;
  background: #00a884;
  border-radius: 0 0 3px 3px;
}

/* Language switcher button */
.bnav-lang-btn { color: #8696a0; flex: 0.8; }
.bnav-lang-btn:hover { color: #00a884; }

.bnav-lang-label {
  font-size: 0.64rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  line-height: 1;
  text-align: center;
}

.bnav-icon-wrap {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px; height: 24px;
}
.bnav-badge {
  position: absolute;
  top: -3px; right: -5px;
  background: #e53935;
  color: white;
  font-size: 0.52rem; font-weight: 700;
  padding: 1px 4px;
  border-radius: 8px;
  min-width: 14px;
  text-align: center; line-height: 1.4;
}

/* ── Body padding for fixed bottom nav ── */
body { padding-bottom: 62px !important; }

/* ── Bot status dot ── */
.bot-status-dot {
  display: inline-block;
  font-size: 1rem;
  cursor: help;
  animation: bot-pulse 2s ease-in-out infinite;
}
.bot-status-dot.connected    { color: #00a884; }
.bot-status-dot.disconnected { color: #e53935; animation: none; }
@keyframes bot-pulse {
  0%,100% { opacity: 1; }
  50%      { opacity: 0.5; }
}

/* ── Sidebar section header ── */
.sb-section {
  padding: 10px 14px 4px;
  display: block;
}

/* ── Mobile ── */
@media (max-width: 768px) {
  .app-left-nav { display: none !important; }
  .app-bottom-nav { height: 58px; }
  body { padding-bottom: 58px !important; }
}

/* ── Desktop ── */
@media (min-width: 1024px) {
  .app-bottom-nav { height: 56px; }
}
`;
document.head.appendChild(_navStyle);

/* ── HEARTBEAT ─────────────────────────────────────────────────────────── */
(function() {
  const updateStatusIndicator = (connected) => {
    const el = document.getElementById('bot-status-indicator');
    if (!el) return;
    el.classList.toggle('connected', connected);
    el.classList.toggle('disconnected', !connected);
    el.textContent = connected ? '🟢' : '🔴';
    el.title = connected
      ? 'متصل · Connecté · Connected'
      : 'غير متصل · Déconnecté · Disconnected';
  };

  async function checkBotStatus() {
    try {
      const data = await fetch('/api/ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }).then(r => r.json());
      updateStatusIndicator(data.connected === true);
    } catch {
      updateStatusIndicator(false);
    }
  }

  checkBotStatus();
  setInterval(checkBotStatus, 120000);
})();

/* ── Badge synchro (unread count → bottom nav badge) ───────────────────── */
function _syncBnavBadge(count) {
  const bb = document.getElementById('bnavBadge');
  if (!bb) return;
  if (count > 0) {
    bb.textContent = count > 99 ? '99+' : count;
    bb.style.display = 'flex';
    bb.style.alignItems = 'center';
    bb.style.justifyContent = 'center';
  } else {
    bb.style.display = 'none';
  }
}
