// Kit Screenshot – background service worker
// Handles full-page capture stitching, free-tier limits, and ExtensionPay

importScripts('lib/ExtPay.js');

// ── ExtensionPay setup ───────────────────────────────────────────────────────
const extpay = ExtPay('kit');
extpay.startBackground();

// ── Constants ────────────────────────────────────────────────────────────────
const FREE_DAILY_FULLPAGE_LIMIT = 5;
const CAPTURE_SETTLE_MS = 180;      // wait after scroll before capture
const MAX_CANVAS_SIDE = 32000;       // Chrome GPU limit guard
const CAPTURE_DB_NAME = 'kit-capture-db';
const CAPTURE_DB_STORE = 'captures';

// ── Utility helpers ───────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

async function getTodayCount() {
  const data = await chrome.storage.local.get(['captureDate', 'captureCount']);
  if (data.captureDate !== today()) {
    await chrome.storage.local.set({ captureDate: today(), captureCount: 0 });
    return 0;
  }
  return data.captureCount || 0;
}

async function incrementTodayCount() {
  const count = await getTodayCount();
  await chrome.storage.local.set({ captureCount: count + 1 });
}

// ── Payment helpers ───────────────────────────────────────────────────────────
async function isPremium() {
  try {
    const cached = await chrome.storage.local.get(['premiumCached', 'premiumExpiry']);
    if (cached.premiumCached !== undefined && Date.now() < (cached.premiumExpiry || 0)) {
      return cached.premiumCached;
    }
    const user = await extpay.getUser();
    const paid = user.paid === true;
    await chrome.storage.local.set({
      premiumCached: paid,
      premiumExpiry: Date.now() + 60 * 60 * 1000   // 1 hour cache
    });
    return paid;
  } catch (e) {
    // If offline, use cached value
    const cached = await chrome.storage.local.get('premiumCached');
    return cached.premiumCached === true;
  }
}

// ── Capture helpers ───────────────────────────────────────────────────────────
async function getPageInfo(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      totalWidth:  Math.max(
        document.body.scrollWidth || 0,
        document.documentElement.scrollWidth || 0,
        document.documentElement.clientWidth || 0
      ),
      totalHeight: Math.max(
        document.body.scrollHeight || 0,
        document.documentElement.scrollHeight || 0,
        document.documentElement.clientHeight || 0
      ),
      viewportWidth:  document.documentElement.clientWidth,
      viewportHeight: document.documentElement.clientHeight,
      dpr: window.devicePixelRatio || 1
    })
  });
  return result.result;
}

async function scrollTo(tabId, x, y) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (sx, sy) => { window.scrollTo(sx, sy); },
    args: [x, y]
  });
}

async function getActualScroll(tabId) {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({ x: Math.round(window.scrollX), y: Math.round(window.scrollY) })
  });
  return r.result;
}

async function hideFixedElements(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const MAX_SCANNED = 3000;
      const MAX_HIDDEN = 400;
      const YIELD_EVERY = 250;
      const VIEWPORT_MARGIN = 200;

      window.__kitHiddenEls = [];
      const root = document.body || document.documentElement;
      if (!root) return;

      let scanned = 0;
      let hidden = 0;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node = walker.currentNode;
      while (node && scanned < MAX_SCANNED && hidden < MAX_HIDDEN) {
        const el = node;
        node = walker.nextNode();
        scanned++;

        if (scanned % YIELD_EVERY === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }

        if (el === document.body || el === document.documentElement) continue;
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const outOfViewport =
          rect.bottom < -VIEWPORT_MARGIN ||
          rect.top > window.innerHeight + VIEWPORT_MARGIN ||
          rect.right < -VIEWPORT_MARGIN ||
          rect.left > window.innerWidth + VIEWPORT_MARGIN;
        if (outOfViewport) continue;

        const s = window.getComputedStyle(el);
        if (s.position !== 'fixed' && s.position !== 'sticky') continue;

        window.__kitHiddenEls.push({
          el,
          visibility: el.style.getPropertyValue('visibility'),
          priority: el.style.getPropertyPriority('visibility')
        });
        el.style.setProperty('visibility', 'hidden', 'important');
        hidden++;
      }
    }
  });
}

async function restoreFixedElements(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      if (!window.__kitHiddenEls) return;
      window.__kitHiddenEls.forEach(({ el, visibility, priority }) => {
        if (!el || !el.isConnected) return;
        if (visibility) {
          el.style.setProperty('visibility', visibility, priority || '');
        } else {
          el.style.removeProperty('visibility');
        }
      });
      delete window.__kitHiddenEls;
    }
  });
}

function dataUrlToArrayBuffer(dataUrl) {
  const base64 = dataUrl.split(',')[1];
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
  return bytes.buffer;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function canCaptureTab(tab) {
  if (!tab || !tab.id || !tab.windowId) return false;
  if (!tab.url || typeof tab.url !== 'string') return false;
  try {
    const protocol = new URL(tab.url).protocol;
    return protocol === 'http:' || protocol === 'https:' || protocol === 'file:';
  } catch {
    return false;
  }
}

async function getActiveTabForCapture() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return { error: 'No active tab' };
  if (!canCaptureTab(tab)) {
    return { error: 'This page cannot be captured. Open a regular webpage and try again.' };
  }
  return { tab };
}

function normalizeCaptureError(err) {
  const message = err?.message || String(err);
  if (message === 'page_too_large') return 'page_too_large';

  if (/No active web contents to capture/i.test(message)) {
    return 'No active webpage to capture. Reload the page or switch to another tab and try again.';
  }

  if (/Cannot access contents of url/i.test(message) || /chrome:\/\//i.test(message)) {
    return 'This page is protected by Chrome and cannot be captured. Open a regular webpage and try again.';
  }

  if (/No tab with id/i.test(message) || /The tab was closed/i.test(message)) {
    return 'The tab is no longer available. Re-open the page and try again.';
  }

  return message;
}

function formatFilenameTemplate(template, meta = {}, date = new Date()) {
  const safeTemplate = typeof template === 'string' && template.trim()
    ? template.trim()
    : 'kit-{date}-{time}';
  const dateStr = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  const timeStr = `${pad2(date.getHours())}-${pad2(date.getMinutes())}-${pad2(date.getSeconds())}`;
  const raw = safeTemplate
    .replaceAll('{title}', String(meta.title || ''))
    .replaceAll('{date}', dateStr)
    .replaceAll('{time}', timeStr)
    .replaceAll('{url}', String(meta.url || ''));
  const cleaned = raw
    .replace(/[\\/:*?"<>|\u0000-\u001F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || `kit-${dateStr}-${timeStr}`;
}

function makeCaptureFilename(meta = {}, ext = 'png', template = 'kit-{date}-{time}') {
  const base = formatFilenameTemplate(template, meta);
  return `${base}.${ext}`;
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

async function idbPutCaptureRecord(id, blob, meta) {
  const db = await openCaptureDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(CAPTURE_DB_STORE, 'readwrite');
      const store = tx.objectStore(CAPTURE_DB_STORE);
      store.put({ id, blob, meta, createdAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Failed to save capture'));
      tx.onabort = () => reject(tx.error || new Error('Failed to save capture'));
    });
  } finally {
    db.close();
  }
}

// ── Full-page capture ─────────────────────────────────────────────────────────
async function captureFullPage(tab, options = {}) {
  const { settleMs = CAPTURE_SETTLE_MS, hideFixed = true } = options;

  const info = await getPageInfo(tab.id);

  if (info.totalWidth * info.dpr > MAX_CANVAS_SIDE || info.totalHeight * info.dpr > MAX_CANVAS_SIDE) {
    throw new Error('page_too_large');
  }

  const canvasW = Math.min(info.totalWidth  * info.dpr, MAX_CANVAS_SIDE);
  const canvasH = Math.min(info.totalHeight * info.dpr, MAX_CANVAS_SIDE);
  const maxTotalH = Math.floor(canvasH / info.dpr);

  const canvas = new OffscreenCanvas(canvasW, canvasH);
  const ctx = canvas.getContext('2d');

  if (hideFixed) await hideFixedElements(tab.id);

  try {
    let yLogical = 0;
    while (yLogical < maxTotalH) {
      const scrollTarget = Math.min(yLogical, Math.max(0, info.totalHeight - info.viewportHeight));
      await scrollTo(tab.id, 0, scrollTarget);
      await sleep(settleMs);

      const actual = await getActualScroll(tab.id);
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });

      const buf = dataUrlToArrayBuffer(dataUrl);
      const blob = new Blob([buf], { type: 'image/png' });
      const bitmap = await createImageBitmap(blob);

      const drawY = actual.y * info.dpr;
      ctx.drawImage(bitmap, 0, drawY);
      bitmap.close();

      // Advance: if we're at the bottom clamp, stop
      if (scrollTarget === info.totalHeight - info.viewportHeight && yLogical >= scrollTarget) break;
      yLogical += info.viewportHeight;
    }
  } finally {
    if (hideFixed) await restoreFixedElements(tab.id);
    await scrollTo(tab.id, info.scrollX, info.scrollY);
  }

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return blob;
}

// ── Visible-area capture ─────────────────────────────────────────────────────
async function captureVisible(tab) {
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const buf = dataUrlToArrayBuffer(dataUrl);
  return new Blob([buf], { type: 'image/png' });
}

// ── Save to history ───────────────────────────────────────────────────────────
async function saveToHistory(blob, meta) {
  try {
    // Create small thumbnail (~200px wide) as JPEG data URI for storage
    const bitmap = await createImageBitmap(blob);
    const thumbW = 200;
    const thumbH = Math.round((bitmap.height / bitmap.width) * thumbW);
    const thumbCanvas = new OffscreenCanvas(thumbW, thumbH);
    thumbCanvas.getContext('2d').drawImage(bitmap, 0, 0, thumbW, thumbH);
    bitmap.close();

    const thumbBlob = await thumbCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.6 });
    const thumbUrl = await blobToDataUrl(thumbBlob);

    const { history = [] } = await chrome.storage.local.get('history');
    history.unshift({ ...meta, thumb: thumbUrl, date: new Date().toISOString() });
    if (history.length > 50) history.length = 50;
    await chrome.storage.local.set({ history });
  } catch (e) {
    // Non-fatal – history saving failed
    console.warn('Kit: history save failed', e);
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    if (typeof FileReaderSync !== 'undefined') {
      try {
        const reader = new FileReaderSync();
        const ab = reader.readAsDataURL(blob);
        resolve(ab);
        return;
      } catch (e) { /* fall through */ }
    }
    // Fallback using ArrayBuffer
    blob.arrayBuffer().then(buf => {
      const bytes = new Uint8Array(buf);
      let str = '';
      bytes.forEach(b => { str += String.fromCharCode(b); });
      resolve(`data:${blob.type};base64,${btoa(str)}`);
    }).catch(reject);
  });
}

async function outputCapture(blob, meta) {
  const { autoEditor = true, filenameTemplate = 'kit-{date}-{time}' } =
    await chrome.storage.local.get(['autoEditor', 'filenameTemplate']);
  if (autoEditor !== false) {
    await openEditorWithBlob(blob, meta);
    return;
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({
      url: objectUrl,
      filename: makeCaptureFilename(meta, 'png', filenameTemplate),
      saveAs: false
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 15000);
  }
}

// ── Open editor tab ───────────────────────────────────────────────────────────
async function openEditorWithBlob(blob, meta) {
  const id = crypto.randomUUID();
  await idbPutCaptureRecord(id, blob, meta);
  await chrome.tabs.create({ url: chrome.runtime.getURL(`editor.html?id=${id}`) });
}

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse).catch(err => {
    sendResponse({ error: err.message || String(err) });
  });
  return true; // async response
});

async function handleMessage(msg, sender) {
  switch (msg.action) {

    case 'get_status': {
      const [premium, count] = await Promise.all([isPremium(), getTodayCount()]);
      return { premium, count, limit: FREE_DAILY_FULLPAGE_LIMIT };
    }

    case 'open_payment': {
      extpay.openPaymentPage();
      return { ok: true };
    }

    case 'open_manage': {
      extpay.openLoginPage();
      return { ok: true };
    }

    case 'capture_visible': {
      const tabState = await getActiveTabForCapture();
      if (tabState.error) return { error: tabState.error };
      const { tab } = tabState;
      try {
        const blob = await captureVisible(tab);
        const meta = { url: tab.url, title: tab.title, type: 'visible' };
        if (await isPremium()) await saveToHistory(blob, meta);
        await outputCapture(blob, meta);
        return { ok: true };
      } catch (err) {
        return { error: normalizeCaptureError(err) };
      }
    }

    case 'capture_fullpage': {
      const tabState = await getActiveTabForCapture();
      if (tabState.error) return { error: tabState.error };
      const { tab } = tabState;

      const premium = await isPremium();
      if (!premium) {
        const count = await getTodayCount();
        if (count >= FREE_DAILY_FULLPAGE_LIMIT) {
          return { error: 'limit_reached', limit: FREE_DAILY_FULLPAGE_LIMIT };
        }
      }

      try {
        const blob = await captureFullPage(tab, {
          settleMs: msg.settleMs || CAPTURE_SETTLE_MS,
          hideFixed: msg.hideFixed !== false
        });

        if (!premium) await incrementTodayCount();

        const meta = { url: tab.url, title: tab.title, type: 'fullpage' };
        if (premium) await saveToHistory(blob, meta);
        await outputCapture(blob, meta);
        return { ok: true };
      } catch (err) {
        return { error: normalizeCaptureError(err) };
      }
    }

    case 'refresh_premium': {
      await chrome.storage.local.remove(['premiumCached', 'premiumExpiry']);
      const premium = await isPremium();
      return { premium };
    }

    default:
      return { error: `Unknown action: ${msg.action}` };
  }
}

// ── Keyboard shortcut commands ────────────────────────────────────────────────
chrome.commands.onCommand.addListener(async command => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (command === 'capture-fullpage') {
    chrome.runtime.sendMessage({ action: 'capture_fullpage' });
  } else if (command === 'capture-visible') {
    chrome.runtime.sendMessage({ action: 'capture_visible' });
  }
});
