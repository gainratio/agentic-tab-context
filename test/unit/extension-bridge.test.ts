/**
 * The daemon side of the browser-extension link, over a real owner-only Unix
 * socket, with a fake native host standing in for the browser.
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { type Socket, createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AtcError } from "../../src/contracts/errors.js";
import { EXTENSION_NAVIGATION_TIMEOUT_MS } from "../../src/contracts/extension.js";
import { resolvePaths } from "../../src/contracts/paths.js";
import { ContextRegistry } from "../../src/daemon/registry.js";
import { DaemonService } from "../../src/daemon/service.js";
import { ExtensionBridge } from "../../src/drivers/extension/bridge.js";
import { ExtensionDriver } from "../../src/drivers/extension/driver.js";
import { parseExtensionMessage } from "../../src/drivers/extension/messages.js";

type Json = Record<string, unknown>;
const INSTANCE = "0a1b2c3d";
const TAB = `ext:chromium-${INSTANCE}:7`;

class FakeHost {
  private buffer = "";
  private readonly inbox: Json[] = [];
  private waiter: ((message: Json) => void) | null = null;

  private constructor(readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.receive(chunk));
  }

  static connect(path: string): Promise<FakeHost> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      socket.once("connect", () => resolve(new FakeHost(socket)));
      socket.once("error", reject);
    });
  }

  send(message: Json): void {
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  next(): Promise<Json> {
    const queued = this.inbox.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => (this.waiter = resolve));
  }

  /** Answer the next command with `result`, returning the command for assertions. */
  async answer(result: unknown, ok = true, extra: Json = {}): Promise<Json> {
    const command = await this.next();
    this.send({ type: "result", id: command.id, ok, result, ...extra });
    return command;
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    for (let i = this.buffer.indexOf("\n"); i !== -1; i = this.buffer.indexOf("\n")) {
      const message = JSON.parse(this.buffer.slice(0, i)) as Json;
      this.buffer = this.buffer.slice(i + 1);
      const waiter = this.waiter;
      this.waiter = null;
      if (waiter === null) this.inbox.push(message);
      else waiter(message);
    }
  }
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
}

let dir: string;
let socketPath: string;
let bridge: ExtensionBridge;
let driver: ExtensionDriver;
let host: FakeHost;

function daemon(): { service: DaemonService; registry: ContextRegistry } {
  const paths = resolvePaths({ ATC_HOME: dir });
  const registry = new ContextRegistry({ statePath: paths.state });
  const service = new DaemonService({ registry, paths, env: {}, extensionBridge: bridge, extensionDriver: driver, driverFactory: () => driver });
  return { service, registry };
}

async function connectBrowser(tabs: Json[] = [{ id: 7, url: "http://localhost:3000/app", title: "My App", active: true }]): Promise<void> {
  host = await FakeHost.connect(socketPath);
  host.send({ type: "hello", browser: "chromium", instance: INSTANCE });
  host.send({ type: "tabs", tabs });
  await until(() => bridge.listTabs().length === tabs.length);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "atc-br-"));
  socketPath = join(dir, "e.sock");
  bridge = new ExtensionBridge();
  await bridge.start(socketPath);
  driver = new ExtensionDriver(bridge);
});

afterEach(async () => {
  host?.socket.destroy();
  await bridge.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("ExtensionBridge", () => {
  it("listens on an owner-only socket, never a network port", () => {
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  });

  it("ignores everything until the extension identifies itself", async () => {
    host = await FakeHost.connect(socketPath);
    host.send({ type: "tabs", tabs: [{ id: 1, url: "https://evil.example", title: "x", active: true }] });
    await new Promise((r) => setTimeout(r, 30));
    expect(bridge.listTabs()).toEqual([]);
  });

  it("lists tabs with stable ids scoped to the browser instance", async () => {
    await connectBrowser();
    expect(bridge.listTabs()).toEqual([
      { tabId: TAB, browser: "chromium", source: "extension", url: "http://localhost:3000/app", title: "My App", active: true },
    ]);
    expect(bridge.connected()).toEqual([{ key: `chromium-${INSTANCE}`, browser: "chromium", tabs: 1 }]);
  });

  it("binds a tab, starts console/network capture, and drives it with the navigation budget", async () => {
    await connectBrowser();
    const binding = driver.bindTab(TAB);
    expect(await host.answer({ ok: true })).toMatchObject({ type: "command", tabId: 7, action: "watch" });
    const session = await binding;
    const inspected = driver.inspect(session);
    const command = await host.answer({ url: "http://localhost:3000/app", title: "My App", aria: '- button "Save"' });
    expect(command).toMatchObject({ action: "page", payload: { op: { op: "inspect" }, timeoutMs: EXTENSION_NAVIGATION_TIMEOUT_MS } });
    expect(await inspected).toEqual({ url: "http://localhost:3000/app", title: "My App", aria: '- button "Save"' });
  });

  it("passes typed page errors through and narrows unknown codes to ACTION_FAILED", async () => {
    await connectBrowser();
    const binding = driver.bindTab(TAB);
    await host.answer({ ok: true });
    const session = await binding;
    const click = driver.click(session, { kind: "role", role: "button", name: "Delete" });
    await host.answer({ ok: false, error: "AMBIGUOUS_TARGET", message: "2 match", matched: 2 });
    await expect(click).rejects.toMatchObject({ code: "AMBIGUOUS_TARGET", details: { matched: 2 } });
    const reload = driver.reload(session);
    await host.answer(undefined, false, { error: "NOT_A_REAL_CODE", message: "boom" });
    await expect(reload).rejects.toMatchObject({ code: "ACTION_FAILED", message: "boom" });
  });

  it("closes the context when the user closes the bound tab", async () => {
    await connectBrowser();
    const binding = driver.bindTab(TAB);
    await host.answer({ ok: true });
    let closed = 0;
    driver.onDisconnect(await binding, () => (closed += 1));
    host.send({ type: "tabs", tabs: [] });
    await until(() => closed === 1);
  });

  it("refuses to bind a tab that is not open", async () => {
    await connectBrowser();
    await expect(driver.bindTab(`ext:chromium-${INSTANCE}:99`)).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
  });

  it("fails clearly once that browser's extension is gone", async () => {
    await connectBrowser();
    host.socket.destroy();
    await until(() => bridge.connected().length === 0);
    await expect(bridge.dispatch(TAB, "location")).rejects.toMatchObject({ code: "ACTION_FAILED" });
  });

  it("closes disconnected daemon contexts once and starts capture when rebound", async () => {
    await connectBrowser();
    const { service, registry } = daemon();
    const binding = service.handle({ method: "bind", params: { tab: TAB } });
    await host.answer({ ok: true });
    const bound = await binding;
    if (!bound.ok || typeof bound.context !== "string") throw new Error("binding did not create a context");
    const session = registry.session(bound.context);
    if (session === undefined) throw new Error("binding did not create a session");
    let closed = 0;
    driver.onDisconnect(session, () => (closed += 1));
    host.socket.destroy();
    await until(() => bridge.connected().length === 0);
    expect(closed).toBe(1);
    expect(registry.get(bound.context)?.status).toBe("closed");
    expect(registry.current).toBeNull();
    expect(await service.handle({ method: "inspect", params: { context: bound.context } })).toMatchObject({ ok: false, error: "CONTEXT_CLOSED" });
    await connectBrowser();
    const rebinding = service.handle({ method: "bind", params: { tab: TAB } });
    expect(await host.answer({ ok: true })).toMatchObject({ action: "watch", tabId: 7 });
    const rebound = await rebinding;
    expect(rebound).toMatchObject({ ok: true, reused: false });
    expect(rebound.ok && rebound.context).not.toBe(bound.context);
    expect(closed).toBe(1);
  });

  it("invalidates replaced connections without closing their replacement sessions", async () => {
    await connectBrowser();
    const binding = driver.bindTab(TAB);
    await host.answer({ ok: true });
    let closed = 0;
    driver.onDisconnect(await binding, () => (closed += 1));
    const previousHost = host;
    try {
      await connectBrowser([{ id: 7, url: "http://localhost:3000/replacement", title: "Replacement", active: true }]);
      await until(() => bridge.listTabs()[0]?.title === "Replacement");
      expect(closed).toBe(1);
      const rebinding = driver.bindTab(TAB);
      expect(await host.answer({ ok: true })).toMatchObject({ action: "watch" });
      const replacement = await rebinding;
      let replacementClosed = 0;
      driver.onDisconnect(replacement, () => (replacementClosed += 1));
      previousHost.send({ type: "tabs", tabs: [] });
      previousHost.socket.destroy();
      const inspected = driver.inspect(replacement);
      await host.answer({ url: "http://localhost:3000/replacement", title: "Replacement", aria: "" });
      expect(await inspected).toMatchObject({ title: "Replacement" });
      expect(replacementClosed).toBe(0);
      expect(closed).toBe(1);
      host.socket.destroy();
      await until(() => bridge.connected().length === 0);
      expect(replacementClosed).toBe(1);
    } finally {
      previousHost.socket.destroy();
    }
  });

  it("answers the popup's 'use this tab' request through the pin handler", async () => {
    bridge.onPinTab((tabId) => Promise.resolve(tabId === TAB ? "ctx_beef" : "wrong"));
    await connectBrowser();
    host.send({ type: "pin", id: 3, tabId: 7 });
    expect(await host.next()).toEqual({ type: "pinned", id: 3, ok: true, context: "ctx_beef" });
  });
});

describe("parseExtensionMessage", () => {
  it.each([
    ["not json", "{"],
    ["unknown type", JSON.stringify({ type: "eval", code: "x" })],
    ["bad instance", JSON.stringify({ type: "hello", browser: "chrome", instance: "../../etc" })],
    ["unknown browser", JSON.stringify({ type: "hello", browser: "netscape", instance: INSTANCE })],
    ["negative id", JSON.stringify({ type: "result", id: -1, ok: true })],
  ])("drops %s", (_label, line) => {
    expect(parseExtensionMessage(line)).toBeUndefined();
  });

  it("keeps only well-formed tabs", () => {
    const line = JSON.stringify({ type: "tabs", tabs: [{ id: 1, url: "u", title: "t", active: true }, { id: "x" }, null] });
    expect(parseExtensionMessage(line)).toEqual({ type: "tabs", tabs: [{ id: 1, url: "u", title: "t", active: true }] });
  });

  it("rejects malformed extension tab ids", async () => {
    await expect(bridge.dispatch("ext:../x:1", "location")).rejects.toBeInstanceOf(AtcError);
  });
});
