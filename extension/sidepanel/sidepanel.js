/**
 * Side-panel entry point. Earlier scripts define ATCUI; this one wires the
 * extension API surface and starts the first refresh.
 */
globalThis.ATCUI = globalThis.ATCUI || {};

ATCUI.setupShortcutHint = function setupShortcutHint() {
  if (!/Mac|iPhone|iPad|iPod/i.test(navigator.userAgent)) ATCUI.els.searchKbd.textContent = "Ctrl K";
};

ATCUI.resetStandaloneHeader = function resetStandaloneHeader() {
  document.body.classList.add("standalone");
  ATCUI.els.sharedSummary.textContent = "Open this page from the Agentic Tab Context side panel.";
  ATCUI.els.sharedCount.textContent = "0";
  ATCUI.els.sharedCountSr.textContent = "0 tabs shared";
  ATCUI.els.activeTarget.hidden = true;
};

ATCUI.showStandalone = function showStandalone() {
  ATCUI.resetStandaloneHeader();
  ATCUI.els.tabList.hidden = true;
  ATCUI.els.sharedEmpty.hidden = true;
  ATCUI.els.listEmpty.hidden = false;
  ATCUI.renderEmptyState({
    icon: "panel",
    title: "Open the side panel",
    copy: "This page needs the browser extension APIs. Use the Agentic Tab Context toolbar button and choose Open shared tabs.",
    action: null,
    label: "",
  });
  ATCUI.els.selectionStatus.textContent = "Browser tabs are unavailable here.";
  ATCUI.els.shareSelected.disabled = true;
};

ATCUI.bindRuntime = function bindRuntime() {
  if (typeof chrome.runtime.onMessage !== "object" || chrome.runtime.onMessage === null) return;
  chrome.runtime.onMessage.addListener(ATCUI.onRuntimeMessage);
};

ATCUI.start = function start() {
  ATCUI.setupShortcutHint();
  if (!ATCUI.hasChromeTabs || !ATCUI.hasRuntime) return ATCUI.showStandalone();
  ATCUI.bindEvents();
  ATCUI.renderAll({ restoreFocus: false });
  ATCUI.bindRuntime();
  void ATCUI.refreshAll();
  ATCUI.startPolling();
};

ATCUI.start();
