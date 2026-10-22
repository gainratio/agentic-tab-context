/**
 * MacosTabDriver: binds to tabs already open in Chrome, Brave, Edge, Chromium
 * or Safari on macOS, through Apple Events. Chromium-family tabs are tracked
 * by their stable browser id; Safari tabs by position plus URL check, so a
 * reordered or reused tab fails closed instead of being silently retargeted.
 */
import { randomUUID } from "node:crypto";
import { AtcError } from "../../contracts/errors.js";
import type {
  ActionResult,
  BrowserDriver,
  BrowserName,
  BrowserSession,
  ConsoleEntry,
  LiveTab,
  NetworkEntry,
  OpenOptions,
  PageState,
  ScreenshotResult,
  Target,
} from "../../contracts/types.js";
import { type ActAction, type PageOp, actOp, pageExpression, toActionResult, toEntries, toPageState } from "../page-agent.js";
import { APP_BY_BROWSER, type JxaRunner, LIST_SCRIPT, type SafariPosition, chromiumPrelude, defaultJxaRunner, safariLocateScript, safariPrelude, toJxaError } from "./jxa.js";

const TAB_ID_PATTERN = /^macos:([a-z]+):(.+)$/;
const SAFARI_POSITION = /^(\d+):(\d+)$/;

interface MacosSession {
  appName: string;
  chromiumTabId?: string;
  safari?: SafariPosition;
  justNavigated: boolean;
  disconnectCallbacks: Array<() => void>;
}

export class MacosTabDriver implements BrowserDriver {
  readonly name: BrowserName = "chrome";
  private readonly sessions = new Map<string, MacosSession>();

  constructor(private readonly runJxa: JxaRunner = defaultJxaRunner) {}

  async open(_options: OpenOptions): Promise<BrowserSession> {
    const tabs = await this.listTabs();
    const active = tabs.find((t) => t.active) ?? tabs[0];
    if (active === undefined) throw new AtcError("TARGET_NOT_FOUND", "no open macOS browser tabs found");
    return this.bindTab(active.tabId, active.url);
  }

  async listTabs(): Promise<LiveTab[]> {
    try {
      return JSON.parse(await this.runJxa(LIST_SCRIPT)) as LiveTab[];
    } catch {
      return [];
    }
  }

  async bindTab(tabId: string, knownUrl?: string): Promise<BrowserSession> {
    const session = { sessionId: randomUUID() };
    this.sessions.set(session.sessionId, await this.newSession(tabId, knownUrl));
    await this.page(session, { op: "watch" }).catch(() => undefined);
    return session;
  }

  close(session: BrowserSession): Promise<void> {
    this.end(session.sessionId);
    return Promise.resolve();
  }

  onDisconnect(session: BrowserSession, callback: () => void): void {
    const state = this.sessions.get(session.sessionId);
    if (state === undefined) queueMicrotask(callback);
    else state.disconnectCallbacks.push(callback);
  }

  async navigate(session: BrowserSession, url: string): Promise<void> {
    await this.run(session, `tab.url = ${JSON.stringify(url)}; "ok";`);
    this.live(session).justNavigated = true;
  }

  back(session: BrowserSession): Promise<void> {
    return this.history(session, "history.back()");
  }

  forward(session: BrowserSession): Promise<void> {
    return this.history(session, "history.forward()");
  }

  reload(session: BrowserSession): Promise<void> {
    return this.history(session, "location.reload()");
  }

  async location(session: BrowserSession): Promise<{ url: string; title: string }> {
    const title = this.live(session).appName === "Safari" ? "tab.name()" : "tab.title()";
    const json = await this.run(session, `JSON.stringify({ url: tab.url() || "", title: ${title} || "" });`);
    return JSON.parse(json) as { url: string; title: string };
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

  screenshot(_session: BrowserSession, _path: string, _fullPage: boolean): Promise<ScreenshotResult> {
    const message = "screenshots of a live macOS tab need the atc browser extension (Apple Events can only capture the whole screen)";
    return Promise.reject(new AtcError("UNSUPPORTED_ACTION", message));
  }

  async console(session: BrowserSession, sinceSeq: number): Promise<ConsoleEntry[]> {
    return toEntries<ConsoleEntry>(await this.page(session, { op: "logs", kind: "console", since: sinceSeq }));
  }

  async network(session: BrowserSession, sinceSeq: number): Promise<NetworkEntry[]> {
    return toEntries<NetworkEntry>(await this.page(session, { op: "logs", kind: "network", since: sinceSeq }));
  }

  private async newSession(tabId: string, knownUrl: string | undefined): Promise<MacosSession> {
    const match = TAB_ID_PATTERN.exec(tabId);
    const appName = match === null ? undefined : APP_BY_BROWSER[match[1] as BrowserName];
    if (match === null || appName === undefined) throw new AtcError("INVALID_ARGUMENT", `not a macOS tab id: ${tabId}`);
    const base = { appName, justNavigated: false, disconnectCallbacks: [] };
    if (appName !== "Safari") return { ...base, chromiumTabId: match[2] ?? "" };
    const position = SAFARI_POSITION.exec(match[2] ?? "");
    if (position === null) throw new AtcError("INVALID_ARGUMENT", `not a Safari tab id: ${tabId}`);
    const url = knownUrl ?? (await this.listTabs()).find((t) => t.tabId === tabId)?.url ?? "";
    return { ...base, safari: { window: Number(position[1]), tab: Number(position[2]), url } };
  }

  private async history(session: BrowserSession, expression: string): Promise<void> {
    await this.evalInPage(session, `${expression}; "ok"`);
    this.live(session).justNavigated = true;
  }

  private async act(session: BrowserSession, action: ActAction, target: Target, value?: string): Promise<ActionResult> {
    return toActionResult(await this.page(session, actOp(action, target, value)));
  }

  private async page(session: BrowserSession, op: PageOp): Promise<unknown> {
    return JSON.parse(await this.evalInPage(session, pageExpression(op))) as unknown;
  }

  private evalInPage(session: BrowserSession, expression: string): Promise<string> {
    const safari = this.live(session).appName === "Safari";
    const call = safari ? "app.doJavaScript(js, { in: tab })" : "app.execute(tab, { javascript: js })";
    return this.run(session, `const js = ${JSON.stringify(expression)}; String(${call});`);
  }

  /** Run `body` with `app` and `tab` bound to this session's tab, re-verifying its identity first. */
  private async run(session: BrowserSession, body: string): Promise<string> {
    const state = this.live(session);
    try {
      return await this.runJxa(`${await this.prelude(state)}\n${body}`);
    } catch (error) {
      const failure = error instanceof AtcError ? error : toJxaError(error, state.appName);
      if (failure.code === "CONTEXT_CLOSED") this.end(session.sessionId);
      throw failure;
    }
  }

  private async prelude(state: MacosSession): Promise<string> {
    if (state.safari === undefined) return chromiumPrelude(state.appName, state.chromiumTabId ?? "");
    const located = JSON.parse(await this.runJxa(safariLocateScript(state.safari, state.justNavigated))) as SafariPosition;
    state.safari = located;
    state.justNavigated = false;
    return safariPrelude(located);
  }

  private live(session: BrowserSession): MacosSession {
    const state = this.sessions.get(session.sessionId);
    if (state === undefined) throw new AtcError("CONTEXT_CLOSED", "this browser context is closed or unknown");
    return state;
  }

  private end(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    this.sessions.delete(sessionId);
    for (const callback of state.disconnectCallbacks.splice(0)) callback();
  }
}
