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
  const status = (await chrome.runtime.sendMessage({ type: "atc:status" })) || {};
  const { ready, text } = describeStatus(status);
  statusDot.classList.toggle("connected", ready);
  statusText.textContent = text;
  bindButton.disabled = !ready;
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

async function bindActiveTab() {
  bindButton.disabled = true;
  const tab = await activeTab();
  const reply = await chrome.runtime.sendMessage({ type: "atc:pin", tabId: tab.id });
  feedback.hidden = false;
  feedback.textContent = reply && reply.ok
    ? `Bound. Your assistant can now use this tab (context ${reply.context}).`
    : `Could not bind: ${(reply && reply.message) || "atc is not running"}`;
  bindButton.disabled = false;
}

bindButton.addEventListener("click", () => void bindActiveTab());
void showStatus();
void showTab();
