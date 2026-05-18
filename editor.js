/* ── Kit Screenshot Editor – editor.js ──────────────────────────────────── */

(async function () {
  // ── Setup ─────────────────────────────────────────────────────────────────
  const params = new URLSearchParams(location.search);
  const captureId = params.get('id');

  const loadingScreen = document.getElementById('loading-screen');
  const canvas = document.getElementById('main-canvas');
  const previewCanvas = document.getElementById('preview-canvas');
  const wrap = document.getElementById('canvas-wrap');
  const ctx = canvas.getContext('2d');
  const previewCtx = previewCanvas.getContext('2d');
  const textInput = document.getElementById('text-input');
  const premNag = document.getElementById('premium-nag');
  const CAPTURE_DB_NAME = 'kit-capture-db';
  const CAPTURE_DB_STORE = 'captures';
  const MAX_EDITOR_SIDE = 32000;
  const MAX_EDITOR_PIXELS = 36_000_000;

  let isPremium = false;
  let currentTool = 'select';
  let strokeColor = '#e63946';
  let fillColor = 'transparent';
  let strokeSize = 3;
  let fontSize = 24;
  let defaultFormat = 'png';
  let filenameTemplate = 'kit-{date}-{time}';
  let captureMeta = {};

  // Undo/redo snapshots as PNG blobs
  let historySnapshots = [];
  let historyIndex = -1;
  let maxHistorySnapshots = 10;
  let historyBusy = false;

  let isDrawing = false;
  let movedSinceDown = false;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function buildFilename(ext) {
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
    const timeStr = `${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}`;
    const template = typeof filenameTemplate === 'string' && filenameTemplate.trim()
      ? filenameTemplate.trim()
      : 'kit-{date}-{time}';
    const raw = template
      .replaceAll('{title}', String(captureMeta.title || ''))
      .replaceAll('{date}', dateStr)
      .replaceAll('{time}', timeStr)
      .replaceAll('{url}', String(captureMeta.url || ''));
    const safe = raw
      .replace(/[\\/:*?"<>|\u0000-\u001F]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || `kit-${dateStr}-${timeStr}`;
    return `${safe}.${ext}`;
  }

  function getHistoryLimitByPixels(width, height) {
    const pixels = width * height;
    if (pixels <= 2_000_000) return 20;
    if (pixels <= 8_000_000) return 14;
    if (pixels <= 16_000_000) return 10;
    if (pixels <= 24_000_000) return 7;
    return 5;
  }

  function resizeCanvases(width, height) {
    canvas.width = width;
    canvas.height = height;
    previewCanvas.width = width;
    previewCanvas.height = height;
    previewCanvas.style.width = `${width}px`;
    previewCanvas.style.height = `${height}px`;
    maxHistorySnapshots = getHistoryLimitByPixels(width, height);
  }

  function clearPreview() {
    previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  }

  function openCaptureDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(CAPTURE_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(CAPTURE_DB_STORE)) {
          db.createObjectStore(CAPTURE_DB_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Failed to open capture DB'));
    });
  }

  async function idbTakeCaptureRecord(id) {
    const db = await openCaptureDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(CAPTURE_DB_STORE, 'readwrite');
        const store = tx.objectStore(CAPTURE_DB_STORE);
        const getReq = store.get(id);
        let record = null;
        getReq.onsuccess = () => {
          record = getReq.result || null;
          if (record) store.delete(id);
        };
        getReq.onerror = () => reject(getReq.error || new Error('Failed to read capture'));
        tx.oncomplete = () => resolve(record);
        tx.onerror = () => reject(tx.error || new Error('Failed to read capture'));
        tx.onabort = () => reject(tx.error || new Error('Failed to read capture'));
      });
    } finally {
      db.close();
    }
  }

  async function loadEditorSettings() {
    try {
      const prefs = await chrome.storage.local.get(['defaultFormat', 'filenameTemplate']);
      const rawFormat = String(prefs.defaultFormat || 'png').toLowerCase();
      const normalized = rawFormat === 'jpeg' ? 'jpg' : rawFormat;
      if (!isPremium && (normalized === 'jpg' || normalized === 'pdf')) {
        defaultFormat = 'png';
      } else if (['png', 'jpg', 'pdf'].includes(normalized)) {
        defaultFormat = normalized;
      } else {
        defaultFormat = 'png';
      }
      filenameTemplate = (!isPremium && prefs.filenameTemplate && prefs.filenameTemplate !== 'kit-{date}-{time}')
        ? 'kit-{date}-{time}'
        : (prefs.filenameTemplate || 'kit-{date}-{time}');
    } catch (e) {
      defaultFormat = 'png';
      filenameTemplate = 'kit-{date}-{time}';
    }
  }

  function isEditorSizeSafe(width, height) {
    return width > 0 &&
      height > 0 &&
      width <= MAX_EDITOR_SIDE &&
      height <= MAX_EDITOR_SIDE &&
      width * height <= MAX_EDITOR_PIXELS;
  }

  // ── Load screenshot from IndexedDB ─────────────────────────────────────────
  async function loadCapture() {
    if (!captureId) { showError('No capture ID found.'); return; }
    try {
      const rec = await idbTakeCaptureRecord(captureId);
      if (!rec || !rec.blob) { showError('Screenshot data not found.'); return; }
      captureMeta = rec.meta || {};

      const bitmap = await createImageBitmap(rec.blob);
      const { width, height } = bitmap;
      if (!isEditorSizeSafe(width, height)) {
        bitmap.close();
        showError('This capture is too large to edit safely. Reduce page zoom and capture again.');
        return;
      }

      resizeCanvases(width, height);
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      await pushHistorySnapshot();
      loadingScreen.classList.add('hidden');
    } catch (e) {
      showError('Failed to load screenshot: ' + e.message);
    }
  }

  // ── Premium check ──────────────────────────────────────────────────────────
  async function checkPremium() {
    try {
      const resp = await sendMsg({ action: 'get_status' });
      isPremium = resp.premium || false;
    } catch (e) {
      isPremium = false;
    }
  }

  // ── Undo / Redo (blob snapshots) ───────────────────────────────────────────
  async function pushHistorySnapshot() {
    if (!canvas.width || !canvas.height || historyBusy) return;
    historyBusy = true;
    try {
      const blob = await canvasToBlob('image/png');
      if (historyIndex < historySnapshots.length - 1) {
        historySnapshots = historySnapshots.slice(0, historyIndex + 1);
      }
      historySnapshots.push(blob);

      while (historySnapshots.length > maxHistorySnapshots) {
        historySnapshots.shift();
      }
      historyIndex = historySnapshots.length - 1;
      updateUndoButtons();
    } finally {
      historyBusy = false;
    }
  }

  async function restoreHistorySnapshot(index) {
    const blob = historySnapshots[index];
    if (!blob) return;
    const bitmap = await createImageBitmap(blob);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
  }

  async function undo() {
    if (historyBusy || historyIndex <= 0) return;
    historyBusy = true;
    try {
      historyIndex--;
      await restoreHistorySnapshot(historyIndex);
      updateUndoButtons();
    } finally {
      historyBusy = false;
    }
  }

  async function redo() {
    if (historyBusy || historyIndex >= historySnapshots.length - 1) return;
    historyBusy = true;
    try {
      historyIndex++;
      await restoreHistorySnapshot(historyIndex);
      updateUndoButtons();
    } finally {
      historyBusy = false;
    }
  }

  function updateUndoButtons() {
    document.getElementById('btn-undo').disabled = historyIndex <= 0 || historyBusy;
    document.getElementById('btn-redo').disabled = historyIndex < 0 || historyIndex >= historySnapshots.length - 1 || historyBusy;
  }

  // ── Drawing helpers ────────────────────────────────────────────────────────
  function setDrawStyles(targetCtx = ctx) {
    targetCtx.strokeStyle = strokeColor;
    targetCtx.fillStyle = fillColor === 'transparent' ? 'rgba(0,0,0,0)' : fillColor;
    targetCtx.lineWidth = strokeSize;
    targetCtx.lineCap = 'round';
    targetCtx.lineJoin = 'round';
  }

  function canvasPos(e) {
    const r = canvas.getBoundingClientRect();
    const scaleX = canvas.width / r.width;
    const scaleY = canvas.height / r.height;
    return {
      x: (e.clientX - r.left) * scaleX,
      y: (e.clientY - r.top) * scaleY
    };
  }

  function clampToCanvas(x, y) {
    return {
      x: Math.max(0, Math.min(canvas.width, x)),
      y: Math.max(0, Math.min(canvas.height, y))
    };
  }

  // ── Blur / pixelate region ─────────────────────────────────────────────────
  function blurRegion(x, y, w, h) {
    const px = 12; // pixelation block size
    const imgData = ctx.getImageData(x, y, w, h);
    const d = imgData.data;
    for (let by = 0; by < h; by += px) {
      for (let bx = 0; bx < w; bx += px) {
        let r = 0;
        let g = 0;
        let b = 0;
        let cnt = 0;
        for (let dy = 0; dy < px && by + dy < h; dy++) {
          for (let dx = 0; dx < px && bx + dx < w; dx++) {
            const i = ((by + dy) * w + (bx + dx)) * 4;
            r += d[i];
            g += d[i + 1];
            b += d[i + 2];
            cnt++;
          }
        }
        r = Math.round(r / cnt);
        g = Math.round(g / cnt);
        b = Math.round(b / cnt);
        for (let dy = 0; dy < px && by + dy < h; dy++) {
          for (let dx = 0; dx < px && bx + dx < w; dx++) {
            const i = ((by + dy) * w + (bx + dx)) * 4;
            d[i] = r;
            d[i + 1] = g;
            d[i + 2] = b;
          }
        }
      }
    }
    ctx.putImageData(imgData, x, y);
  }

  // ── Draw arrow ─────────────────────────────────────────────────────────────
  function drawArrow(targetCtx, x1, y1, x2, y2) {
    const headLen = Math.max(12, strokeSize * 4);
    const angle = Math.atan2(y2 - y1, x2 - x1);
    targetCtx.beginPath();
    targetCtx.moveTo(x1, y1);
    targetCtx.lineTo(x2, y2);
    targetCtx.stroke();
    targetCtx.beginPath();
    targetCtx.moveTo(x2, y2);
    targetCtx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
    targetCtx.moveTo(x2, y2);
    targetCtx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
    targetCtx.stroke();
  }

  function drawShapePreview(pos) {
    clearPreview();
    setDrawStyles(previewCtx);

    if (currentTool === 'rect') {
      const w = pos.x - startX;
      const h = pos.y - startY;
      previewCtx.beginPath();
      previewCtx.rect(startX, startY, w, h);
      if (fillColor !== 'transparent') previewCtx.fill();
      previewCtx.stroke();
    } else if (currentTool === 'ellipse') {
      const rx = Math.abs(pos.x - startX) / 2;
      const ry = Math.abs(pos.y - startY) / 2;
      const cx = startX + (pos.x - startX) / 2;
      const cy = startY + (pos.y - startY) / 2;
      previewCtx.beginPath();
      previewCtx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      if (fillColor !== 'transparent') previewCtx.fill();
      previewCtx.stroke();
    } else if (currentTool === 'arrow') {
      drawArrow(previewCtx, startX, startY, pos.x, pos.y);
    } else if (currentTool === 'blur') {
      const x = Math.min(startX, pos.x);
      const y = Math.min(startY, pos.y);
      const w = Math.abs(pos.x - startX);
      const h = Math.abs(pos.y - startY);
      previewCtx.save();
      previewCtx.setLineDash([4, 4]);
      previewCtx.strokeStyle = '#ffffff';
      previewCtx.lineWidth = 1.5;
      previewCtx.strokeRect(x, y, w, h);
      previewCtx.restore();
    }
  }

  function applyShapeFinal(pos) {
    setDrawStyles(ctx);
    if (currentTool === 'rect') {
      const w = pos.x - startX;
      const h = pos.y - startY;
      ctx.beginPath();
      ctx.rect(startX, startY, w, h);
      if (fillColor !== 'transparent') ctx.fill();
      ctx.stroke();
      return true;
    }
    if (currentTool === 'ellipse') {
      const rx = Math.abs(pos.x - startX) / 2;
      const ry = Math.abs(pos.y - startY) / 2;
      const cx = startX + (pos.x - startX) / 2;
      const cy = startY + (pos.y - startY) / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      if (fillColor !== 'transparent') ctx.fill();
      ctx.stroke();
      return true;
    }
    if (currentTool === 'arrow') {
      drawArrow(ctx, startX, startY, pos.x, pos.y);
      return true;
    }
    if (currentTool === 'blur') {
      if (!isPremium) { showPremiumNag(); return false; }
      const x = Math.round(Math.min(startX, pos.x));
      const y = Math.round(Math.min(startY, pos.y));
      const w = Math.round(Math.abs(pos.x - startX));
      const h = Math.round(Math.abs(pos.y - startY));
      if (w > 4 && h > 4) {
        blurRegion(x, y, w, h);
        return true;
      }
      return false;
    }
    return false;
  }

  // ── Mouse events ──────────────────────────────────────────────────────────
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('mouseleave', onMouseUp);

  function onMouseDown(e) {
    if (e.button !== 0) return;
    if (currentTool === 'select' || historyBusy) return;
    const pos = canvasPos(e);
    startX = pos.x;
    startY = pos.y;
    lastX = pos.x;
    lastY = pos.y;
    isDrawing = true;
    movedSinceDown = false;
    clearPreview();
    setDrawStyles();

    if (currentTool === 'text') {
      placeTextInput(pos.x, pos.y);
      isDrawing = false;
      return;
    }

    if (currentTool === 'pen') {
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y);
    }
  }

  function onMouseMove(e) {
    if (!isDrawing) return;
    const pos = canvasPos(e);
    movedSinceDown = true;
    setDrawStyles();

    if (currentTool === 'pen') {
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
      lastX = pos.x;
      lastY = pos.y;
      return;
    }

    if (['rect', 'ellipse', 'arrow', 'blur'].includes(currentTool)) {
      drawShapePreview(pos);
    }
  }

  async function onMouseUp(e) {
    if (!isDrawing) return;
    isDrawing = false;
    const rawPos = canvasPos(e);
    const pos = clampToCanvas(rawPos.x, rawPos.y);
    clearPreview();

    if (!movedSinceDown && ['pen', 'rect', 'ellipse', 'arrow', 'blur'].includes(currentTool)) return;

    let changed = false;
    if (currentTool === 'pen') {
      changed = true;
    } else if (['rect', 'ellipse', 'arrow', 'blur'].includes(currentTool)) {
      changed = applyShapeFinal(pos);
    }

    if (changed) await pushHistorySnapshot();
  }

  // ── Text placement ─────────────────────────────────────────────────────────
  function placeTextInput(x, y) {
    const r = canvas.getBoundingClientRect();
    const scaleX = r.width / canvas.width;
    const scaleY = r.height / canvas.height;

    textInput.style.left = `${x * scaleX + wrap.scrollLeft}px`;
    textInput.style.top = `${y * scaleY + wrap.scrollTop}px`;
    textInput.style.color = strokeColor;
    textInput.style.fontSize = `${fontSize * scaleX}px`;
    textInput.value = '';
    textInput.classList.remove('hidden');
    textInput.focus();

    textInput.onblur = () => {
      void commitText(x, y);
    };
    textInput.onkeydown = (ev) => {
      if (ev.key === 'Escape') {
        textInput.classList.add('hidden');
      }
    };
  }

  async function commitText(x, y) {
    const val = textInput.value.trim();
    if (val) {
      ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
      ctx.fillStyle = strokeColor;
      ctx.textBaseline = 'top';
      val.split('\n').forEach((line, i) => {
        ctx.fillText(line, x, y + i * (fontSize * 1.3));
      });
      await pushHistorySnapshot();
    }
    textInput.classList.add('hidden');
  }

  // ── Tool selection ─────────────────────────────────────────────────────────
  document.querySelectorAll('[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tool = btn.dataset.tool;
      if (tool === 'blur' && !isPremium) { showPremiumNag(); return; }
      currentTool = tool;
      document.querySelectorAll('[data-tool]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
    });
  });

  document.getElementById('color-picker').addEventListener('input', (e) => { strokeColor = e.target.value; });
  document.getElementById('fill-picker').addEventListener('input', (e) => { fillColor = e.target.value; });
  document.getElementById('stroke-size').addEventListener('input', (e) => { strokeSize = parseInt(e.target.value, 10); });
  document.getElementById('font-size-sel').addEventListener('change', (e) => { fontSize = parseInt(e.target.value, 10); });
  document.getElementById('btn-undo').addEventListener('click', () => { void undo(); });
  document.getElementById('btn-redo').addEventListener('click', () => { void redo(); });

  // ── Download / export ──────────────────────────────────────────────────────
  document.getElementById('btn-download-png').addEventListener('click', () => {
    void downloadCanvas('image/png', buildFilename('png'));
  });

  document.getElementById('btn-download-jpg').addEventListener('click', () => {
    if (!isPremium) { showPremiumNag(); return; }
    void downloadCanvas('image/jpeg', buildFilename('jpg'), 0.92);
  });

  document.getElementById('btn-download-pdf').addEventListener('click', () => {
    if (!isPremium) { showPremiumNag(); return; }
    exportPDF();
  });

  async function downloadCanvas(type, filename, quality) {
    try {
      const blob = await canvasToBlob(type, quality);
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
    } catch (e) {
      alert('Export failed: ' + e.message);
    }
  }

  function exportPDF() {
    try {
      const { jsPDF } = window.jspdf;
      const w = canvas.width;
      const h = canvas.height;
      if (!isEditorSizeSafe(w, h)) {
        alert('This image is too large to export safely as PDF.');
        return;
      }
      const orientation = w >= h ? 'l' : 'p';
      const pdfW = orientation === 'l' ? 297 : 210; // A4 mm
      const pdfH = orientation === 'l' ? 210 : 297;
      const scale = Math.min(pdfW / w, pdfH / h);
      const doc = new jsPDF({ orientation, unit: 'mm', format: 'a4' });
      doc.addImage(canvas, 'PNG', 0, 0, w * scale, h * scale);
      doc.save(buildFilename('pdf'));
    } catch (e) {
      alert('PDF export failed: ' + e.message);
    }
  }

  // Copy to clipboard
  document.getElementById('btn-copy').addEventListener('click', async () => {
    try {
      const blob = await canvasToBlob('image/png');
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blob })
      ]);
      flashBtn('btn-copy', '✓ Copied!');
    } catch (e) {
      alert('Copy failed: ' + e.message);
    }
  });

  function flashBtn(id, msg) {
    const btn = document.getElementById(id);
    const orig = btn.textContent;
    btn.textContent = msg;
    setTimeout(() => { btn.textContent = orig; }, 1800);
  }

  // ── Premium nag ────────────────────────────────────────────────────────────
  function showPremiumNag() {
    premNag.classList.remove('hidden');
  }

  document.getElementById('nag-close').addEventListener('click', () => {
    premNag.classList.add('hidden');
  });
  document.getElementById('nag-upgrade').addEventListener('click', () => {
    sendMsg({ action: 'open_payment' });
    premNag.classList.add('hidden');
  });

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.target === textInput) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); void undo(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { e.preventDefault(); void redo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      const btnByFormat = { png: 'btn-download-png', jpg: 'btn-download-jpg', pdf: 'btn-download-pdf' };
      const fallbackFormat = (!isPremium && (defaultFormat === 'jpg' || defaultFormat === 'pdf')) ? 'png' : defaultFormat;
      document.getElementById(btnByFormat[fallbackFormat] || 'btn-download-png').click();
      return;
    }

    const toolMap = { s: 'select', p: 'pen', a: 'arrow', r: 'rect', e: 'ellipse', t: 'text', b: 'blur' };
    if (!e.ctrlKey && !e.metaKey && !e.altKey && toolMap[e.key]) {
      const tool = toolMap[e.key];
      const btn = document.querySelector(`[data-tool="${tool}"]`);
      if (btn) btn.click();
    }
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  function sendMsg(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(resp || {});
      });
    });
  }

  function canvasToBlob(type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Failed to create image blob'));
      }, type, quality);
    });
  }

  function showError(msg) {
    const p = document.createElement('p');
    p.style.color = '#ef4444';
    p.style.fontSize = '14px';
    p.style.textAlign = 'center';
    p.style.padding = '20px';
    p.textContent = msg;
    loadingScreen.replaceChildren(p);
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  await checkPremium();
  await loadEditorSettings();
  await loadCapture();
})();
