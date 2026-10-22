import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

function source(name: string): string {
  return readFileSync(join(import.meta.dirname, "../../extension", name), "utf8")
    .replace(/^import .*;\n/gm, "").replace(/export /g, "");
}

function workerHarness() {
  const data: Record<string, unknown> = { atcWatched: [] };
  const capturing = new Set<number>();
  const results: Record<string, unknown>[] = [];
  let unwatchGate = Promise.resolve();
  let handler!: (message: Record<string, unknown>) => Promise<void>;
  const event = { addListener() {} };
  const context = vm.createContext({
    chrome: {
      storage: { session: { get: async () => ({ ...data }), set: async (value: Record<string, unknown>) => Object.assign(data, value) } },
      alarms: { create: async () => undefined, onAlarm: event },
      runtime: { onInstalled: event, onStartup: event, onMessage: event },
      tabs: { onUpdated: event, onActivated: event, onRemoved: event }, windows: { onFocusChanged: event },
      scripting: { executeScript: async (script: { args?: { op: string }[]; target: { tabId: number } }) => {
        const operation = script.args?.[0]?.op;
        if (operation === "watch") capturing.add(script.target.tabId);
        if (operation === "unwatch") { await unwatchGate; capturing.delete(script.target.tabId); }
        return [{ result: { ok: true } }];
      } },
    },
    setMessageHandler: (fn: typeof handler) => { handler = fn; },
    connect: async () => undefined, isConnected: () => true, pushTabs: async () => undefined,
    send: (message: Record<string, unknown>) => results.push(message),
  });
  vm.runInContext(source("sw/page.js"), context);
  vm.runInContext(`globalThis.runCommand = async (message) => {
    await setWatched(message.tabId, true);
    await runPageOp(message.tabId, {op:"watch"});
  };`, context);
  if (existsSync(join(import.meta.dirname, "../../extension/sw/lifecycle.js"))) vm.runInContext(source("sw/lifecycle.js"), context);
  vm.runInContext(`${source("service-worker.js")}\nglobalThis.reinject = reinjectWatch;`, context);
  return { message: (message: Record<string, unknown>) => handler(message), data, capturing, results,
    reinject: context.reinject as (id: number, change: { status: string }) => Promise<void>,
    blockUnwatch: (gate: Promise<void>) => { unwatchGate = gate; } };
}

function nativeHarness() {
  const messages: Record<string, unknown>[] = [];
  const data: Record<string, unknown> = {};
  let disconnect!: () => void;
  const context = vm.createContext({
    browserName: () => "chromium", instanceId: async () => "fixture",
    chrome: {
      runtime: { lastError: { message: "native host exited" }, connectNative: () => ({
        onMessage: { addListener() {} }, onDisconnect: { addListener: (fn: typeof disconnect) => { disconnect = fn; } }, postMessage() {},
      }) },
      storage: { session: { set: async (values: Record<string, unknown>) => Object.assign(data, values) } },
    },
  });
  vm.runInContext(`${source("sw/native.js")}\nglobalThis.api = {connect, setMessageHandler};`, context);
  const api = context.api as { connect: () => Promise<void>; setMessageHandler: (fn: (message: Record<string, unknown>) => void) => void };
  api.setMessageHandler((message) => { messages.push(message); });
  return { api, disconnect: () => disconnect(), messages, data };
}

describe("extension capture after connection loss", () => {
  it("notifies the worker when the native port disconnects and preserves host errors", async () => {
    const h = nativeHarness();
    await h.api.connect();
    h.disconnect();
    await Promise.resolve();
    expect(h.data.atcHost).toBe("missing: native host exited");
    expect(h.messages).toEqual([{ type: "daemon", connected: false }]);
  });

  it("clears watched membership and active capture when the daemon disconnects", async () => {
    const h = workerHarness();
    await h.message({ type: "daemon", connected: true });
    await h.message({ type: "command", id: 1, tabId: 7, action: "watch" });
    expect([...h.capturing]).toEqual([7]);
    await h.message({ type: "daemon", connected: false });
    expect(h.data.atcWatched).toEqual([]);
    expect([...h.capturing]).toEqual([]);
    await h.reinject(7, { status: "loading" });
    expect([...h.capturing]).toEqual([]);
  });

  it("rejects stale watch commands while disconnected and accepts a fresh binding after reconnect", async () => {
    const h = workerHarness();
    await h.message({ type: "daemon", connected: false });
    await h.message({ type: "command", id: 2, tabId: 7, action: "watch" });
    expect([...h.capturing]).toEqual([]);
    expect(h.results).toContainEqual(expect.objectContaining({ id: 2, ok: false }));
    await h.message({ type: "daemon", connected: true });
    await h.message({ type: "command", id: 3, tabId: 7, action: "watch" });
    expect([...h.capturing]).toEqual([7]);
  });

  it("rejects a command admitted before a disconnect even after a fast reconnect", async () => {
    const h = workerHarness();
    await h.message({ type: "daemon", connected: true });
    const stale = h.message({ type: "command", id: 4, tabId: 7, action: "watch" });
    const lost = h.message({ type: "daemon", connected: false });
    const reconnected = h.message({ type: "daemon", connected: true });
    await Promise.all([stale, lost, reconnected]);
    expect([...h.capturing]).toEqual([]);
    expect(h.results).toContainEqual(expect.objectContaining({ id: 4, ok: false }));
  });

  it("finishes capture cleanup before commands from a reconnected daemon run", async () => {
    const h = workerHarness();
    await h.message({ type: "daemon", connected: true });
    await h.message({ type: "command", id: 5, tabId: 7, action: "watch" });
    let release!: () => void;
    h.blockUnwatch(new Promise((resolve) => { release = resolve; }));
    const lost = h.message({ type: "daemon", connected: false });
    const reconnected = h.message({ type: "daemon", connected: true });
    const binding = h.message({ type: "command", id: 6, tabId: 8, action: "watch" });
    await expect.poll(() => h.data.atcWatched).toEqual([]);
    expect([...h.capturing]).toEqual([7]);
    release();
    await Promise.all([lost, reconnected, binding]);
    expect([...h.capturing]).toEqual([8]);
  });
});
