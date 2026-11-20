const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const tabTitle = document.getElementById("tab-title");
const tabUrl = document.getElementById("tab-url");
const bindButton = document.getElementById("bind-btn");
const openSharedButton = document.getElementById("open-shared-btn");
const keepAliveRow = document.getElementById("keepalive-row");
const keepAliveToggle = document.getElementById("keepalive-toggle");
const feedback = document.getElementById("feedback");

function describeStatus(status) {
  if (status.atcDaemon) return { ready: true, text: "Connected to atc" };
  if (String(status.atcHost || "").startsWith("missing")) return { ready: false, text: "Run `atc setup` in a terminal, then reopen this popup" };
  return { ready: false, text: "Starting atc…" };
}

function applyStatus(status) {
  const { ready, text } = describeStatus(status);
  statusDot.classList.toggle("connected", ready);
  statusText.textContent = text;
  bindButton.disabled = !ready;
}

async function showStatus() {
  applyStatus(await request({ type: "atc:status" }));
}

async function request(message) {
  try {
    return (await chrome.runtime.sendMessage(message)) || {};
  } catch {
    return { ok: false, message: "Connection to atc was lost. Reopen this popup." };
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

function isHttpUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

async function showTab() {
  const tab = await activeTab();
  tabTitle.textContent = (tab && tab.title) || "No tab";
  tabUrl.textContent = (tab && tab.url) || "";
  await syncKeepAliveToggle(tab);
}

async function syncKeepAliveToggle(tab) {
  if (!keepAliveToggle) return;
  const supported = Number.isSafeInteger(tab?.id) && isHttpUrl(tab?.url);
  keepAliveToggle.disabled = !supported;
  if (!supported) { keepAliveToggle.checked = false; return; }
  const reply = await request({ type: "atc:tab-keepalive-status", tabId: tab.id });
  keepAliveToggle.checked = reply.keepAlive === true;
}

async function toggleTabKeepAlive() {
  const tab = await activeTab();
  if (!Number.isSafeInteger(tab?.id)) return;
  const enabled = keepAliveToggle.checked;
  keepAliveToggle.disabled = true;
  const reply = await request({ type: "atc:tab-keepalive", tabId: tab.id, enabled });
  keepAliveToggle.disabled = false;
  if (!reply.ok) { keepAliveToggle.checked = !enabled; return showText(`Could not update keep-alive: ${reply.message || "try again"}`); }
  showText(enabled ? "Keep-alive on — this tab will stay awake and signed in." : "Keep-alive off for this tab.");
}

async function pinActiveTab() {
  const tab = await activeTab();
  if (!tab?.id) return { ok: false, message: "No active tab is available." };
  return request({ type: "atc:pin", tabId: tab.id });
}

function showText(text) {
  feedback.hidden = false;
  feedback.textContent = text;
}

function showFeedback(reply) {
  showText(
    reply && reply.ok
      ? "Bound. Your assistant can now use this tab."
      : `Could not bind: ${(reply && reply.message) || "atc is not running"}`,
  );
}

async function bindActiveTab() {
  bindButton.disabled = true;
  try {
    showFeedback(await pinActiveTab());
  } catch {
    showFeedback({ ok: false, message: "Could not read the active tab. Reopen this popup." });
  } finally {
    bindButton.disabled = false;
  }
}

async function activeWindowId() {
  const tab = await activeTab();
  return Number.isSafeInteger(tab?.windowId) ? tab.windowId : undefined;
}

async function openSidePanelApi(windowId) {
  if (typeof globalThis.chrome?.sidePanel?.open !== "function") return false;
  try {
    await chrome.sidePanel.open(windowId === undefined ? {} : { windowId });
    return true;
  } catch {
    return false;
  }
}

async function openPanelViaWorker(windowId) {
  const reply = await request({ type: "atc:open-sidepanel", ...(windowId === undefined ? {} : { windowId }) });
  if (reply.ok) return true;
  showText(`Could not open shared tabs: ${(reply && reply.message) || "the panel is unavailable."}`);
  return false;
}

async function openSharedTabs() {
  openSharedButton.disabled = true;
  try {
    const windowId = await activeWindowId();
    if ((await openSidePanelApi(windowId)) || (await openPanelViaWorker(windowId))) window.close();
  } finally {
    openSharedButton.disabled = false;
  }
}

function watchStatusChanges() {
  if (typeof globalThis.chrome?.storage?.onChanged?.addListener !== "function") return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && (changes.atcDaemon || changes.atcHost)) void showStatus();
  });
}

function startPopup() {
  if (typeof globalThis.chrome?.runtime?.sendMessage !== "function" || typeof globalThis.chrome?.tabs?.query !== "function") {
    showStandaloneHelp();
    return;
  }
  bindButton.addEventListener("click", () => void bindActiveTab());
  openSharedButton.addEventListener("click", () => void openSharedTabs());
  keepAliveToggle?.addEventListener("change", () => void toggleTabKeepAlive());
  watchStatusChanges();
  void showStatus();
  void showTab();
}

function showStandaloneHelp() {
  document.body.classList.add("standalone");
  statusText.textContent = "Opened outside the browser extension";
  document.getElementById("standalone-help").hidden = false;
  for (const element of [bindButton, openSharedButton, keepAliveRow, document.querySelector(".tab-box"), document.querySelector(".footer")]) {
    if (element) element.hidden = true;
  }
}

startPopup();
