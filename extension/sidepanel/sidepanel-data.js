/**
 * Daemon and browser-tab refreshes for the side panel. Every write is guarded
 * by a generation counter so a slow reply can never overwrite a newer one.
 */
globalThis.ATCUI = globalThis.ATCUI || {};

ATCUI.refreshAll = async function refreshAll() {
  await Promise.allSettled([ATCUI.refreshTabs(), ATCUI.refreshBindings()]);
};

ATCUI.refreshTabs = async function refreshTabs() {
  if (!ATCUI.hasChromeTabs || typeof chrome.tabs.query !== "function") return ATCUI.finishTabsLoading();
  const generation = ++ATCUI.tabsGeneration;
  try {
    const tabs = await chrome.tabs.query({});
    const windowId = await ATCUI.currentWindowId(tabs);
    await ATCUI.applyTabs(generation, tabs, windowId);
  } catch {
    if (generation === ATCUI.tabsGeneration) ATCUI.failTabs();
  }
};

ATCUI.finishTabsLoading = function finishTabsLoading() {
  ATCUI.state.tabsLoaded = true;
  ATCUI.renderAll();
};

ATCUI.failTabs = function failTabs() {
  ATCUI.state.tabsLoaded = true;
  ATCUI.showToast("Could not read your browser tabs.");
  ATCUI.renderAll();
};

ATCUI.applyTabs = async function applyTabs(generation, tabs, windowId) {
  await ATCUI.updateNeedsAccess(tabs);
  if (generation !== ATCUI.tabsGeneration) return;
  ATCUI.state.tabs = Array.isArray(tabs) ? tabs : [];
  ATCUI.state.windowId = windowId;
  ATCUI.state.tabsLoaded = true;
  ATCUI.renderAll();
};

ATCUI.currentWindowId = async function currentWindowId(tabs) {
  try {
    const window = await chrome.windows.getCurrent();
    if (window && Number.isSafeInteger(window.id)) return window.id;
  } catch {
    // Fall through to the active tab.
  }
  const active = (Array.isArray(tabs) ? tabs : []).find((tab) => tab.active === true);
  return active && Number.isSafeInteger(active.windowId) ? active.windowId : null;
};

ATCUI.updateNeedsAccess = async function updateNeedsAccess(tabs) {
  const next = {};
  if (chrome.permissions === undefined || typeof chrome.permissions.contains !== "function") {
    ATCUI.state.needsAccess = next;
    return;
  }
  const checks = await Promise.all((Array.isArray(tabs) ? tabs : []).map((tab) => ATCUI.tabAccess(tab)));
  for (const entry of checks) if (entry !== null) next[entry[0]] = entry[1];
  ATCUI.state.needsAccess = next;
};

ATCUI.tabAccess = async function tabAccess(tab) {
  if (!Number.isSafeInteger(tab.id) || !ATCState.isSupportedUrl(tab.url)) return null;
  const origin = ATCUI.originOf(tab.url);
  if (origin === null) return null;
  const granted = await ATCUI.hasAccess(origin);
  return granted === false ? [tab.id, true] : null;
};

ATCUI.originOf = function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

ATCUI.hasAccess = async function hasAccess(origin) {
  const cached = ATCUI.permissionCache.get(origin);
  if (cached !== undefined) return cached;
  try {
    const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
    if (granted) ATCUI.permissionCache.set(origin, true);
    return granted;
  } catch {
    return null;
  }
};

ATCUI.refreshBindings = async function refreshBindings() {
  if (!ATCUI.hasRuntime) return ATCUI.bindingsUnavailable("Open this panel from the Agentic Tab Context extension.");
  const generation = ++ATCUI.bindingsGeneration;
  let reply;
  try {
    reply = await chrome.runtime.sendMessage({ type: "atc:bindings" });
  } catch {
    reply = { ok: false, message: "Could not reach atc. Start it in a terminal, then reopen this panel." };
  }
  if (generation !== ATCUI.bindingsGeneration) return;
  ATCUI.applyBindings(ATCState.normalizeBindingsReply(reply));
};

ATCUI.bindingsUnavailable = function bindingsUnavailable(message) {
  ATCUI.state.snapshot = { current: null, bindings: [] };
  ATCUI.state.connection = "error";
  ATCUI.state.connectionMessage = message;
  ATCUI.renderAll();
};

ATCUI.applyBindings = function applyBindings(normalized) {
  if (normalized.ok) {
    ATCUI.state.snapshot = { current: normalized.current, bindings: normalized.bindings };
    ATCUI.state.connection = "ready";
    ATCUI.state.connectionMessage = "";
  } else {
    ATCUI.state.snapshot = { current: null, bindings: [] };
    ATCUI.state.connection = "error";
    ATCUI.state.connectionMessage = normalized.message || "atc isn't connected. Start it in a terminal, then try again.";
  }
  ATCUI.renderAll();
};

ATCUI.onRuntimeMessage = function onRuntimeMessage(message) {
  if (typeof message !== "object" || message === null) return false;
  if (message.type === "atc:tabs-changed") {
    void ATCUI.refreshTabs();
    void ATCUI.refreshBindings();
  } else if (message.type === "atc:bindings-changed") {
    void ATCUI.refreshBindings();
  }
  return false;
};

ATCUI.poll = function poll() {
  if (document.visibilityState !== "visible" || ATCUI.polling) return;
  ATCUI.polling = true;
  void ATCUI.refreshAll().finally(() => {
    ATCUI.polling = false;
  });
};

ATCUI.startPolling = function startPolling() {
  if (ATCUI.pollTimer !== null) return;
  ATCUI.pollTimer = setInterval(ATCUI.poll, 6000);
};
