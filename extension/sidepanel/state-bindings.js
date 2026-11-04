/**
 * Binding snapshot validation and the daemon-binding -> browser-tab mapping.
 * Pure, no chrome.* and no DOM.
 */
globalThis.ATCState = globalThis.ATCState || {};

function bindingIsRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function bindingIsId(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function nullableString(value) {
  return value === null || typeof value === "string";
}
function optionalNullableString(value) {
  return value === undefined || value === null || typeof value === "string";
}
function parseExtensionTabId(tabId) {
  if (typeof tabId !== "string") return null;
  const match = /^ext:([a-z]+-[0-9a-f]{8}):(\d+)$/.exec(tabId);
  if (match === null) return null;
  const rawTabId = Number(match[2]);
  if (!Number.isSafeInteger(rawTabId) || rawTabId <= 0) return null;
  return { key: match[1], tabId: rawTabId };
}
function normalizeBinding(raw) {
  if (!bindingIsRecord(raw)) return null;
  if (typeof raw.context !== "string" || raw.context.trim() === "") return null;
  if (!nullableString(raw.tabId) || !nullableString(raw.source)) return null;
  if (typeof raw.browser !== "string" || typeof raw.current !== "boolean") return null;
  if (raw.tabId === undefined || raw.source === undefined) return null;
  return {
    context: raw.context,
    tabId: raw.tabId,
    browser: raw.browser,
    source: raw.source,
    url: typeof raw.url === "string" ? raw.url : null,
    title: typeof raw.title === "string" ? raw.title : null,
    current: raw.current,
  };
}
function normalizeBindingList(rawList) {
  if (!Array.isArray(rawList)) return null;
  const bindings = [];
  for (const raw of rawList) {
    const binding = normalizeBinding(raw);
    if (binding === null) return null;
    bindings.push(binding);
  }
  return bindings;
}
function normalizeBindingsReply(reply) {
  const invalid = { ok: false, current: null, bindings: [], message: "atc sent an invalid tab list." };
  if (!bindingIsRecord(reply) || typeof reply.ok !== "boolean") return invalid;
  if (reply.current !== null && typeof reply.current !== "string") return invalid;
  if (reply.message !== undefined && typeof reply.message !== "string") return invalid;
  const bindings = normalizeBindingList(reply.bindings);
  if (bindings === null) return invalid;
  return { ok: reply.ok, current: reply.current, bindings, ...(typeof reply.message === "string" ? { message: reply.message } : {}) };
}
function normalizeOutcomeReply(reply) {
  if (!bindingIsRecord(reply) || typeof reply.ok !== "boolean") return { ok: false, message: "atc sent an invalid response." };
  if (reply.context !== undefined && typeof reply.context !== "string") return { ok: false, message: "atc sent an invalid response." };
  if (!optionalNullableString(reply.message) || !optionalNullableString(reply.error)) return { ok: false, message: "atc sent an invalid response." };
  return {
    ok: reply.ok,
    ...(typeof reply.context === "string" ? { context: reply.context } : {}),
    ...(typeof reply.message === "string" ? { message: reply.message } : {}),
    ...(typeof reply.error === "string" ? { error: reply.error } : {}),
  };
}
function bindingRawId(binding) {
  const parsed = parseExtensionTabId(binding && binding.tabId);
  return parsed === null ? null : parsed.tabId;
}
function bindingsByTabId(bindings) {
  const byTabId = new Map();
  for (const binding of bindings) {
    const rawId = bindingRawId(binding);
    if (rawId !== null && !byTabId.has(rawId)) byTabId.set(rawId, binding);
  }
  return byTabId;
}
function tabUrl(tab) {
  return typeof tab.url === "string" ? tab.url : "";
}
function tabTitle(tab, host, url) {
  return typeof tab.title === "string" && tab.title.trim() !== "" ? tab.title.trim() : host || url || "Untitled tab";
}
function tabIdentity(tab, url, host) {
  return {
    id: tab.id, index: Number.isSafeInteger(tab.index) ? tab.index : 0,
    windowId: Number.isSafeInteger(tab.windowId) ? tab.windowId : null,
    title: tabTitle(tab, host, url), url, host, activeBrowserTab: tab.active === true,
  };
}
function tabBinding(binding, current) {
  return {
    context: binding ? binding.context : null,
    shared: binding !== null,
    activeTarget: binding !== null && binding.context === current,
  };
}
function tabRisk(classified, needsAccess, tabId) {
  return {
    sensitive: classified.sensitive,
    supported: classified.supported,
    unsupported: classified.unsupported,
    category: classified.category,
    needsAccess: needsAccess[tabId] === true,
  };
}
function tabRow(tab, binding, current, needsAccess) {
  const url = tabUrl(tab);
  const classified = ATCState.classifyUrl(url);
  const host = ATCState.hostOf(url);
  return { ...tabIdentity(tab, url, host), ...tabBinding(binding, current), ...tabRisk(classified, needsAccess, tab.id) };
}
function createRows(tabs, snapshot, options) {
  const input = Array.isArray(tabs) ? tabs : [];
  const bindings = snapshot && Array.isArray(snapshot.bindings) ? snapshot.bindings : [];
  const current = snapshot && typeof snapshot.current === "string" ? snapshot.current : null;
  const byTabId = bindingsByTabId(bindings);
  const needsAccess = (options && options.needsAccess) || {};
  return input
    .filter((tab) => tab && bindingIsId(tab.id))
    .map((tab) => tabRow(tab, byTabId.get(tab.id) || null, current, needsAccess));
}

Object.assign(ATCState, {
  parseExtensionTabId,
  normalizeBindingsReply,
  normalizeOutcomeReply,
  bindingRawId,
  createRows,
});
