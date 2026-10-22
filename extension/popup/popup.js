const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const tabTitle = document.getElementById("tab-title");
const tabUrl = document.getElementById("tab-url");
const bindButton = document.getElementById("bind-btn");
const feedback = document.getElementById("feedback");

function describeStatus(status) {
  if (status.atcDaemon) return { ready: true, text: "Connected to atc" };
  if (String(status.atcHost || "").startsWith("missing")) return { ready: false, text: "Run `atc setup` in a terminal, then reopen this popup" };
  return { ready: false, text: "Waiting for atc. Run any `atc` command (e.g. `atc tabs`)" };
}

async function showStatus() {
  const status = await request({ type: "atc:status" });
  const { ready, text } = describeStatus(status);
  statusDot.classList.toggle("connected", ready);
  statusText.textContent = text;
  bindButton.disabled = !ready;
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

async function showTab() {
  const tab = await activeTab();
  tabTitle.textContent = (tab && tab.title) || "No tab";
  tabUrl.textContent = (tab && tab.url) || "";
}

async function pinActiveTab() {
  const tab = await activeTab();
  if (!tab?.id) return { ok: false, message: "No active tab is available." };
  return request({ type: "atc:pin", tabId: tab.id });
}

function showFeedback(reply) {
  feedback.hidden = false;
  feedback.textContent = reply && reply.ok
    ? "Bound. Your assistant can now use this tab."
    : `Could not bind: ${(reply && reply.message) || "atc is not running"}`;
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

function startPopup() {
  if (typeof globalThis.chrome?.runtime?.sendMessage !== "function" || typeof globalThis.chrome?.tabs?.query !== "function") {
    showStandaloneHelp();
    return;
  }
  bindButton.addEventListener("click", () => void bindActiveTab());
  void showStatus();
  void showTab();
}

function showStandaloneHelp() {
  document.body.classList.add("standalone");
  statusText.textContent = "Opened outside the browser extension";
  document.getElementById("standalone-help").hidden = false;
  for (const element of [bindButton, document.querySelector(".tab-box"), document.querySelector(".footer")]) element.hidden = true;
}

startPopup();
