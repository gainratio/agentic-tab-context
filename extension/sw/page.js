/**
 * Runs the shared page agent (page-agent.js) inside a tab. Inspect and actions
 * run in the extension's isolated world, where page scripts cannot tamper with
 * them; console/network capture must run in the page's own world to see its calls.
 */

const PAGE_WORLD_OPS = new Set(["watch", "unwatch", "logs"]);
const pageTails = new Map();
let storageTail = Promise.resolve();

export function runPageOp(tabId, op) {
  const result = (pageTails.get(tabId) || Promise.resolve()).then(() => executePageOp(tabId, op));
  const tail = result.catch(() => undefined);
  pageTails.set(tabId, tail);
  void tail.then(() => { if (pageTails.get(tabId) === tail) pageTails.delete(tabId); });
  return result;
}

async function executePageOp(tabId, op) {
  if (op.op === "watch" && !(await watchedTabs()).has(tabId)) return { ok: true };
  const world = PAGE_WORLD_OPS.has(op.op) ? "MAIN" : "ISOLATED";
  const target = { tabId };
  await chrome.scripting.executeScript({ target, world, files: ["page-agent-watch.js", "page-agent-actions.js", "page-agent.js"], injectImmediately: true });
  const [frame] = await chrome.scripting.executeScript({
    target,
    world,
    injectImmediately: true,
    func: invokeAgent,
    args: [op],
  });
  if (frame?.result?.atcPageError) throw new Error(frame.result.atcPageError);
  return frame ? frame.result : undefined;
}

function invokeAgent(op) {
  try {
    globalThis.__atcWatch.checkUpgrade(globalThis.__atcAgent);
    return globalThis.__atcAgent.run(op);
  } catch (error) {
    return { atcPageError: error instanceof Error ? error.message : String(error) };
  }
}

/** Tabs whose console/network the daemon asked us to keep capturing across page loads. */
export async function watchedTabs() {
  const { atcWatched = [] } = await chrome.storage.session.get("atcWatched");
  return new Set(atcWatched);
}

export function setWatched(tabId, watched) {
  const result = storageTail.then(() => updateWatched(tabId, watched));
  storageTail = result.catch(() => undefined);
  return result;
}

export function clearWatched() {
  const result = storageTail.then(async () => {
    const tabs = await watchedTabs();
    await chrome.storage.session.set({ atcWatched: [] });
    return tabs;
  });
  storageTail = result.catch(() => undefined);
  return result;
}

async function updateWatched(tabId, watched) {
  const tabs = await watchedTabs();
  if (watched) tabs.add(tabId);
  else tabs.delete(tabId);
  await chrome.storage.session.set({ atcWatched: [...tabs] });
}
