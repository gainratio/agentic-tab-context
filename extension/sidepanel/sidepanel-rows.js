/**
 * Row DOM builders. Titles/hosts/URLs are untrusted, so they are always set as
 * textContent or title attributes; no markup is interpolated.
 */
globalThis.ATCUI = globalThis.ATCUI || {};

ATCUI.createRow = function createRow(row) {
  const active = row.activeTarget ? " is-active" : "";
  const selected = ATCUI.state.selected.has(row.id) ? " is-selected" : "";
  const item = ATCUI.h("li", `tab-row${active}${selected}`);
  item.dataset.tabId = String(row.id);
  item.append(ATCUI.createLeadingControl(row), ATCUI.createRowMain(row), ATCUI.createRowActions(row));
  return item;
};

ATCUI.createLeadingControl = function createLeadingControl(row) {
  const cell = ATCUI.h("span", "check-cell");
  if (row.shared) return ATCUI.appendCheckbox(cell, ATCUI.createCheckbox(row, { checked: true, unshare: true }));
  if (row.sensitive) return ATCUI.appendLock(cell);
  return ATCUI.appendCheckbox(cell, ATCUI.createCheckbox(row, { checked: ATCUI.state.selected.has(row.id), select: true }));
};

ATCUI.appendCheckbox = function appendCheckbox(cell, checkbox) {
  cell.append(checkbox);
  return cell;
};
ATCUI.appendLock = function appendLock(cell) {
  const lock = ATCUI.h("span", "lock-cell");
  lock.setAttribute("role", "img");
  lock.setAttribute("aria-label", "Locked sensitive tab");
  lock.title = "Sensitive tab — locked by default";
  lock.append(ATCUI.icon("lock"));
  cell.append(lock);
  return cell;
};

ATCUI.createCheckbox = function createCheckbox(row, options) {
  const checkbox = ATCUI.h("input", "select-box");
  checkbox.type = "checkbox";
  checkbox.checked = options.checked === true;
  if (options.select) ATCUI.markSelectable(checkbox, row);
  if (options.unshare) ATCUI.markUnshare(checkbox, row);
  return checkbox;
};

ATCUI.markSelectable = function markSelectable(checkbox, row) {
  const selectable = ATCState.isSelectable(row);
  checkbox.dataset.selectId = String(row.id);
  checkbox.dataset.focus = "select";
  checkbox.disabled = !selectable;
  checkbox.setAttribute("aria-label", `Select ${row.title} from ${row.host} for sharing`);
  if (selectable) return;
  checkbox.title = row.unsupported ? "Unsupported pages can't be shared" : "This site needs host access before it can be shared";
  checkbox.setAttribute("aria-label", `${row.title} can't be shared because ${row.unsupported ? "this page is unsupported" : "host access is missing"}`);
};

ATCUI.markUnshare = function markUnshare(checkbox, row) {
  checkbox.dataset.unshareTab = String(row.id);
  checkbox.dataset.focus = "unshare";
  checkbox.disabled = ATCUI.state.connection !== "ready";
  checkbox.setAttribute("aria-label", `Stop sharing ${row.title} with your assistant`);
  checkbox.title = checkbox.disabled ? "atc isn't connected" : "Already shared — unchecking stops sharing. The browser tab stays open.";
};

ATCUI.createRowMain = function createRowMain(row) {
  const main = ATCUI.h("button", "tab-main");
  main.type = "button";
  main.dataset.rowMain = String(row.id);
  main.dataset.focus = "main";
  main.setAttribute("aria-label", ATCUI.describeRowAction(row));
  main.title = ATCUI.describeRowTitle(row);
  if (row.activeTarget) main.setAttribute("aria-current", "true");
  main.append(ATCUI.faviconFor(row), ATCUI.rowBody(row));
  return main;
};

ATCUI.faviconFor = function faviconFor(row) {
  const favicon = ATCUI.h("span", "favicon");
  favicon.setAttribute("aria-hidden", "true");
  favicon.style.setProperty("--dot", ATCState.faviconColor(row.host));
  return favicon;
};
ATCUI.rowBody = function rowBody(row) {
  const body = ATCUI.h("span", "tab-body");
  const title = ATCUI.h("span", "tab-title", row.title);
  title.title = row.title;
  body.append(title, ATCUI.rowMeta(row));
  return body;
};

ATCUI.rowMeta = function rowMeta(row) {
  const meta = ATCUI.h("span", "tab-meta");
  const host = ATCUI.h("span", "tab-host", row.host);
  host.title = row.url;
  const badges = ATCUI.h("span", "badges");
  badges.append(...ATCUI.createBadges(row));
  meta.append(host, badges);
  return meta;
};

ATCUI.describeRowAction = function describeRowAction(row) {
  if (row.shared) return row.activeTarget ? `${row.title} is the active target` : `Make ${row.title} from ${row.host} the active target`;
  if (row.sensitive && row.supported) return `${row.title} is a locked sensitive tab from ${row.host}. Choose Share to review it.`;
  if (row.unsupported) return `${row.title} can't be shared because this page is unsupported`;
  if (row.needsAccess) return `${row.title} needs host access before it can be shared`;
  return `Select ${row.title} from ${row.host} for sharing`;
};

ATCUI.describeRowTitle = function describeRowTitle(row) {
  if (row.shared) return row.activeTarget ? "Active target" : "Click to make this the active target";
  if (row.sensitive) return "Locked sensitive tab";
  if (row.unsupported) return "Unsupported page";
  return "Click to select for sharing";
};

ATCUI.createBadges = function createBadges(row) {
  const badges = [];
  if (row.shared) badges.push(ATCUI.sharedBadge(row));
  if (row.activeTarget) badges.push(ATCUI.activeBadge());
  if (row.needsAccess && !row.shared) badges.push(ATCUI.accessBadge());
  if (row.sensitive) badges.push(ATCUI.sensitiveBadge());
  if (row.unsupported) badges.push(ATCUI.makeBadge("badge-unsupported", null, "Unsupported"));
  return badges;
};

ATCUI.makeBadge = function makeBadge(className, iconName, text) {
  const badge = ATCUI.h("span", `badge ${className}`);
  if (iconName !== null) badge.append(ATCUI.icon(iconName));
  badge.append(document.createTextNode(text));
  return badge;
};

ATCUI.sharedBadge = function sharedBadge(row) {
  return ATCUI.makeBadge(`badge-shared${row.sensitive ? " is-amber" : ""}`, row.sensitive ? "lock" : "check", "Shared");
};

ATCUI.activeBadge = function activeBadge() {
  const badge = ATCUI.h("span", "badge badge-active");
  badge.append(ATCUI.h("span", "badge-dot"), document.createTextNode("Active"));
  return badge;
};

ATCUI.accessBadge = function accessBadge() {
  return ATCUI.makeBadge("badge-access", "key", "Needs access");
};

ATCUI.sensitiveBadge = function sensitiveBadge() {
  return ATCUI.makeBadge("badge-sensitive", "lock", "Sensitive");
};

ATCUI.createRowActions = function createRowActions(row) {
  const actions = ATCUI.h("span", "row-actions");
  if (row.sensitive && !row.shared && row.supported) actions.append(ATCUI.sensitiveShareButton(row));
  if (row.shared && !row.activeTarget) actions.append(ATCUI.activateButton(row));
  if (row.shared) actions.append(ATCUI.unshareButton(row));
  actions.append(ATCUI.closeButton(row));
  return actions;
};

ATCUI.sensitiveShareButton = function sensitiveShareButton(row) {
  const button = ATCUI.h("button", "unlock-btn");
  button.type = "button";
  button.dataset.shareSensitive = String(row.id);
  button.dataset.focus = "sensitive";
  button.disabled = ATCUI.state.connection !== "ready";
  button.setAttribute("aria-label", `Share sensitive tab: ${row.title}`);
  button.title = button.disabled ? "atc isn't connected" : "Review and share this sensitive tab";
  button.append(ATCUI.icon("lock"), document.createTextNode("Share"));
  return button;
};

ATCUI.iconButton = function iconButton(row, datasetName, focus, label, title, iconName) {
  const button = ATCUI.h("button", "row-icon-btn");
  button.type = "button";
  button.dataset[datasetName] = String(row.id);
  button.dataset.focus = focus;
  button.disabled = ATCUI.state.connection !== "ready";
  button.setAttribute("aria-label", label(row.title));
  button.title = button.disabled ? "atc isn't connected" : title;
  button.append(ATCUI.icon(iconName));
  return button;
};

ATCUI.activateButton = function activateButton(row) {
  return ATCUI.iconButton(row, "activateTab", "activate", (title) => `Make ${title} the active target`, "Make this the active target", "target");
};

ATCUI.unshareButton = function unshareButton(row) {
  return ATCUI.iconButton(row, "unshareTab", "remove", (title) => `Stop sharing ${title} with your assistant`, "Stop sharing (keeps the tab open)", "unlink");
};

ATCUI.closeButton = function closeButton(row) {
  const button = ATCUI.h("button", "close-btn");
  button.type = "button"; button.dataset.closeTab = String(row.id); button.dataset.focus = "close";
  button.setAttribute("aria-label", `Close tab: ${row.title}`); button.title = "Close tab";
  button.append(ATCUI.icon("x"));
  return button;
};
