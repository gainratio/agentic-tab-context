/**
 * One connected browser extension instance (one browser profile), as seen
 * through its native-messaging host. Owns that instance's tab list and the
 * commands in flight to it.
 */
import type { Socket } from "node:net";
import { AtcError, toErrorCode } from "../../contracts/errors.js";
import {
  EXTENSION_COMMAND_TIMEOUT_MS,
  EXTENSION_NAVIGATION_TIMEOUT_MS,
  type DaemonToExtension,
  type ExtensionAction,
  type ExtensionBindings,
  type ExtensionTab,
  type ExtensionToDaemon,
} from "../../contracts/extension.js";
import type { BrowserName, LiveTab } from "../../contracts/types.js";
import { readLines, writeLine } from "../../transport/lines.js";
import { parseExtensionMessage } from "./messages.js";

/** Chrome's cap on one extension-to-host message; anything larger is not from a real browser. */
const MAX_LINE_BYTES = 64 * 1024 * 1024;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ConnectionEvents {
  onIdentified: (connection: ExtensionConnection) => void;
  onTabs: (connection: ExtensionConnection) => void;
  onPin: (tabId: string) => Promise<string>;
  /** Side-panel workspace snapshot; never includes page content. */
  onBindings: () => Promise<ExtensionBindings>;
  /** User-initiated share of one of this browser's tabs: no active change, sensitive URLs allowed. */
  onShare: (tabId: string) => Promise<string>;
  onUnshare: (context: string) => Promise<void>;
  onActivate: (context: string) => Promise<void>;
}

export class ExtensionConnection {
  key = "";
  browser: BrowserName = "chrome";
  tabs: LiveTab[] = [];
  protocol = 1;
  version = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly socket: Socket,
    private readonly events: ConnectionEvents,
  ) {
    readLines(socket, MAX_LINE_BYTES, { onLine: (line) => this.receive(line), onOverflow: () => socket.destroy() });
    socket.on("close", () => this.rejectAll());
  }

  tabId(rawTabId: number): string {
    return `ext:${this.key}:${String(rawTabId)}`;
  }

  dispatch(rawTabId: number, action: ExtensionAction, payload: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const message = { type: "command", id, tabId: rawTabId, action, payload: { ...payload, timeoutMs: EXTENSION_NAVIGATION_TIMEOUT_MS } };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.settle(id, () => reject(timeoutError(action))), EXTENSION_COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      writeLine(this.socket, message);
    });
  }

  private receive(line: string): void {
    const message = parseExtensionMessage(line);
    if (message === undefined) return;
    if (message.type === "hello") this.identify(message.browser, message.instance, message.protocol ?? 1, message.version ?? "");
    else if (this.key === "") return;
    else if (message.type === "tabs") this.updateTabs(message.tabs);
    else if (message.type === "result") this.complete(message);
    else if (message.type === "pin") void this.pin(message.id, message.tabId);
    else if (message.type === "bindings") void this.bindings(message.id);
    else if (message.type === "share") void this.share(message.id, message.tabId);
    else if (message.type === "unshare") void this.unshare(message.id, message.context);
    else void this.activate(message.id, message.context);
  }

  private identify(browser: BrowserName, instance: string, protocol: number, version: string): void {
    this.browser = browser;
    this.protocol = protocol;
    this.version = version;
    this.key = `${browser}-${instance}`;
    this.events.onIdentified(this);
  }

  private updateTabs(tabs: ExtensionTab[]): void {
    this.tabs = tabs.map((tab) => ({
      tabId: this.tabId(tab.id),
      browser: this.browser,
      source: "extension",
      url: tab.url,
      title: tab.title,
      active: tab.active,
    }));
    this.events.onTabs(this);
  }

  private complete(message: Extract<ExtensionToDaemon, { type: "result" }>): void {
    const entry = this.pending.get(message.id);
    if (entry === undefined) return;
    this.settle(message.id, () => {
      if (message.ok) entry.resolve(message.result);
      else {
        const { type: _type, id: _id, ok: _ok, error, message: text, ...details } = message;
        entry.reject(new AtcError(toErrorCode(error), text ?? "browser extension reported an error", details));
      }
    });
  }

  private async pin(id: number, rawTabId: number): Promise<void> {
    try {
      const context = await this.events.onPin(this.tabId(rawTabId));
      this.respond({ type: "pinned", id, ok: true, context });
    } catch (error) {
      this.respond({ type: "pinned", id, ok: false, message: errorMessage(error) });
    }
  }

  private async bindings(id: number): Promise<void> {
    try {
      const { current, bindings } = await this.events.onBindings();
      this.respond({ type: "bindings", id, ok: true, current, bindings });
    } catch (error) {
      this.respond({ type: "bindings", id, ok: false, current: null, bindings: [], message: errorMessage(error) });
    }
  }

  private async share(id: number, rawTabId: number): Promise<void> {
    try {
      const context = await this.events.onShare(this.tabId(rawTabId));
      this.respond({ type: "shared", id, ok: true, context });
    } catch (error) {
      this.respond({ type: "shared", id, ok: false, message: errorMessage(error) });
    }
  }

  private async unshare(id: number, context: string): Promise<void> {
    try {
      await this.events.onUnshare(context);
      this.respond({ type: "unshared", id, ok: true, context });
    } catch (error) {
      this.respond({ type: "unshared", id, ok: false, message: errorMessage(error) });
    }
  }

  private async activate(id: number, context: string): Promise<void> {
    try {
      await this.events.onActivate(context);
      this.respond({ type: "activated", id, ok: true, context });
    } catch (error) {
      this.respond({ type: "activated", id, ok: false, message: errorMessage(error) });
    }
  }

  /** A side-panel failure must never take down the connection or another in-flight request. */
  private respond(message: DaemonToExtension): void {
    writeLine(this.socket, message);
  }

  private settle(id: number, outcome: () => void): void {
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    outcome();
  }

  private rejectAll(): void {
    for (const [id, entry] of this.pending) {
      this.settle(id, () => entry.reject(new AtcError("ACTION_FAILED", "browser extension disconnected mid-command")));
    }
  }
}

function timeoutError(action: ExtensionAction): AtcError {
  return new AtcError("TIMEOUT", `browser extension did not finish "${action}" in ${EXTENSION_COMMAND_TIMEOUT_MS} ms`);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message === "" ? "browser extension request failed" : message.slice(0, 1024);
}
