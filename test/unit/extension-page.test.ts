import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

function pageHarness() {
  let watched: number[] = [];
  const scripts: Record<string, unknown>[] = [];
  const chrome = {
    storage: { session: {
      get: async () => ({ atcWatched: [...watched] }),
      set: async ({ atcWatched }: { atcWatched: number[] }) => { watched = [...atcWatched]; },
    } },
    scripting: { executeScript: async (script: Record<string, unknown>) => { scripts.push(script); return [{ result: { ok: true } }]; } },
  };
  const source = readFileSync(join(import.meta.dirname, "../../extension/sw/page.js"), "utf8").replace(/export /g, "");
  const context = vm.createContext({ chrome });
  vm.runInContext(`${source}\nglobalThis.api = { setWatched, watchedTabs, runPageOp, clearWatched: globalThis.clearWatched }`, context);
  const api = context.api as {
    setWatched: (id: number, value: boolean) => Promise<void>;
    clearWatched: () => Promise<Set<number>>;
    watchedTabs: () => Promise<Set<number>>;
    runPageOp: (id: number, op: { op: string }) => Promise<unknown>;
  };
  return { ...api, scripts };
}

describe("extension watched-tab lifecycle", () => {
  it("retains both tabs when their watch state changes concurrently", async () => {
    const h = pageHarness();
    await Promise.all([h.setWatched(1, true), h.setWatched(2, true)]);
    expect([...(await h.watchedTabs())].sort()).toEqual([1, 2]);
  });

  it("does not restart capture from a stale page-load event after unwatch", async () => {
    const h = pageHarness();
    await h.setWatched(1, true);
    await h.setWatched(1, false);
    await h.runPageOp(1, { op: "watch" });
    expect(h.scripts).toEqual([]);
  });

  it("atomically drains watched tabs after all earlier queued updates", async () => {
    const h = pageHarness();
    const updates = [h.setWatched(1, true), h.setWatched(2, true)];
    const cleared = h.clearWatched();
    await Promise.all(updates);
    expect([...(await cleared)].sort()).toEqual([1, 2]);
    expect([...(await h.watchedTabs())]).toEqual([]);
  });
});
