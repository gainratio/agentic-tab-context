/**
 * Shared side-panel singletons: DOM references, UI state, and small helpers.
 * Loaded before the render/action modules.
 */
globalThis.ATCUI = globalThis.ATCUI || {};

ATCUI.els = {
  panel: document.getElementById("panel"),
  sharedCount: document.getElementById("shared-count"),
  sharedCountSr: document.getElementById("shared-count-sr"),
  sharedSummary: document.getElementById("shared-summary"),
  activeTarget: document.getElementById("active-target"),
  search: document.getElementById("tab-search"),
  searchWrap: document.getElementById("search-wrap"),
  searchClear: document.getElementById("clear-search"),
  searchKbd: document.getElementById("search-kbd"),
  filters: Array.from(document.querySelectorAll("[data-filter]")),
  filterCounts: Array.from(document.querySelectorAll("[data-count-for]")),
  resultsCount: document.getElementById("results-count"),
  tabList: document.getElementById("tab-list"),
  listEmpty: document.getElementById("list-empty"),
  sharedEmpty: document.getElementById("shared-empty"),
  selectionStatus: document.getElementById("selection-status"),
  shareSelected: document.getElementById("share-selected"),
  inlineConfirm: document.getElementById("inline-confirm"),
  inlineTitle: document.getElementById("inline-title"),
  inlineHost: document.getElementById("inline-host"),
  inlineCancel: document.getElementById("inline-cancel"),
  inlineShare: document.getElementById("inline-share"),
  shareDialog: document.getElementById("share-dialog"),
  shareTitle: document.getElementById("share-title"),
  shareDesc: document.getElementById("share-desc"),
  shareList: document.getElementById("share-list"),
  shareDomains: document.getElementById("share-domains"),
  shareWarningExtra: document.getElementById("share-warning-extra"),
  shareConfirm: document.getElementById("share-confirm"),
  sensitiveDialog: document.getElementById("sensitive-dialog"),
  sensitiveTarget: document.getElementById("sensitive-target"),
  sensitiveError: document.getElementById("sensitive-error"),
  sensitiveConfirm: document.getElementById("sensitive-confirm"),
  toast: document.getElementById("toast"),
  a11yStatus: document.getElementById("a11y-status"),
};

ATCUI.state = {
  tabs: [],
  snapshot: { current: null, bindings: [] },
  rows: [],
  windowId: null,
  filter: "all",
  query: "",
  selected: new Set(),
  needsAccess: {},
  connection: "loading",
  connectionMessage: "",
  tabsLoaded: false,
  busy: false,
  pendingSensitiveId: null,
  pendingInlineId: null,
  pendingShareIds: [],
};

ATCUI.permissionCache = new Map();
ATCUI.tabsGeneration = 0;
ATCUI.bindingsGeneration = 0;
ATCUI.toastTimer = null;
ATCUI.pollTimer = null;
ATCUI.polling = false;
ATCUI.dialogOpener = null;
ATCUI.hasChromeTabs = typeof chrome === "object" && chrome !== null && chrome.tabs !== undefined;
ATCUI.hasRuntime =
  typeof chrome === "object" && chrome !== null && chrome.runtime !== undefined &&
  typeof chrome.runtime.sendMessage === "function";

ATCUI.h = function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

ATCUI.icon = function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
};

ATCUI.rowById = function rowById(id) {
  return ATCUI.state.rows.find((row) => row.id === id) || null;
};

ATCUI.pluralize = function pluralize(count, singular) {
  return ATCState.pluralize(count, singular);
};

ATCUI.showToast = function showToast(message) {
  if (ATCUI.toastTimer !== null) clearTimeout(ATCUI.toastTimer);
  ATCUI.els.toast.textContent = message;
  ATCUI.els.toast.classList.add("is-visible");
  ATCUI.toastTimer = setTimeout(() => {
    ATCUI.els.toast.classList.remove("is-visible");
    ATCUI.toastTimer = null;
  }, 3200);
};

ATCUI.announce = function announce(message) {
  ATCUI.els.a11yStatus.textContent = "";
  setTimeout(() => {
    ATCUI.els.a11yStatus.textContent = message;
  }, 20);
};

ATCUI.sendRuntime = async function sendRuntime(message) {
  if (!ATCUI.hasRuntime) return { ok: false, message: "Open this panel from the Agentic Tab Context extension." };
  try {
    return await chrome.runtime.sendMessage(message);
  } catch {
    return { ok: false, message: "Could not reach atc. Start it in a terminal and try again." };
  }
};

ATCUI.canTalkToDaemon = function canTalkToDaemon() {
  if (ATCUI.state.connection === "ready") return true;
  ATCUI.showToast(ATCUI.state.connection === "loading" ? "Still connecting to atc…" : "atc isn't connected. Start it in a terminal and try again.");
  return false;
};

ATCUI.setButtonBusy = function setButtonBusy(button, busy, label) {
  if (!button) return;
  if (!busy) return ATCUI.restoreButton(button);
  if (!button.dataset.restText) button.dataset.restText = button.textContent;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  if (label !== undefined) button.textContent = label;
};

ATCUI.restoreButton = function restoreButton(button) {
  button.disabled = false;
  button.removeAttribute("aria-busy");
  if (button.dataset.restText !== undefined) {
    button.textContent = button.dataset.restText;
    delete button.dataset.restText;
  }
};

ATCUI.captureFocus = function captureFocus() {
  const active = document.activeElement;
  if (!(active instanceof Element) || !ATCUI.els.tabList.contains(active)) return null;
  const item = active.closest("[data-tab-id]");
  if (item === null) return null;
  const focusTarget = active.closest("[data-focus]");
  return { id: Number(item.dataset.tabId), focus: focusTarget === null ? null : focusTarget.dataset.focus };
};

ATCUI.restoreFocus = function restoreFocus(snapshot) {
  const item = ATCUI.els.tabList.querySelector(`[data-tab-id="${snapshot.id}"]`);
  if (item === null) return;
  const selector = snapshot.focus === null ? "[data-focus='main']" : `[data-focus="${snapshot.focus}"]`;
  const target = item.querySelector(selector) || item.querySelector("[data-focus='main']");
  if (target !== null) target.focus({ preventScroll: true });
};

ATCUI.focusRow = function focusRow(id, target) {
  requestAnimationFrame(() => {
    const item = ATCUI.els.tabList.querySelector(`[data-tab-id="${id}"]`);
    if (item === null) {
      if (ATCUI.state.rows.length === 0) ATCUI.els.search.focus();
      return;
    }
    const selector = target === "select" ? "[data-select-id]" : `[data-focus="${target}"]`;
    const element = item.querySelector(selector) || item.querySelector("[data-focus='main']");
    if (element !== null) element.focus({ preventScroll: true });
  });
};
