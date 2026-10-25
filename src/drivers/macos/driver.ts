/**
 * MacosTabDriver: binds to tabs already open in Chrome, Brave, Edge, Chromium
 * on macOS through Apple Events. Chromium-family tabs have stable browser ids.
 * Safari discovery is supported, but binding is refused because Safari exposes
 * only positions and URLs, neither of which identifies a tab safely.
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
import { APP_BY_BROWSER, type JxaRunner, LIST_SCRIPT, chromiumPrelude, defaultJxaRunner, toJxaError } from "./jxa.js";

const TAB_ID_PATTERN = /^macos:([a-z]+):(.+)$/;
const SAFARI_POSITION = /^(\d+):(\d+)$/;

interface MacosSession {
  appName: string;
  chromiumTabId: string;
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

  async bindTab(tabId: string, _knownUrl?: string): Promise<BrowserSession> {
    const session = { sessionId: randomUUID() };
    this.sessions.set(session.sessionId, this.newSession(tabId));
    await this.page(session, { op: "watch" }).catch(() => undefined);
    return session;
  }

  async close(session: BrowserSession): Promise<void> {
    if (!this.sessions.has(session.sessionId)) return;
    await this.page(session, { op: "unwatch" }).catch(() => undefined);
    this.end(session.sessionId);
  }

  onDisconnect(session: BrowserSession, callback: () => void): void {
    const state = this.sessions.get(session.sessionId);
    if (state === undefined) queueMicrotask(callback);
    else state.disconnectCallbacks.push(callback);
  }

  async navigate(session: BrowserSession, url: string): Promise<void> {
    await this.run(session, `tab.url = ${JSON.stringify(url)}; "ok";`);
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
    const json = await this.run(session, `JSON.stringify({ url: tab.url() || "", title: tab.title() || "" });`);
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

  async press(session: BrowserSession, key: string): Promise<ActionResult> {
    return toActionResult(await this.page(session, { op: "press", key }));
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

  private newSession(tabId: string): MacosSession {
    const match = TAB_ID_PATTERN.exec(tabId);
    const appName = match === null ? undefined : APP_BY_BROWSER[match[1] as BrowserName];
    if (match === null || appName === undefined) throw new AtcError("INVALID_ARGUMENT", `not a macOS tab id: ${tabId}`);
    if (appName === "Safari") return this.rejectSafari(tabId, match[2] ?? "");
    return { appName, chromiumTabId: match[2] ?? "", disconnectCallbacks: [] };
  }

  private rejectSafari(tabId: string, position: string): never {
    if (!SAFARI_POSITION.test(position)) throw new AtcError("INVALID_ARGUMENT", `not a Safari tab id: ${tabId}`);
    throw new AtcError("UNSUPPORTED_ACTION", "Safari live tabs support discovery only: stable tab identity is unavailable, so page access is refused. Use a supported browser extension or an atc-managed browser.");
  }

  private async history(session: BrowserSession, expression: string): Promise<void> {
    await this.evalInPage(session, `${expression}; "ok"`);
  }

  private async act(session: BrowserSession, action: ActAction, target: Target, value?: string): Promise<ActionResult> {
    return toActionResult(await this.page(session, actOp(action, target, value)));
  }

  private async page(session: BrowserSession, op: PageOp): Promise<unknown> {
    return JSON.parse(await this.evalInPage(session, pageExpression(op))) as unknown;
  }

  private evalInPage(session: BrowserSession, expression: string): Promise<string> {
    return this.run(session, `const js = ${JSON.stringify(expression)}; String(app.execute(tab, { javascript: js }));`);
  }

  /** Run `body` with `app` and `tab` bound to this session's tab, re-verifying its identity first. */
  private async run(session: BrowserSession, body: string): Promise<string> {
    const state = this.live(session);
    try {
      return await this.runJxa(`${chromiumPrelude(state.appName, state.chromiumTabId)}\n${body}`);
    } catch (error) {
      const failure = error instanceof AtcError ? error : toJxaError(error, state.appName);
      if (failure.code === "CONTEXT_CLOSED") this.end(session.sessionId);
      throw failure;
    }
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
