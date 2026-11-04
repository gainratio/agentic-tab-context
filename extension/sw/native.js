/**
 * The persistent link to the local atc daemon: a native-messaging port to the
 * host that `atc setup` registered. While the port is open the browser keeps
 * this service worker alive. There is no network listener anywhere.
 *
 * Side-panel membership requests share the same port. Each one carries a
 * positive request id and waits for exactly one typed reply; a disconnect or
 * timeout settles every pending request instead of leaving the panel spinning.
 */
import { browserName, instanceId } from "./identity.js";
import { normalizeDaemonReply, responseTypeFor } from "./requests.js";

const HOST_NAME = "com.gainratio.atc";
const NATIVE_REPLY_TYPES = new Set(["bindings", "shared", "unshared", "activated"]);
const REQUEST_TIMEOUT_MS = Object.freeze({
  bindings: 10_000,
  share: 35_000,
  unshare: 15_000,
  activate: 15_000,
});

let port = null;
let onMessage = () => undefined;
let nextRequestId = 1;
const pending = new Map();

export function setMessageHandler(handler) {
  onMessage = handler;
}

export function isConnected() {
  return port !== null;
}

export async function connect() {
  if (port !== null) return;
  port = chrome.runtime.connectNative(HOST_NAME);
  port.onMessage.addListener((message) => {
    if (receiveReply(message)) return;
    void onMessage(message);
  });
  port.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError ? chrome.runtime.lastError.message : "";
    port = null;
    settleAll(`atc disconnected${error ? ` (${error})` : ""}. Reopen the panel to try again.`);
    void chrome.storage.session.set({ atcHost: error ? `missing: ${error}` : "disconnected", atcDaemon: false });
    void onMessage({ type: "daemon", connected: false });
  });
  await chrome.storage.session.set({ atcHost: "connected" });
  send({ type: "hello", browser: browserName(), instance: await instanceId(), protocol: 2, version: typeof chrome.runtime.getManifest === "function" ? chrome.runtime.getManifest().version : "unknown" });
}

export function send(message) {
  if (port === null) return false;
  port.postMessage(message);
  return true;
}

/** Read-only workspace snapshot for the side panel. */
export function requestBindings() {
  return requestDaemon("bindings");
}

/** User-initiated share of a raw browser tab id (sensitive URLs are allowed only through this path). */
export function shareTab(tabId) {
  if (!Number.isSafeInteger(tabId) || tabId <= 0) return Promise.resolve({ ok: false, message: "Invalid tab id." });
  return requestDaemon("share", { tabId });
}

export function unshareContext(context) {
  if (typeof context !== "string" || context.trim() === "") {
    return Promise.resolve({ ok: false, message: "Invalid context." });
  }
  return requestDaemon("unshare", { context });
}

export function activateContext(context) {
  if (typeof context !== "string" || context.trim() === "") {
    return Promise.resolve({ ok: false, message: "Invalid context." });
  }
  return requestDaemon("activate", { context });
}

function requestDaemon(type, payload = {}) {
  const responseType = responseTypeFor(type);
  if (responseType === undefined) return Promise.resolve({ ok: false, message: `Unsupported request: ${type}` });
  if (port === null) {
    return Promise.resolve({ ok: false, message: "atc is not connected. Start atc in a terminal, then try again." });
  }
  return createPendingRequest(type, responseType, payload);
}

function createPendingRequest(type, responseType, payload) {
  const id = allocateRequestId();
  return new Promise((resolve) => {
    const timer = setTimeout(() => settleTimeout(id, resolve), REQUEST_TIMEOUT_MS[type] ?? 15_000);
    pending.set(id, { responseType, resolve, timer });
    if (send({ type, id, ...payload })) return;
    clearTimeout(timer);
    pending.delete(id);
    resolve({ ok: false, message: "atc is not connected." });
  });
}

function settleTimeout(id, resolve) {
  if (!pending.has(id)) return;
  pending.delete(id);
  resolve({ ok: false, message: "atc did not respond in time. Check that the daemon is running." });
}

/** Resolve the pending request this message answers. Returns false for command/other traffic. */
function receiveReply(message) {
  if (typeof message !== "object" || message === null || !NATIVE_REPLY_TYPES.has(message.type)) return false;
  const entry = pending.get(message.id);
  if (entry === undefined) return true;
  if (entry.responseType !== message.type) return true;
  clearTimeout(entry.timer);
  pending.delete(message.id);
  const reply = normalizeDaemonReply(entry.responseType, message);
  entry.resolve(reply ?? { ok: false, message: "atc sent an invalid response. Update atc and retry." });
  return true;
}

function allocateRequestId() {
  while (pending.has(nextRequestId)) nextRequestId = nextRequestId >= 2_147_483_647 ? 1 : nextRequestId + 1;
  const id = nextRequestId;
  nextRequestId = nextRequestId >= 2_147_483_647 ? 1 : nextRequestId + 1;
  return id;
}

function settleAll(message) {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.resolve({ ok: false, message });
  }
  pending.clear();
}
