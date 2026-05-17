/* ── Kit Screenshot Editor – editor.js ──────────────────────────────────── */

(async function () {
  // ── Setup ─────────────────────────────────────────────────────────────────
  const params   = new URLSearchParams(location.search);
  const captureId = params.get('id');

  const loadingScreen = document.getElementById('loading-screen');
  const canvas  = document.getElementById('main-canvas');
  const wrap    = document.getElementById('canvas-wrap');
  const ctx     = canvas.getContext('2d');
  const textInput = document.getElementById('text-input');
  const premNag = document.getElementById('premium-nag');

  let isPremium = false;
  let baseImage = null;   // HTMLImageElement
  let currentTool = 'select';
  let strokeColor  = '#e63946';
  let fillColor    = 'transparent';
  let strokeSize   = 3;
  let fontSize     = 24;

  // Undo/redo stacks store ImageData snapshots
  const undoStack = [];
  const redoStack = [];
  const MAX_UNDO  = 25;

  let isDrawing = false;
  let startX = 0, startY = 0;
  let lastX = 0, lastY = 0;
  let snapshot = null;    // canvas snapshot before shape being drawn

  // ── Load screenshot from session storage ──────────────────────────────────
  async function loadCapture() {
    if (!captureId) { showError('No capture ID found.'); return; }
    try {
      const data = await chromeStorageGet(`capture_${captureId}`);
      if (!data) { showError('Screenshot data not found.'); return; }
      const img = new Image();
      img.onload = () => {
        baseImage = img;
        canvas.width  = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0);
        pushUndo();
        loadingScreen.classList.add('hidden');

        // Cleanup session storage
        chrome.storage.session.remove([`capture_${captureId}`, `meta_${captureId}`]);
      };
      img.onerror = () => showError('Failed to decode screenshot.');
      img.src = data;
    } catch (e) {
      showError('Failed to load screenshot: ' + e.message);
    }
  }

  // ── Premium check ──────────────────────────────────────────────────────────
  async function checkPremium() {
    try {
      const resp = await sendMsg({ action: 'get_status' });
      isPremium = resp.premium || false;
    } catch (e) { isPremium = false; }
  }

  // ── Undo / Redo ────────────────────────────────────────────────────────────
  function pushUndo() {
    undoStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
    updateUndoButtons();
  }

  function undo() {
    if (undoStack.length < 2) return;
    redoStack.push(undoStack.pop());
    ctx.putImageData(undoStack[undoStack.length - 1], 0, 0);
    updateUndoButtons();
  }

  function redo() {
    if (!redoStack.length) return;
    const state = redoStack.pop();
    undoStack.push(state);
    ctx.putImageData(state, 0, 0);
    updateUndoButtons();
  }

  function updateUndoButtons() {
    document.getElementById('btn-undo').disabled = undoStack.length < 2;
    document.getElementById('btn-redo').disabled = redoStack.length === 0;
  }

  // ── Drawing helpers ────────────────────────────────────────────────────────
  function setDrawStyles() {
    ctx.strokeStyle = strokeColor;
    ctx.fillStyle   = fillColor === 'transparent' ? 'rgba(0,0,0,0)' : fillColor;
    ctx.lineWidth   = strokeSize;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
  }

  function canvasPos(e) {
    const r = canvas.getBoundingClientRect();
    const scaleX = canvas.width  / r.width;
    const scaleY = canvas.height / r.height;
    return {
      x: (e.clientX - r.left) * scaleX,
      y: (e.clientY - r.top)  * scaleY
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
        // Average colour of block
        let r = 0, g = 0, b = 0, cnt = 0;
        for (let dy = 0; dy < px && by + dy < h; dy++) {
          for (let dx = 0; dx < px && bx + dx < w; dx++) {
            const i = ((by + dy) * w + (bx + dx)) * 4;
            r += d[i]; g += d[i+1]; b += d[i+2]; cnt++;
          }
        }
        r = Math.round(r/cnt); g = Math.round(g/cnt); b = Math.round(b/cnt);
        for (let dy = 0; dy < px && by + dy < h; dy++) {
          for (let dx = 0; dx < px && bx + dx < w; dx++) {
            const i = ((by + dy) * w + (bx + dx)) * 4;
            d[i] = r; d[i+1] = g; d[i+2] = b;
          }
        }
      }
    }
    ctx.putImageData(imgData, x, y);
  }

  // ── Draw arrow ─────────────────────────────────────────────────────────────
  function drawArrow(x1, y1, x2, y2) {
    const headLen = Math.max(12, strokeSize * 4);
    const angle   = Math.atan2(y2 - y1, x2 - x1);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI/6), y2 - headLen * Math.sin(angle - Math.PI/6));
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI/6), y2 - headLen * Math.sin(angle + Math.PI/6));
    ctx.stroke();
  }

  // ── Mouse events ──────────────────────────────────────────────────────────
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseup',   onMouseUp);
  canvas.addEventListener('mouseleave', onMouseUp);

  function onMouseDown(e) {
    if (e.button !== 0) return;
    if (currentTool === 'select') return;
    const pos = canvasPos(e);
    startX = pos.x; startY = pos.y;
    lastX  = pos.x; lastY  = pos.y;
    isDrawing = true;
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

    // Snapshot for shape preview
    if (['rect','ellipse','arrow','blur'].includes(currentTool)) {
      snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
    }
  }

  function onMouseMove(e) {
    if (!isDrawing) return;
    const pos = canvasPos(e);

    setDrawStyles();

    if (currentTool === 'pen') {
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
      lastX = pos.x; lastY = pos.y;
      return;
    }

    if (currentTool === 'rect') {
      ctx.putImageData(snapshot, 0, 0);
      const w = pos.x - startX, h = pos.y - startY;
      ctx.beginPath();
      ctx.rect(startX, startY, w, h);
      if (fillColor !== 'transparent') ctx.fill();
      ctx.stroke();
    }

    if (currentTool === 'ellipse') {
      ctx.putImageData(snapshot, 0, 0);
      const rx = Math.abs(pos.x - startX) / 2;
      const ry = Math.abs(pos.y - startY) / 2;
      const cx = startX + (pos.x - startX) / 2;
      const cy = startY + (pos.y - startY) / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      if (fillColor !== 'transparent') ctx.fill();
      ctx.stroke();
    }

    if (currentTool === 'arrow') {
      ctx.putImageData(snapshot, 0, 0);
      drawArrow(startX, startY, pos.x, pos.y);
    }

    if (currentTool === 'blur') {
      ctx.putImageData(snapshot, 0, 0);
      const x = Math.min(startX, pos.x), y = Math.min(startY, pos.y);
      const w = Math.abs(pos.x - startX), h = Math.abs(pos.y - startY);
      // Draw selection rectangle preview
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
    }
  }

  function onMouseUp(e) {
    if (!isDrawing) return;
    isDrawing = false;
    const rawPos = canvasPos(e);
    const pos = clampToCanvas(rawPos.x, rawPos.y);
    setDrawStyles();

    if (currentTool === 'blur') {
      if (!isPremium) { showPremiumNag(); ctx.putImageData(snapshot, 0, 0); return; }
      const x = Math.round(Math.min(startX, pos.x));
      const y = Math.round(Math.min(startY, pos.y));
      const w = Math.round(Math.abs(pos.x - startX));
      const h = Math.round(Math.abs(pos.y - startY));
      if (w > 4 && h > 4) blurRegion(x, y, w, h);
    }

    pushUndo();
  }

  // ── Text placement ─────────────────────────────────────────────────────────
  function placeTextInput(x, y) {
    const r    = canvas.getBoundingClientRect();
    const scaleX = r.width  / canvas.width;
    const scaleY = r.height / canvas.height;

    textInput.style.left   = `${x * scaleX + wrap.scrollLeft}px`;
    textInput.style.top    = `${y * scaleY + wrap.scrollTop}px`;
    textInput.style.color  = strokeColor;
    textInput.style.fontSize = `${fontSize * scaleX}px`;
    textInput.value = '';
    textInput.classList.remove('hidden');
    textInput.focus();

    textInput.onblur = () => commitText(x, y);
    textInput.onkeydown = ev => {
      if (ev.key === 'Escape') { textInput.classList.add('hidden'); }
    };
  }

  function commitText(x, y) {
    const val = textInput.value.trim();
    if (val) {
      ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
      ctx.fillStyle = strokeColor;
      ctx.textBaseline = 'top';
      val.split('\n').forEach((line, i) => {
        ctx.fillText(line, x, y + i * (fontSize * 1.3));
      });
      pushUndo();
    }
    textInput.classList.add('hidden');
  }

  // ── Tool selection ─────────────────────────────────────────────────────────
  document.querySelectorAll('[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tool = btn.dataset.tool;
      if (tool === 'blur' && !isPremium) { showPremiumNag(); return; }
      currentTool = tool;
      document.querySelectorAll('[data-tool]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
    });
  });

  document.getElementById('color-picker').addEventListener('input', e => { strokeColor = e.target.value; });
  document.getElementById('fill-picker').addEventListener('input', e => { fillColor = e.target.value; });
  document.getElementById('stroke-size').addEventListener('input', e => { strokeSize = parseInt(e.target.value); });
  document.getElementById('font-size-sel').addEventListener('change', e => { fontSize = parseInt(e.target.value); });
  document.getElementById('btn-undo').addEventListener('click', undo);
  document.getElementById('btn-redo').addEventListener('click', redo);

  // ── Download / export ──────────────────────────────────────────────────────
  function getFilename(ext) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `kit-screenshot-${ts}.${ext}`;
  }

  document.getElementById('btn-download-png').addEventListener('click', () => {
    triggerDownload(canvas.toDataURL('image/png'), getFilename('png'));
  });

  document.getElementById('btn-download-jpg').addEventListener('click', () => {
    triggerDownload(canvas.toDataURL('image/jpeg', 0.92), getFilename('jpg'));
  });

  document.getElementById('btn-download-pdf').addEventListener('click', () => {
    if (!isPremium) { showPremiumNag(); return; }
    exportPDF();
  });

  function triggerDownload(dataUrl, filename) {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    a.click();
  }

  function exportPDF() {
    try {
      const { jsPDF } = window.jspdf;
      const imgData = canvas.toDataURL('image/jpeg', 0.92);
      const w = canvas.width;
      const h = canvas.height;
      const orientation = w >= h ? 'l' : 'p';
      const pdfW = orientation === 'l' ? 297 : 210;  // A4 mm
      const pdfH = orientation === 'l' ? 210 : 297;
      const scale = Math.min(pdfW / w, pdfH / h);
      const doc = new jsPDF({ orientation, unit: 'mm', format: 'a4' });
      doc.addImage(imgData, 'JPEG', 0, 0, w * scale, h * scale);
      doc.save(getFilename('pdf'));
    } catch (e) {
      alert('PDF export failed: ' + e.message);
    }
  }

  // Copy to clipboard
  document.getElementById('btn-copy').addEventListener('click', async () => {
    try {
      canvas.toBlob(async blob => {
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': blob })
        ]);
        flashBtn('btn-copy', '✓ Copied!');
      }, 'image/png');
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
  document.addEventListener('keydown', e => {
    if (e.target === textInput) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { e.preventDefault(); redo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); document.getElementById('btn-download-png').click(); return; }

    const toolMap = { s: 'select', p: 'pen', a: 'arrow', r: 'rect', e: 'ellipse', t: 'text', b: 'blur' };
    if (!e.ctrlKey && !e.metaKey && !e.altKey && toolMap[e.key]) {
      const tool = toolMap[e.key];
      const btn = document.querySelector(`[data-tool="${tool}"]`);
      if (btn) btn.click();
    }
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  function chromeStorageGet(key) {
    return new Promise(resolve => {
      chrome.storage.session.get(key, data => resolve(data[key]));
    });
  }

  function sendMsg(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, resp => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(resp || {});
      });
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
  await loadCapture();
})();
