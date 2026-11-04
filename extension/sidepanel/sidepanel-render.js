/**
 * Rendering for the shared-tabs panel. All untrusted tab text is inserted with
 * textContent (never innerHTML); missing data has explicit empty states.
 */
globalThis.ATCUI = globalThis.ATCUI || {};

ATCUI.renderAll = function renderAll(options) {
  const focus = options && options.restoreFocus === false ? null : ATCUI.captureFocus();
  ATCUI.recomputeRows();
  ATCUI.renderHeader();
  ATCUI.renderFilters();
  ATCUI.renderRows();
  ATCUI.renderFooter();
  ATCUI.hideInlineIfStale();
  if (focus !== null) ATCUI.restoreFocus(focus);
};

ATCUI.recomputeRows = function recomputeRows() {
  ATCUI.state.rows = ATCState.createRows(ATCUI.state.tabs, ATCUI.state.snapshot, { needsAccess: ATCUI.state.needsAccess });
  for (const id of [...ATCUI.state.selected]) {
    const row = ATCUI.rowById(id);
    if (row === null || !ATCState.isSelectable(row)) ATCUI.state.selected.delete(id);
  }
};

ATCUI.sharedCount = function sharedCount() {
  return ATCUI.state.rows.filter((row) => row.shared).length;
};

ATCUI.summaryText = function summaryText(shared) {
  if (ATCUI.state.connection === "error") return ATCUI.state.connectionMessage || "atc isn't connected.";
  if (ATCUI.state.connection === "loading") return "Connecting to atc…";
  if (shared === 0) return "Nothing is shared right now. Choose a tab below to get started.";
  return "Only tabs you share are visible to your assistant.";
};

ATCUI.renderHeader = function renderHeader() {
  const shared = ATCUI.sharedCount();
  ATCUI.els.sharedCount.textContent = String(shared);
  ATCUI.els.sharedCountSr.textContent = `${shared} ${ATCUI.pluralize(shared, "tab")} shared`;
  ATCUI.els.sharedSummary.textContent = ATCUI.summaryText(shared);
  ATCUI.renderActiveTarget();
};

ATCUI.renderActiveTarget = function renderActiveTarget() {
  const active = ATCUI.state.rows.find((row) => row.activeTarget);
  if (active === undefined) {
    ATCUI.els.activeTarget.hidden = true;
    ATCUI.els.activeTarget.replaceChildren();
    return;
  }
  const title = ATCUI.h("strong", null, active.title);
  title.title = active.url;
  ATCUI.els.activeTarget.hidden = false;
  ATCUI.els.activeTarget.replaceChildren(ATCUI.icon("target"), ATCUI.h("span", null, "Active target:"), title);
};

ATCUI.renderFilters = function renderFilters() {
  const countFor = ATCState.counts(ATCUI.state.rows, ATCUI.state.windowId);
  for (const button of ATCUI.els.filters) {
    const active = button.dataset.filter === ATCUI.state.filter;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  for (const countElement of ATCUI.els.filterCounts) {
    countElement.textContent = String(countFor[countElement.dataset.countFor] ?? 0);
  }
};

ATCUI.renderRows = function renderRows() {
  if (!ATCUI.state.tabsLoaded) return ATCUI.renderLoadingRows();
  const visible = ATCState.visibleRows(ATCUI.state.rows, ATCUI.state);
  ATCUI.els.tabList.replaceChildren(...visible.map(ATCUI.createRow));
  ATCUI.els.tabList.hidden = visible.length === 0;
  ATCUI.els.resultsCount.textContent = `${visible.length} ${ATCUI.pluralize(visible.length, "tab")}`;
  ATCUI.els.sharedEmpty.hidden = !ATCUI.showSharedEmpty();
  ATCUI.renderEmpty(visible.length);
};

ATCUI.showSharedEmpty = function showSharedEmpty() {
  return ATCUI.sharedCount() === 0 && ATCUI.state.rows.length > 0 && ATCUI.state.filter !== "shared" && ATCUI.state.query.trim() === "";
};

ATCUI.renderLoadingRows = function renderLoadingRows() {
  ATCUI.els.tabList.hidden = true;
  ATCUI.els.tabList.replaceChildren();
  ATCUI.els.sharedEmpty.hidden = true;
  ATCUI.els.resultsCount.textContent = "";
  ATCUI.renderEmptyState({ icon: "panel", title: "Loading tabs…", copy: "Reading the tabs in this browser.", action: null, label: "" });
};

ATCUI.renderEmpty = function renderEmpty(visibleCount) {
  const empty = visibleCount === 0 ? ATCState.emptyState(ATCUI.state.rows, ATCUI.state) : null;
  ATCUI.els.listEmpty.hidden = empty === null;
  if (empty === null) return ATCUI.els.listEmpty.replaceChildren();
  ATCUI.renderEmptyState(empty);
};

ATCUI.renderEmptyState = function renderEmptyState(content) {
  const children = [ATCUI.h("span", "empty-symbol")];
  children[0].append(ATCUI.icon(content.icon));
  children.push(ATCUI.h("h3", null, content.title), ATCUI.h("p", null, content.copy));
  if (content.action !== null) {
    const button = ATCUI.h("button", "btn btn-secondary btn-sm", content.label);
    button.type = "button";
    button.dataset.emptyAction = content.action;
    children.push(button);
  }
  ATCUI.els.listEmpty.replaceChildren(...children);
};

ATCUI.renderFooter = function renderFooter() {
  const selected = ATCState.selectionRows(ATCUI.state.rows, ATCUI.state.selected);
  const count = selected.length;
  ATCUI.els.shareSelected.disabled = count === 0 || ATCUI.state.connection !== "ready" || ATCUI.state.busy;
  ATCUI.els.shareSelected.title = count === 0 ? "Select at least one unshared tab to share" : "Review and share selected tabs";
  ATCUI.els.selectionStatus.classList.toggle("has-selection", count > 0);
  ATCUI.els.selectionStatus.textContent = ATCUI.footerStatus(count);
};

ATCUI.footerStatus = function footerStatus(count) {
  if (ATCUI.state.connection === "error") return count > 0 ? `${count} ${ATCUI.pluralize(count, "tab")} selected · atc isn't connected` : "atc isn't connected";
  if (ATCUI.state.connection === "loading") return "Connecting to atc…";
  if (count > 0) return `${count} ${ATCUI.pluralize(count, "tab")} selected`;
  if (ATCUI.state.rows.length > 0 && ATCUI.state.rows.every((row) => !ATCState.isSelectable(row))) return "All available tabs are already shared";
  return "Select tabs to share";
};

ATCUI.updateSearchUi = function updateSearchUi() {
  const hasQuery = ATCUI.state.query.trim() !== "";
  ATCUI.els.searchWrap.classList.toggle("has-query", hasQuery);
  ATCUI.els.searchClear.hidden = !hasQuery;
};

ATCUI.updateSelectionUi = function updateSelectionUi() {
  for (const item of ATCUI.els.tabList.querySelectorAll("[data-tab-id]")) {
    item.classList.toggle("is-selected", ATCUI.state.selected.has(Number(item.dataset.tabId)));
  }
  for (const checkbox of ATCUI.els.tabList.querySelectorAll("[data-select-id]")) {
    checkbox.checked = ATCUI.state.selected.has(Number(checkbox.dataset.selectId));
  }
  ATCUI.renderFooter();
};
