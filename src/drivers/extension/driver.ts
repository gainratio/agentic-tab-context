/**
 * ExtensionDriver: drives a tab the user already has open, through the
 * browser extension. Tab ids are stable for the life of the tab, so a bound
 * context can never silently retarget a different tab.
 */
import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AtcError } from "../../contracts/errors.js";
import type { ExtensionAction } from "../../contracts/extension.js";
import type {
  ActionResult,
  BrowserDriver,
  BrowserSession,
  ConsoleEntry,
  LiveTab,
  NetworkEntry,
  OpenOptions,
  PageState,
  ScreenshotResult,
  Target,
} from "../../contracts/types.js";
import { type ActAction, type PageOp, actOp, toActionResult, toEntries, toPageState } from "../page-agent.js";
import { type ExtensionBridge, parseExtensionTabId } from "./bridge.js";

interface ExtSession {
  tabId: string;
  disconnectCallbacks: Array<() => void>;
}

export class ExtensionDriver implements BrowserDriver {
  readonly name = "extension" as const;
  private readonly sessions = new Map<string, ExtSession>();

  constructor(private readonly bridge: ExtensionBridge) {
    bridge.onTabsChanged((key, tabs) => this.closeVanished(key, tabs));
  }

  open(_options: OpenOptions): Promise<BrowserSession> {
    const tabs = this.bridge.listTabs();
    const active = tabs.find((t) => t.active) ?? tabs[0];
    if (active === undefined) {
      return Promise.reject(new AtcError("TARGET_NOT_FOUND", "no browser extension is connected; run `atc doctor` for setup steps"));
    }
    return this.bindTab(active.tabId);
  }

  listTabs(): Promise<LiveTab[]> {
    return Promise.resolve(this.bridge.listTabs());
  }

  async bindTab(tabId: string): Promise<BrowserSession> {
    if (!this.bridge.listTabs().some((tab) => tab.tabId === tabId)) {
      throw new AtcError("TARGET_NOT_FOUND", `tab ${tabId} is not open in any connected browser`);
    }
    const sessionId = randomUUID();
    this.sessions.set(sessionId, { tabId, disconnectCallbacks: [] });
    await this.bridge.dispatch(tabId, "watch").catch(() => undefined);
    return { sessionId };
  }

  close(session: BrowserSession): Promise<void> {
    const state = this.sessions.get(session.sessionId);
    if (state !== undefined) void this.bridge.dispatch(state.tabId, "unwatch").catch(() => undefined);
    this.end(session.sessionId);
    return Promise.resolve();
  }

  onDisconnect(session: BrowserSession, callback: () => void): void {
    const state = this.sessions.get(session.sessionId);
    if (state === undefined) queueMicrotask(callback);
    else state.disconnectCallbacks.push(callback);
  }

  async navigate(session: BrowserSession, url: string): Promise<void> {
    await this.send(session, "navigate", { url });
  }

  async back(session: BrowserSession): Promise<void> {
    await this.send(session, "back");
  }

  async forward(session: BrowserSession): Promise<void> {
    await this.send(session, "forward");
  }

  async reload(session: BrowserSession): Promise<void> {
    await this.send(session, "reload");
  }

  async location(session: BrowserSession): Promise<{ url: string; title: string }> {
    const { url, title } = toPageState(await this.send(session, "location"));
    return { url, title };
  }

  async inspect(session: BrowserSession): Promise<PageState> {
    return toPageState(await this.page(session, { op: "inspect" }));
  }

  click(session: BrowserSession, target: Target): Promise<ActionResult> {
    return this.act(session, "click", target);
  }

  type(session: BrowserSession, target: Target, value: string): Promise<ActionResult> {
    return this.act(session, "type", target, value);
  }

  select(session: BrowserSession, target: Target, value: string): Promise<ActionResult> {
    return this.act(session, "select", target, value);
  }

  async screenshot(session: BrowserSession, path: string, _fullPage: boolean): Promise<ScreenshotResult> {
    const dataUrl = String(await this.send(session, "screenshot"));
    const absolute = resolve(path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, Buffer.from(dataUrl.replace(/^data:image\/\w+;base64,/, ""), "base64"));
    return { path: absolute, bytes: (await stat(absolute)).size };
  }

  async console(session: BrowserSession, sinceSeq: number): Promise<ConsoleEntry[]> {
    return toEntries<ConsoleEntry>(await this.page(session, { op: "logs", kind: "console", since: sinceSeq }));
  }

  async network(session: BrowserSession, sinceSeq: number): Promise<NetworkEntry[]> {
    return toEntries<NetworkEntry>(await this.page(session, { op: "logs", kind: "network", since: sinceSeq }));
  }

  private async act(session: BrowserSession, action: ActAction, target: Target, value?: string): Promise<ActionResult> {
    return toActionResult(await this.page(session, actOp(action, target, value)));
  }

  private page(session: BrowserSession, op: PageOp): Promise<unknown> {
    return this.send(session, "page", { op });
  }

  private send(session: BrowserSession, action: ExtensionAction, payload: Record<string, unknown> = {}): Promise<unknown> {
    const state = this.sessions.get(session.sessionId);
    if (state === undefined) return Promise.reject(new AtcError("CONTEXT_CLOSED", "this browser context is closed or unknown"));
    return this.bridge.dispatch(state.tabId, action, payload);
  }

  /** A bound tab that disappears from its browser's tab list was closed by the user. */
  private closeVanished(key: string, tabs: readonly LiveTab[]): void {
    const open = new Set(tabs.map((tab) => tab.tabId));
    for (const [sessionId, state] of this.sessions) {
      if (parseExtensionTabId(state.tabId).key === key && !open.has(state.tabId)) this.end(sessionId);
    }
  }

  private end(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    this.sessions.delete(sessionId);
    for (const callback of state.disconnectCallbacks.splice(0)) callback();
  }
}
