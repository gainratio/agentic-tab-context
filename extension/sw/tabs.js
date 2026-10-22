/**
 * Keeps the daemon's view of this browser's open tabs current. "Active" means
 * the selected tab of the window the user last focused, so it is unique.
 */
import { send } from "./native.js";

const PAGE_URL = /^(https?|file):/;

export async function pushTabs() {
  const [tabs, focused] = await Promise.all([chrome.tabs.query({}), lastFocusedWindowId()]);
  const visible = tabs.filter((tab) => typeof tab.id === "number" && PAGE_URL.test(tab.url || ""));
  send({
    type: "tabs",
    tabs: visible.map((tab) => ({
      id: tab.id,
      url: tab.url || "",
      title: tab.title || "",
      active: Boolean(tab.active) && tab.windowId === focused,
    })),
  });
}

async function lastFocusedWindowId() {
  try {
    return (await chrome.windows.getLastFocused()).id;
  } catch {
    return -1;
  }
}
