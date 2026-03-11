// ── State ─────────────────────────────────────────────────────────────────
let voiceData      = null;
let voiceMime      = null;
let mediaRecorder  = null;
let recordChunks   = [];
let recordInterval = null;
let recordSeconds  = 0;
let inlineStream   = null;
let isSending      = false;
let capturedPhone  = null; // يُحفظ رقم الهاتف عند إيقاف التسجيل

// ── Toggle recording ──────────────────────────────────────────────────────
async function toggleInlineRecord() {
  if (!selectedPhone) return showToast("⚠️ اختر محادثة أولاً");
  if (mediaRecorder?.state === "recording") {
    stopAndSendRecord();
  } else {
    await startInlineRecord();
  }
}

// ── Start recording ───────────────────────────────────────────────────────
async function startInlineRecord() {
  if (isSending) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return showToast("❌ التسجيل يتطلب HTTPS أو localhost");
  }
  try {
    inlineStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    const types = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/ogg",
      "audio/mp4",
    ];
    const detected = types.find(t => {
      try { return MediaRecorder.isTypeSupported(t); } catch { return false; }
    }) || "";

    mediaRecorder = new MediaRecorder(inlineStream, detected ? { mimeType: detected } : {});
    recordChunks  = [];
    voiceMime     = null;
    voiceData     = null;

    mediaRecorder.ondataavailable = e => { if (e.data?.size > 0) recordChunks.push(e.data); };

    mediaRecorder.onerror = () => {
      clearInterval(recordInterval);
      inlineStream?.getTracks().forEach(t => t.stop());
      inlineStream = null;
      showRecNormal();
      showToast("❌ خطأ في التسجيل");
    };

    mediaRecorder.onstop = async () => {
      inlineStream?.getTracks().forEach(t => t.stop());
      inlineStream = null;

      const actualMime = mediaRecorder.mimeType || detected || "audio/webm";
      const blob = new Blob(recordChunks, { type: actualMime });
      voiceMime  = actualMime.split(";")[0];

      if (!blob.size) {
        showRecNormal();
        return showToast("❌ التسجيل فارغ");
      }

      showRecSending();

      const reader = new FileReader();
      reader.onload = async ev => {
        voiceData = ev.target.result.split(",")[1];
        await doSendVoice();
      };
      reader.onerror = () => { showRecNormal(); showToast("❌ خطأ في قراءة الصوت"); };
      reader.readAsDataURL(blob);
    };

    mediaRecorder.start(100);
    recordSeconds = 0;
    showRecActive();

    recordInterval = setInterval(() => {
      recordSeconds++;
      const m = Math.floor(recordSeconds / 60);
      const s = recordSeconds % 60;
      document.getElementById("recTimer").textContent = `${m}:${s.toString().padStart(2, "0")}`;
    }, 1000);

  } catch (err) {
    inlineStream?.getTracks().forEach(t => t.stop());
    inlineStream = null;
    const msgs = {
      NotAllowedError: "❌ تم رفض إذن الميكروفون — اسمح من إعدادات المتصفح",
      NotFoundError:   "❌ لم يُعثر على ميكروفون",
    };
    showToast(msgs[err.name] || `❌ خطأ: ${err.message}`);
  }
}

// ── Stop and send ─────────────────────────────────────────────────────────
function stopAndSendRecord() {
  if (isSending) return;
  if (mediaRecorder?.state !== "recording") return;
  capturedPhone = selectedPhone; // احفظ الرقم الآن قبل أي تغيير
  clearInterval(recordInterval);
  mediaRecorder.stop();
}

// ── Cancel ────────────────────────────────────────────────────────────────
function cancelInlineRecord() {
  if (isSending) return;
  clearInterval(recordInterval);
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.ondataavailable = null;
    mediaRecorder.onstop = null;
    mediaRecorder.stop();
  }
  inlineStream?.getTracks().forEach(t => t.stop());
  inlineStream  = null;
  recordChunks  = [];
  voiceData     = null;
  capturedPhone = null;
  showRecNormal();
}

// ── UI helpers ────────────────────────────────────────────────────────────
function showRecActive() {
  document.getElementById("msgInput").style.display    = "none";
  document.getElementById("attachBtn").style.display   = "none";
  document.getElementById("sendTextBtn").style.display = "none";
  document.getElementById("micBtn").style.display      = "none";
  document.getElementById("recBar").classList.add("active");
  document.getElementById("recBar").querySelector(".rec-label").textContent = "جاري التسجيل...";
  document.getElementById("recBar").querySelector(".rec-dot").style.animationPlayState = "";
  document.getElementById("recCancelBtn").style.display = "flex";
  document.getElementById("recSendBtn").style.display   = "flex";
}

function showRecSending() {
  document.getElementById("recCancelBtn").style.display = "none";
  document.getElementById("recSendBtn").style.display   = "none";
  document.getElementById("recBar").querySelector(".rec-label").textContent = "⏳ جاري الإرسال...";
  document.getElementById("recBar").querySelector(".rec-dot").style.animationPlayState = "paused";
}

function showRecNormal() {
  clearInterval(recordInterval);
  isSending = false;
  document.getElementById("recBar").classList.remove("active");
  document.getElementById("recTimer").textContent        = "0:00";
  document.getElementById("recCancelBtn").style.display  = "none";
  document.getElementById("recSendBtn").style.display    = "none";
  document.getElementById("msgInput").style.display      = "";
  document.getElementById("attachBtn").style.display     = "flex";
  document.getElementById("sendTextBtn").style.display   = "flex";
  document.getElementById("micBtn").style.display        = "flex";
}

// ── Send voice ────────────────────────────────────────────────────────────
async function doSendVoice() {
  const phone = capturedPhone || selectedPhone;
  if (!voiceData || !phone) { showRecNormal(); return; }
  if (isSending) { showRecNormal(); return; }
  isSending = true;

  try {
    const botId = document.getElementById("botSelect")?.value || undefined;
    const res  = await fetch("/api/send-voice", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ phone, data: voiceData, mimetype: voiceMime || "audio/ogg", ...(botId ? { botId } : {}) }),
    });
    const data = await res.json();
    showRecNormal();
    if (data.ok) {
      showToast("✅ تم إرسال الصوت");
      markContactReplied(phone);
      clearUnansweredMarks();
      setTimeout(() => loadMessages(true), 600);
    } else {
      showToast("❌ " + (data.error || "فشل الإرسال"));
    }
  } catch {
    showRecNormal();
    showToast("❌ خطأ في الاتصال");
  } finally {
    voiceData     = null;
    capturedPhone = null;
  }
}
