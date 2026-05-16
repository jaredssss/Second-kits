// Kit Screenshot – content script
// Injected by background to query page info and control scrolling.
// Runs in page context (not isolated world for style access).

(function () {
  // Prevent double injection
  if (window.__kitContentLoaded) return;
  window.__kitContentLoaded = true;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.action) {
      case 'kit_page_info':
        sendResponse({
          scrollX: Math.round(window.scrollX),
          scrollY: Math.round(window.scrollY),
          totalWidth: Math.max(
            document.body.scrollWidth || 0,
            document.documentElement.scrollWidth || 0,
            document.documentElement.clientWidth || 0
          ),
          totalHeight: Math.max(
            document.body.scrollHeight || 0,
            document.documentElement.scrollHeight || 0,
            document.documentElement.clientHeight || 0
          ),
          viewportWidth: document.documentElement.clientWidth,
          viewportHeight: document.documentElement.clientHeight,
          dpr: window.devicePixelRatio || 1
        });
        break;

      case 'kit_scroll_to':
        window.scrollTo(msg.x, msg.y);
        sendResponse({ x: Math.round(window.scrollX), y: Math.round(window.scrollY) });
        break;

      case 'kit_hide_fixed':
        window.__kitHiddenEls = window.__kitHiddenEls || [];
        document.querySelectorAll('*').forEach(el => {
          const s = window.getComputedStyle(el);
          if (s.position === 'fixed' || s.position === 'sticky') {
            window.__kitHiddenEls.push({ el, vis: el.style.visibility });
            el.style.setProperty('visibility', 'hidden', 'important');
          }
        });
        sendResponse({ ok: true });
        break;

      case 'kit_restore_fixed':
        if (window.__kitHiddenEls) {
          window.__kitHiddenEls.forEach(({ el, vis }) => {
            el.style.visibility = vis;
          });
          delete window.__kitHiddenEls;
        }
        sendResponse({ ok: true });
        break;

      default:
        break;
    }
    return true;
  });
})();
