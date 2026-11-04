/** Captures share an extension-wide quota and a focus lock for each window. */
const windowCaptures = new Map();

function setRedaction(tabId, enabled) {
  return chrome.scripting.executeScript({ target: { tabId }, func: enabled ? maskSecrets : unmaskSecrets }).catch(() => undefined);
}

function maskSecrets() {
  const selector = 'input[type="password"],[autocomplete~="one-time-code"],[autocomplete*="cc-"]';
  for (const element of document.querySelectorAll(selector)) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const mask = document.createElement("div");
    mask.dataset.atcRedact = "1";
    mask.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;background:#111;z-index:2147483647;pointer-events:none`;
    document.documentElement.append(mask);
  }
}

function unmaskSecrets() {
  for (const mask of document.querySelectorAll("[data-atc-redact]")) mask.remove();
}
const CAPTURE_INTERVAL_MS = Math.ceil(1000 / (chrome.tabs.MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND || 2)) + 1;
let captureTail = Promise.resolve();
let nextCaptureAt = 0;

export async function captureTab(tabId, options = {}) {
  const tab = await chrome.tabs.get(tabId);
  return inWindow(tab.windowId, () => withinQuota(() => captureSelected(tabId, tab.windowId, options)));
}

function withinQuota(work) {
  const result = captureTail.then(async () => {
    const delay = Math.max(0, nextCaptureAt - performance.now());
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    return work();
  });
  captureTail = result.then(() => undefined, () => undefined);
  return result;
}

function inWindow(windowId, work) {
  const previous = windowCaptures.get(windowId) || Promise.resolve();
  const result = previous.then(work);
  const tail = result.catch(() => undefined);
  windowCaptures.set(windowId, tail);
  void tail.then(() => { if (windowCaptures.get(windowId) === tail) windowCaptures.delete(windowId); });
  return result;
}

async function captureSelected(tabId, windowId, options = {}) {
  const state = await beginCapture(tabId, windowId);
  try {
    await selectTarget(state);
    if (options.redact) { await setRedaction(tabId, true); await new Promise((resolve) => setTimeout(resolve, 120)); }
    const data = await capturePixels(windowId);
    await assertTarget(state);
    return data;
  } finally {
    if (options.redact) await setRedaction(tabId, false);
    await finishCapture(state);
  }
}

async function capturePixels(windowId) {
  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } finally {
    // Browser admission precedes settlement, even when IPC delivery is delayed.
    nextCaptureAt = performance.now() + CAPTURE_INTERVAL_MS;
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
