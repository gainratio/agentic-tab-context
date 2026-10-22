/**
 * Runs the shared page agent (page-agent.js) inside a tab. Inspect and actions
 * run in the extension's isolated world, where page scripts cannot tamper with
 * them; console/network capture must run in the page's own world to see its calls.
 */

const PAGE_WORLD_OPS = new Set(["watch", "logs"]);

export async function runPageOp(tabId, op) {
  const world = PAGE_WORLD_OPS.has(op.op) ? "MAIN" : "ISOLATED";
  const target = { tabId };
  await chrome.scripting.executeScript({ target, world, files: ["page-agent.js"], injectImmediately: true });
  const [frame] = await chrome.scripting.executeScript({
    target,
    world,
    injectImmediately: true,
    func: (pageOp) => globalThis.__atcAgent.run(pageOp),
    args: [op],
  });
  return frame ? frame.result : undefined;
}

/** Tabs whose console/network the daemon asked us to keep capturing across page loads. */
export async function watchedTabs() {
  const { atcWatched = [] } = await chrome.storage.session.get("atcWatched");
  return new Set(atcWatched);
}

export async function setWatched(tabId, watched) {
  const tabs = await watchedTabs();
  if (watched) tabs.add(tabId);
  else tabs.delete(tabId);
  await chrome.storage.session.set({ atcWatched: [...tabs] });
}
