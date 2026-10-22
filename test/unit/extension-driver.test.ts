import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionBridge } from "../../src/drivers/extension/bridge.js";
import { ExtensionDriver } from "../../src/drivers/extension/driver.js";

const TAB = "ext:chromium-01234567:1";
function driverHarness() {
  const commands: string[] = [];
  let unwatch = async () => ({ ok: true });
  let watch = async () => ({ ok: true });
  const bridge = {
    onTabsChanged() {},
    listTabs: () => [{ tabId: TAB, browser: "chromium", source: "extension", url: "http://fixture/", title: "Fixture", active: true }],
    dispatch: async (_tabId: string, action: string) => {
      commands.push(action);
      if (action === "unwatch") return unwatch();
      if (action === "watch") return watch();
      if (action === "screenshot") return "data:image/png;base64,dGVzdA==";
      return { ok: true };
    },
  };
  return { driver: new ExtensionDriver(bridge as unknown as ExtensionBridge), commands,
    setUnwatch: (fn: () => Promise<{ ok: boolean }>) => { unwatch = fn; },
    setWatch: (fn: () => Promise<{ ok: boolean }>) => { watch = fn; } };
}

describe("extension driver capabilities and capture lifetime", () => {
  it("rejects full-page screenshots before taking a viewport screenshot", async () => {
    const h = driverHarness();
    const dir = await mkdtemp(join(tmpdir(), "atc-full-page-"));
    try {
      const session = await h.driver.bindTab(TAB);
      await expect(h.driver.screenshot(session, join(dir, "image.png"), true)).rejects.toMatchObject({ code: "UNSUPPORTED_ACTION" });
      expect(h.commands).toEqual(["watch"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("does not finish closing until the tab has stopped capture", async () => {
    const h = driverHarness();
    const session = await h.driver.bindTab(TAB);
    let release!: () => void;
    h.setUnwatch(() => new Promise((resolve) => { release = () => resolve({ ok: true }); }));
    let finished = false;
    const closing = h.driver.close(session).then(() => { finished = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(finished).toBe(false);
    release();
    await closing;
    expect(finished).toBe(true);
    await expect(h.driver.inspect(session)).rejects.toMatchObject({ code: "CONTEXT_CLOSED" });
  });

  it("keeps capture until the last session for the same tab closes", async () => {
    const h = driverHarness();
    const first = await h.driver.bindTab(TAB);
    const second = await h.driver.bindTab(TAB);
    await h.driver.close(first);
    expect(h.commands).toEqual(["watch", "watch"]);
    await h.driver.close(second);
    expect(h.commands).toEqual(["watch", "watch", "unwatch"]);
  });

  it("finishes unwatch before starting a new binding for the tab", async () => {
    const h = driverHarness();
    const first = await h.driver.bindTab(TAB);
    let release!: () => void;
    h.setUnwatch(() => new Promise((resolve) => { release = () => resolve({ ok: true }); }));
    const closing = h.driver.close(first);
    const rebinding = h.driver.bindTab(TAB);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.commands).toEqual(["watch", "unwatch"]);
    release();
    await closing;
    await rebinding;
    expect(h.commands).toEqual(["watch", "unwatch", "watch"]);
  });

  it("surfaces legacy capture hooks that require a tab reload", async () => {
    const h = driverHarness();
    let watched = false;
    h.setWatch(async () => { watched = true; throw new Error("ATC_RELOAD_REQUIRED: Reload this tab"); });
    h.setUnwatch(async () => { watched = false; return { ok: true }; });
    await expect(h.driver.bindTab(TAB)).rejects.toThrow(/ATC_RELOAD_REQUIRED/);
    expect(watched).toBe(false);
    expect(h.commands).toEqual(["watch", "unwatch"]);
  });

  it("preserves the reload error when failed-bind cleanup also fails", async () => {
    const h = driverHarness();
    h.setWatch(async () => { throw new Error("ATC_RELOAD_REQUIRED: Reload this tab"); });
    h.setUnwatch(async () => { throw new Error("tab gone during cleanup"); });
    await expect(h.driver.bindTab(TAB)).rejects.toThrow(/ATC_RELOAD_REQUIRED/);
  });

});
