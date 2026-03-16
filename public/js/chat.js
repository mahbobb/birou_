// ─────────────────────────────────────────
// GLOBAL STATE
// ─────────────────────────────────────────
let selectedPhone = ""
let selectedName = ""
let selectedColor = "#00a884"
let currentViewTab = "msgs"

// ─────────────────────────────────────────
// NOTIFICATION SOUND  (Web Audio API — no file needed)
// ─────────────────────────────────────────
const AC = window.AudioContext || (/** @type {any} */(window)).webkitAudioContext
let _audioCtx = null

// يُفعَّل عند أول تفاعل للمستخدم لتجاوز سياسة autoplay
function unlockAudio() {
  if (!_audioCtx && AC) {
    _audioCtx = new AC()
    if (_audioCtx.state === "suspended") _audioCtx.resume()
  }
  document.removeEventListener("click",   unlockAudio)
  document.removeEventListener("keydown", unlockAudio)
  document.removeEventListener("touchend",unlockAudio)
}
document.addEventListener("click",   unlockAudio, { once: true })
document.addEventListener("keydown", unlockAudio, { once: true })
document.addEventListener("touchend",unlockAudio, { once: true })

function playNotifSound() {
  try {
    if (!_audioCtx) return   // المستخدم لم يتفاعل بعد
    const ctx = _audioCtx
    if (ctx.state === "suspended") ctx.resume()

    // نغمتان متتاليتان مثل WhatsApp
    const notes = [
      { freq: 880,  start: 0,    dur: 0.12 },
      { freq: 1100, start: 0.13, dur: 0.18 },
    ]

    notes.forEach(({ freq, start, dur }) => {
      const osc  = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)

      osc.type = "sine"
      osc.frequency.setValueAtTime(freq, ctx.currentTime + start)

      gain.gain.setValueAtTime(0,    ctx.currentTime + start)
      gain.gain.linearRampToValueAtTime(0.35,  ctx.currentTime + start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur)

      osc.start(ctx.currentTime + start)
      osc.stop(ctx.currentTime  + start + dur + 0.05)
    })
  } catch {}
}

// ─────────────────────────────────────────
// SOCKET.IO
// ─────────────────────────────────────────
const socket = io()

socket.on("new_message", (m) => {

// ── Browser notification for incoming messages ────────────────────────────
if (m.direction === "in") {
  const mKey = String(m.phone || "").replace(/\D/g,"")
  const sKey = (selectedPhone || "").replace(/\D/g,"")
  const isCurrentChat = sKey && (mKey.endsWith(sKey.slice(-9)) || sKey.endsWith(mKey.slice(-9)))
  const isHidden = document.hidden || !isCurrentChat

  if (isHidden) {
    playNotifSound()
  }

  if (isHidden && Notification.permission === "granted") {
    const senderName = m.senderName || m.phone || "رسالة جديدة"
    const body = previewText(m.body || "")
    const notif = new Notification(senderName, {
      body: body || "رسالة جديدة",
      icon: "/favicon.ico",
      tag:  "wa-" + mKey,   // replace older notif from same contact
    })
    notif.onclick = () => {
      window.focus()
      notif.close()
    }
  }
}

if(!selectedPhone) return

const wrap = document.getElementById("messagesWrap")
if(!wrap) return

// match phone
const mKey = String(m.phone || "").replace(/\D/g,"")
const sKey = selectedPhone.replace(/\D/g,"")

if(!mKey.endsWith(sKey.slice(-9)) && !sKey.endsWith(mKey.slice(-9))) return

// prevent duplicate id
const idKey = m.waMsgId || String(m.id || "")
if(idKey && socketSeenId.has(idKey)) return
if(idKey) socketSeenId.add(idKey)

// prevent duplicate content
const minute = Math.floor(new Date(m.created_at).getTime()/60000)
const sig = `${m.direction}|${(m.body||"").trim()}|${minute}`

if(socketSeenSig.has(sig)) return
socketSeenSig.add(sig)

// scroll check
const wasAtBottom =
wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80

wrap.insertAdjacentHTML("beforeend", renderSingleMessage(m))

if(m.direction === "out"){
  markContactReplied(m.phone || selectedPhone)
  clearUnansweredMarks()
} else {
  markUnansweredMessages()
}

if(wasAtBottom) requestAnimationFrame(()=>{ wrap.scrollTop = wrap.scrollHeight })

lastMessageId = m.id || lastMessageId

})

// ─────────────────────────────────────────
// SELECT CONTACT
// ─────────────────────────────────────────
// ─── Mobile: show chat panel, hide sidebar ───────────────────────────────────
function showChatPanel(){
  if(window.innerWidth <= 640){
    const sb = document.getElementById("sidebar")
    const cp = document.getElementById("chatPanel")
    if(sb) sb.classList.add("hidden")
    if(cp) cp.classList.add("show")
  }
}

function backToList(){
  const sb = document.getElementById("sidebar")
  const cp = document.getElementById("chatPanel")
  if(sb) sb.classList.remove("hidden")
  if(cp) cp.classList.remove("show")
}

function selectContact(el){

const phone = el.dataset.phone
const name  = el.dataset.name

selectedPhone = phone
selectedName  = name
selectedColor = avatarColor(name || phone)

lastMessageId = 0
lastDateRendered = ""

socketSeenId.clear()
socketSeenSig.clear()

socket.emit("join", normalizeKey(phone))

setViewTab("msgs")

document.getElementById("noSelection").style.display="none"
document.getElementById("chatView").classList.add("open")
showChatPanel()

const av = document.getElementById("chatAvatar")

av.textContent = (name || phone)[0].toUpperCase()
av.style.background = selectedColor

document.getElementById("chatName").textContent = name || phone
document.getElementById("chatPhone").textContent = "+" + phone

document.querySelectorAll(".contact-item")
.forEach(i=>i.classList.remove("active"))

el.classList.add("active")

loadMessages(true)

}

// ─────────────────────────────────────────
// OPEN CHAT BY PHONE
// ─────────────────────────────────────────
function toggleNewChat(){

const bar = document.getElementById("newChatBar")
const inp = document.getElementById("newChatPhone")
bar.classList.toggle("open")
if(bar.classList.contains("open")){ inp.value=""; inp.focus() }

}

function openByPhone(){

const raw = document.getElementById("newChatPhone").value.trim()

let phone = normalizeOutPhone(raw)

if(!phone || phone.length < 7){

showToast("⚠️ أدخل رقم صحيح")
return

}

selectedPhone = phone
selectedName = phone
selectedColor = avatarColor(phone)

lastMessageId = 0
lastDateRendered = ""

socketSeenId.clear()
socketSeenSig.clear()

socket.emit("join", normalizeKey(phone))

document.getElementById("newChatBar").classList.remove("open")

setViewTab("msgs")

document.getElementById("noSelection").style.display="none"
document.getElementById("chatView").classList.add("open")
showChatPanel()

const av = document.getElementById("chatAvatar")

av.textContent = phone[0]
av.style.background = selectedColor

document.getElementById("chatName").textContent = phone
document.getElementById("chatPhone").textContent = "+"+phone

loadMessages(true)
showToast("📱 فتح محادثة: +"+phone)

}

// ─────────────────────────────────────────
// SEND MESSAGE
// ─────────────────────────────────────────
async function sendText(){

const input = document.getElementById("msgInput")
const text = input.value.trim()

if(!text || !selectedPhone) return

input.value=""
autoResize(input)

try{

const botId = document.getElementById("botSelect")?.value || undefined

const res = await fetch("/api/send",{

method:"POST",

headers:{
"Content-Type":"application/json"
},

body:JSON.stringify({
phone:selectedPhone,
message:text,
...(botId ? { botId } : {})
})

})

const data = await res.json()

if(data.ok){

showToast("✅ تم الإرسال")
markContactReplied(selectedPhone)
clearUnansweredMarks()
setTimeout(()=>loadMessages(true),500)

}else{

showToast("❌ "+(data.error || "فشل"))

}

}catch{

showToast("❌ خطأ في الاتصال")

}

}

// ─────────────────────────────────────────
// ENTER KEY SEND
// ─────────────────────────────────────────
function handleKey(e){

if(e.key==="Enter" && !e.shiftKey){

e.preventDefault()
sendText()

}

}

// ─────────────────────────────────────────
// AUTO RESIZE TEXTAREA
// ─────────────────────────────────────────
function autoResize(el){
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 130) + "px";
  // إظهار زر الإرسال أو الميكروفون حسب وجود نص
  const sendBtn = document.getElementById("sendTextBtn");
  const micBtn  = document.getElementById("micBtn");
  if (!sendBtn || !micBtn) return;
  const hasText = el.value.trim().length > 0;
  sendBtn.style.display = hasText ? "flex" : "none";
  micBtn.style.display  = hasText ? "none" : "flex";
}

// ─────────────────────────────────────────
// EMOJI PICKER
// ─────────────────────────────────────────
const EP_CATS = [
  ["😀","😃","😄","😁","😆","😅","😂","🤣","😊","😇","🙂","🙃","😉","😌","😍","🥰","😘","😗","😙","😚","😋","😛","😝","😜","🤪","🤨","🧐","🤓","😎","🤩","🥳","😏","😒","😞","😔","😟","😕","🙁","☹️","😣","😖","😫","😩","🥺","😢","😭","😤","😠","😡","🤬","🤯","😳","🥵","🥶","😱","😨","😰","😥","😓","🤗","🤔","🤭","🤫","🤥","😶","😐","😑","😬","🙄","😯","😦","😧","😮","😲","🥱","😴","🤤","😪","😵","🤐","🥴","🤢","🤮","🤧","😷","🤒","🤕","🤑","🤠"],
  ["❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔","❣️","💕","💞","💓","💗","💖","💘","💝","💟","☮️","✝️","☯️","🕉️","☪️","🔯","✡️","🛐","⛎","♈","♉","♊","♋","♌","♍","♎","♏","♐","♑","♒","♓","🆔","⚛️","🉑","☢️","☣️","📴","📳","🈶","🈚","🈸","🈺","🈷️","✴️","🆚","💮","🉐","㊙️","㊗️","🈴","🈵","🈹","🈲","🅰️","🅱️","🆎","🆑","🅾️","🆘","❌","⭕","🛑","⛔"],
  ["👋","🤚","🖐️","✋","🖖","👌","🤌","🤏","✌️","🤞","🤟","🤘","🤙","👈","👉","👆","🖕","👇","☝️","👍","👎","✊","👊","🤛","🤜","👏","🙌","👐","🤲","🤝","🙏","✍️","💅","🤳","💪","🦾","🦿","🦵","🦶","👂","🦻","👃","🫀","🫁","🧠","🦷","🦴","👀","👁️","👅","👄","💋","🫦","🧑","👱","👩","👨","🧔","👴","👵","🧓","👶","🍼","🎅","🤶","🧑‍🎄"],
  ["🏠","🏡","🏢","🏣","🏤","🏥","🏦","🏨","🏩","🏪","🏫","🏬","🏭","🏯","🏰","💒","🗼","🗽","⛪","🕌","🛕","🕍","⛩️","🕋","⛲","⛺","🌁","🌃","🏙️","🌄","🌅","🌆","🌇","🌉","♨️","🌌","🌠","🎇","🎆","🌈","🏔️","⛰️","🌋","🗻","🏕️","🏖️","🏜️","🏝️","🏞️","🏟️","🏛️","🏗️","🧱","⛽","🛞","🚨","🚥","🚦","🛑","🚧","⚓","🛟","⛵","🚤","🛥️","🛳️","⛴️","🚢","✈️","🛩️","🛫","🛬","🪂","💺"],
  ["🌍","🌎","🌏","🌐","🗺️","🧭","🌑","🌒","🌓","🌔","🌕","🌖","🌗","🌘","🌙","🌚","🌛","🌜","🌝","🌞","🪐","⭐","🌟","💫","✨","☄️","🌤️","⛅","🌥️","☁️","🌦️","🌧️","⛈️","🌩️","🌨️","❄️","☃️","⛄","🌬️","💨","🌀","🌈","🌂","☂️","☔","⛱️","⚡","🌱","🌿","☘️","🍀","🎋","🎍","🍃","🍂","🍁","🌾","🌺","🌸","🌼","🌻","🌞","🌹","🥀","🌷","💐","🍄","🌰","🦔","🐾","🌵","🎄"],
];

let epCatIdx = 0;

function showEpCat(i) {
  epCatIdx = i;
  document.querySelectorAll(".ep-tab").forEach((t, j) => t.classList.toggle("active", j === i));
  const grid = document.getElementById("epGrid");
  grid.innerHTML = EP_CATS[i].map(e =>
    `<button class="ep-emoji" onclick="insertEmoji('${e}')">${e}</button>`
  ).join("");
}

function toggleEmojiPicker(btn) {
  const picker = document.getElementById("emojiPicker");
  const isOpen = picker.classList.contains("open");
  picker.classList.toggle("open", !isOpen);
  if (!isOpen) {
    showEpCat(epCatIdx);
    // ضع البانيل فوق زر الإيموجي
    const rect = btn.getBoundingClientRect();
    picker.style.bottom = (window.innerHeight - rect.top + 6) + "px";
    picker.style.right  = (window.innerWidth - rect.right - 40) + "px";
  }
}

function insertEmoji(e) {
  const ta = document.getElementById("msgInput");
  if (!ta) return;
  const s = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? s;
  ta.value = ta.value.slice(0, s) + e + ta.value.slice(end);
  ta.focus();
  ta.selectionStart = ta.selectionEnd = s + e.length;
  autoResize(ta);
}

// أغلق البانيل عند الضغط خارجه
document.addEventListener("click", e => {
  if (!e.target.closest("#emojiPicker") && !e.target.closest(".wa-emoji-btn"))
    document.getElementById("emojiPicker")?.classList.remove("open");
});

// ─────────────────────────────────────────
// QUICK REPLIES
// ─────────────────────────────────────────
let _qrAll = [];

async function loadQuickReplies() {
  try {
    const data = await fetch("/api/responses").then(r => r.json());
    _qrAll = (data.responses || []).filter(r => r.reply);
    renderQuickReplies(_qrAll);
  } catch { renderQuickReplies([]); }
}

function renderQuickReplies(list) {
  const el = document.getElementById("qrList");
  if (!el) return;
  if (!list.length) {
    el.innerHTML = `<div class="qr-empty">لا توجد ردود محفوظة<br><small>اضغط "+ جديد" لإضافة رد</small></div>`;
    return;
  }
  el.innerHTML = list.map((r, i) => {
    const reply = Array.isArray(r.reply) ? r.reply[0] : (r.reply || "");
    const kws = (r.keywords || []).join(", ");
    return `
      <div class="qr-item" onclick="insertQuickReply(${i})">
        <span class="qr-item-icon">💬</span>
        <div class="qr-item-body">
          <div class="qr-item-reply">${escHtml(reply)}</div>
          ${kws ? `<div class="qr-item-kw">${escHtml(kws)}</div>` : ""}
        </div>
        <button class="qr-item-send" onclick="event.stopPropagation();sendQuickReply(${i})">إرسال</button>
      </div>`;
  }).join("");
}

function filterQuickReplies() {
  const q = (document.getElementById("qrSearch")?.value || "").toLowerCase();
  if (!q) { renderQuickReplies(_qrAll); return; }
  const filtered = _qrAll.filter(r => {
    const reply = Array.isArray(r.reply) ? r.reply.join(" ") : (r.reply || "");
    return reply.toLowerCase().includes(q) ||
      (r.keywords || []).some(k => k.toLowerCase().includes(q));
  });
  renderQuickReplies(filtered);
}

function insertQuickReply(i) {
  const r = _qrAll[i];
  if (!r) return;
  const reply = Array.isArray(r.reply) ? r.reply[0] : (r.reply || "");
  const ta = document.getElementById("msgInput");
  if (ta) { ta.value = reply; autoResize(ta); ta.focus(); }
  closeQuickReplies();
}

async function sendQuickReply(i) {
  const r = _qrAll[i];
  if (!r || !selectedPhone) return showToast("⚠️ اختر محادثة أولاً");
  const reply = Array.isArray(r.reply) ? r.reply[0] : (r.reply || "");
  closeQuickReplies();
  const ta = document.getElementById("msgInput");
  if (ta) ta.value = reply;
  await sendText();
}

function toggleQuickReplies(e) {
  if (e) e.stopPropagation();
  const panel = document.getElementById("quickRepliesPanel");
  const btn   = document.getElementById("qrToggleBtn");
  if (!panel || !btn) return;

  const isOpen = panel.classList.contains("open");
  panel.classList.toggle("open", !isOpen);

  if (!isOpen) {
    // حسب موضع الزر
    const rect = btn.getBoundingClientRect();
    panel.style.bottom = (window.innerHeight - rect.top + 8) + "px";
    panel.style.left   = rect.left + "px";
    loadQuickReplies();
    const search = document.getElementById("qrSearch");
    if (search) { search.value = ""; search.focus(); }
  }
}

function closeQuickReplies() {
  document.getElementById("quickRepliesPanel")?.classList.remove("open");
}

function openAddReplyModal() {
  closeQuickReplies();
  document.getElementById("arKeywords").value = "";
  document.getElementById("arReply").value = "";
  document.getElementById("addReplyOverlay").style.display = "flex";
}

function closeAddReplyModal() {
  document.getElementById("addReplyOverlay").style.display = "none";
}

async function saveQuickReply() {
  const keywords = document.getElementById("arKeywords").value.trim();
  const reply    = document.getElementById("arReply").value.trim();
  if (!reply) return showToast("⚠️ اكتب نص الرد");
  try {
    const body = { reply, keywords: keywords || "عام" };
    const d = await fetch("/api/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(r => r.json());
    if (d.ok) {
      showToast("✅ تم حفظ الرد");
      closeAddReplyModal();
    } else {
      showToast("❌ " + (d.error || "خطأ"));
    }
  } catch { showToast("❌ فشل الاتصال"); }
}

// أغلق panel عند الضغط خارجه
document.addEventListener("click", e => {
  const panel = document.getElementById("quickRepliesPanel");
  if (!panel?.classList.contains("open")) return;
  if (!e.target.closest("#quickRepliesPanel") && !e.target.closest("#qrToggleBtn")) {
    closeQuickReplies();
  }
});

// ─────────────────────────────────────────
// VIEW TABS
// ─────────────────────────────────────────
function setViewTab(tab) {
  currentViewTab = tab;

  const isMsgs = tab === "msgs" || tab === "msgs-in" || tab === "msgs-out";

  document.querySelectorAll(".chat-tab-btn").forEach(btn => {
    const onc = btn.getAttribute("onclick") || "";
    // Use exact match: setViewTab('msgs') should not activate setViewTab('msgs-in')
    const match = onc.match(/setViewTab\('([^']+)'\)/);
    btn.classList.toggle("active", match ? match[1] === tab : false);
  });

  document.getElementById("messagesWrap").style.display = isMsgs ? "" : "none";
  document.getElementById("chatInputBar").style.display = isMsgs ? "" : "none";
  document.getElementById("imgsPanel").classList.toggle("show", tab === "imgs");
  document.getElementById("vidsPanel").classList.toggle("show", tab === "vids");
  document.getElementById("audsPanel").classList.toggle("show", tab === "auds");

  // فرز الرسائل
  if (typeof setMsgFilter === "function") {
    if (tab === "msgs-in")  setMsgFilter("in");
    else if (tab === "msgs-out") setMsgFilter("out");
    else setMsgFilter("all");
  }

  if (isMsgs) { loadMessages(false); return; }
  if (tab === "imgs") loadImagesPanel();
  if (tab === "vids") loadVideosPanel();
  if (tab === "auds") loadVoicesPanel();
}

// ─────────────────────────────────────────
// IMAGES PANEL
// ─────────────────────────────────────────
async function loadImagesPanel(){

if(!selectedPhone) return

const grid = document.getElementById("imgsGrid")
grid.innerHTML = `<div class="media-empty" style="grid-column:1/-1">⏳ جاري التحميل...</div>`

try{

const res = await fetch(`/api/images?phone=${encodeURIComponent(selectedPhone)}&limit=200`)
const imgs = await res.json()

if(!imgs.length){
grid.innerHTML=`<div class="media-empty" style="grid-column:1/-1">📷 لا توجد صور لهذا الزبون</div>`
return
}

grid.innerHTML = imgs.map(img=>{
const src = `/uploads/images/${escHtml(img.filename)}`
const note = img.note ? `<span class="m-note">${escHtml(img.note)}</span>` : ""
const date = new Date(img.created_at).toLocaleDateString("ar-MA",{day:"numeric",month:"short"})
return `<div class="media-thumb" onclick="openLightbox('${src}')" title="${date}">
  <img src="${src}" loading="lazy">
  ${note}
</div>`
}).join("")

}catch{

grid.innerHTML=`<div class="media-empty" style="grid-column:1/-1">❌ خطأ في تحميل الصور</div>`

}

}

// ─────────────────────────────────────────
// VIDEOS PANEL
// ─────────────────────────────────────────
async function loadVideosPanel(){

if(!selectedPhone) return

const grid = document.getElementById("vidsGrid")
grid.innerHTML = `<div class="media-empty" style="grid-column:1/-1">⏳ جاري التحميل...</div>`

try{

const res = await fetch(`/api/videos?phone=${encodeURIComponent(selectedPhone)}&limit=100`)
const vids = await res.json()

if(!vids.length){
grid.innerHTML=`<div class="media-empty" style="grid-column:1/-1">🎬 لا توجد فيديوهات لهذا الزبون</div>`
return
}

grid.innerHTML = vids.map(v=>{
const src = `/uploads/videos/${escHtml(v.filename)}`
const note = v.note ? `<span class="m-note">${escHtml(v.note)}</span>` : ""
const date = new Date(v.created_at).toLocaleDateString("ar-MA",{day:"numeric",month:"short"})
return `<div class="media-thumb" title="${date}" onclick="openVideoModal('${src}')">
  <video src="${src}" preload="metadata"></video>
  <span class="m-play">▶️</span>
  ${note}
</div>`
}).join("")

}catch{

grid.innerHTML=`<div class="media-empty" style="grid-column:1/-1">❌ خطأ في تحميل الفيديوهات</div>`

}

}

// ─────────────────────────────────────────
// VOICES PANEL
// ─────────────────────────────────────────
async function loadVoicesPanel(){
  if(!selectedPhone) return
  const grid = document.getElementById("audsGrid")
  grid.innerHTML = `<div class="media-empty" style="grid-column:1/-1">⏳ جاري التحميل...</div>`
  try{
    const res  = await fetch(`/api/voices?phone=${encodeURIComponent(selectedPhone)}&limit=200`)
    const list = await res.json()
    if(!list.length){
      grid.innerHTML = `<div class="media-empty" style="grid-column:1/-1">🎤 لا توجد رسائل صوتية</div>`
      return
    }
    grid.innerHTML = list.map(v => {
      const src  = `/uploads/voices/${escHtml(v.filename)}`
      const date = new Date(v.created_at).toLocaleDateString("ar-MA",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})
      const dir  = v.direction === "outgoing" ? "📤" : "📥"
      return `<div class="voice-item">
        <div class="voice-item-meta">${dir} ${date}</div>
        <audio controls src="${src}" preload="none" style="width:100%;max-width:320px;height:36px;"></audio>
      </div>`
    }).join("")
  }catch{
    grid.innerHTML = `<div class="media-empty" style="grid-column:1/-1">❌ خطأ في تحميل الصوتيات</div>`
  }
}

// ─────────────────────────────────────────
// VIDEO MODAL
// ─────────────────────────────────────────
function openVideoModal(src){

const existing = document.getElementById("videoModal")
if(existing) existing.remove()

const el = document.createElement("div")
el.id = "videoModal"
el.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:500;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;"
el.innerHTML = `
  <video src="${escHtml(src)}" controls autoplay style="max-width:92vw;max-height:85vh;border-radius:6px;box-shadow:0 4px 24px rgba(0,0,0,0.5)"></video>
  <button onclick="this.closest('#videoModal').remove()" style="background:rgba(255,255,255,0.15);border:none;color:white;font-size:1.1rem;padding:8px 22px;border-radius:8px;cursor:pointer;">✕ إغلاق</button>`

el.addEventListener("click", e=>{ if(e.target===el) el.remove() })
document.body.appendChild(el)

document.addEventListener("keydown", function onKey(e){
if(e.key==="Escape"){ el.remove(); document.removeEventListener("keydown",onKey) }
})

}

// ─────────────────────────────────────────
// QUICK RESPONSE MODAL
// ─────────────────────────────────────────
function openResponseModal(){
  document.getElementById("qrKeywords").value = ""
  document.getElementById("qrReply").value = ""
  document.getElementById("qrOverlay").classList.add("open")
  document.getElementById("qrKeywords").focus()
}

function closeResponseModal(){
  document.getElementById("qrOverlay").classList.remove("open")
}

async function saveQuickResponse(){
  const keywords = document.getElementById("qrKeywords").value.trim()
  const reply    = document.getElementById("qrReply").value.trim()

  if(!reply) return showToast("⚠️ اكتب نص الرد")
  if(!keywords) return showToast("⚠️ اكتب كلمة مفتاحية واحدة على الأقل")

  try{
    const res = await fetch("/api/responses",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ keywords, reply })
    })
    const data = await res.json()
    if(data.ok){
      showToast("✅ تم حفظ الرد المبرمج")
      closeResponseModal()
    }else{
      showToast("❌ "+(data.error||"خطأ في الحفظ"))
    }
  }catch{
    showToast("❌ خطأ في الاتصال")
  }
}

document.getElementById("qrOverlay").addEventListener("click", e=>{
  if(e.target === document.getElementById("qrOverlay")) closeResponseModal()
})

document.addEventListener("keydown", e=>{
  if(e.key==="Escape" && document.getElementById("qrOverlay").classList.contains("open")){
    closeResponseModal()
  }
})

// ─────────────────────────────────────────
// LOGOUT
// ─────────────────────────────────────────
function logout(){
  fetch("/api/logout",{method:"POST"})
  .then(()=>location.href="/login")
}

// ─────────────────────────────────────────
// DELETE CHAT
// ─────────────────────────────────────────
async function deleteChat() {
  if (!selectedPhone) return;
  const name = selectedName || selectedPhone;
  if (!confirm(`هل تريد حذف محادثة "${name}" نهائياً؟\nسيتم حذف جميع الرسائل.`)) return;
  try {
    const res  = await fetch(`/api/contacts/${encodeURIComponent(selectedPhone)}`, { method: "DELETE" });
    const data = await res.json();
    if (data.ok) {
      showToast("🗑 تم حذف المحادثة");
      selectedPhone = "";
      selectedName  = "";
      document.getElementById("chatView").classList.remove("open");
      document.getElementById("noSelection").style.display = "";
      backToList();
      loadContacts();
    } else {
      showToast("❌ " + (data.error || "فشل الحذف"));
    }
  } catch {
    showToast("❌ خطأ في الاتصال");
  }
}

// ─────────────────────────────────────────
// WHATSAPP CALL
// ─────────────────────────────────────────
function startCall(callType) {
  if (!selectedPhone) return showToast("⚠️ اختر محادثة أولاً");
  // بناء رقم بصيغة دولية
  let p = String(selectedPhone).replace(/\D/g, "");
  if (p.startsWith("00")) p = p.slice(2);
  if (p.length === 9 && /^[5-7]/.test(p)) p = "212" + p;
  if (p.length === 10 && p.startsWith("0"))  p = "212" + p.slice(1);
  // wa.me يفتح واتساب (web أو تطبيق) لبدء مكالمة
  const url = callType === "video"
    ? `https://wa.me/${p}?video=1`
    : `https://wa.me/${p}`;
  window.open(url, "_blank");
}

// ─────────────────────────────────────────
// PASTE IMAGE FROM CLIPBOARD
// ─────────────────────────────────────────
document.getElementById("msgInput").addEventListener("paste", e => {
  const items = Array.from(e.clipboardData?.items || []);
  const imageItems = items.filter(i => i.kind === "file" && i.type.startsWith("image/"));
  if (!imageItems.length) return;
  if (!selectedPhone) return showToast("⚠️ اختر محادثة أولاً");
  e.preventDefault();
  const files = imageItems.map(i => i.getAsFile()).filter(Boolean);
  openMediaModal();
  setTimeout(() => addFiles(files), 80);
});

// ─────────────────────────────────────────
// INIT
// ─────────────────────────────────────────

// Request browser notification permission
if ("Notification" in window && Notification.permission === "default") {
  Notification.requestPermission()
}

loadContacts()

setInterval(loadContacts,10000)

setInterval(()=>{
  if (currentViewTab !== "msgs") return;

  // pause while user is typing
  const input = document.getElementById("msgInput");
  if (input && input.value.trim()) return;

  // pause while any audio is playing
  const anyPlaying = Array.from(document.querySelectorAll("audio")).some(a => !a.paused);
  if (anyPlaying) return;

  loadMessages();
}, 8000)
