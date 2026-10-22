/**
 * Agentic Tab Context background worker: links this browser to the local atc
 * daemon over native messaging, reports open tabs, and runs commands the
 * daemon sends for tabs the user bound.
 */
import { runConnectedCommand, setCaptureConnection } from "./sw/lifecycle.js";
import { connect, isConnected, send, setMessageHandler } from "./sw/native.js";
import { runPageOp, watchedTabs } from "./sw/page.js";
import { pushTabs } from "./sw/tabs.js";

/** Chrome's minimum alarm period; only used to retry if the native host is not installed yet. */
const RETRY_ALARM = { name: "atc-reconnect", periodInMinutes: 0.5 };
const pendingPins = new Map();
let nextPinId = 1;

setMessageHandler(async (message) => {
  if (message.type === "command") await runConnectedCommand(message);
  else if (message.type === "pinned") pendingPins.get(message.id)?.(message);
  else if (message.type === "daemon") await onDaemon(message.connected);
});

async function onDaemon(connected) {
  const cleanup = setCaptureConnection(connected);
  await chrome.storage.session.set({ atcDaemon: connected });
  await cleanup;
  if (connected) await pushTabs();
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

chrome.runtime.onInstalled.addListener(() => void start());
chrome.runtime.onStartup.addListener(() => void start());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RETRY_ALARM.name && !isConnected()) void start();
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  void reinjectWatch(tabId, change);
  if (change.status === "complete" || change.title || change.url) void pushTabs();
});
chrome.tabs.onActivated.addListener(() => void pushTabs());
chrome.tabs.onRemoved.addListener(() => void pushTabs());
chrome.windows.onFocusChanged.addListener(() => void pushTabs());

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "atc:pin") {
    void pinActiveTab(message.tabId).then(sendResponse);
    return true;
  }
  if (message?.type === "atc:status") {
    void chrome.storage.session.get(["atcHost", "atcDaemon"]).then(sendResponse);
    return true;
  }
  return false;
});

void start();
