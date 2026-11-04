/**
 * Agentic Tab Context background worker: links this browser to the local atc
 * daemon over native messaging, reports open tabs, runs commands the daemon
 * sends for tabs the user shared, and brokers the side panel's membership
 * requests. No page content crosses this worker.
 */
import { runConnectedCommand, setCaptureConnection } from "./sw/lifecycle.js";
import { activateContext, connect, isConnected, requestBindings, send, setMessageHandler, shareTab, unshareContext } from "./sw/native.js";
import { runPageOp, watchedTabs } from "./sw/page.js";
import { parseSidepanelMessage } from "./sw/requests.js";
import { pushTabs } from "./sw/tabs.js";

/** Chrome's minimum alarm period; only used to retry if the native host is not installed yet. */
const RETRY_ALARM = { name: "atc-reconnect", periodInMinutes: 0.5 };
const pendingPins = new Map();
let nextPinId = 1;

setMessageHandler(async (message) => {
  if (message.type === "command") await runConnectedCommand(message);
  else if (message.type === "pinned") pendingPins.get(message.id)?.(message);
  else if (message.type === "daemon") await onDaemon(message.connected);
  // bindings/shared/unshared/activated replies are settled inside sw/native.js.
});

async function onDaemon(connected) {
  const cleanup = setCaptureConnection(connected);
  await chrome.storage.session.set({ atcDaemon: connected });
  await cleanup;
  if (connected) await pushTabs();
  broadcastMembershipChanged();
}

async function start() {
  await chrome.alarms.create(RETRY_ALARM.name, { periodInMinutes: RETRY_ALARM.periodInMinutes });
  await connect();
  await pushTabs();
}

function pinActiveTab(tabId) {
  return new Promise((resolve) => {
    const id = nextPinId++;
    pendingPins.set(id, (reply) => {
      pendingPins.delete(id);
      resolve(reply);
    });
    send({ type: "pin", id, tabId });
  });
}

async function reinjectWatch(tabId, change) {
  if (change.status !== "loading" || !(await watchedTabs()).has(tabId)) return;
  await runPageOp(tabId, { op: "watch" }).catch(() => undefined);
}

/** Coalesce a burst of tab events into one daemon push and one panel invalidation. */
let tabsChangedQueued = false;
let tabsChangedTail = Promise.resolve();
function scheduleTabsChanged() {
  if (tabsChangedQueued) return;
  tabsChangedQueued = true;
  tabsChangedTail = tabsChangedTail
    .then(async () => {
      tabsChangedQueued = false;
      await pushTabs();
      broadcastMembershipChanged();
    })
    .catch(() => {
      tabsChangedQueued = false;
    });
}

/** Invalidate both views after any membership or tab-list change. */
function broadcastMembershipChanged() {
  broadcast({ type: "atc:tabs-changed" });
  broadcast({ type: "atc:bindings-changed" });
}

function broadcast(message) {
  try {
    const result = chrome.runtime.sendMessage?.(message);
    if (result !== undefined && result !== null && typeof result.catch === "function") {
      result.catch(() => undefined);
    }
  } catch {
    // No panel is open, or it was closed between events.
  }
}

async function handleSidepanelRequest(request) {
  if (request.type === "atc:bindings") return requestBindings();
  if (request.type === "atc:open-sidepanel") return openSidepanel(request.windowId);
  const action = sidepanelAction(request);
  if (action === null) return { ok: false, message: "Unsupported request." };
  const reply = await action();
  if (reply.ok) broadcastMembershipChanged();
  return reply;
}

function sidepanelAction(request) {
  if (request.type === "atc:share") return () => shareTab(request.tabId);
  if (request.type === "atc:unshare") return () => unshareContext(request.context);
  if (request.type === "atc:activate") return () => activateContext(request.context);
  return null;
}

/**
 * `chrome.sidePanel.open` needs a user gesture. The popup calls it directly
 * first; this worker path is the fallback and, where the API is unavailable
 * (e.g. Firefox), opens the same panel page in a normal browser tab.
 */
async function openSidepanel(windowId) {
  const target = await targetWindowId(windowId);
  if (target === null) return { ok: false, message: "No browser window is available." };
  if (await openSidePanelApi(target)) return { ok: true, mode: "sidepanel" };
  return openPanelTab(target);
}

async function targetWindowId(windowId) {
  if (Number.isSafeInteger(windowId) && windowId > 0) return windowId;
  try {
    return (await chrome.windows.getLastFocused()).id ?? null;
  } catch {
    return null;
  }
}

async function openSidePanelApi(windowId) {
  if (chrome.sidePanel === undefined || typeof chrome.sidePanel.open !== "function") return false;
  try {
    await chrome.sidePanel.open({ windowId });
    return true;
  } catch {
    return false;
  }
}

async function openPanelTab(windowId) {
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL("sidepanel/index.html"), windowId, active: true });
    return { ok: true, mode: "tab" };
  } catch {
    return { ok: false, message: "Could not open the shared tabs panel." };
  }
}

function listen(event, listener) {
  if (event !== undefined && typeof event.addListener === "function") event.addListener(listener);
}

chrome.runtime.onInstalled.addListener(() => void start());
chrome.runtime.onStartup.addListener(() => void start());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RETRY_ALARM.name && !isConnected()) void start();
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  void reinjectWatch(tabId, change);
  if (change.status === "complete" || change.title || change.url) scheduleTabsChanged();
});
listen(chrome.tabs.onCreated, () => scheduleTabsChanged());
listen(chrome.tabs.onRemoved, () => scheduleTabsChanged());
listen(chrome.tabs.onMoved, () => scheduleTabsChanged());
listen(chrome.tabs.onReplaced, () => scheduleTabsChanged());
listen(chrome.tabs.onActivated, () => scheduleTabsChanged());
listen(chrome.windows.onFocusChanged, () => scheduleTabsChanged());

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "atc:pin") {
    void pinActiveTab(message.tabId).then(sendResponse);
    return true;
  }
  if (message?.type === "atc:status") {
    void chrome.storage.session.get(["atcHost", "atcDaemon"]).then(sendResponse);
    return true;
  }
  const request = parseSidepanelMessage(message);
  if (request === undefined) return false;
  void handleSidepanelRequest(request).then(
    sendResponse,
    (error) => sendResponse({ ok: false, message: error instanceof Error ? error.message : String(error) }),
  );
  return true;
});

void start();
