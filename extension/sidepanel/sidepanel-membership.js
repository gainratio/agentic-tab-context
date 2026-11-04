/**
 * Membership mutations: share, unshare, activate, close. Share/unshare/activate
 * go through the worker daemon contract; close calls chrome.tabs.remove and
 * removes the row locally before the browser round trip.
 */
globalThis.ATCUI = globalThis.ATCUI || {};

ATCUI.sendShare = function sendShare(tabId) {
  return ATCUI.sendRuntime({ type: "atc:share", tabId });
};
ATCUI.sendOutcome = function sendOutcome(type, payload) {
  return ATCUI.sendRuntime({ type, ...payload }).then(ATCState.normalizeOutcomeReply);
};

ATCUI.performShare = async function performShare(row, options) {
  if (row === null || !ATCState.isSelectable(row)) {
    ATCUI.hideInlineConfirm(false);
    return false;
  }
  if (!ATCUI.canTalkToDaemon() || ATCUI.state.busy) return false;
  ATCUI.state.busy = true;
  ATCUI.setButtonBusy(options && options.button, true, "Sharing…");
  ATCUI.renderFooter();
  const reply = await ATCUI.sendOutcome("atc:share", { tabId: row.id });
  ATCUI.state.busy = false;
  ATCUI.setButtonBusy(options && options.button, false);
  if (!reply.ok) return ATCUI.shareFailed(row, reply);
  await ATCUI.shareSucceeded(row, options);
  return true;
};

ATCUI.shareFailed = function shareFailed(row, reply) {
  ATCUI.showToast(`Could not share “${row.title}”: ${reply.message || "atc did not respond."}`);
  ATCUI.renderFooter();
  return false;
};
ATCUI.shareSucceeded = async function shareSucceeded(row, options) {
  ATCUI.state.selected.delete(row.id);
  ATCUI.hideInlineConfirm(false);
  const note = options && options.sensitive ? " You unlocked this sensitive tab." : "";
  ATCUI.showToast(`Shared “${row.title}” with your assistant.${note}`);
  ATCUI.announce(`${row.title} shared with your assistant.`);
  await ATCUI.refreshBindings();
  ATCUI.focusRow(row.id, "main");
};

ATCUI.beginUnshare = function beginUnshare(context) {
  const current = ATCUI.state.snapshot.current;
  ATCUI.state.busy = true;
  ATCUI.state.snapshot = {
    current: current === context ? null : current,
    bindings: ATCUI.state.snapshot.bindings.filter((binding) => binding.context !== context),
  };
  ATCUI.renderAll();
};

ATCUI.unshareFailed = function unshareFailed(row, previous, reply) {
  ATCUI.state.snapshot = previous;
  ATCUI.renderAll();
  ATCUI.showToast(`Could not stop sharing “${row.title}”: ${reply.message || "atc did not respond."}`);
};

ATCUI.unshareSucceeded = async function unshareSucceeded(row) {
  ATCUI.showToast(`Stopped sharing “${row.title}”. The tab is still open.`);
  ATCUI.announce(`${row.title} is no longer shared. The browser tab is still open.`);
  await ATCUI.refreshBindings();
  ATCUI.focusRow(row.id, "select");
};

ATCUI.unshareRow = async function unshareRow(row) {
  if (row === null || !row.shared || typeof row.context !== "string") return;
  if (!ATCUI.canTalkToDaemon()) return ATCUI.renderAll();
  if (ATCUI.state.busy) return;
  const previous = ATCUI.state.snapshot;
  ATCUI.beginUnshare(row.context);
  const reply = await ATCUI.sendOutcome("atc:unshare", { context: row.context });
  ATCUI.state.busy = false;
  if (!reply.ok) return ATCUI.unshareFailed(row, previous, reply);
  await ATCUI.unshareSucceeded(row);
};

ATCUI.activateFailed = function activateFailed(row, previous, reply) {
  ATCUI.state.snapshot = { ...ATCUI.state.snapshot, current: previous };
  ATCUI.renderAll();
  ATCUI.showToast(`Could not activate “${row.title}”: ${reply.message || "atc did not respond."}`);
};

ATCUI.activateSucceeded = async function activateSucceeded(row) {
  ATCUI.showToast(`“${row.title}” is now the active target.`);
  ATCUI.announce(`${row.title} is now the active target.`);
  await ATCUI.refreshBindings();
  ATCUI.focusRow(row.id, "main");
};

ATCUI.activateRow = async function activateRow(row) {
  if (row === null || !row.shared || typeof row.context !== "string") return;
  if (!ATCUI.canTalkToDaemon()) return;
  if (row.activeTarget) return ATCUI.announce(`${row.title} is already the active target.`);
  const previous = ATCUI.state.snapshot.current;
  ATCUI.state.snapshot = { ...ATCUI.state.snapshot, current: row.context };
  ATCUI.renderAll();
  const reply = await ATCUI.sendOutcome("atc:activate", { context: row.context });
  if (!reply.ok) return ATCUI.activateFailed(row, previous, reply);
  await ATCUI.activateSucceeded(row);
};

ATCUI.nextVisibleId = function nextVisibleId(rowId) {
  const visible = ATCState.visibleRows(ATCUI.state.rows, ATCUI.state);
  const index = visible.findIndex((candidate) => candidate.id === rowId);
  return (visible[index + 1] || visible[index - 1] || { id: null }).id;
};

ATCUI.removeLocalTab = function removeLocalTab(row) {
  ATCUI.state.tabs = ATCUI.state.tabs.filter((tab) => tab.id !== row.id);
  ATCUI.state.selected.delete(row.id);
  ATCUI.state.snapshot = {
    current: row.context !== null && ATCUI.state.snapshot.current === row.context ? null : ATCUI.state.snapshot.current,
    bindings: ATCUI.state.snapshot.bindings.filter((binding) => binding.context !== row.context),
  };
  ATCUI.renderAll();
};

ATCUI.removeBrowserTab = function removeBrowserTab(row, wasShared) {
  Promise.resolve()
    .then(() => chrome.tabs.remove(row.id))
    .then(
      () => {
        if (wasShared) void ATCUI.refreshBindings();
      },
      () => {
        ATCUI.showToast(`Could not close “${row.title}”.`);
        void ATCUI.refreshTabs();
      },
    );
};

ATCUI.closeTab = function closeTab(row) {
  if (row === null || typeof chrome.tabs.remove !== "function") return;
  const wasShared = row.shared;
  const nextId = ATCUI.nextVisibleId(row.id);
  ATCUI.removeLocalTab(row);
  ATCUI.showToast(`Closed “${row.title}”.${wasShared ? " It was removed from shared tabs." : ""}`);
  ATCUI.announce(`${row.title} closed.${wasShared ? " It was removed from shared tabs." : ""}`);
  if (nextId !== null) ATCUI.focusRow(nextId, "main");
  else ATCUI.els.search.focus({ preventScroll: true });
  ATCUI.removeBrowserTab(row, wasShared);
};

ATCUI.shareRows = async function shareRows(rows) {
  const results = [];
  for (const row of rows) results.push({ row, reply: await ATCUI.sendOutcome("atc:share", { tabId: row.id }) });
  return results;
};

ATCUI.finishShareMany = function finishShareMany(rows, results) {
  const shared = results.filter((result) => result.reply.ok);
  const failed = results.find((result) => !result.reply.ok);
  if (shared.length > 0) {
    const suffix = failed === undefined ? "" : ` ${results.length - shared.length} could not be shared: ${failed.reply.message || "atc did not respond."}`;
    ATCUI.showToast(`${shared.length} ${ATCUI.pluralize(shared.length, "tab")} shared with your assistant.${suffix}`);
    ATCUI.announce(`${shared.length} tabs shared.`);
    ATCUI.focusRow(rows[0].id, "main");
    return;
  }
  ATCUI.showToast(`Could not share the selected tabs: ${failed === undefined ? "atc did not respond." : failed.reply.message}`);
};

ATCUI.confirmShareSelected = async function confirmShareSelected() {
  const rows = ATCUI.state.pendingShareIds.map(ATCUI.rowById).filter((row) => row !== null && ATCState.isSelectable(row));
  if (rows.length === 0) return ATCUI.closeDialog(ATCUI.els.shareDialog);
  if (ATCUI.state.busy) return;
  ATCUI.state.busy = true;
  ATCUI.state.pendingShareIds = [];
  ATCUI.setButtonBusy(ATCUI.els.shareConfirm, true, "Sharing…");
  const results = await ATCUI.shareRows(rows);
  for (const result of results) if (result.reply.ok) ATCUI.state.selected.delete(result.row.id);
  ATCUI.state.busy = false;
  ATCUI.setButtonBusy(ATCUI.els.shareConfirm, false);
  ATCUI.closeDialog(ATCUI.els.shareDialog);
  await ATCUI.refreshBindings();
  ATCUI.finishShareMany(rows, results);
};

ATCUI.confirmSensitiveShare = async function confirmSensitiveShare() {
  const row = ATCUI.state.pendingSensitiveId === null ? null : ATCUI.rowById(ATCUI.state.pendingSensitiveId);
  if (row === null) return ATCUI.closeDialog(ATCUI.els.sensitiveDialog);
  if (ATCUI.state.busy) return;
  ATCUI.state.busy = true;
  ATCUI.setButtonBusy(ATCUI.els.sensitiveConfirm, true, "Sharing…");
  ATCUI.els.sensitiveError.hidden = true;
  const reply = await ATCUI.sendOutcome("atc:share", { tabId: row.id });
  ATCUI.state.busy = false;
  ATCUI.setButtonBusy(ATCUI.els.sensitiveConfirm, false);
  if (!reply.ok) return ATCUI.sensitiveShareFailed(reply);
  ATCUI.state.pendingSensitiveId = null;
  ATCUI.closeDialog(ATCUI.els.sensitiveDialog);
  await ATCUI.shareSucceeded(row, { sensitive: true });
};
