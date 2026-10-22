import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

type Activation = { tabId: number; windowId: number };

function captureHarness(quota?: number) {
  const windows = new Map([[1, 99], [2, 98]]);
  const tabs = new Map([[1, 1], [2, 1], [3, 1], [4, 2], [99, 1], [98, 2]]);
  const listeners = new Set<(event: Activation) => void>();
  let capture = async (windowId: number) => `png-of-tab-${windows.get(windowId)}`;
  let queries = 0;
  let afterQuery = (_windowId: number, _count: number) => {};
  const activate = (tabId: number) => {
    const windowId = tabs.get(tabId)!;
    windows.set(windowId, tabId);
    for (const listener of listeners) listener({ tabId, windowId });
  };
  const chrome = { tabs: {
    MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND: quota,
    get: async (id: number) => ({ id, windowId: tabs.get(id), active: windows.get(tabs.get(id)!) === id }),
    query: async ({ windowId }: { windowId: number }) => {
      const result = [{ id: windows.get(windowId), windowId }];
      afterQuery(windowId, ++queries);
      return result;
    },
    update: async (id: number) => { activate(id); return { id }; },
    captureVisibleTab: (windowId: number) => capture(windowId),
    onActivated: { addListener: (listener: (event: Activation) => void) => listeners.add(listener), removeListener: (listener: (event: Activation) => void) => listeners.delete(listener) },
  } };
  const source = readFileSync(join(import.meta.dirname, "../../extension/sw/capture.js"), "utf8").replace(/export /g, "");
  const context = vm.createContext({ chrome, setTimeout, performance: { now: () => Date.now() } });
  vm.runInContext(`${source}\nglobalThis.capture = captureTab`, context);
  return { capture: context.capture as (id: number) => Promise<string>, windows, listeners, activate,
    setCapture: (fn: (windowId: number) => Promise<string>) => { capture = fn; },
    setAfterQuery: (fn: typeof afterQuery) => { afterQuery = fn; } };
}

afterEach(() => vi.useRealTimers());

describe("extension screenshot isolation", () => {
  it("serializes captures in one window and restores the user's original tab", async () => {
    const h = captureHarness();
    expect(await Promise.all([h.capture(1), h.capture(2)])).toEqual(["png-of-tab-1", "png-of-tab-2"]);
    expect(h.windows.get(1)).toBe(99);
    expect(h.listeners.size).toBe(0);
  });

  it("rejects an intervening focus change and leaves the user's selected tab alone", async () => {
    const h = captureHarness();
    h.setCapture(async () => { h.activate(3); return "png-of-tab-3"; });
    await expect(h.capture(1)).rejects.toThrow(/focus changed/i);
    expect(h.windows.get(1)).toBe(3);
    expect(h.listeners.size).toBe(0);
  });

  it("releases the window after a failed capture", async () => {
    const h = captureHarness();
    h.setCapture(async () => { throw new Error("capture failed"); });
    await expect(h.capture(1)).rejects.toThrow("capture failed");
    h.setCapture(async (windowId) => `png-of-tab-${h.windows.get(windowId)}`);
    expect(await h.capture(2)).toBe("png-of-tab-2");
    expect(h.windows.get(1)).toBe(99);
    expect(h.listeners.size).toBe(0);
  });

  it("preserves a user's selection made while checking whether to restore the original tab", async () => {
    const h = captureHarness();
    h.setAfterQuery((_windowId, count) => { if (count === 4) h.activate(3); });
    expect(await h.capture(1)).toBe("png-of-tab-1");
    expect(h.windows.get(1)).toBe(3);
    expect(h.listeners.size).toBe(0);
  });

  it.each([undefined, 2])("paces a capture burst across windows within the browser quota (%s)", async (quota) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const h = captureHarness(quota);
    const starts: number[] = [];
    h.setCapture(async (windowId) => { starts.push(Date.now()); return `png-of-tab-${h.windows.get(windowId)}`; });
    const burst = Promise.all([h.capture(1), h.capture(4), h.capture(2), h.capture(4)]);
    await vi.runAllTimersAsync();
    expect(await burst).toEqual(["png-of-tab-1", "png-of-tab-4", "png-of-tab-2", "png-of-tab-4"]);
    expect(starts).toHaveLength(4);
    for (let index = 2; index < starts.length; index += 1) expect(starts[index]! - starts[index - 2]!).toBeGreaterThanOrEqual(1000);
    expect([h.windows.get(1), h.windows.get(2)]).toEqual([99, 98]);
  });

  it("retains quota accounting after failure and admits the next window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const h = captureHarness(2);
    const starts: number[] = [];
    h.setCapture(async (windowId) => {
      starts.push(Date.now());
      if (starts.length === 1) throw new Error("capture failed");
      return `png-of-tab-${h.windows.get(windowId)}`;
    });
    const first = expect(h.capture(1)).rejects.toThrow("capture failed");
    const second = h.capture(4);
    await vi.runAllTimersAsync();
    await first;
    expect(await second).toBe("png-of-tab-4");
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(500);
    expect(h.listeners.size).toBe(0);
  });
});
