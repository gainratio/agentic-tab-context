import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

interface SwKeepAliveApi {
  KEEPALIVE_ALARM: { name: string; periodInMinutes: number };
  isAuthScreenUrl(url: string): boolean;
  isLoginRedirectUrl(initialUrl: string, currentUrl: string): boolean;
  keepAliveEntries(): Promise<Record<string, { url: string }>>;
  setTabKeepAlive(tabId: number, enabled: boolean): Promise<{ ok: boolean; keepAlive: boolean }>;
  dropKeepAliveTab(tabId: number): Promise<void>;
  clearAllKeepAlive(): Promise<void>;
  pulseKeepAliveTabs(): Promise<void>;
}

function stripModule(name: string): string {
  return readFileSync(join(import.meta.dirname, "../../extension", name), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace(/^export /gm, "");
}

function swHarness(initialTabs: Record<number, { id: number; url: string }>) {
  const tabs = new Map(Object.entries(initialTabs).map(([id, tab]) => [Number(id), { ...tab }]));
  const session: Record<string, unknown> = {};
  const updates: Array<{ tabId: number; props: Record<string, unknown> }> = [];
  const alarmsCreated: Array<{ name: string; info: Record<string, unknown> }> = [];
  const alarmsCleared: string[] = [];
  const pulses: number[] = [];

  const context = vm.createContext({
    URL,
    runPageOp: async (tabId: number, op: { op: string }) => {
      if (op.op === "keepalive") pulses.push(tabId);
      return { ok: true };
    },
    chrome: {
      storage: {
        session: {
          get: async (key: string) => ({ [key]: session[key] }),
          set: async (next: Record<string, unknown>) => Object.assign(session, next),
        },
      },
      tabs: {
        get: async (tabId: number) => {
          const tab = tabs.get(tabId);
          if (tab === undefined) throw new Error("No tab");
          return { ...tab };
        },
        update: async (tabId: number, props: Record<string, unknown>) => {
          updates.push({ tabId, props });
          return tabs.get(tabId);
        },
      },
      alarms: {
        create: async (name: string, info: Record<string, unknown>) => {
          alarmsCreated.push({ name, info });
        },
        clear: async (name: string) => {
          alarmsCleared.push(name);
          return true;
        },
      },
    },
  });

  vm.runInContext(
    `${stripModule("sw/keepalive.js")}\nglobalThis.api = { KEEPALIVE_ALARM, isAuthScreenUrl, isLoginRedirectUrl, keepAliveEntries, setTabKeepAlive, dropKeepAliveTab, clearAllKeepAlive, pulseKeepAliveTabs };`,
    context,
  );
  return { api: context.api as SwKeepAliveApi, tabs, updates, alarmsCreated, alarmsCleared, pulses };
}

describe("extension service-worker keep-alive", () => {
  it("disables autoDiscardable, creates the MV3 alarm, pulses immediately, and restores on disable", async () => {
    const h = swHarness({ 7: { id: 7, url: "https://app.example.com/dashboard" } });
    expect(await h.api.setTabKeepAlive(7, true)).toEqual({ ok: true, keepAlive: true });
    expect(await h.api.keepAliveEntries()).toEqual({ "7": { url: "https://app.example.com/dashboard" } });
    expect(h.updates).toEqual([{ tabId: 7, props: { autoDiscardable: false } }]);
    expect(h.alarmsCreated).toEqual([{ name: "atc-keepalive", info: { periodInMinutes: 2 } }]);
    expect(h.pulses).toEqual([7]);

    expect(await h.api.setTabKeepAlive(7, false)).toEqual({ ok: true, keepAlive: false });
    expect(await h.api.keepAliveEntries()).toEqual({});
    expect(h.updates.at(-1)).toEqual({ tabId: 7, props: { autoDiscardable: true } });
    expect(h.alarmsCleared).toEqual(["atc-keepalive"]);
  });

  it("skips pulsing tabs that redirected to an SSO login screen and drops vanished tabs", async () => {
    const h = swHarness({
      7: { id: 7, url: "https://app.example.com/dashboard" },
      8: { id: 8, url: "https://app.example.com/orders" },
    });
    await h.api.setTabKeepAlive(7, true);
    await h.api.setTabKeepAlive(8, true);
    h.pulses.length = 0;

    h.tabs.set(7, { id: 7, url: "https://acme.okta.com/login" });
    h.tabs.delete(8);

    await h.api.pulseKeepAliveTabs();
    expect(h.pulses).toEqual([]);
    expect(await h.api.keepAliveEntries()).toEqual({ "7": { url: "https://app.example.com/dashboard" } });

    await h.api.clearAllKeepAlive();
    expect(await h.api.keepAliveEntries()).toEqual({});
    expect(h.alarmsCleared).toContain("atc-keepalive");
  });
});

describe("page-agent non-destructive keep-alive op", () => {
  it("dispatches benign activity events, scrollBy(0, 0), and a same-origin HEAD touch", async () => {
    const source = ["page-agent-watch.js", "page-agent-actions.js", "page-agent.js"]
      .map((name) => readFileSync(join(import.meta.dirname, "../../extension", name), "utf8"))
      .join("\n");
    const dispatched: string[] = [];
    const scrolls: Array<[number, number]> = [];
    const fetches: Array<{ url: string; init: Record<string, unknown> }> = [];
    class FakeEvent {
      constructor(readonly type: string) {}
    }
    const context = vm.createContext({
      URL,
      Element: class {},
      HTMLInputElement: class {},
      HTMLSelectElement: class {},
      PointerEvent: FakeEvent,
      MouseEvent: FakeEvent,
      CSS: { escape: (v: string) => v },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      document: {
        title: "Work",
        documentElement: { dispatchEvent: (ev: FakeEvent) => dispatched.push(ev.type) },
        body: { querySelectorAll: () => [] },
        querySelector: () => null,
      },
      location: { href: "https://app.example.com/work", protocol: "https:" },
      scrollBy: (x: number, y: number) => scrolls.push([x, y]),
      fetch: async (url: string, init: Record<string, unknown>) => {
        fetches.push({ url, init });
        return { status: 200 };
      },
      console: { log: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    vm.runInContext(source, context);
    const agent = context.__atcAgent as { run(op: Record<string, unknown>): { ok: boolean } };
    expect(agent.run({ op: "keepalive" })).toEqual({ ok: true, pulsed: true, url: "https://app.example.com/work" });
    expect(dispatched).toEqual(["pointermove", "mousemove"]);
    expect(scrolls).toEqual([[0, 0]]);
    expect(fetches).toEqual([
      {
        url: "https://app.example.com/work",
        init: { method: "HEAD", credentials: "include", cache: "no-store" },
      },
    ]);
  });
});
