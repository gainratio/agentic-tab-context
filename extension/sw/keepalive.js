/**
 * Session-scoped keep-alive for explicitly shared tabs: prevents Chrome tab
 * discarding (`autoDiscardable: false`) and runs a periodic MV3 alarm pulse
 * without reloading the page or touching credentials.
 */
import { runPageOp } from "./page.js";

export const KEEPALIVE_ALARM = { name: "atc-keepalive", periodInMinutes: 1 };

const AUTH_HOST = /^(login|signin|sso|auth|id|idp)\.|(\.|^)(okta|auth0|onelogin|pingidentity|duosecurity)\.com$|^login\.microsoftonline\.com$|^accounts\.google\.com$/i;
const AUTH_PATH = /\/(login|log-in|signin|sign-in|sso|oauth2?|authorize|authenticate|reauth)(\/|$)/i;
let keepAliveTail = Promise.resolve();

export function isAuthScreenUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ""));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return AUTH_HOST.test(parsed.hostname) || AUTH_PATH.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function isLoginRedirectUrl(initialUrl, currentUrl) {
  if (!initialUrl || !currentUrl) return false;
  return !isAuthScreenUrl(initialUrl) && isAuthScreenUrl(currentUrl);
}

export async function keepAliveEntries() {
  const { atcKeepAlive = {} } = await chrome.storage.session.get("atcKeepAlive");
  return typeof atcKeepAlive === "object" && atcKeepAlive !== null ? { ...atcKeepAlive } : {};
}

export async function isTabKeepAlive(tabId) {
  const entries = await keepAliveEntries();
  return Object.hasOwn(entries, String(tabId));
}

export async function refreshKeepAliveTab(tabId) {
  if (!(await isTabKeepAlive(tabId))) return;
  await setAutoDiscardable(tabId, false);
}

export function setTabKeepAlive(tabId, enabled) {
  const result = keepAliveTail.then(() => (enabled ? enableTab(tabId) : disableTab(tabId)));
  keepAliveTail = result.catch(() => undefined);
  return result;
}

export function dropKeepAliveTab(tabId) {
  const result = keepAliveTail.then(() => removeEntry(tabId, false));
  keepAliveTail = result.catch(() => undefined);
  return result;
}

export function clearAllKeepAlive() {
  const result = keepAliveTail.then(resetAllEntries);
  keepAliveTail = result.catch(() => undefined);
  return result;
}

export async function pulseKeepAliveTabs() {
  const entries = await keepAliveEntries();
  const ids = Object.keys(entries);
  if (ids.length === 0) return clearKeepAliveAlarm();
  await Promise.all(ids.map((id) => tickTab(Number(id), entries[id])));
}

async function enableTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const entries = await keepAliveEntries();
  entries[String(tabId)] = { url: tab.url || "" };
  await chrome.storage.session.set({ atcKeepAlive: entries });
  await setAutoDiscardable(tabId, false);
  await chrome.alarms.create(KEEPALIVE_ALARM.name, { periodInMinutes: KEEPALIVE_ALARM.periodInMinutes });
  await pulseOne(tabId, entries[String(tabId)].url, tab.url || "");
  return { ok: true, keepAlive: true };
}

async function disableTab(tabId) {
  await removeEntry(tabId, true);
  return { ok: true, keepAlive: false };
}

async function removeEntry(tabId, restoreTab) {
  const entries = await keepAliveEntries();
  const key = String(tabId);
  if (!Object.hasOwn(entries, key)) return;
  delete entries[key];
  await chrome.storage.session.set({ atcKeepAlive: entries });
  if (restoreTab) await setAutoDiscardable(tabId, true);
  if (Object.keys(entries).length === 0) await clearKeepAliveAlarm();
}

async function resetAllEntries() {
  const entries = await keepAliveEntries();
  await chrome.storage.session.set({ atcKeepAlive: {} });
  await clearKeepAliveAlarm();
  await Promise.all(Object.keys(entries).map((id) => setAutoDiscardable(Number(id), true)));
}

async function tickTab(tabId, meta) {
  const tab = await getTabOrNull(tabId);
  if (tab === null) return dropKeepAliveTab(tabId);
  await setAutoDiscardable(tabId, false);
  await pulseOne(tabId, meta?.url || "", tab.url || "");
}

async function pulseOne(tabId, initialUrl, currentUrl) {
  if (isLoginRedirectUrl(initialUrl, currentUrl)) return;
  await runPageOp(tabId, { op: "keepalive" }).catch(() => undefined);
}

async function getTabOrNull(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

async function setAutoDiscardable(tabId, autoDiscardable) {
  if (typeof chrome.tabs?.update !== "function") return;
  await Promise.resolve(chrome.tabs.update(tabId, { autoDiscardable })).catch(() => undefined);
}

async function clearKeepAliveAlarm() {
  if (typeof chrome.alarms?.clear !== "function") return;
  await Promise.resolve(chrome.alarms.clear(KEEPALIVE_ALARM.name)).catch(() => undefined);
}
