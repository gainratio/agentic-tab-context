/**
 * Pure list view-model helpers: filtering, counts, selection, share plans,
 * empty-state copy, and the deterministic favicon-dot color.
 */
globalThis.ATCState = globalThis.ATCState || {};

const FILTERS = ["all", "shared", "sensitive", "window"];

function normalizedQuery(query) {
  return typeof query === "string" ? query.trim().toLowerCase() : "";
}
function rowMatchesQuery(row, query) {
  if (query === "") return true;
  return [row.title, row.host, row.url].some((value) => typeof value === "string" && value.toLowerCase().includes(query));
}
function rowMatchesFilter(row, filter, windowId) {
  if (filter === "shared" && !row.shared) return false;
  if (filter === "sensitive" && !row.sensitive) return false;
  if (filter === "window" && windowId !== null && row.windowId !== windowId) return false;
  return true;
}
function visibleRows(rows, options) {
  const filter = options && FILTERS.includes(options.filter) ? options.filter : "all";
  const query = normalizedQuery(options && options.query);
  const windowId = options && Number.isSafeInteger(options.windowId) ? options.windowId : null;
  return rows.filter((row) => rowMatchesFilter(row, filter, windowId) && rowMatchesQuery(row, query));
}
function counts(rows, windowId) {
  const windowRows = Number.isSafeInteger(windowId) ? rows.filter((row) => row.windowId === windowId) : rows;
  return {
    all: rows.length,
    shared: rows.filter((row) => row.shared).length,
    sensitive: rows.filter((row) => row.sensitive).length,
    window: windowRows.length,
  };
}
function isSelectable(row) {
  return Boolean(row) && !row.shared && !row.sensitive && !row.unsupported && !row.needsAccess;
}
function selectedIdSet(selected) {
  if (selected !== null && typeof selected === "object" && typeof selected.has === "function") return selected;
  return new Set(Array.isArray(selected) ? selected : []);
}
function selectionRows(rows, selected) {
  const ids = selectedIdSet(selected);
  return rows.filter((row) => ids.has(row.id) && isSelectable(row));
}
function createSharePlan(rows, selected) {
  const tabs = selectionRows(rows, selected);
  return {
    tabs,
    count: tabs.length,
    domains: [...new Set(tabs.map((tab) => tab.host).filter(Boolean))],
    single: tabs.length === 1,
    lockedSensitive: rows.filter((row) => row.sensitive && !row.shared && !row.unsupported).length,
    unsupported: rows.filter((row) => row.unsupported && !row.shared).length,
  };
}
function pluralize(count, singular, plural) {
  return count === 1 ? singular : plural || `${singular}s`;
}
function emptyBase(icon, title, copy, action, label) {
  return { icon, title, copy, action: action || null, label: label || "" };
}
function emptyForQuery(options) {
  return emptyBase("search", `No tabs match “${(options && options.query) || ""}”`, "Try part of a title, hostname, or URL instead.", "clear-search", "Clear search");
}
function emptyForFilter(filter) {
  if (filter === "shared") return emptyBase("share", "Nothing shared yet", "Select an unshared tab below and choose Share selected. Sensitive tabs stay locked.", "show-all", "Show all tabs");
  if (filter === "sensitive") return emptyBase("lock", "No sensitive tabs open", "Mail, banking, health, password manager, and Web Store tabs appear here.", "show-all", "Show all tabs");
  if (filter === "window") return emptyBase("panel", "No tabs in this window", "Try All to see tabs from your other browser windows.", "show-all", "Show all tabs");
  return emptyBase("search", "No tabs here", "Try another filter or clear the search.", "show-all", "Show all tabs");
}
function emptyState(rows, options) {
  const filter = options && FILTERS.includes(options.filter) ? options.filter : "all";
  const visible = visibleRows(rows, options || {});
  if (visible.length > 0) return null;
  if (rows.length === 0) return emptyBase("panel", "No open tabs", "Open a page in your browser, then come back here to share it.", null, "");
  if (normalizedQuery(options && options.query) !== "") return emptyForQuery(options);
  return emptyForFilter(filter);
}
function faviconColor(host) {
  const text = typeof host === "string" ? host : "";
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `hsl(${Math.abs(hash) % 360} 48% 48%)`;
}

Object.assign(ATCState, {
  FILTERS,
  visibleRows,
  counts,
  isSelectable,
  selectionRows,
  createSharePlan,
  pluralize,
  emptyState,
  faviconColor,
});
