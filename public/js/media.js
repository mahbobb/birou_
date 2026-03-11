// ── State ─────────────────────────────────────────────────────────────────
let selectedFiles = [];

// ── Modal ─────────────────────────────────────────────────────────────────
function openMediaModal() {
  if (!selectedPhone) return showToast("⚠️ اختر محادثة أولاً");
  selectedFiles = [];
  document.getElementById("mediaTo").textContent    = `إلى: ${selectedName} (+${selectedPhone})`;
  document.getElementById("mediaFileInput").value   = "";
  document.getElementById("fileGrid").style.display = "none";
  document.getElementById("fileGrid").innerHTML     = "";
  document.getElementById("sendProgress").style.display = "none";
  document.getElementById("fileCount").textContent  = "0";
  document.getElementById("dropZone").style.display = "";
  document.getElementById("captionRow").style.display = "none";
  document.getElementById("mediaCaption").value = "";
  document.getElementById("mediaOverlay").classList.add("open");
}

function closeMediaModal() {
  document.getElementById("mediaOverlay").classList.remove("open");
}

document.getElementById("mediaOverlay").addEventListener("click", e => {
  if (e.target === document.getElementById("mediaOverlay")) closeMediaModal();
});

// ── Drop zone ─────────────────────────────────────────────────────────────
const dropZone = document.getElementById("dropZone");

dropZone.addEventListener("dragover",  e => { e.preventDefault(); dropZone.classList.add("drag-over"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", e => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  addFiles(Array.from(e.dataTransfer.files));
});

document.getElementById("mediaFileInput").addEventListener("change", function () {
  addFiles(Array.from(this.files));
  this.value = "";
});

// ── File management ───────────────────────────────────────────────────────
function addFiles(files) {
  files.forEach(file => {
    const entry = {
      file, name: file.name,
      mime: file.type || "application/octet-stream",
      ext: file.name.split(".").pop(),
      data: null, dataUrl: null,
    };
    selectedFiles.push(entry);
    const reader = new FileReader();
    reader.onload = e => {
      entry.dataUrl = e.target.result;
      entry.data    = e.target.result.split(",")[1];
      renderFileGrid();
    };
    reader.readAsDataURL(file);
  });
  document.getElementById("fileCount").textContent = selectedFiles.length;
  if (selectedFiles.length) document.getElementById("dropZone").style.display = "none";
  renderFileGrid();
}

function removeFile(idx) {
  selectedFiles.splice(idx, 1);
  document.getElementById("fileCount").textContent = selectedFiles.length;
  if (!selectedFiles.length) document.getElementById("dropZone").style.display = "";
  renderFileGrid();
}

function renderFileGrid() {
  const grid = document.getElementById("fileGrid");
  if (!selectedFiles.length) { grid.style.display = "none"; grid.innerHTML = ""; return; }
  const hasImages = selectedFiles.some(f => f.mime.startsWith("image/"));
  document.getElementById("captionRow").style.display = hasImages ? "" : "none";
  grid.style.display = "grid";
  grid.innerHTML = selectedFiles.map((f, i) => {
    const isImg    = f.mime.startsWith("image/");
    const isVid    = f.mime.startsWith("video/");
    const preview  = isImg && f.dataUrl ? `<img src="${f.dataUrl}">`
                   : isVid && f.dataUrl ? `<div class="file-overlay">${fileIcon(f.mime)}</div>` : "";
    const shortName = f.name.length > 16 ? f.name.substring(0, 14) + "…" : f.name;
    return `<div class="file-thumb">
      ${preview}
      ${!isImg ? `<div class="file-icon">${fileIcon(f.mime)}</div><div class="file-name">${shortName}</div>` : ""}
      <button class="rm-btn" onclick="removeFile(${i})" title="حذف">✕</button>
    </div>`;
  }).join("");
}

// ── Send files ────────────────────────────────────────────────────────────
async function sendMedia() {
  if (!selectedFiles.length) return showToast("⚠️ اختر ملفاً أولاً");
  if (selectedFiles.some(f => !f.data)) return showToast("⚠️ انتظر حتى يكتمل تحميل الملفات");

  const progress = document.getElementById("sendProgress");
  const bar      = document.getElementById("progressBar");
  const txt      = document.getElementById("progressText");
  const sendBtn  = document.getElementById("mediaSendBtn");

  progress.style.display = "block";
  sendBtn.disabled = true;
  let sent = 0, failed = 0;

  for (let i = 0; i < selectedFiles.length; i++) {
    const f = selectedFiles[i];
    txt.textContent = `جاري إرسال ${i + 1} من ${selectedFiles.length}: ${f.name}`;
    bar.style.width = `${Math.round((i / selectedFiles.length) * 100)}%`;
    try {
      const res = await fetch("/api/send-media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: selectedPhone, data: f.data, mimetype: f.mime, ext: f.ext, filename: f.name }),
      });
      const d = await res.json();
      if (d.ok) sent++; else failed++;
    } catch { failed++; }
  }

  // send caption as text if provided
  const caption = document.getElementById("mediaCaption")?.value?.trim();
  if (caption && sent > 0) {
    try {
      const botId = document.getElementById("botSelect")?.value || undefined;
      await fetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: selectedPhone, message: caption, ...(botId ? { botId } : {}) }),
      });
    } catch { /* non-critical */ }
  }

  bar.style.width = "100%";
  txt.textContent = `✅ تم إرسال ${sent}${failed ? ` · ❌ فشل ${failed}` : ""}`;
  sendBtn.disabled = false;
  if (sent > 0) { markContactReplied(selectedPhone); clearUnansweredMarks(); }
  setTimeout(() => { closeMediaModal(); loadMessages(true); }, 1200);
}
