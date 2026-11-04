/**
 * Share/sensitive confirmations. Single-tab non-sensitive shares confirm inline;
 * multi-tab and sensitive shares use native <dialog> sheets.
 */
globalThis.ATCUI = globalThis.ATCUI || {};

ATCUI.showDialog = function showDialog(dialog) {
  ATCUI.dialogOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  requestAnimationFrame(() => dialog.focus());
};

ATCUI.closeDialog = function closeDialog(dialog) {
  if (typeof dialog.close === "function" && dialog.open) dialog.close();
  else if (dialog.hasAttribute("open")) {
    dialog.removeAttribute("open");
    dialog.dispatchEvent(new Event("close"));
  }
  const opener = ATCUI.dialogOpener;
  ATCUI.dialogOpener = null;
  if (opener !== null && document.contains(opener)) requestAnimationFrame(() => opener.focus());
};

ATCUI.openShareFlow = function openShareFlow() {
  if (!ATCUI.canTalkToDaemon()) return;
  const plan = ATCState.createSharePlan(ATCUI.state.rows, ATCUI.state.selected);
  if (plan.count === 0) return ATCUI.showToast("Select at least one unshared tab first.");
  if (plan.single) return ATCUI.showInlineConfirm(plan.tabs[0]);
  ATCUI.openShareDialog(plan);
};

ATCUI.showInlineConfirm = function showInlineConfirm(row) {
  ATCUI.state.pendingInlineId = row.id;
  ATCUI.els.inlineTitle.textContent = row.title;
  ATCUI.els.inlineHost.textContent = row.host;
  ATCUI.els.inlineConfirm.hidden = false;
  requestAnimationFrame(() => ATCUI.els.inlineShare.focus({ preventScroll: true }));
};

ATCUI.hideInlineConfirm = function hideInlineConfirm(restoreFocus) {
  const wasOpen = !ATCUI.els.inlineConfirm.hidden;
  ATCUI.els.inlineConfirm.hidden = true;
  ATCUI.state.pendingInlineId = null;
  if (wasOpen && restoreFocus !== false) ATCUI.els.shareSelected.focus({ preventScroll: true });
};

ATCUI.hideInlineIfStale = function hideInlineIfStale() {
  if (ATCUI.state.pendingInlineId === null) return;
  const row = ATCUI.rowById(ATCUI.state.pendingInlineId);
  if (row === null || !ATCState.isSelectable(row)) ATCUI.hideInlineConfirm(false);
};

ATCUI.openShareDialog = function openShareDialog(plan) {
  ATCUI.state.pendingShareIds = plan.tabs.map((row) => row.id);
  ATCUI.els.shareTitle.textContent = `Share ${plan.count} ${ATCUI.pluralize(plan.count, "tab")}?`;
  ATCUI.els.shareDesc.textContent = plan.count === 1
    ? "Your assistant will be able to read and act on this tab until you remove it."
    : "Your assistant will be able to read and act on these tabs until you remove them.";
  ATCUI.els.shareList.replaceChildren(...plan.tabs.map(ATCUI.createShareItem));
  ATCUI.fillShareDomains(plan);
  ATCUI.els.shareConfirm.textContent = `Share ${plan.count} ${ATCUI.pluralize(plan.count, "tab")}`;
  ATCUI.showDialog(ATCUI.els.shareDialog);
};

ATCUI.fillShareDomains = function fillShareDomains(plan) {
  ATCUI.els.shareDomains.replaceChildren();
  ATCUI.els.shareDomains.append(ATCUI.h("strong", null, "Domains:"), ATCUI.h("span", null, plan.domains.join(", ") || "—"));
  const locked = plan.lockedSensitive;
  ATCUI.els.shareWarningExtra.textContent = locked > 0
    ? `${locked} sensitive ${ATCUI.pluralize(locked, "tab")} ${locked === 1 ? "stays" : "stay"} locked.`
    : "Sensitive tabs require an explicit confirmation.";
};

ATCUI.createShareItem = function createShareItem(row) {
  const item = ATCUI.h("li", "share-item");
  const copy = ATCUI.h("span", "share-item-copy");
  copy.append(ATCUI.h("span", "share-item-title", row.title), ATCUI.h("span", "share-item-host", row.host));
  item.append(ATCUI.faviconFor(row), copy);
  return item;
};

ATCUI.openSensitiveDialog = function openSensitiveDialog(row) {
  if (row === null || !row.sensitive || row.shared || !row.supported) return;
  if (!ATCUI.canTalkToDaemon()) return;
  ATCUI.state.pendingSensitiveId = row.id;
  ATCUI.els.sensitiveError.hidden = true;
  ATCUI.els.sensitiveError.textContent = "";
  ATCUI.els.sensitiveTarget.replaceChildren(ATCUI.faviconFor(row), ATCUI.sensitiveTargetCopy(row));
  ATCUI.showDialog(ATCUI.els.sensitiveDialog);
};

ATCUI.sensitiveTargetCopy = function sensitiveTargetCopy(row) {
  const copy = ATCUI.h("span", "sensitive-target-copy");
  copy.append(ATCUI.h("span", "sensitive-target-title", row.title));
  copy.append(ATCUI.h("span", "sensitive-target-host", `${row.host} · ${row.category || "Sensitive"}`));
  return copy;
};

ATCUI.sensitiveShareFailed = function sensitiveShareFailed(reply) {
  ATCUI.els.sensitiveError.textContent = `Could not share this tab: ${reply.message || "atc did not respond."}`;
  ATCUI.els.sensitiveError.hidden = false;
};
