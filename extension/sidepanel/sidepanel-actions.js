/**
 * Search, filter, and selection actions. Keeping selection as a Set means it
 * survives filter/search changes, while a refresh prunes tabs that closed.
 */
globalThis.ATCUI = globalThis.ATCUI || {};

ATCUI.onSearchInput = function onSearchInput() {
  ATCUI.state.query = ATCUI.els.search.value;
  ATCUI.updateSearchUi();
  ATCUI.hideInlineConfirm(false);
  ATCUI.renderRows();
};

ATCUI.clearSearch = function clearSearch() {
  ATCUI.state.query = "";
  ATCUI.els.search.value = "";
  ATCUI.updateSearchUi();
  ATCUI.renderRows();
  ATCUI.els.search.focus();
};

ATCUI.setFilter = function setFilter(filter) {
  if (!ATCState.FILTERS.includes(filter)) return;
  ATCUI.state.filter = filter;
  ATCUI.hideInlineConfirm(false);
  ATCUI.renderFilters();
  ATCUI.renderRows();
};

ATCUI.toggleSelection = function toggleSelection(id) {
  const row = ATCUI.rowById(id);
  if (row === null || !ATCState.isSelectable(row)) return;
  if (ATCUI.state.selected.has(id)) ATCUI.state.selected.delete(id);
  else ATCUI.state.selected.add(id);
  ATCUI.hideInlineConfirm(false);
  ATCUI.updateSelectionUi();
};

ATCUI.handleEmptyAction = function handleEmptyAction(button) {
  if (button.dataset.emptyAction === "clear-search") return ATCUI.clearSearch();
  ATCUI.setFilter("all");
  ATCUI.els.search.focus();
};
