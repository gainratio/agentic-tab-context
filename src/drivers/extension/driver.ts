/**
 * ExtensionDriver: drives any live browser tab connected via the Agentic Browser Tab
 * WebExtension (Chrome, Brave, Edge, Arc, Firefox, Safari) without opening a new browser.
 */
import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { TabCtxError } from "../../contracts/errors.js";
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
import {
  ACTION_SCRIPT_BODY,
  INSPECT_SCRIPT_BODY,
  LOGS_SCRIPT_BODY,
  buildActionExpression,
  buildInspectExpression,
  buildLogsExpression,
} from "../dom-script.js";
import { describeTarget } from "../target.js";
import type { ExtensionBridge } from "./bridge.js";

interface ExtSession {
  id: string;
  rawTabId: number;
  tabId: string;
  closed: boolean;
  disconnectCallbacks: Array<() => void>;
}

export class ExtensionDriver implements BrowserDriver {
  readonly name = "extension" as const;
  private readonly bridge: ExtensionBridge;
  private readonly sessions = new Map<string, ExtSession>();

  constructor(bridge: ExtensionBridge) {
    this.bridge = bridge;
  }

  open(_options: OpenOptions): Promise<BrowserSession> {
    const tabs = this.bridge.listTabs();
    const active = tabs.find((t) => t.active) ?? tabs[0];
    if (active === undefined) {
      throw new TabCtxError(
        "ACTION_FAILED",
        "No browser extension tabs connected; load the extension from `abt setup` or use `abt open chrome`",
      );
    }
    return this.bindTab(active.tabId);
  }

  listTabs(): Promise<LiveTab[]> {
    return Promise.resolve(this.bridge.listTabs());
  }

  bindTab(tabId: string): Promise<BrowserSession> {
    const match = /^ext:[^:]+:(\d+)$/.exec(tabId);
    if (match === null) throw new TabCtxError("INVALID_ARGUMENT", `Invalid extension tabId: ${tabId}`);
    const rawTabId = Number(match[1]);
    const id = randomUUID();
    this.sessions.set(id, { id, rawTabId, tabId, closed: false, disconnectCallbacks: [] });
    return Promise.resolve({ sessionId: id });
  }

  close(session: BrowserSession): Promise<void> {
    const state = this.sessions.get(session.sessionId);
    if (state !== undefined && !state.closed) {
      state.closed = true;
      this.sessions.delete(state.id);
      for (const cb of state.disconnectCallbacks.splice(0)) cb();
    }
    return Promise.resolve();
  }

  onDisconnect(session: BrowserSession, callback: () => void): void {
    const state = this.sessions.get(session.sessionId);
    if (state === undefined || state.closed) queueMicrotask(callback);
    else state.disconnectCallbacks.push(callback);
  }

  async navigate(session: BrowserSession, url: string): Promise<void> {
    const state = this.live(session);
    await this.bridge.dispatch(state.rawTabId, "navigate", { url });
  }

  async back(session: BrowserSession): Promise<void> {
    const state = this.live(session);
    await this.bridge.dispatch(state.rawTabId, "back");
  }

  async forward(session: BrowserSession): Promise<void> {
    const state = this.live(session);
    await this.bridge.dispatch(state.rawTabId, "forward");
  }

  async reload(session: BrowserSession): Promise<void> {
    const state = this.live(session);
    await this.bridge.dispatch(state.rawTabId, "reload");
  }

  async location(session: BrowserSession): Promise<{ url: string; title: string }> {
    const state = this.live(session);
    const res = (await this.bridge.dispatch(state.rawTabId, "location")) as { url?: string; title?: string };
    return { url: res.url ?? "", title: res.title ?? "" };
  }

  async inspect(session: BrowserSession): Promise<PageState> {
    const state = this.live(session);
    const raw = (await this.bridge.dispatch(state.rawTabId, "eval", {
      op: "inspect",
      scriptBody: INSPECT_SCRIPT_BODY,
      expression: buildInspectExpression(),
    })) as string;
    return JSON.parse(raw) as PageState;
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
    const state = this.live(session);
    const absolute = resolve(path);
    const dataUrl = (await this.bridge.dispatch(state.rawTabId, "screenshot")) as string;
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, Buffer.from(base64, "base64"));
    const { size } = await stat(absolute);
    return { path: absolute, bytes: size };
  }

  async console(session: BrowserSession, sinceSeq: number): Promise<ConsoleEntry[]> {
    const state = this.live(session);
    const raw = (await this.bridge.dispatch(state.rawTabId, "eval", {
      op: "logs",
      kind: "console",
      sinceSeq,
      scriptBody: LOGS_SCRIPT_BODY,
      expression: buildLogsExpression("console", sinceSeq),
    })) as string;
    return JSON.parse(raw) as ConsoleEntry[];
  }

  async network(session: BrowserSession, sinceSeq: number): Promise<NetworkEntry[]> {
    const state = this.live(session);
    const raw = (await this.bridge.dispatch(state.rawTabId, "eval", {
      op: "logs",
      kind: "network",
      sinceSeq,
      scriptBody: LOGS_SCRIPT_BODY,
      expression: buildLogsExpression("network", sinceSeq),
    })) as string;
    return JSON.parse(raw) as NetworkEntry[];
  }

  private async act(
    session: BrowserSession,
    action: "click" | "type" | "select",
    target: Target,
    value?: string,
  ): Promise<ActionResult> {
    const state = this.live(session);
    const raw = (await this.bridge.dispatch(state.rawTabId, "eval", {
      op: "act",
      action,
      target,
      value,
      label: describeTarget(target),
      scriptBody: ACTION_SCRIPT_BODY,
      expression: buildActionExpression(action, target, value),
    })) as string;
    const parsed = JSON.parse(raw) as { ok: boolean; matched?: number; error?: "TARGET_NOT_FOUND"; message?: string };
    if (!parsed.ok) {
      throw new TabCtxError(parsed.error ?? "ACTION_FAILED", parsed.message ?? "Action failed", {
        ...(parsed.matched === undefined ? {} : { matched: parsed.matched }),
      });
    }
    return { matched: 1 };
  }

  private live(session: BrowserSession): ExtSession {
    const state = this.sessions.get(session.sessionId);
    if (state === undefined || state.closed) {
      throw new TabCtxError("CONTEXT_CLOSED", "This browser context is closed or unknown");
    }
    return state;
  }
}
