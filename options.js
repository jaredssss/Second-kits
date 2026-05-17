const $ = (id) => document.getElementById(id);

let isPremium = false;

function sendMsg(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(resp || {});
    });
  });
}

function localGet(keys) {
  return chrome.storage.local.get(keys);
}

function localSet(data) {
  return chrome.storage.local.set(data);
}

function showSection(hash) {
  const id = hash?.replace("#", "") || "account";
  document.querySelectorAll(".section").forEach((s) => s.classList.remove("active"));
  document.querySelectorAll(".nav-link").forEach((a) => a.classList.remove("active"));
  const section = $(id);
  const link = document.querySelector(`.nav-link[href="#${id}"]`);
  if (section) section.classList.add("active");
  if (link) link.classList.add("active");
}

function updateAccountUI() {
  $("account-free-card").classList.toggle("hidden", isPremium);
  $("account-premium-card").classList.toggle("hidden", !isPremium);
  $("history-gate").classList.toggle("hidden", isPremium);
  $("history-footer").classList.toggle("hidden", !isPremium);
}

async function loadStatus() {
  const s = await sendMsg({ action: "get_status" });
  isPremium = !!s.premium;
  updateAccountUI();
}

async function loadGeneralSettings() {
  const d = await localGet(["defaultFormat", "filenameTemplate", "settleMs", "autoEditor"]);
  $("sel-format").value = d.defaultFormat || "png";
  $("inp-filename").value = d.filenameTemplate || "kit-{date}-{time}";
  $("sel-settle").value = String(d.settleMs || 180);
  $("chk-auto-editor").checked = d.autoEditor !== false;

  if (!isPremium && $("sel-format").value === "pdf") {
    $("sel-format").value = "png";
  }
}

async function saveGeneralSettings() {
  const format = $("sel-format").value;
  const filenameTemplate = $("inp-filename").value.trim() || "kit-{date}-{time}";
  const settleMs = parseInt($("sel-settle").value, 10) || 180;
  const autoEditor = $("chk-auto-editor").checked;

  if (!isPremium && format === "pdf") {
    alert("PDF default format is Premium.");
    return;
  }

  if (!isPremium && filenameTemplate !== "kit-{date}-{time}") {
    alert("Custom filename template is Premium.");
    return;
  }

  await localSet({
    defaultFormat: format,
    filenameTemplate,
    settleMs,
    autoEditor
  });

  $("save-status").classList.remove("hidden");
  setTimeout(() => $("save-status").classList.add("hidden"), 1500);
}

function historyItemHTML(item) {
  const dt = new Date(item.date || Date.now()).toLocaleString();
  const t = (item.title || "Untitled").replace(/[<>&"]/g, "");
  const u = (item.url || "").replace(/[<>&"]/g, "");
  return `
    <article class="history-item">
      <img src="${item.thumb || ""}" alt="Capture preview" />
      <div class="history-meta">
        <div><strong>${item.type || "capture"}</strong> · ${dt}</div>
        <div title="${u}">${t}</div>
      </div>
    </article>
  `;
}

async function loadHistory() {
  if (!isPremium) {
    $("history-grid").innerHTML = "";
    $("history-empty").classList.add("hidden");
    return;
  }
  const { history = [] } = await localGet("history");
  if (!history.length) {
    $("history-grid").innerHTML = "";
    $("history-empty").classList.remove("hidden");
    return;
  }
  $("history-empty").classList.add("hidden");
  $("history-grid").innerHTML = history.map(historyItemHTML).join("");
}

async function clearHistory() {
  if (!confirm("Clear all saved capture history?")) return;
  await localSet({ history: [] });
  await loadHistory();
}

function bindEvents() {
  document.querySelectorAll(".nav-link").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const hash = a.getAttribute("href");
      history.replaceState(null, "", hash);
      showSection(hash);
    });
  });

  $("btn-save-general").addEventListener("click", saveGeneralSettings);
  $("btn-clear-history").addEventListener("click", clearHistory);

  $("btn-upgrade").addEventListener("click", () => sendMsg({ action: "open_payment" }));
  $("btn-upgrade-history").addEventListener("click", () => sendMsg({ action: "open_payment" }));
  $("btn-manage").addEventListener("click", () => sendMsg({ action: "open_manage" }));

  $("btn-rate").addEventListener("click", () => {
    chrome.tabs.create({ url: "https://chrome.google.com/webstore" });
  });
  $("btn-support").addEventListener("click", () => {
    chrome.tabs.create({ url: "mailto:support@example.com?subject=Kit%20Screenshot%20Support" });
  });

  $("sel-format").addEventListener("change", (e) => {
    if (!isPremium && e.target.value === "pdf") {
      alert("PDF export is a Premium feature.");
      e.target.value = "png";
    }
  });
}

async function boot() {
  bindEvents();
  showSection(location.hash);
  await loadStatus();
  await loadGeneralSettings();
  await loadHistory();
}

boot();
