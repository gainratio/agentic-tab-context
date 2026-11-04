import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

type Binding = Record<string, unknown>;

interface RequestsApi {
  parseSidepanelMessage(message: unknown): { type: string; tabId?: number; context?: string; windowId?: number } | undefined;
  responseTypeFor(type: string): string | undefined;
  normalizeDaemonReply(type: string, message: unknown): Record<string, unknown> | undefined;
}

function source(name: string): string {
  return readFileSync(join(import.meta.dirname, "../../extension", name), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace(/^export /gm, "");
}

function requestsApi(): RequestsApi {
  const context = vm.createContext({});
  vm.runInContext(
    `${source("sw/requests.js")}\nglobalThis.api = { parseSidepanelMessage, responseTypeFor, normalizeDaemonReply };`,
    context,
  );
  return context.api as RequestsApi;
}

function binding(overrides: Binding = {}): Binding {
  return {
    context: "ctx_1",
    tabId: "ext:chromium-0a1b2c3d:7",
    browser: "chromium",
    source: "extension",
    url: "https://example.test/",
    title: "Example",
    current: false,
    ...overrides,
  };
}

describe("side-panel runtime request validation", () => {
  it("accepts exactly the contract's messages and drops everything else", () => {
    const api = requestsApi();
    expect(api.parseSidepanelMessage({ type: "atc:bindings" })).toEqual({ type: "atc:bindings" });
    expect(api.parseSidepanelMessage({ type: "atc:share", tabId: 7 })).toEqual({ type: "atc:share", tabId: 7 });
    expect(api.parseSidepanelMessage({ type: "atc:unshare", context: "ctx_1" })).toEqual({
      type: "atc:unshare",
      context: "ctx_1",
    });
    expect(api.parseSidepanelMessage({ type: "atc:activate", context: "ctx_1" })).toEqual({
      type: "atc:activate",
      context: "ctx_1",
    });
    expect(api.parseSidepanelMessage({ type: "atc:open-sidepanel" })).toEqual({
      type: "atc:open-sidepanel",
      windowId: undefined,
    });
    expect(api.parseSidepanelMessage({ type: "atc:open-sidepanel", windowId: 3 })).toEqual({
      type: "atc:open-sidepanel",
      windowId: 3,
    });

    for (const message of [
      undefined,
      null,
      "atc:bindings",
      {},
      { type: "atc:share" },
      { type: "atc:share", tabId: 0 },
      { type: "atc:share", tabId: -1 },
      { type: "atc:share", tabId: "7" },
      { type: "atc:unshare" },
      { type: "atc:unshare", context: "" },
      { type: "atc:activate", context: 7 },
      { type: "atc:open-sidepanel", windowId: 0 },
      { type: "atc:open-sidepanel", windowId: "3" },
      { type: "atc:unknown" },
      { type: 7 },
    ]) {
      expect(api.parseSidepanelMessage(message)).toBeUndefined();
    }
  });

  it("maps request types to their reply types", () => {
    const api = requestsApi();
    expect(api.responseTypeFor("bindings")).toBe("bindings");
    expect(api.responseTypeFor("share")).toBe("shared");
    expect(api.responseTypeFor("unshare")).toBe("unshared");
    expect(api.responseTypeFor("activate")).toBe("activated");
    expect(api.responseTypeFor("hello")).toBeUndefined();
  });
});

describe("daemon reply validation", () => {
  it("keeps a complete bindings snapshot, including null source and tabId", () => {
    const api = requestsApi();
    const reply = {
      type: "bindings",
      id: 4,
      ok: true,
      current: "ctx_1",
      bindings: [
        binding(),
        binding({ context: "ctx_2", tabId: null, source: null, url: null, title: null, browser: "safari", current: false }),
        binding({ context: "ctx_3", source: "extension", tabId: "ext:chrome-deadbeef:9", current: false }),
      ],
    };
    expect(api.normalizeDaemonReply("bindings", reply)).toEqual(reply);
  });

  it("keeps a valid failure snapshot for the empty panel state", () => {
    const api = requestsApi();
    const reply = { type: "bindings", id: 1, ok: false, current: null, bindings: [], message: "not connected" };
    expect(api.normalizeDaemonReply("bindings", reply)).toEqual(reply);
  });

  it("drops malformed bindings replies", () => {
    const api = requestsApi();
    const base = { type: "bindings", id: 1, ok: true, current: null, bindings: [] };
    for (const reply of [
      undefined,
      { ...base, type: "shared" },
      { ...base, id: 0 },
      { ...base, ok: "yes" },
      { ...base, current: 3 },
      { ...base, bindings: [{ ...binding(), source: 7 }] },
      { ...base, bindings: [{ ...binding(), tabId: 7 }] },
      { ...base, bindings: [{ ...binding(), current: "no" }] },
    ]) {
      expect(api.normalizeDaemonReply("bindings", reply)).toBeUndefined();
    }
  });

  it("validates shared/unshared/activated replies", () => {
    const api = requestsApi();
    expect(api.normalizeDaemonReply("shared", { type: "shared", id: 2, ok: true, context: "ctx_2" })).toEqual({
      type: "shared",
      id: 2,
      ok: true,
      context: "ctx_2",
    });
    expect(api.normalizeDaemonReply("unshared", { type: "unshared", id: 3, ok: false, message: "nope" })).toEqual({
      type: "unshared",
      id: 3,
      ok: false,
      message: "nope",
    });
    expect(api.normalizeDaemonReply("activated", { type: "activated", id: 4, ok: true })).toEqual({
      type: "activated",
      id: 4,
      ok: true,
    });
    expect(api.normalizeDaemonReply("activated", { type: "activated", id: 4, ok: true, context: 4 })).toBeUndefined();
    expect(api.normalizeDaemonReply("shared", { type: "shared", id: 0, ok: true })).toBeUndefined();
  });
});

interface NativeApi {
  connect(): Promise<void>;
  requestBindings(): Promise<Record<string, unknown>>;
  shareTab(tabId: number): Promise<Record<string, unknown>>;
  unshareContext(context: string): Promise<Record<string, unknown>>;
  activateContext(context: string): Promise<Record<string, unknown>>;
}

function nativeHarness() {
  const posted: Array<Record<string, unknown>> = [];
  const stored: Record<string, unknown> = {};
  let messageListener: (message: unknown) => void = () => undefined;
  let disconnectListener: () => void = () => undefined;
  const port = {
    onMessage: { addListener: (listener: (message: unknown) => void) => { messageListener = listener; } },
    onDisconnect: { addListener: (listener: () => void) => { disconnectListener = listener; } },
    postMessage: (message: Record<string, unknown>) => posted.push(message),
  };
  const context = vm.createContext({
    browserName: () => "chromium",
    instanceId: async () => "0a1b2c3d",
    chrome: {
      runtime: { lastError: undefined, connectNative: () => port },
      storage: { session: { set: async (values: Record<string, unknown>) => Object.assign(stored, values) } },
    },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  });
  vm.runInContext(source("sw/requests.js"), context);
  vm.runInContext(
    `${source("sw/native.js")}\nglobalThis.api = { connect, requestBindings, shareTab, unshareContext, activateContext };`,
    context,
  );
  return {
    api: context.api as NativeApi,
    posted,
    stored,
    receive: (message: unknown) => messageListener(message),
    disconnect: () => disconnectListener(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("native pending request map", () => {
  it("correlates each request with exactly one typed daemon reply", async () => {
    const h = nativeHarness();
    await h.api.connect();
    h.posted.splice(0);

    const first = h.api.requestBindings();
    expect(h.posted).toEqual([{ type: "bindings", id: 1 }]);
    h.receive({ type: "bindings", id: 1, ok: true, current: null, bindings: [] });
    await expect(first).resolves.toEqual({ type: "bindings", id: 1, ok: true, current: null, bindings: [] });

    const second = h.api.shareTab(7);
    expect(h.posted.at(-1)).toEqual({ type: "share", id: 2, tabId: 7 });
    h.receive({ type: "shared", id: 2, ok: true, context: "ctx_2" });
    await expect(second).resolves.toEqual({ type: "shared", id: 2, ok: true, context: "ctx_2" });
  });

  it("ignores a reply with the wrong type until the matching reply arrives", async () => {
    const h = nativeHarness();
    await h.api.connect();
    h.posted.splice(0);
    const pending = h.api.requestBindings();
    h.receive({ type: "shared", id: 1, ok: true, context: "ctx_wrong" });
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    h.receive({ type: "bindings", id: 1, ok: true, current: null, bindings: [] });
    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it("settles a malformed reply as an error instead of leaving the panel waiting", async () => {
    const h = nativeHarness();
    await h.api.connect();
    h.posted.splice(0);
    const pending = h.api.requestBindings();
    h.receive({ type: "bindings", id: 1, ok: true, current: null, bindings: [{ context: "" }] });
    await expect(pending).resolves.toMatchObject({ ok: false, message: expect.stringContaining("invalid response") });
  });

  it("times out a request when the daemon never answers", async () => {
    vi.useFakeTimers();
    const h = nativeHarness();
    await h.api.connect();
    h.posted.splice(0);
    const pending = h.api.requestBindings();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toMatchObject({ ok: false, message: expect.stringContaining("did not respond") });
  });

  it("settles every pending request on disconnect", async () => {
    const h = nativeHarness();
    await h.api.connect();
    h.posted.splice(0);
    const pending = h.api.activateContext("ctx_1");
    h.disconnect();
    await expect(pending).resolves.toMatchObject({ ok: false, message: expect.stringContaining("disconnected") });
    expect(h.stored.atcDaemon).toBe(false);
  });

  it("rejects invalid local arguments without sending them", async () => {
    const h = nativeHarness();
    await h.api.connect();
    h.posted.splice(0);
    await expect(h.api.shareTab(0)).resolves.toMatchObject({ ok: false });
    await expect(h.api.unshareContext("")).resolves.toMatchObject({ ok: false });
    await expect(h.api.activateContext(null as unknown as string)).resolves.toMatchObject({ ok: false });
    expect(h.posted).toEqual([]);
  });
});
