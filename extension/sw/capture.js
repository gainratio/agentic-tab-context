/** A capture changes the active tab, so all captures in one window share a lock. */
const windowCaptures = new Map();

export async function captureTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  return inWindow(tab.windowId, () => captureSelected(tabId, tab.windowId));
}

function inWindow(windowId, work) {
  const previous = windowCaptures.get(windowId) || Promise.resolve();
  const result = previous.then(work);
  const tail = result.catch(() => undefined);
  windowCaptures.set(windowId, tail);
  void tail.then(() => { if (windowCaptures.get(windowId) === tail) windowCaptures.delete(windowId); });
  return result;
}

async function captureSelected(tabId, windowId) {
  const state = await beginCapture(tabId, windowId);
  try {
    await selectTarget(state);
    const data = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    await assertTarget(state);
    return data;
  } finally {
    await finishCapture(state);
  }
}

async function beginCapture(tabId, windowId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.windowId !== windowId) throw new Error("the screenshot tab moved to another window; retry the capture");
  const [previous] = await chrome.tabs.query({ active: true, windowId });
  const state = { tabId, windowId, previous, changed: false };
  state.listener = (event) => { if (event.windowId === windowId && event.tabId !== tabId) state.changed = true; };
  chrome.tabs.onActivated.addListener(state.listener);
  return state;
}

async function selectTarget(state) {
  if (state.previous?.id !== state.tabId) await chrome.tabs.update(state.tabId, { active: true });
  await assertTarget(state);
}

async function assertTarget(state) {
  const [active] = await chrome.tabs.query({ active: true, windowId: state.windowId });
  if (state.changed || active?.id !== state.tabId) throw new Error("the window focus changed during the screenshot; retry the capture");
}

async function finishCapture(state) {
  try {
    const [active] = await chrome.tabs.query({ active: true, windowId: state.windowId }).catch(() => []);
    if (!state.changed && active?.id === state.tabId && state.previous && state.previous.id !== state.tabId) {
      await chrome.tabs.update(state.previous.id, { active: true }).catch(() => undefined);
    }
  } finally {
    chrome.tabs.onActivated.removeListener(state.listener);
  }
}
