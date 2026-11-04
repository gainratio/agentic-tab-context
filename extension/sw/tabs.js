/**
 * Keeps the daemon's view of this browser's open tabs current. "Active" means
 * the selected tab of the window the user last focused, so it is unique.
 */
import { send } from "./native.js";

const PAGE_URL = /^(https?|file):/;

/** Every tab the daemon can receive, plus the window used to compute "active". */
export async function queryPageTabs() {
  const [tabs, focusedWindowId] = await Promise.all([chrome.tabs.query({}), lastFocusedWindowId()]);
  return {
    focusedWindowId,
    tabs: tabs.filter((tab) => typeof tab.id === "number" && PAGE_URL.test(tab.url || "")),
  };
}

export async function pushTabs() {
  const { tabs, focusedWindowId } = await queryPageTabs();
  send({
    type: "tabs",
    tabs: tabs.map((tab) => ({
      id: tab.id,
      url: tab.url || "",
      title: tab.title || "",
      active: Boolean(tab.active) && tab.windowId === focusedWindowId,
    })),
  });
  return tabs;
}

export async function lastFocusedWindowId() {
  try {
    return (await chrome.windows.getLastFocused()).id;
  } catch {
    return -1;
  }
}
