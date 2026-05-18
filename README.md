# Kit Screenshot (Chrome Extension)

Production-ready Chrome extension for:
- visible area screenshots
- full-page stitched screenshots
- built-in annotation editor
- free + premium monetization using ExtensionPay (`ExtPay('kit')`)

## Tech stack
- Manifest V3
- Vanilla JavaScript / HTML / CSS
- Chrome Extension APIs (`tabs`, `scripting`, `downloads`, `storage`, `commands`)
- `ExtPay.js` for subscription billing
- `jsPDF` for premium PDF export

## Free features
- Unlimited visible-area captures
- Full-page captures up to **5/day**
- Annotation tools: pen, arrow, rectangle, ellipse, text
- PNG export
- Copy to clipboard
- Keyboard shortcuts

## Premium features ($5/month via ExtensionPay)
- Unlimited full-page captures
- PDF + JPEG export
- Blur / redact tool
- Capture history (up to 50)
- Hide fixed/sticky page overlays
- Capture delay controls
- Custom filename templates (settings)

## Files
- `/home/runner/work/Second-kits/Second-kits/manifest.json`
- `/home/runner/work/Second-kits/Second-kits/background.js`
- `/home/runner/work/Second-kits/Second-kits/content.js`
- `/home/runner/work/Second-kits/Second-kits/popup.html`
- `/home/runner/work/Second-kits/Second-kits/popup.css`
- `/home/runner/work/Second-kits/Second-kits/popup.js`
- `/home/runner/work/Second-kits/Second-kits/editor.html`
- `/home/runner/work/Second-kits/Second-kits/editor.css`
- `/home/runner/work/Second-kits/Second-kits/editor.js`
- `/home/runner/work/Second-kits/Second-kits/options.html`
- `/home/runner/work/Second-kits/Second-kits/options.css`
- `/home/runner/work/Second-kits/Second-kits/options.js`
- `/home/runner/work/Second-kits/Second-kits/lib/ExtPay.js`
- `/home/runner/work/Second-kits/Second-kits/lib/jspdf.umd.min.js`
- `/home/runner/work/Second-kits/Second-kits/icons/*.png`

## Load in Chrome
1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `/home/runner/work/Second-kits/Second-kits`

## Package as zip
From repo root:
```bash
cd /home/runner/work/Second-kits/Second-kits
zip -r kit-screenshot-extension.zip . -x "*.git*" -x "*.DS_Store"
```

Output:
- `/home/runner/work/Second-kits/Second-kits/kit-screenshot-extension.zip`

## Notes
- Extension ID used for billing is hardcoded to `kit`.
- Full-page capture now runs directly from `background.js` via `chrome.scripting.executeScript` helpers (no injected content-script capture path).
- Settings links in `options.js` are configured to real external endpoints (Web Store category + project issues page).
