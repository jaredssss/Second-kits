/* Kit Screenshot – popup script */

const $ = id => document.getElementById(id);

// ── State ─────────────────────────────────────────────────────────────────────
let isPremium = false;
let captureCount = 0;
const LIMIT = 5;

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  try {
    const status = await sendMsg({ action: 'get_status' });
    isPremium = status.premium || false;
    captureCount = status.count || 0;
    updateUI();
  } catch (e) {
    showToast('Could not load status', true);
  }
}

function updateUI() {
  // Premium badge
  $('premium-badge').classList.toggle('hidden', !isPremium);

  // Upsell section
  $('upsell-section').classList.toggle('hidden', isPremium);

  // Full-page badge
  if (isPremium) {
    $('badge-fullpage').textContent = 'UNLIMITED';
  } else {
    $('badge-fullpage').textContent = `${Math.max(0, LIMIT - captureCount)} left`;
  }

  // Usage bar (only for free users)
  if (!isPremium) {
    $('usage-bar').classList.remove('hidden');
    $('usage-text').textContent = `${captureCount} / ${LIMIT}`;
    const pct = Math.min(100, (captureCount / LIMIT) * 100);
    $('usage-fill').style.width = `${pct}%`;
    $('usage-fill').classList.toggle('full', captureCount >= LIMIT);
  } else {
    $('usage-bar').classList.add('hidden');
  }

  // Lock premium-only controls for free users
  const locked = !isPremium;
  $('sel-delay').disabled = locked;
  $('chk-hide-fixed').disabled = locked;
  if (locked) {
    $('delay-lock').style.display = 'inline';
    $('hide-lock').style.display = 'inline';
    $('sel-delay').title = 'Upgrade to unlock';
    $('chk-hide-fixed').title = 'Upgrade to unlock';
  } else {
    $('delay-lock').style.display = 'none';
    $('hide-lock').style.display = 'none';
  }
}

// ── Capture ───────────────────────────────────────────────────────────────────
async function doCapture(action) {
  if (action === 'capture_fullpage' && !isPremium && captureCount >= LIMIT) {
    showToast(`Free limit reached (${LIMIT}/day). Upgrade for unlimited.`, true);
    return;
  }

  const delay = isPremium ? parseInt($('sel-delay').value, 10) || 0 : 0;
  const hideFixed = isPremium ? $('chk-hide-fixed').checked : false;

  showOverlay(action === 'capture_fullpage' ? 'Capturing full page…' : 'Capturing…');

  if (delay > 0) {
    let secs = delay / 1000;
    while (secs > 0) {
      setOverlayMsg(`Capturing in ${secs}s…`);
      await sleep(1000);
      secs--;
    }
  }

  try {
    const result = await sendMsg({ action, settleMs: 220, hideFixed });
    if (result.error === 'limit_reached') {
      showToast('Daily limit reached. Upgrade to Premium for unlimited captures.', true);
    } else if (result.error) {
      showToast(result.error, true);
    } else {
      if (action === 'capture_fullpage' && !isPremium) {
        captureCount = Math.min(LIMIT, captureCount + 1);
        updateUI();
      }
      window.close();
    }
  } catch (e) {
    showToast('Capture failed. Try again.', true);
  } finally {
    hideOverlay();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sendMsg(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, resp => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(resp);
    });
  });
}

function showOverlay(msg) {
  setOverlayMsg(msg);
  $('overlay').classList.remove('hidden');
}
function setOverlayMsg(msg) { $('overlay-msg').textContent = msg; }
function hideOverlay() { $('overlay').classList.add('hidden'); }

let toastTimer;
function showToast(msg, error = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast' + (error ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast hidden'; }, 3500);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Event listeners ───────────────────────────────────────────────────────────
$('btn-visible').addEventListener('click', () => doCapture('capture_visible'));
$('btn-fullpage').addEventListener('click', () => doCapture('capture_fullpage'));

$('btn-options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

$('btn-upgrade').addEventListener('click', async () => {
  await sendMsg({ action: 'open_payment' });
  window.close();
});

$('btn-manage').addEventListener('click', async () => {
  await sendMsg({ action: 'open_manage' });
  window.close();
});

// ── Boot ──────────────────────────────────────────────────────────────────────
init();
