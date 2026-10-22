/**
 * The persistent link to the local atc daemon: a native-messaging port to the
 * host that `atc setup` registered. While the port is open the browser keeps
 * this service worker alive. There is no network listener anywhere.
 */
import { browserName, instanceId } from "./identity.js";

const HOST_NAME = "com.gainratio.atc";
let port = null;
let onMessage = () => undefined;

export function setMessageHandler(handler) {
  onMessage = handler;
}

export function isConnected() {
  return port !== null;
}

export async function connect() {
  if (port !== null) return;
  port = chrome.runtime.connectNative(HOST_NAME);
  port.onMessage.addListener((message) => void onMessage(message));
  port.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError ? chrome.runtime.lastError.message : "";
    port = null;
    void chrome.storage.session.set({ atcHost: error ? `missing: ${error}` : "disconnected", atcDaemon: false });
    void onMessage({ type: "daemon", connected: false });
  });
  await chrome.storage.session.set({ atcHost: "connected" });
  send({ type: "hello", browser: browserName(), instance: await instanceId() });
}

export function send(message) {
  if (port !== null) port.postMessage(message);
}
