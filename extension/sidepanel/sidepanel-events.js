/**
 * Event wiring. Handlers are deliberately small dispatchers so the DOM stays a
 * thin layer over the pure state module and membership actions.
 */
globalThis.ATCUI = globalThis.ATCUI || {};

ATCUI.bindEvents = function bindEvents() {
  ATCUI.bindSearchEvents();
  ATCUI.bindFilterEvents();
  ATCUI.bindListEvents();
  ATCUI.bindFooterEvents();
  ATCUI.bindDialogEvents();
  ATCUI.bindVisibility();
};

ATCUI.bindSearchEvents = function bindSearchEvents() {
  ATCUI.els.search.addEventListener("input", ATCUI.onSearchInput);
  ATCUI.els.search.addEventListener("keydown", ATCUI.onSearchKeydown);
  ATCUI.els.searchClear.addEventListener("click", ATCUI.clearSearch);
  ATCUI.bindShortcut();
};

ATCUI.bindShortcut = function bindShortcut() {
  document.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "k") return;
    event.preventDefault();
    ATCUI.els.search.focus();
    ATCUI.els.search.select();
  });
};

ATCUI.onSearchKeydown = function onSearchKeydown(event) {
  if (event.key !== "Escape") return;
  if (ATCUI.els.search.value !== "") {
    event.preventDefault();
    ATCUI.clearSearch();
    return;
  }
  ATCUI.els.search.blur();
};

ATCUI.bindFilterEvents = function bindFilterEvents() {
  for (const button of ATCUI.els.filters) button.addEventListener("click", () => ATCUI.setFilter(button.dataset.filter));
};

ATCUI.bindListEvents = function bindListEvents() {
  ATCUI.els.tabList.addEventListener("change", ATCUI.onListChange);
  ATCUI.els.tabList.addEventListener("click", ATCUI.onListClick);
  ATCUI.els.listEmpty.addEventListener("click", ATCUI.onEmptyClick);
};

ATCUI.onListChange = function onListChange(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (target.dataset.selectId !== undefined) return ATCUI.selectChanged(target);
  if (target.dataset.unshareTab !== undefined) ATCUI.unshareChanged(target);
};

ATCUI.selectChanged = function selectChanged(target) {
  const id = Number(target.dataset.selectId);
  if (target.checked) ATCUI.state.selected.add(id);
  else ATCUI.state.selected.delete(id);
  ATCUI.hideInlineConfirm(false);
  ATCUI.updateSelectionUi();
};

ATCUI.unshareChanged = function unshareChanged(target) {
  const row = ATCUI.rowById(Number(target.dataset.unshareTab));
  target.checked = true;
  if (row !== null) void ATCUI.unshareRow(row);
};

ATCUI.onListClick = function onListClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (target === null || target.matches("input")) return;
  ATCUI.handleRowTarget(target);
};

ATCUI.handleRowTarget = function handleRowTarget(target) {
  if (ATCUI.handleRowAction(target)) return;
  const main = target.closest("[data-row-main]");
  if (main !== null) ATCUI.handleRowMain(ATCUI.rowById(Number(main.dataset.rowMain)));
};

ATCUI.handleRowAction = function handleRowAction(target) {
  const close = target.closest("[data-close-tab]");
  if (close !== null) return ATCUI.runRowAction(ATCUI.closeTab, close.dataset.closeTab);
  const sensitive = target.closest("[data-share-sensitive]");
  if (sensitive !== null) return ATCUI.runRowAction(ATCUI.openSensitiveDialog, sensitive.dataset.shareSensitive);
  const activate = target.closest("[data-activate-tab]");
  if (activate !== null) return ATCUI.runRowAction(ATCUI.activateRow, activate.dataset.activateTab);
  const unshare = target.closest("[data-unshare-tab]");
  if (unshare !== null) return ATCUI.runRowAction(ATCUI.unshareRow, unshare.dataset.unshareTab);
  return false;
};

ATCUI.runRowAction = function runRowAction(action, rawId) {
  const row = ATCUI.rowById(Number(rawId));
  if (row !== null) void action(row);
  return true;
};

ATCUI.handleRowMain = function handleRowMain(row) {
  if (row === null) return;
  if (row.shared) return void ATCUI.activateRow(row);
  if (ATCState.isSelectable(row)) return ATCUI.toggleSelection(row.id);
  if (row.sensitive && row.supported) return ATCUI.focusSensitiveShare(row);
  if (row.needsAccess) return ATCUI.showToast("This site needs host access before it can be shared.");
  ATCUI.showToast("This page type can't be shared.");
};

ATCUI.focusSensitiveShare = function focusSensitiveShare(row) {
  const shareButton = ATCUI.els.tabList.querySelector(`[data-share-sensitive="${row.id}"]`);
  if (shareButton instanceof HTMLElement) shareButton.focus();
  ATCUI.showToast("This tab is locked. Choose Share to review it.");
};

ATCUI.onEmptyClick = function onEmptyClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  const button = target === null ? null : target.closest("[data-empty-action]");
  if (button !== null) ATCUI.handleEmptyAction(button);
};

ATCUI.bindFooterEvents = function bindFooterEvents() {
  ATCUI.els.shareSelected.addEventListener("click", ATCUI.openShareFlow);
  ATCUI.els.inlineCancel.addEventListener("click", () => ATCUI.hideInlineConfirm(true));
  ATCUI.els.inlineShare.addEventListener("click", ATCUI.onInlineShare);
  ATCUI.els.shareConfirm.addEventListener("click", () => void ATCUI.confirmShareSelected());
  ATCUI.els.sensitiveConfirm.addEventListener("click", () => void ATCUI.confirmSensitiveShare());
};

ATCUI.onInlineShare = function onInlineShare() {
  const row = ATCUI.state.pendingInlineId === null ? null : ATCUI.rowById(ATCUI.state.pendingInlineId);
  if (row === null) return ATCUI.hideInlineConfirm(false);
  void ATCUI.performShare(row, { button: ATCUI.els.inlineShare });
};

ATCUI.bindDialogEvents = function bindDialogEvents() {
  for (const closer of document.querySelectorAll("[data-close-dialog]")) ATCUI.bindDialogCloser(closer);
  for (const dialog of [ATCUI.els.shareDialog, ATCUI.els.sensitiveDialog]) ATCUI.bindDialogElement(dialog);
  ATCUI.els.shareDialog.addEventListener("close", () => { ATCUI.state.pendingShareIds = []; });
  ATCUI.els.sensitiveDialog.addEventListener("close", ATCUI.onSensitiveClosed);
};

ATCUI.bindDialogCloser = function bindDialogCloser(closer) {
  closer.addEventListener("click", () => {
    const dialog = document.getElementById(closer.dataset.closeDialog);
    if (dialog !== null) ATCUI.closeDialog(dialog);
  });
};

ATCUI.bindDialogElement = function bindDialogElement(dialog) {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) ATCUI.closeDialog(dialog);
  });
};

ATCUI.onSensitiveClosed = function onSensitiveClosed() {
  ATCUI.state.pendingSensitiveId = null;
  ATCUI.els.sensitiveError.hidden = true;
  ATCUI.els.sensitiveError.textContent = "";
};

ATCUI.bindVisibility = function bindVisibility() {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void ATCUI.refreshAll();
  });
};
