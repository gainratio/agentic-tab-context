/**
 * Executes one daemon command against one tab and reports the result.
 */
import { send } from "./native.js";
import { captureTab } from "./capture.js";
import { runPageOp, setWatched } from "./page.js";

const HANDLERS = {
  navigate: (tabId, p) => navigateAndWait(tabId, p.timeoutMs, () => chrome.tabs.update(tabId, { url: String(p.url) })),
  back: (tabId, p) => navigateAndWait(tabId, p.timeoutMs, () => chrome.tabs.goBack(tabId)),
  forward: (tabId, p) => navigateAndWait(tabId, p.timeoutMs, () => chrome.tabs.goForward(tabId)),
  reload: (tabId, p) => navigateAndWait(tabId, p.timeoutMs, () => chrome.tabs.reload(tabId)),
  location: async (tabId) => {
    const tab = await chrome.tabs.get(tabId);
    return { url: tab.url || "", title: tab.title || "" };
  },
  screenshot: (tabId) => captureTab(tabId),
  page: (tabId, p) => runPageOp(tabId, p.op),
  watch: async (tabId) => {
    await setWatched(tabId, true);
    return runPageOp(tabId, { op: "watch" });
  },
  unwatch: async (tabId) => {
    await setWatched(tabId, false);
    return runPageOp(tabId, { op: "unwatch" });
  },
};

export async function runCommand(command) {
  const handler = HANDLERS[command.action];
  try {
    if (!handler) throw new Error(`unsupported command ${command.action}`);
    const result = await handler(command.tabId, command.payload || {});
    send({ type: "result", id: command.id, ok: true, result });
  } catch (error) {
    send({ type: "result", id: command.id, ok: false, ...describeError(error) });
  }
}

function describeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/No tab with id/i.test(message)) return { error: "CONTEXT_CLOSED", message: "the bound tab was closed" };
  if (/Timed out/i.test(message)) return { error: "TIMEOUT", message };
  if (/Cannot access|cannot be scripted|chrome:\/\//i.test(message)) return { error: "UNSUPPORTED_ACTION", message };
  return { error: "ACTION_FAILED", message };
}

/** Start a navigation and resolve once the tab finishes loading (or fail after timeoutMs). */
function navigateAndWait(tabId, timeoutMs, start) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Timed out after ${timeoutMs} ms waiting for the page to load`)), timeoutMs);
    const listener = (id, change) => {
      if (id === tabId && change.status === "complete") finish();
    };
    const finish = (error) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      if (error) reject(error);
      else resolve({ ok: true });
    };
    chrome.tabs.onUpdated.addListener(listener);
    start().catch(finish);
  });
}
